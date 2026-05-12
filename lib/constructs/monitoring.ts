import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ce from 'aws-cdk-lib/aws-ce';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as sns from 'aws-cdk-lib/aws-sns';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

const DISK_ALARM_THRESHOLD_PCT   = 80;
const MEMORY_ALARM_THRESHOLD_PCT = 85;
const BILLING_ALARM_USD          = 25;
const COST_ANOMALY_USD           = 10;
const HC_FAILURE_THRESHOLD       = 3;
const HC_REQUEST_INTERVAL_SECS   = 30;

export interface MonitoringDeps {
  alertTopic: sns.Topic;
  backupCheckFn: NodejsFunction;
  networkMetricsFn: NodejsFunction;
  domain: string;
}

export function createMonitoring(scope: Construct, deps: MonitoringDeps): void {
  const { alertTopic, backupCheckFn, networkMetricsFn, domain } = deps;

  const snsAction = new cloudwatchActions.SnsAction(alertTopic);

  const diskAlarm = new cloudwatch.Alarm(scope, 'DiskUsageAlarm', {
    metric: new cloudwatch.Metric({
      namespace: 'UnifiController',
      metricName: 'disk_used_percent',
      dimensionsMap: { Service: 'unifi' },
      statistic: 'Average',
      period: cdk.Duration.minutes(5),
    }),
    threshold: DISK_ALARM_THRESHOLD_PCT,
    evaluationPeriods: 2,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    alarmDescription: `Unifi controller disk usage on / exceeded ${DISK_ALARM_THRESHOLD_PCT}%`,
    alarmName: 'unifi-disk-usage',
  });
  diskAlarm.addAlarmAction(snsAction);
  diskAlarm.addOkAction(snsAction);

  const memAlarm = new cloudwatch.Alarm(scope, 'MemUsageAlarm', {
    metric: new cloudwatch.Metric({
      namespace: 'UnifiController',
      metricName: 'mem_used_percent',
      dimensionsMap: { Service: 'unifi' },
      statistic: 'Average',
      period: cdk.Duration.minutes(5),
    }),
    threshold: MEMORY_ALARM_THRESHOLD_PCT,
    evaluationPeriods: 2,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    alarmDescription: `Unifi controller memory usage exceeded ${MEMORY_ALARM_THRESHOLD_PCT}%`,
    alarmName: 'unifi-memory-usage',
  });
  memAlarm.addAlarmAction(snsAction);
  memAlarm.addOkAction(snsAction);

  const r53HealthCheck = new route53.CfnHealthCheck(scope, 'UnifiHealthCheck', {
    healthCheckConfig: {
      type: 'HTTPS',
      fullyQualifiedDomainName: domain,
      port: 443,
      resourcePath: '/',
      requestInterval: HC_REQUEST_INTERVAL_SECS,
      failureThreshold: HC_FAILURE_THRESHOLD,
      enableSni: true,
    },
    healthCheckTags: [{ key: 'Name', value: 'unifi-controller' }],
  });

  const healthCheckAlarm = new cloudwatch.Alarm(scope, 'UnifiHealthCheckAlarm', {
    metric: new cloudwatch.Metric({
      namespace: 'AWS/Route53',
      metricName: 'HealthCheckStatus',
      dimensionsMap: { HealthCheckId: r53HealthCheck.attrHealthCheckId },
      statistic: 'Minimum',
      period: cdk.Duration.minutes(1),
    }),
    threshold: 1,
    evaluationPeriods: HC_FAILURE_THRESHOLD,
    comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    alarmDescription: `${domain} is failing Route 53 health checks`,
    alarmName: 'unifi-health-check',
  });
  healthCheckAlarm.addAlarmAction(snsAction);
  healthCheckAlarm.addOkAction(snsAction);

  const backupFreshnessAlarm = new cloudwatch.Alarm(scope, 'BackupFreshnessAlarm', {
    metric: new cloudwatch.Metric({
      namespace: 'UnifiController',
      metricName: 'BackupFreshness',
      dimensionsMap: { Service: 'unifi' },
      statistic: 'Minimum',
      period: cdk.Duration.hours(1),
    }),
    threshold: 1,
    evaluationPeriods: 2,
    comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    alarmDescription: 'No Unifi backup in S3 newer than 25 hours',
    alarmName: 'unifi-backup-freshness',
  });
  backupFreshnessAlarm.addAlarmAction(snsAction);
  backupFreshnessAlarm.addOkAction(snsAction);

  const billingAlarm = new cloudwatch.Alarm(scope, 'BillingAlarm', {
    metric: new cloudwatch.Metric({
      namespace: 'AWS/Billing',
      metricName: 'EstimatedCharges',
      dimensionsMap: { Currency: 'USD' },
      statistic: 'Maximum',
      period: cdk.Duration.hours(6),
    }),
    threshold: BILLING_ALARM_USD,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    alarmName: 'unifi-monthly-cost',
    alarmDescription: `Estimated monthly AWS charges exceeded $${BILLING_ALARM_USD}`,
  });
  billingAlarm.addAlarmAction(snsAction);

  alertTopic.addToResourcePolicy(new iam.PolicyStatement({
    principals: [new iam.ServicePrincipal('costalerts.amazonaws.com')],
    actions: ['sns:Publish'],
    resources: [alertTopic.topicArn],
  }));

  const anomalyMonitor = new ce.CfnAnomalyMonitor(scope, 'CostAnomalyMonitor', {
    monitorName: 'unifi-cost-monitor',
    monitorType: 'DIMENSIONAL',
    monitorDimension: 'SERVICE',
  });

  new ce.CfnAnomalySubscription(scope, 'CostAnomalySubscription', {
    subscriptionName: 'unifi-cost-alerts',
    monitorArnList: [anomalyMonitor.attrMonitorArn],
    subscribers: [{ address: alertTopic.topicArn, type: 'SNS' }],
    threshold: COST_ANOMALY_USD,
    frequency: 'IMMEDIATE',
  });

  new logs.LogGroup(scope, 'UserDataLogs', {
    logGroupName: '/unifi/user-data',
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  new logs.LogGroup(scope, 'NginxErrorLogs', {
    logGroupName: '/unifi/nginx-error',
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  new events.Rule(scope, 'BackupCheckRule', {
    description: 'Check Unifi backup freshness in S3 every hour',
    schedule: events.Schedule.rate(cdk.Duration.hours(1)),
    targets: [new targets.LambdaFunction(backupCheckFn)],
  });

  new events.Rule(scope, 'NetworkMetricsRule', {
    description: 'Publish UniFi network metrics to CloudWatch every hour',
    schedule: events.Schedule.rate(cdk.Duration.hours(1)),
    targets: [new targets.LambdaFunction(networkMetricsFn)],
  });

  new cloudwatch.Dashboard(scope, 'UnifiDashboard', {
    dashboardName: 'unifi-controller',
    widgets: [
      [
        new cloudwatch.GraphWidget({
          title: 'Disk Usage %',
          left: [new cloudwatch.Metric({
            namespace: 'UnifiController',
            metricName: 'disk_used_percent',
            dimensionsMap: { Service: 'unifi' },
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
          })],
          leftYAxis: { min: 0, max: 100 },
          width: 12,
        }),
        new cloudwatch.GraphWidget({
          title: 'Memory Usage %',
          left: [new cloudwatch.Metric({
            namespace: 'UnifiController',
            metricName: 'mem_used_percent',
            dimensionsMap: { Service: 'unifi' },
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
          })],
          leftYAxis: { min: 0, max: 100 },
          width: 12,
        }),
      ],
      [
        new cloudwatch.GraphWidget({
          title: 'Route 53 Health Check',
          left: [new cloudwatch.Metric({
            namespace: 'AWS/Route53',
            metricName: 'HealthCheckStatus',
            dimensionsMap: { HealthCheckId: r53HealthCheck.attrHealthCheckId },
            statistic: 'Minimum',
            period: cdk.Duration.minutes(1),
          })],
          leftYAxis: { min: 0, max: 1 },
          width: 12,
        }),
        new cloudwatch.GraphWidget({
          title: 'Backup Freshness',
          left: [new cloudwatch.Metric({
            namespace: 'UnifiController',
            metricName: 'BackupFreshness',
            dimensionsMap: { Service: 'unifi' },
            statistic: 'Minimum',
            period: cdk.Duration.hours(1),
          })],
          leftYAxis: { min: 0, max: 1 },
          width: 12,
        }),
      ],
      [
        new cloudwatch.GraphWidget({
          title: 'Connected Clients by Site',
          left: [new cloudwatch.MathExpression({
            expression: 'SEARCH(\'{UnifiController,Site} MetricName="ConnectedClients"\', \'Sum\', 3600)',
            label: '',
            period: cdk.Duration.hours(1),
          })],
          leftYAxis: { min: 0 },
          width: 12,
        }),
        new cloudwatch.GraphWidget({
          title: 'WAN Throughput by Site',
          left: [new cloudwatch.MathExpression({
            expression: 'SEARCH(\'{UnifiController,Site} MetricName="WanRxBytesPerSec"\', \'Sum\', 3600)',
            label: 'Download',
            period: cdk.Duration.hours(1),
          })],
          right: [new cloudwatch.MathExpression({
            expression: 'SEARCH(\'{UnifiController,Site} MetricName="WanTxBytesPerSec"\', \'Sum\', 3600)',
            label: 'Upload',
            period: cdk.Duration.hours(1),
          })],
          leftYAxis: { min: 0, label: 'Download (B/s)', showUnits: false },
          rightYAxis: { min: 0, label: 'Upload (B/s)', showUnits: false },
          width: 12,
        }),
      ],
      [
        new cloudwatch.AlarmStatusWidget({
          title: 'Alarm Status',
          alarms: [diskAlarm, memAlarm, healthCheckAlarm, backupFreshnessAlarm],
          width: 24,
        }),
      ],
    ],
  });
}
