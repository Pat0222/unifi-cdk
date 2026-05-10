import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

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
    const region = this.region;

    // ── S3 backup bucket ──────────────────────────────────────────────────────
    const backupBucket = new s3.Bucket(this, 'UnifiBackups', {
      bucketName: `unifi-backups-${this.account}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [{
        id: 'expire-old-backups',
        expiration: cdk.Duration.days(30),
        noncurrentVersionExpiration: cdk.Duration.days(7),
      }],
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── MongoDB password secret ───────────────────────────────────────────────
    const mongoSecret = new secretsmanager.Secret(this, 'MongoPassword', {
      secretName: `unifi/mongodb-password-${this.account}`,
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── Unifi API key (pre-created in Secrets Manager) ────────────────────────
    const apiKeySecret = secretsmanager.Secret.fromSecretNameV2(this, 'UnifiApiKey', 'unifi/api-key');

    // /unifi/current-instance-id is created by triggerInitialCutover on first deploy
    // and updated by performCutover after each rotation — not managed by CloudFormation

    // ── IAM role for EC2 instance ─────────────────────────────────────────────
    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });

    backupBucket.grantReadWrite(instanceRole);
    mongoSecret.grantRead(instanceRole);
    apiKeySecret.grantRead(instanceRole);

    // Route 53 permissions for Certbot DNS-01 challenge
    instanceRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'route53:ListHostedZones',
        'route53:GetChange',
        'route53:ChangeResourceRecordSets',
      ],
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

    // SSM parameter update permission (signals readiness)
    instanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:PutParameter'],
      resources: [`arn:aws:ssm:${region}:${this.account}:parameter/unifi/*`],
    }));

    // ── Security group ────────────────────────────────────────────────────────
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'DefaultVpc', {
      vpcId,
      availabilityZones: [`${this.region}a`, `${this.region}b`, `${this.region}c`],
    });

    const sg = new ec2.SecurityGroup(this, 'UnifiSG', {
      vpc,
      description: 'Unifi controller security group',
      allowAllOutbound: true,
    });

    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP (redirect to HTTPS)');
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS (nginx to Unifi)');
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8080), 'Unifi device inform');
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8443), 'Unifi HTTPS');
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(3478), 'Unifi STUN');
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(10001), 'Unifi AP discovery');
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(6789), 'Unifi speed test');

    // ── Latest AL2023 AMI ─────────────────────────────────────────────────────
    const al2023Ami = ec2.MachineImage.latestAmazonLinux2023({
      cpuType: ec2.AmazonLinuxCpuType.X86_64,
    });

    // ── User data script ──────────────────────────────────────────────────────
    const rawUserData = fs.readFileSync(
      path.join(__dirname, 'scripts', 'user-data.sh'),
      'utf8'
    );
    const renderedUserData = rawUserData
      .replace(/\$\{DOMAIN\}/g, domain)
      .replace(/\$\{ADMIN_EMAIL\}/g, adminEmail)
      .replace(/\$\{BACKUP_BUCKET\}/g, backupBucket.bucketName)
      .replace(/\$\{REGION\}/g, region)
      .replace(/\$\{MONGO_SECRET_ARN\}/g, mongoSecret.secretArn)
      .replace(/\$\{API_KEY_SECRET_ARN\}/g, apiKeySecret.secretArn);

    const userData = ec2.UserData.forLinux();
    userData.addCommands(renderedUserData);

    // ── Launch template ───────────────────────────────────────────────────────
    const launchTemplate = new ec2.LaunchTemplate(this, 'UnifiLaunchTemplate', {
      launchTemplateName: 'unifi-controller',
      instanceType: new ec2.InstanceType(props.instanceType),
      machineImage: al2023Ami,
      role: instanceRole,
      securityGroup: sg,
      userData,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(30, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          encrypted: true,
          deleteOnTermination: true,
        }),
      }],
      requireImdsv2: true,
    });

    // ── Lambda execution role ─────────────────────────────────────────────────
    const lambdaRole = new iam.Role(this, 'HandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ec2:DescribeInstances',
        'ec2:DescribeInstanceStatus',
        'ec2:RunInstances',
        'ec2:TerminateInstances',
        'ec2:AssociateAddress',
        'ec2:DescribeAddresses',
        'ec2:DescribeLaunchTemplateVersions',
        'ec2:CreateTags',
      ],
      resources: ['*'],
    }));

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:PutParameter'],
      resources: [`arn:aws:ssm:${region}:${this.account}:parameter/unifi/*`],
    }));

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['states:StartExecution'],
      resources: ['*'],
    }));

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [instanceRole.roleArn],
    }));

    const entryPath = path.join(__dirname, '../lambda/handlers/index.ts');
    const commonFnProps = {
      runtime: lambda.Runtime.NODEJS_20_X,
      role: lambdaRole,
      memorySize: 256,
      entry: entryPath,
    };

    // ── Lambda functions (esbuild bundling, no Docker required) ───────────────
    const handlerFn = new NodejsFunction(this, 'Handler', {
      ...commonFnProps,
      handler: 'checkHealth',
      timeout: cdk.Duration.seconds(30),
      environment: {
        LAUNCH_TEMPLATE_ID: launchTemplate.launchTemplateId!,
        EIP_ALLOCATION_ID: eipAllocationId,
      },
    });

    const rotatorFn = new NodejsFunction(this, 'RotatorHandler', {
      ...commonFnProps,
      handler: 'startRotation',
      timeout: cdk.Duration.seconds(60),
      environment: {
        LAUNCH_TEMPLATE_ID: launchTemplate.launchTemplateId!,
        EIP_ALLOCATION_ID: eipAllocationId,
      },
    });

    const cutoverFn = new NodejsFunction(this, 'CutoverHandler', {
      ...commonFnProps,
      handler: 'performCutover',
      timeout: cdk.Duration.seconds(60),
    });

    const cleanupFn = new NodejsFunction(this, 'CleanupHandler', {
      ...commonFnProps,
      handler: 'cleanup',
      timeout: cdk.Duration.seconds(30),
    });

    const triggerFn = new NodejsFunction(this, 'TriggerHandler', {
      ...commonFnProps,
      handler: 'triggerInitialCutover',
      timeout: cdk.Duration.seconds(30),
    });

    // ── Step Functions state machine ──────────────────────────────────────────

    // Check EC2 + Unifi health
    const checkHealthTask = new tasks.LambdaInvoke(this, 'CheckHealth', {
      lambdaFunction: handlerFn,
      payload: sfn.TaskInput.fromObject({
        instanceId: sfn.JsonPath.stringAt('$.newInstanceId'),
      }),
      resultPath: '$.healthResult',
    });
    checkHealthTask.addRetry({
      errors: ['HealthCheckFailed', 'Lambda.ServiceException'],
      interval: cdk.Duration.minutes(2),
      maxAttempts: 30,
      backoffRate: 1.0,
    });

    // Perform EIP cutover + terminate old instance
    const cutoverTask = new tasks.LambdaInvoke(this, 'PerformCutover', {
      lambdaFunction: cutoverFn,
      payload: sfn.TaskInput.fromObject({
        newInstanceId: sfn.JsonPath.stringAt('$.newInstanceId'),
        oldInstanceId: sfn.JsonPath.stringAt('$.oldInstanceId'),
        eipAllocationId: sfn.JsonPath.stringAt('$.eipAllocationId'),
      }),
      resultPath: '$.cutoverResult',
    });

    const failState = new sfn.Fail(this, 'CutoverFailed', {
      error: 'CutoverFailed',
      cause: 'Health checks did not pass within the allowed time',
    });

    const cleanupTask = new tasks.LambdaInvoke(this, 'CleanupOnFailure', {
      lambdaFunction: cleanupFn,
      payload: sfn.TaskInput.fromObject({
        instanceId: sfn.JsonPath.stringAt('$.newInstanceId'),
      }),
    });
    cleanupTask.next(failState);

    const definition = new sfn.Wait(this, 'WaitForBoot', {
      time: sfn.WaitTime.duration(cdk.Duration.minutes(5)),
    })
      .next(checkHealthTask)
      .next(cutoverTask);

    checkHealthTask.addCatch(cleanupTask, {
      errors: ['States.ALL'],
      resultPath: '$.error',
    });

    const logGroup = new logs.LogGroup(this, 'StateMachineLogs', {
      logGroupName: '/aws/states/unifi-cutover',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const stateMachineName = 'unifi-cutover';
    // Build ARN without referencing the state machine resource — breaks the dependency cycle
    const stateMachineArn = `arn:aws:states:${this.region}:${this.account}:stateMachine:${stateMachineName}`;

    const stateMachine = new sfn.StateMachine(this, 'CutoverStateMachine', {
      stateMachineName,
      definition,
      timeout: cdk.Duration.hours(2),
      stateMachineType: sfn.StateMachineType.STANDARD,
      logs: {
        destination: logGroup,
        level: sfn.LogLevel.ERROR,
      },
    });

    // states:StartExecution on * is already in lambdaRole policy above — no grant needed here
    rotatorFn.addEnvironment('STATE_MACHINE_ARN', stateMachineArn);

    // ── EventBridge rule: new AL2023 AMI published ────────────────────────────
    // SSM publishes a new parameter version when a new AMI is available
    new events.Rule(this, 'NewAmiRule', {
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

    // ── SNS alerting for cutover success/failure ──────────────────────────────
    const alertTopic = new sns.Topic(this, 'CutoverAlerts', {
      topicName: 'unifi-cutover-alerts',
      displayName: 'Unifi Cutover Alerts',
    });
    alertTopic.addSubscription(new snsSubscriptions.EmailSubscription(adminEmail));

    new events.Rule(this, 'CutoverSuccessRule', {
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

    new events.Rule(this, 'CutoverFailureRule', {
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

    // ── CloudWatch disk usage alarm ───────────────────────────────────────────
    // CWAgent publishes under Service=unifi (no InstanceId), so the alarm
    // survives instance rotation without any updates
    const diskAlarm = new cloudwatch.Alarm(this, 'DiskUsageAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'UnifiController',
        metricName: 'disk_used_percent',
        dimensionsMap: { Service: 'unifi' },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 80,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Unifi controller disk usage on / exceeded 80%',
      alarmName: 'unifi-disk-usage',
    });
    diskAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));

    // ── Route 53 health check ─────────────────────────────────────────────────
    const r53HealthCheck = new route53.CfnHealthCheck(this, 'UnifiHealthCheck', {
      healthCheckConfig: {
        type: 'HTTPS',
        fullyQualifiedDomainName: domain,
        port: 443,
        resourcePath: '/',
        requestInterval: 30,
        failureThreshold: 3,
        enableSni: true,
      },
      healthCheckTags: [{ key: 'Name', value: 'unifi-controller' }],
    });

    // Route 53 health check metrics are always in us-east-1 (same as our stack)
    const healthCheckAlarm = new cloudwatch.Alarm(this, 'UnifiHealthCheckAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Route53',
        metricName: 'HealthCheckStatus',
        dimensionsMap: { HealthCheckId: r53HealthCheck.attrHealthCheckId },
        statistic: 'Minimum',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription: `${domain} is failing Route 53 health checks`,
      alarmName: 'unifi-health-check',
    });
    healthCheckAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));

    // ── Custom Resource: kick off initial cutover on first deploy ─────────────
    const customResourceProvider = new cr.Provider(this, 'CutoverProvider', {
      onEventHandler: triggerFn,
    });

    const initialCutover = new cdk.CustomResource(this, 'InitialCutover', {
      serviceToken: customResourceProvider.serviceToken,
      properties: {
        LaunchTemplateId: launchTemplate.launchTemplateId,
        OldInstanceId: existingInstanceId,
        EipAllocationId: eipAllocationId,
        StateMachineArn: stateMachineArn,
        // Only changes when --context forceRotation=true, preventing rotation on every deploy
        DeployTimestamp: forceRotation ? new Date().toISOString() : 'stable',
      },
    });
    // State machine ARN is a plain string (not a Ref) so CloudFormation won't
    // infer the dependency automatically — declare it explicitly.
    initialCutover.node.addDependency(stateMachine);

    // ── Route 53 A record ─────────────────────────────────────────────────────
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId,
      zoneName: domain,
    });

    new route53.ARecord(this, 'UnifiARecord', {
      zone: hostedZone,
      recordName: domain,
      target: route53.RecordTarget.fromIpAddresses(eipPublicIp),
      ttl: cdk.Duration.minutes(5),
    });

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: stateMachineArn,
      description: 'Step Functions state machine — monitor cutover progress here',
    });

    new cdk.CfnOutput(this, 'BackupBucketName', {
      value: backupBucket.bucketName,
      description: 'S3 bucket where Unifi backups are stored',
    });

    new cdk.CfnOutput(this, 'MongoSecretArn', {
      value: mongoSecret.secretArn,
      description: 'Secrets Manager ARN for MongoDB password',
    });

    new cdk.CfnOutput(this, 'LaunchTemplateId', {
      value: launchTemplate.launchTemplateId!,
      description: 'Launch template used for future AMI rotations',
    });
  }
}
