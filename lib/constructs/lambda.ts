import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as path from 'path';

export interface FunctionsDeps {
  lambdaRole: iam.Role;
  launchTemplateId: string;
  eipAllocationId: string;
  backupBucketName: string;
  apiKeySecretArn: string;
  domain: string;
}

export interface FunctionsResources {
  handlerFn: NodejsFunction;
  rotatorFn: NodejsFunction;
  cutoverFn: NodejsFunction;
  cleanupFn: NodejsFunction;
  triggerFn: NodejsFunction;
  scheduledRotationFn: NodejsFunction;
  backupCheckFn: NodejsFunction;
  networkMetricsFn: NodejsFunction;
}

export function createFunctions(scope: Construct, deps: FunctionsDeps): FunctionsResources {
  const { lambdaRole, launchTemplateId, eipAllocationId, backupBucketName, apiKeySecretArn, domain } = deps;

  const handlersDir = path.join(__dirname, '../../lambda/handlers');
  const commonFnProps = {
    runtime: lambda.Runtime.NODEJS_20_X,
    role: lambdaRole,
    memorySize: 256,
  };

  const handlerFn = new NodejsFunction(scope, 'Handler', {
    ...commonFnProps,
    entry: path.join(handlersDir, 'health.ts'),
    handler: 'checkHealth',
    timeout: cdk.Duration.seconds(90),
  });

  const rotatorFn = new NodejsFunction(scope, 'RotatorHandler', {
    ...commonFnProps,
    entry: path.join(handlersDir, 'rotation.ts'),
    handler: 'startRotation',
    timeout: cdk.Duration.seconds(60),
    environment: {
      LAUNCH_TEMPLATE_ID: launchTemplateId,
      EIP_ALLOCATION_ID: eipAllocationId,
    },
  });

  const cutoverFn = new NodejsFunction(scope, 'CutoverHandler', {
    ...commonFnProps,
    entry: path.join(handlersDir, 'cutover.ts'),
    handler: 'performCutover',
    timeout: cdk.Duration.seconds(60),
  });

  const cleanupFn = new NodejsFunction(scope, 'CleanupHandler', {
    ...commonFnProps,
    entry: path.join(handlersDir, 'cutover.ts'),
    handler: 'cleanup',
    timeout: cdk.Duration.seconds(30),
  });

  const triggerFn = new NodejsFunction(scope, 'TriggerHandler', {
    ...commonFnProps,
    entry: path.join(handlersDir, 'trigger.ts'),
    handler: 'triggerInitialCutover',
    timeout: cdk.Duration.seconds(60),
  });

  // STATE_MACHINE_ARN added by createRotation after the state machine is defined
  const scheduledRotationFn = new NodejsFunction(scope, 'ScheduledRotationHandler', {
    ...commonFnProps,
    entry: path.join(handlersDir, 'rotation.ts'),
    handler: 'scheduledRotationCheck',
    timeout: cdk.Duration.seconds(60),
    environment: {
      LAUNCH_TEMPLATE_ID: launchTemplateId,
      EIP_ALLOCATION_ID: eipAllocationId,
    },
  });

  const backupCheckFn = new NodejsFunction(scope, 'BackupCheckHandler', {
    ...commonFnProps,
    entry: path.join(handlersDir, 'backup.ts'),
    handler: 'checkBackupFreshness',
    timeout: cdk.Duration.seconds(30),
    environment: {
      BACKUP_BUCKET: backupBucketName,
    },
  });

  const networkMetricsFn = new NodejsFunction(scope, 'NetworkMetricsHandler', {
    ...commonFnProps,
    entry: path.join(handlersDir, 'network-metrics.ts'),
    handler: 'publishNetworkMetrics',
    timeout: cdk.Duration.seconds(60),
    environment: {
      API_KEY_SECRET_ARN: apiKeySecretArn,
      CONTROLLER_DOMAIN: domain,
    },
  });

  return { handlerFn, rotatorFn, cutoverFn, cleanupFn, triggerFn, scheduledRotationFn, backupCheckFn, networkMetricsFn };
}
