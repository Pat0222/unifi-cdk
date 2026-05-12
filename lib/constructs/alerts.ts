import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export interface AlertingDeps {
  adminEmail: string;
  stateMachineArn: string;
}

export interface AlertingResources {
  alertTopic: sns.Topic;
}

export function createAlerting(scope: Construct, deps: AlertingDeps): AlertingResources {
  const { adminEmail, stateMachineArn } = deps;

  const alertTopic = new sns.Topic(scope, 'CutoverAlerts', {
    topicName: 'unifi-cutover-alerts',
    displayName: 'Unifi Cutover Alerts',
  });
  alertTopic.addSubscription(new snsSubscriptions.EmailSubscription(adminEmail));

  new events.Rule(scope, 'CutoverSuccessRule', {
    description: 'Notify when Unifi cutover state machine succeeds',
    eventPattern: {
      source: ['aws.states'],
      detailType: ['Step Functions Execution Status Change'],
      detail: {
        stateMachineArn: [stateMachineArn],
        status: ['SUCCEEDED'],
      },
    },
    targets: [new targets.SnsTopic(alertTopic, {
      message: events.RuleTargetInput.fromText(
        `Unifi instance rotation SUCCEEDED. Execution: ${events.EventField.fromPath('$.detail.executionArn')}`
      ),
    })],
  });

  new events.Rule(scope, 'CutoverFailureRule', {
    description: 'Notify when Unifi cutover state machine fails',
    eventPattern: {
      source: ['aws.states'],
      detailType: ['Step Functions Execution Status Change'],
      detail: {
        stateMachineArn: [stateMachineArn],
        status: ['FAILED', 'TIMED_OUT', 'ABORTED'],
      },
    },
    targets: [new targets.SnsTopic(alertTopic, {
      message: events.RuleTargetInput.fromText(
        `Unifi instance rotation FAILED (status: ${events.EventField.fromPath('$.detail.status')}). Execution: ${events.EventField.fromPath('$.detail.executionArn')}`
      ),
    })],
  });

  return { alertTopic };
}
