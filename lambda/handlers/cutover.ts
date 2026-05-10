import {
  EC2Client,
  AssociateAddressCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';

const ec2 = new EC2Client({ region: process.env.AWS_REGION });
const ssm = new SSMClient({ region: process.env.AWS_REGION });

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
    await ec2.send(new TerminateInstancesCommand({ InstanceIds: [oldInstanceId] }));
  }

  return { success: true };
}

// Terminates the new instance when health checks fail
export async function cleanup(event: { instanceId: string }): Promise<void> {
  const { instanceId } = event;
  if (instanceId && instanceId !== 'none') {
    await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
  }
}
