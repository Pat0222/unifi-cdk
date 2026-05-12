import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface IamDeps {
  backupBucket: s3.Bucket;
  mongoSecret: secretsmanager.Secret;
  apiKeySecret: secretsmanager.ISecret;
  hostedZoneId: string;
}

export interface IamResources {
  instanceRole: iam.Role;
  lambdaRole: iam.Role;
}

export function createIam(scope: Construct, deps: IamDeps): IamResources {
  const stack = cdk.Stack.of(scope);
  const { backupBucket, mongoSecret, apiKeySecret, hostedZoneId } = deps;

  const instanceRole = new iam.Role(scope, 'InstanceRole', {
    assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    managedPolicies: [
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
    ],
  });

  backupBucket.grantReadWrite(instanceRole);
  mongoSecret.grantRead(instanceRole);
  apiKeySecret.grantRead(instanceRole);

  instanceRole.addToPolicy(new iam.PolicyStatement({
    actions: ['route53:ListHostedZones', 'route53:GetChange', 'route53:ChangeResourceRecordSets'],
    resources: [
      `arn:aws:route53:::hostedzone/${hostedZoneId}`,
      'arn:aws:route53:::change/*',
      'arn:aws:route53:::hostedzone',
    ],
  }));
  instanceRole.addToPolicy(new iam.PolicyStatement({
    actions: ['route53:ListHostedZones', 'route53:GetChange'],
    resources: ['*'],
  }));
  instanceRole.addToPolicy(new iam.PolicyStatement({
    actions: ['ssm:PutParameter'],
    resources: [`arn:aws:ssm:${stack.region}:${stack.account}:parameter/unifi/*`],
  }));

  const lambdaRole = new iam.Role(scope, 'HandlerRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    managedPolicies: [
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    ],
  });

  lambdaRole.addToPolicy(new iam.PolicyStatement({
    actions: [
      'ec2:DescribeInstances', 'ec2:DescribeInstanceStatus', 'ec2:RunInstances',
      'ec2:TerminateInstances', 'ec2:AssociateAddress', 'ec2:DescribeAddresses',
      'ec2:DescribeLaunchTemplateVersions', 'ec2:CreateTags',
    ],
    resources: ['*'],
  }));
  lambdaRole.addToPolicy(new iam.PolicyStatement({
    actions: ['ssm:GetParameter', 'ssm:PutParameter'],
    resources: [`arn:aws:ssm:${stack.region}:${stack.account}:parameter/unifi/*`],
  }));
  lambdaRole.addToPolicy(new iam.PolicyStatement({
    actions: ['states:StartExecution', 'states:ListExecutions'],
    resources: ['*'],
  }));
  lambdaRole.addToPolicy(new iam.PolicyStatement({
    actions: ['s3:ListBucket', 's3:GetObject'],
    resources: [backupBucket.bucketArn, `${backupBucket.bucketArn}/*`],
  }));
  lambdaRole.addToPolicy(new iam.PolicyStatement({
    actions: ['cloudwatch:PutMetricData'],
    resources: ['*'],
  }));
  lambdaRole.addToPolicy(new iam.PolicyStatement({
    actions: ['iam:PassRole'],
    resources: [instanceRole.roleArn],
  }));

  apiKeySecret.grantRead(lambdaRole);

  return { instanceRole, lambdaRole };
}
