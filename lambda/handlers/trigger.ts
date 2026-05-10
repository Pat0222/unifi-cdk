import { EC2Client, RunInstancesCommand } from '@aws-sdk/client-ec2';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';

const ec2 = new EC2Client({ region: process.env.AWS_REGION });
const ssm = new SSMClient({ region: process.env.AWS_REGION });
const sfn = new SFNClient({ region: process.env.AWS_REGION });

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
    LaunchTemplate: { LaunchTemplateId, Version: '$Latest' },
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
    input: JSON.stringify({ newInstanceId, oldInstanceId, eipAllocationId: EipAllocationId }),
  }));

  return { PhysicalResourceId: 'initial-cutover' };
}
