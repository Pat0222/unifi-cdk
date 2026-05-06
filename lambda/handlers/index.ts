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
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import * as https from 'https';
import * as http from 'http';

const ec2 = new EC2Client({ region: process.env.AWS_REGION });
const ssm = new SSMClient({ region: process.env.AWS_REGION });
const sfn = new SFNClient({ region: process.env.AWS_REGION });

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
// Creates a new instance and kicks off the Step Functions cutover workflow
export async function startRotation(event: Record<string, unknown>): Promise<void> {
  const launchTemplateId = process.env.LAUNCH_TEMPLATE_ID!;
  const stateMachineArn = process.env.STATE_MACHINE_ARN!;
  const eipAllocationId = process.env.EIP_ALLOCATION_ID!;

  const currentInstanceParam = await ssm.send(new GetParameterCommand({
    Name: '/unifi/current-instance-id',
  }));
  const oldInstanceId = currentInstanceParam.Parameter?.Value ?? 'none';

  const ltVersions = await ec2.send(new DescribeLaunchTemplateVersionsCommand({
    LaunchTemplateId: launchTemplateId,
    Versions: ['$Latest'],
  }));
  const ltVersion = ltVersions.LaunchTemplateVersions?.[0]?.VersionNumber?.toString() ?? '$Latest';

  const runResult = await ec2.send(new RunInstancesCommand({
    MinCount: 1,
    MaxCount: 1,
    LaunchTemplate: {
      LaunchTemplateId: launchTemplateId,
      Version: ltVersion,
    },
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
    input: JSON.stringify({
      newInstanceId,
      oldInstanceId,
      eipAllocationId,
    }),
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
      oldInstanceId: OldInstanceId,
      eipAllocationId: EipAllocationId,
    }),
  }));

  return { PhysicalResourceId: 'initial-cutover' };
}
