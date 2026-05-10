import {
  EC2Client,
  RunInstancesCommand,
  DescribeInstancesCommand,
  DescribeLaunchTemplateVersionsCommand,
} from '@aws-sdk/client-ec2';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SFNClient, StartExecutionCommand, ListExecutionsCommand } from '@aws-sdk/client-sfn';

const ec2 = new EC2Client({ region: process.env.AWS_REGION });
const ssm = new SSMClient({ region: process.env.AWS_REGION });
const sfn = new SFNClient({ region: process.env.AWS_REGION });

const MAX_INSTANCE_AGE_DAYS = 30;

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

// Triggered by EventBridge when a new AL2023 AMI is published
export async function startRotation(event: Record<string, unknown>): Promise<void> {
  const launchTemplateId = process.env.LAUNCH_TEMPLATE_ID!;
  const stateMachineArn = process.env.STATE_MACHINE_ARN!;
  const eipAllocationId = process.env.EIP_ALLOCATION_ID!;

  const param = await ssm.send(new GetParameterCommand({ Name: '/unifi/current-instance-id' }));
  const oldInstanceId = param.Parameter?.Value ?? 'none';

  await triggerRotation({ launchTemplateId, stateMachineArn, eipAllocationId, oldInstanceId });
}

// Triggered weekly — rotates only if the current instance is older than MAX_INSTANCE_AGE_DAYS
export async function scheduledRotationCheck(event: Record<string, unknown>): Promise<void> {
  const launchTemplateId = process.env.LAUNCH_TEMPLATE_ID!;
  const stateMachineArn = process.env.STATE_MACHINE_ARN!;
  const eipAllocationId = process.env.EIP_ALLOCATION_ID!;

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

  if (ageDays < MAX_INSTANCE_AGE_DAYS) {
    console.log('Instance is fresh — no rotation needed');
    return;
  }

  console.log(`Instance is older than ${MAX_INSTANCE_AGE_DAYS} days — triggering rotation`);
  await triggerRotation({ launchTemplateId, stateMachineArn, eipAllocationId, oldInstanceId: currentInstanceId });
}
