# UniFi Log Shipper

Receives syslog from your UniFi gateway and devices on UDP (default port
5514) and uploads it to S3 as gzipped JSON lines under `unifi/devices/`.
While the internet is down, logs wait on disk under `/data` and upload when
the connection returns.

There's no AWS access key. The add-on signs with a certificate in Home
Assistant's `ssl` folder, and IAM Roles Anywhere exchanges it for one-hour
credentials.

## Options

| Option | What to enter |
|---|---|
| `bucket` | The `LogBucketName` output of the UnifiStack CloudFormation stack |
| `region` | The `LogRegion` output (for example `us-east-1`) |
| `trust_anchor_arn` | The `LogShipperTrustAnchorArn` output |
| `profile_arn` | The `LogShipperProfileArn` output |
| `role_arn` | The `LogShipperRoleArn` output |
| `certificate` | Certificate file name in the `ssl` folder (default `unifi-log-shipper.crt`) |
| `private_key` | Private key file name in the `ssl` folder (default `unifi-log-shipper.key`) |
| `syslog_port` | UDP port to listen on. Use the same port in UniFi's syslog setting. |

Full setup steps, including creating the certificate and the UniFi syslog
setting, are in the "Log archive" section of the repository README.

## Checking it works

On the **Log** tab, look for:

- `IAM Roles Anywhere: got temporary credentials` at startup
- `Successfully uploaded object` lines, at least hourly

Upload errors show as `[error] [output:s3:s3.0]` lines. They're expected
while the internet is down and stop once it's back. The certificate's expiry
date is logged at every start; renew it before then.
