import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// EC2 limits user data to 16,384 bytes. Deploy-time values (ARNs, bucket
// names, the asset URL) add a few hundred bytes after synth, so leave room.
const MAX_USER_DATA_BYTES_AT_SYNTH = 15000;

// Controller Fluent Bit files: everything in lib/scripts/fluent-bit, plus the
// parser and Lua script shared with the Home Assistant add-on.
const FLUENT_BIT_EC2_DIR = path.join(__dirname, '../scripts/fluent-bit');
const FLUENT_BIT_SHARED_DIR = path.join(__dirname, '../../collector/unifi_log_shipper/rootfs/etc/fluent-bit');
const FLUENT_BIT_SHARED_FILES = ['unifi.lua', 'unifi-parsers.conf'];

export interface ComputeDeps {
  instanceRole: iam.Role;
  backupBucket: s3.Bucket;
  logBucket: s3.Bucket;
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
  const { instanceRole, backupBucket, logBucket, mongoSecret, apiKeySecret, domain, adminEmail, vpcId, instanceType } = deps;

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

  // Fluent Bit files go to the instance as an asset because they don't fit
  // in user data. Stage the EC2 files and the shared ones in one directory.
  const fluentBitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unifi-fluent-bit-'));
  const fluentBitFiles = [
    ...fs.readdirSync(FLUENT_BIT_EC2_DIR).map((f) => path.join(FLUENT_BIT_EC2_DIR, f)),
    ...FLUENT_BIT_SHARED_FILES.map((f) => path.join(FLUENT_BIT_SHARED_DIR, f)),
  ];
  for (const file of fluentBitFiles) {
    fs.copyFileSync(file, path.join(fluentBitDir, path.basename(file)));
  }
  const fluentBitAsset = new s3assets.Asset(scope, 'FluentBitFiles', { path: fluentBitDir });
  fluentBitAsset.grantRead(instanceRole);

  // Comment-only lines are dropped to stay under the user data size limit.
  // Shebangs (#!) are kept, including those inside heredocs.
  const rawUserData = fs.readFileSync(path.join(__dirname, '../scripts/user-data.sh'), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('#!') || !/^\s*#/.test(line))
    .join('\n');
  const userDataBytes = Buffer.byteLength(rawUserData, 'utf8');
  if (userDataBytes > MAX_USER_DATA_BYTES_AT_SYNTH) {
    throw new Error(`user-data.sh is ${userDataBytes} bytes after stripping comments; keep it under ${MAX_USER_DATA_BYTES_AT_SYNTH} (EC2 limit is 16,384 after deploy-time values are filled in)`);
  }

  const renderedUserData = rawUserData
    .replace(/\$\{DOMAIN\}/g, domain)
    .replace(/\$\{ADMIN_EMAIL\}/g, adminEmail)
    .replace(/\$\{BACKUP_BUCKET\}/g, backupBucket.bucketName)
    .replace(/\$\{LOG_BUCKET\}/g, logBucket.bucketName)
    .replace(/\$\{FLUENT_BIT_ASSET\}/g, fluentBitAsset.s3ObjectUrl)
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
