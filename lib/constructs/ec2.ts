import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

export interface ComputeDeps {
  instanceRole: iam.Role;
  backupBucket: s3.Bucket;
  mongoSecret: secretsmanager.Secret;
  apiKeySecret: secretsmanager.ISecret;
  domain: string;
  adminEmail: string;
  vpcId: string;
  instanceType: string;
}

export interface ComputeResources {
  launchTemplate: ec2.LaunchTemplate;
}

export function createCompute(scope: Construct, deps: ComputeDeps): ComputeResources {
  const stack = cdk.Stack.of(scope);
  const { instanceRole, backupBucket, mongoSecret, apiKeySecret, domain, adminEmail, vpcId, instanceType } = deps;

  const vpc = ec2.Vpc.fromVpcAttributes(scope, 'DefaultVpc', {
    vpcId,
    availabilityZones: [`${stack.region}a`, `${stack.region}b`, `${stack.region}c`],
  });

  const sg = new ec2.SecurityGroup(scope, 'UnifiSG', {
    vpc,
    description: 'Unifi controller security group',
    allowAllOutbound: true,
  });

  sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP (redirect to HTTPS)');
  sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS (nginx to Unifi)');
  sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8080), 'Unifi device inform');
  sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(3478), 'Unifi STUN');
  sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(10001), 'Unifi AP discovery');
  sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(6789), 'Unifi speed test');

  const al2023Ami = ec2.MachineImage.latestAmazonLinux2023({
    cpuType: ec2.AmazonLinuxCpuType.X86_64,
  });

  const rawUserData = fs.readFileSync(
    path.join(__dirname, '../scripts/user-data.sh'),
    'utf8'
  );
  const renderedUserData = rawUserData
    .replace(/\$\{DOMAIN\}/g, domain)
    .replace(/\$\{ADMIN_EMAIL\}/g, adminEmail)
    .replace(/\$\{BACKUP_BUCKET\}/g, backupBucket.bucketName)
    .replace(/\$\{REGION\}/g, stack.region)
    .replace(/\$\{MONGO_SECRET_ARN\}/g, mongoSecret.secretArn)
    .replace(/\$\{API_KEY_SECRET_ARN\}/g, apiKeySecret.secretArn);

  const userData = ec2.UserData.forLinux();
  userData.addCommands(renderedUserData);

  const launchTemplate = new ec2.LaunchTemplate(scope, 'UnifiLaunchTemplate', {
    launchTemplateName: 'unifi-controller',
    instanceType: new ec2.InstanceType(instanceType),
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

  return { launchTemplate };
}
