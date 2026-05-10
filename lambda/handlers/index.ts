import {
  EC2Client,
  DescribeInstanceStatusCommand,
  AssociateAddressCommand,
  TerminateInstancesCommand,
  RunInstancesCommand,
  DescribeInstancesCommand,
  DescribeLaunchTemplateVersionsCommand,
} from '@aws-sdk/client-ec2';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { SFNClient, StartExecutionCommand, ListExecutionsCommand } from '@aws-sdk/client-sfn';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import * as https from 'https';
import * as http from 'http';

const ec2 = new EC2Client({ region: process.env.AWS_REGION });
const ssm = new SSMClient({ region: process.env.AWS_REGION });
const sfn = new SFNClient({ region: process.env.AWS_REGION });
const s3 = new S3Client({ region: process.env.AWS_REGION });
const cw = new CloudWatchClient({ region: process.env.AWS_REGION });

class HealthCheckFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HealthCheckFailed';
  }
}

async function getInstancePublicIp(instanceId: string): Promise<string> {
  const result = await ec2.send(new DescribeInstancesCommand({
    InstanceIds: [instanceId],
  }));
  const instance = result.Reservations?.[0]?.Instances?.[0];
  const ip = instance?.PublicIpAddress;
  if (!ip) throw new HealthCheckFailed(`No public IP yet for ${instanceId}`);
  return ip;
}

function httpCheck(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { rejectUnauthorized: false, timeout: 10000 }, (res) => {
      if (res.statusCode && res.statusCode < 500) resolve();
      else reject(new HealthCheckFailed(`HTTP ${res.statusCode} from ${url}`));
    });
    req.on('error', (e) => reject(new HealthCheckFailed(`Connection failed to ${url}: ${e.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new HealthCheckFailed(`Timeout connecting to ${url}`));
    });
  });
}

// Verifies Unifi redirects to the login page, not the setup wizard
function checkNotSetupWizard(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { rejectUnauthorized: false, timeout: 10000 }, (res) => {
      const location = res.headers.location ?? '';
      if (location.includes('/manage/account/login')) {
        resolve();
      } else if (location.includes('/setup') || location.includes('/wizard')) {
        reject(new HealthCheckFailed(`Unifi is in setup wizard state (redirect: ${location}) — restore may not have applied`));
      } else {
        resolve();
      }
    });
    req.on('error', (e) => reject(new HealthCheckFailed(`Connection failed to ${url}: ${e.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new HealthCheckFailed(`Timeout connecting to ${url}`));
    });
  });
}

// Shared rotation logic used by startRotation and scheduledRotationCheck
async function triggerRotation(params: {
  launchTemplateId: string;
  stateMachineArn: string;
  eipAllocationId: string;
  oldInstanceId: string;
}): Promise<void> {
  const { launchTemplateId, stateMachineArn, eipAllocationId, oldInstanceId } = params;

  const ltVersions = await ec2.send(new DescribeLaunchTemplateVersionsCommand({
    LaunchTemplateId: launchTemplateId,
    Versions: ['$Latest'],
  }));
  const ltVersion = ltVersions.LaunchTemplateVersions?.[0]?.VersionNumber?.toString() ?? '$Latest';

  const runResult = await ec2.send(new RunInstancesCommand({
    MinCount: 1,
    MaxCount: 1,
    LaunchTemplate: { LaunchTemplateId: launchTemplateId, Version: ltVersion },
    TagSpecifications: [{
      ResourceType: 'instance',
      Tags: [
        { Key: 'Name', Value: 'unifi-controller-new' },
        { Key: 'Project', Value: 'unifi' },
        { Key: 'State', Value: 'pending-cutover' },
      ],
    }],
  }));

  const newInstanceId = runResult.Instances?.[0]?.InstanceId;
  if (!newInstanceId) throw new Error('Failed to launch new instance');

  await sfn.send(new StartExecutionCommand({
    stateMachineArn,
    input: JSON.stringify({ newInstanceId, oldInstanceId, eipAllocationId }),
  }));
}

