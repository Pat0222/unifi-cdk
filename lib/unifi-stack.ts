import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { createStorage } from './constructs/s3';
import { createIam } from './constructs/iam';
import { createCompute } from './constructs/ec2';
import { createFunctions } from './constructs/lambda';
import { createRotation } from './constructs/step_functions';
import { createAlerting } from './constructs/alerts';
import { createMonitoring } from './constructs/monitoring';
import { createDns } from './constructs/dns';

export interface UnifiStackProps extends cdk.StackProps {
  eipAllocationId: string;
  hostedZoneId: string;
  existingInstanceId: string;
  instanceType: string;
  domain: string;
  adminEmail: string;
  vpcId: string;
  eipPublicIp: string;
  forceRotation?: boolean;
}

export class UnifiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: UnifiStackProps) {
    super(scope, id, props);

    const { eipAllocationId, hostedZoneId, existingInstanceId, domain, adminEmail, vpcId, eipPublicIp, forceRotation } = props;

    const storage = createStorage(this);
    const { instanceRole, lambdaRole } = createIam(this, { ...storage, hostedZoneId });
    const { launchTemplate } = createCompute(this, { instanceRole, ...storage, domain, adminEmail, vpcId, instanceType: props.instanceType });
    const fns = createFunctions(this, {
      lambdaRole,
      launchTemplateId: launchTemplate.launchTemplateId!,
      eipAllocationId,
      backupBucketName: storage.backupBucket.bucketName,
      apiKeySecretArn: storage.apiKeySecret.secretArn,
      domain,
    });
    const { stateMachineArn, stateMachine } = createRotation(this, {
      ...fns,
      existingInstanceId,
      eipAllocationId,
      launchTemplateId: launchTemplate.launchTemplateId!,
      forceRotation,
    });
    const { alertTopic } = createAlerting(this, { adminEmail, stateMachineArn });
    createMonitoring(this, { alertTopic, backupCheckFn: fns.backupCheckFn, networkMetricsFn: fns.networkMetricsFn, domain });
    createDns(this, { hostedZoneId, domain, eipPublicIp });

    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: stateMachineArn,
      description: 'Step Functions state machine — monitor cutover progress here',
    });
    new cdk.CfnOutput(this, 'BackupBucketName', {
      value: storage.backupBucket.bucketName,
      description: 'S3 bucket where Unifi backups are stored',
    });
    new cdk.CfnOutput(this, 'MongoSecretArn', {
      value: storage.mongoSecret.secretArn,
      description: 'Secrets Manager ARN for MongoDB password',
    });
    new cdk.CfnOutput(this, 'LaunchTemplateId', {
      value: launchTemplate.launchTemplateId!,
      description: 'Launch template used for future AMI rotations',
    });

    // Suppress unused variable warning — stateMachine referenced only for dependency declaration in step_functions.ts
    void stateMachine;
  }
}
