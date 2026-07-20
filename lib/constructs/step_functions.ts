import * as cdk from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { FunctionsResources } from './lambda';

export interface RotationDeps extends FunctionsResources {
  existingInstanceId: string;
  eipAllocationId: string;
  launchTemplateId: string;
  forceRotation?: boolean;
}

export interface RotationResources {
  stateMachineArn: string;
  stateMachine: sfn.StateMachine;
}

export function createRotation(scope: Construct, deps: RotationDeps): RotationResources {
  const stack = cdk.Stack.of(scope);
  const {
    handlerFn, rotatorFn, cutoverFn, cleanupFn, triggerFn, scheduledRotationFn,
    existingInstanceId, eipAllocationId, launchTemplateId, forceRotation,
  } = deps;

  const checkHealthTask = new tasks.LambdaInvoke(scope, 'CheckHealth', {
    lambdaFunction: handlerFn,
    payload: sfn.TaskInput.fromObject({
      instanceId: sfn.JsonPath.stringAt('$.newInstanceId'),
    }),
    resultPath: '$.healthResult',
  });
  checkHealthTask.addRetry({
    errors: ['HealthCheckFailed', 'Lambda.ServiceException', 'Lambda.AWSLambdaException', 'Lambda.TooManyRequestsException'],
    interval: cdk.Duration.minutes(2),
    maxAttempts: 30,
    backoffRate: 1.0,
  });

  const cutoverTask = new tasks.LambdaInvoke(scope, 'PerformCutover', {
    lambdaFunction: cutoverFn,
    payload: sfn.TaskInput.fromObject({
      newInstanceId: sfn.JsonPath.stringAt('$.newInstanceId'),
      oldInstanceId: sfn.JsonPath.stringAt('$.oldInstanceId'),
      eipAllocationId: sfn.JsonPath.stringAt('$.eipAllocationId'),
    }),
    resultPath: '$.cutoverResult',
  });
  cutoverTask.addRetry({
    errors: ['Lambda.ServiceException', 'Lambda.AWSLambdaException', 'Lambda.TooManyRequestsException'],
    interval: cdk.Duration.seconds(30),
    maxAttempts: 3,
    backoffRate: 2.0,
  });

  const failState = new sfn.Fail(scope, 'CutoverFailed', {
    error: 'CutoverFailed',
    cause: 'Health checks did not pass within the allowed time',
  });

  const cleanupTask = new tasks.LambdaInvoke(scope, 'CleanupOnFailure', {
    lambdaFunction: cleanupFn,
    payload: sfn.TaskInput.fromObject({
      instanceId: sfn.JsonPath.stringAt('$.newInstanceId'),
    }),
  });
  cleanupTask.next(failState);

  const definition = checkHealthTask.next(cutoverTask);

  checkHealthTask.addCatch(cleanupTask, {
    errors: ['States.ALL'],
    resultPath: '$.error',
  });

  const logGroup = new logs.LogGroup(scope, 'StateMachineLogs', {
    logGroupName: '/aws/states/unifi-cutover',
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  const stateMachineName = 'unifi-cutover';
  // Build ARN without referencing the state machine resource — breaks the dependency cycle
  const stateMachineArn = `arn:aws:states:${stack.region}:${stack.account}:stateMachine:${stateMachineName}`;

  const stateMachine = new sfn.StateMachine(scope, 'CutoverStateMachine', {
    stateMachineName,
    definitionBody: sfn.DefinitionBody.fromChainable(definition),
    timeout: cdk.Duration.hours(2),
    stateMachineType: sfn.StateMachineType.STANDARD,
    logs: {
      destination: logGroup,
      level: sfn.LogLevel.ERROR,
    },
  });

  rotatorFn.addEnvironment('STATE_MACHINE_ARN', stateMachineArn);
  scheduledRotationFn.addEnvironment('STATE_MACHINE_ARN', stateMachineArn);

  new events.Rule(scope, 'NewAmiRule', {
    description: 'Trigger Unifi instance rotation when a new AL2023 AMI is published',
    eventPattern: {
      source: ['aws.ssm'],
      detailType: ['Parameter Store Change'],
      detail: {
        name: ['/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64'],
        operation: ['Update'],
      },
    },
    targets: [new targets.LambdaFunction(rotatorFn)],
  });

  new events.Rule(scope, 'ScheduledRotationRule', {
    description: 'Rotate Unifi instance if it has not rotated in the past 30 days',
    schedule: events.Schedule.cron({ weekDay: 'MON', hour: '3', minute: '0' }),
    targets: [new targets.LambdaFunction(scheduledRotationFn)],
  });

  const customResourceProvider = new cr.Provider(scope, 'CutoverProvider', {
    onEventHandler: triggerFn,
  });

  const initialCutover = new cdk.CustomResource(scope, 'InitialCutover', {
    serviceToken: customResourceProvider.serviceToken,
    properties: {
      LaunchTemplateId: launchTemplateId,
      OldInstanceId: existingInstanceId,
      EipAllocationId: eipAllocationId,
      StateMachineArn: stateMachineArn,
      DeployTimestamp: forceRotation ? new Date().toISOString() : 'stable',
    },
  });
  // State machine ARN is a plain string (not a Ref) so CloudFormation won't
  // infer the dependency automatically — declare it explicitly.
  initialCutover.node.addDependency(stateMachine);

  return { stateMachineArn, stateMachine };
}