// Checks EC2 system/instance status (2/2) and Unifi ports
export async function checkHealth(event: { instanceId: string }): Promise<{ healthy: boolean }> {
  const { instanceId } = event;

  const statusResult = await ec2.send(new DescribeInstanceStatusCommand({
    InstanceIds: [instanceId],
    IncludeAllInstances: true,
  }));

  const status = statusResult.InstanceStatuses?.[0];
  const systemOk = status?.SystemStatus?.Status === 'ok';
  const instanceOk = status?.InstanceStatus?.Status === 'ok';

  if (!systemOk || !instanceOk) {
    throw new HealthCheckFailed(
      `EC2 status not ready: system=${status?.SystemStatus?.Status}, instance=${status?.InstanceStatus?.Status}`
    );
  }

  const publicIp = await getInstancePublicIp(instanceId);

  await httpCheck(`http://${publicIp}:8080/inform`);
  await httpCheck(`https://${publicIp}:8443`);
  await checkNotSetupWizard(`https://${publicIp}:8443`);

  return { healthy: true };
}

// Re-associates the EIP to the new instance and terminates the old one
export async function performCutover(event: {
  newInstanceId: string;
  oldInstanceId: string;
  eipAllocationId: string;
}): Promise<{ success: boolean }> {
  const { newInstanceId, oldInstanceId, eipAllocationId } = event;

  await ec2.send(new AssociateAddressCommand({
    InstanceId: newInstanceId,
    AllocationId: eipAllocationId,
    AllowReassociation: true,
  }));

  await ssm.send(new PutParameterCommand({
    Name: '/unifi/current-instance-id',
    Value: newInstanceId,
    Type: 'String',
    Overwrite: true,
  }));

  if (oldInstanceId && oldInstanceId !== 'none') {
    await ec2.send(new TerminateInstancesCommand({
      InstanceIds: [oldInstanceId],
    }));
  }

  return { success: true };
}

// Terminates the new instance when health checks fail
export async function cleanup(event: { instanceId: string }): Promise<void> {
  const { instanceId } = event;
  if (instanceId && instanceId !== 'none') {
    await ec2.send(new TerminateInstancesCommand({
      InstanceIds: [instanceId],
    }));
  }
}

// Triggered by EventBridge when a new AL2023 AMI is published
export async function startRotation(event: Record<string, unknown>): Promise<void> {
  const launchTemplateId = process.env.LAUNCH_TEMPLATE_ID!;
  const stateMachineArn = process.env.STATE_MACHINE_ARN!;
  const eipAllocationId = process.env.EIP_ALLOCATION_ID!;

  const currentInstanceParam = await ssm.send(new GetParameterCommand({
    Name: '/unifi/current-instance-id',
  }));
  const oldInstanceId = currentInstanceParam.Parameter?.Value ?? 'none';

  await triggerRotation({ launchTemplateId, stateMachineArn, eipAllocationId, oldInstanceId });
}

// Triggered weekly — rotates only if the current instance is older than 30 days
export async function scheduledRotationCheck(event: Record<string, unknown>): Promise<void> {
  const launchTemplateId = process.env.LAUNCH_TEMPLATE_ID!;
  const stateMachineArn = process.env.STATE_MACHINE_ARN!;
  const eipAllocationId = process.env.EIP_ALLOCATION_ID!;
  const maxAgeDays = 30;

  // Skip if a rotation is already in progress
  const running = await sfn.send(new ListExecutionsCommand({
    stateMachineArn,
    statusFilter: 'RUNNING',
  }));
  if ((running.executions?.length ?? 0) > 0) {
    console.log('Rotation already in progress — skipping scheduled check');
    return;
  }

  const param = await ssm.send(new GetParameterCommand({ Name: '/unifi/current-instance-id' }));
  const currentInstanceId = param.Parameter?.Value;
  if (!currentInstanceId || currentInstanceId === 'none') return;

  const describeResult = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [currentInstanceId] }));
  const launchTime = describeResult.Reservations?.[0]?.Instances?.[0]?.LaunchTime;
  if (!launchTime) return;

  const ageDays = (Date.now() - launchTime.getTime()) / (1000 * 60 * 60 * 24);
  console.log(`Instance ${currentInstanceId} is ${ageDays.toFixed(1)} days old`);

  if (ageDays < maxAgeDays) {
    console.log('Instance is fresh — no rotation needed');
    return;
  }

  console.log(`Instance is older than ${maxAgeDays} days — triggering rotation`);
  await triggerRotation({ launchTemplateId, stateMachineArn, eipAllocationId, oldInstanceId: currentInstanceId });
}

