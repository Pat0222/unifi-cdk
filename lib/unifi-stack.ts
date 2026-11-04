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
import { createLogArchive } from './constructs/logs';

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
  /** Days to keep archived logs (default 730). */
  logRetentionDays?: number;
  /** Per-query Athena scan limit in GB (default 1). */
  athenaBytesScannedLimitGb?: number;
}

export class UnifiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: UnifiStackProps) {
    super(scope, id, props);

    const { eipAllocationId, hostedZoneId, existingInstanceId, domain, adminEmail, vpcId, eipPublicIp, forceRotation } = props;

    const storage = createStorage(this);
    const { instanceRole, lambdaRole } = createIam(this, { ...storage, hostedZoneId });
    const logs = createLogArchive(this, {
      instanceRole,
      retentionDays: props.logRetentionDays ?? 730,
      bytesScannedLimitGb: props.athenaBytesScannedLimitGb ?? 1,
    });
    const { launchTemplate } = createCompute(this, {
      instanceRole, ...storage, logBucket: logs.logBucket, domain, adminEmail, vpcId, instanceType: props.instanceType,
    });
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

    new cdk.CfnOutput(this, 'LogBucketName', {
      value: logs.logBucket.bucketName,
      description: 'S3 bucket for archived UniFi logs',
    });
    new cdk.CfnOutput(this, 'LogRegion', {
      value: this.region,
      description: 'Region of the log bucket (the add-on\'s "region" option)',
    });
    new cdk.CfnOutput(this, 'LogShipperTrustAnchorArn', {
      value: logs.trustAnchor.attrTrustAnchorArn,
      description: 'IAM Roles Anywhere trust anchor (the add-on\'s "trust_anchor_arn" option)',
    });
    new cdk.CfnOutput(this, 'LogShipperProfileArn', {
      value: logs.shipperProfile.attrProfileArn,
      description: 'IAM Roles Anywhere profile (the add-on\'s "profile_arn" option)',
    });
    new cdk.CfnOutput(this, 'LogShipperRoleArn', {
      value: logs.shipperRole.roleArn,
      description: 'Role the add-on assumes (the add-on\'s "role_arn" option)',
    });
    new cdk.CfnOutput(this, 'AthenaWorkgroupName', {
      value: logs.workgroup.name,
      description: 'Athena workgroup holding the saved log queries',
    });

    // Suppress unused variable warning — stateMachine referenced only for dependency declaration in step_functions.ts
    void stateMachine;
  }
}
