import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface StorageResources {
  backupBucket: s3.Bucket;
  mongoSecret: secretsmanager.Secret;
  apiKeySecret: secretsmanager.ISecret;
}

export function createStorage(scope: Construct): StorageResources {
  const stack = cdk.Stack.of(scope);

  const backupBucket = new s3.Bucket(scope, 'UnifiBackups', {
    bucketName: `unifi-backups-${stack.account}`,
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

  const mongoSecret = new secretsmanager.Secret(scope, 'MongoPassword', {
    secretName: `unifi/mongodb-password-${stack.account}`,
    generateSecretString: {
      excludePunctuation: true,
      passwordLength: 32,
    },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  const apiKeySecret = secretsmanager.Secret.fromSecretNameV2(scope, 'UnifiApiKey', 'unifi/api-key');

  return { backupBucket, mongoSecret, apiKeySecret };
}