// Triggered hourly — publishes BackupFreshness metric (1 = fresh, 0 = stale)
export async function checkBackupFreshness(event: Record<string, unknown>): Promise<void> {
  const backupBucket = process.env.BACKUP_BUCKET!;
  const maxAgeHours = 25;

  const listResult = await s3.send(new ListObjectsV2Command({
    Bucket: backupBucket,
    Prefix: 'backups/',
  }));

  const backups = (listResult.Contents ?? [])
    .filter(obj => obj.Key?.endsWith('.unf'))
    .sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0));

  let freshness = 0;
  if (backups.length > 0) {
    const ageHours = (Date.now() - (backups[0].LastModified?.getTime() ?? 0)) / (1000 * 60 * 60);
    freshness = ageHours < maxAgeHours ? 1 : 0;
    console.log(`Newest backup: ${backups[0].Key}, age: ${ageHours.toFixed(1)}h, fresh: ${freshness}`);
  } else {
    console.log('No backups found in S3');
  }

  await cw.send(new PutMetricDataCommand({
    Namespace: 'UnifiController',
    MetricData: [{
      MetricName: 'BackupFreshness',
      Dimensions: [{ Name: 'Service', Value: 'unifi' }],
      Value: freshness,
      Unit: 'None',
    }],
  }));
}

// Custom Resource handler — starts the initial cutover Step Functions execution on first deploy
export async function triggerInitialCutover(event: {
  RequestType: string;
  ResourceProperties: {
    LaunchTemplateId: string;
    OldInstanceId: string;
    EipAllocationId: string;
    StateMachineArn: string;
  };
}): Promise<{ PhysicalResourceId: string }> {
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: 'initial-cutover' };
  }

  const { LaunchTemplateId, OldInstanceId, EipAllocationId, StateMachineArn } = event.ResourceProperties;

  // Read current instance from SSM at runtime — authoritative after first deploy.
  // Falls back to OldInstanceId prop (from CDK context) on first deploy when SSM doesn't exist yet.
  let oldInstanceId: string;
  try {
    const param = await ssm.send(new GetParameterCommand({ Name: '/unifi/current-instance-id' }));
    oldInstanceId = param.Parameter?.Value ?? OldInstanceId;
  } catch {
    oldInstanceId = OldInstanceId;
    await ssm.send(new PutParameterCommand({
      Name: '/unifi/current-instance-id',
      Value: oldInstanceId,
      Type: 'String',
      Description: 'The currently active Unifi EC2 instance ID',
    }));
  }

  const runResult = await ec2.send(new RunInstancesCommand({
    MinCount: 1,
    MaxCount: 1,
    LaunchTemplate: {
      LaunchTemplateId,
      Version: '$Latest',
    },
    TagSpecifications: [{
      ResourceType: 'instance',
      Tags: [
        { Key: 'Name', Value: 'unifi-controller' },
        { Key: 'Project', Value: 'unifi' },
        { Key: 'State', Value: 'pending-cutover' },
      ],
    }],
  }));

  const newInstanceId = runResult.Instances?.[0]?.InstanceId;
  if (!newInstanceId) throw new Error('Failed to launch new instance');

  await sfn.send(new StartExecutionCommand({
    stateMachineArn: StateMachineArn,
    name: `cutover-${Date.now()}`,
    input: JSON.stringify({
      newInstanceId,
      oldInstanceId,
      eipAllocationId: EipAllocationId,
    }),
  }));

  return { PhysicalResourceId: 'initial-cutover' };
}
