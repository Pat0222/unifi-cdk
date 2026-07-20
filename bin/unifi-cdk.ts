#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { UnifiStack } from '../lib/unifi-stack';

const app = new cdk.App();

new UnifiStack(app, 'UnifiStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: app.node.tryGetContext('region') ?? 'us-east-1',
  },
  eipAllocationId: app.node.tryGetContext('eipAllocationId'),
  hostedZoneId: app.node.tryGetContext('hostedZoneId'),
  existingInstanceId: app.node.tryGetContext('existingInstanceId'),
  instanceType: app.node.tryGetContext('instanceType') ?? 't3.small',
  domain: app.node.tryGetContext('domain'),
  adminEmail: app.node.tryGetContext('adminEmail'),
  vpcId: app.node.tryGetContext('vpcId'),
  eipPublicIp: app.node.tryGetContext('eipPublicIp'),
  forceRotation: app.node.tryGetContext('forceRotation') === 'true',
});
