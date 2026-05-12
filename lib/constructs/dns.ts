import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export interface DnsDeps {
  hostedZoneId: string;
  domain: string;
  eipPublicIp: string;
}

export function createDns(scope: Construct, deps: DnsDeps): void {
  const { hostedZoneId, domain, eipPublicIp } = deps;

  const hostedZone = route53.HostedZone.fromHostedZoneAttributes(scope, 'HostedZone', {
    hostedZoneId,
    zoneName: domain,
  });

  new route53.ARecord(scope, 'UnifiARecord', {
    zone: hostedZone,
    recordName: domain,
    target: route53.RecordTarget.fromIpAddresses(eipPublicIp),
    ttl: cdk.Duration.minutes(5),
  });
}
