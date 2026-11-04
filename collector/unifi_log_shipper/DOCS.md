# UniFi Log Shipper

Receives syslog from your UniFi gateway and devices on UDP (default port
5514) and uploads it to S3 as gzipped JSON lines under `unifi/devices/`.
While the internet is down, logs wait on disk under `/data` and upload when
the connection returns.

## Options

| Option | What to enter |
|---|---|
| `bucket` | The `LogBucketName` output of the UnifiStack CloudFormation stack |
| `region` | The `LogRegion` output (for example `us-east-1`) |
| `aws_access_key_id` | Access key ID for the `unifi-log-shipper` IAM user |
| `aws_secret_access_key` | Its secret access key |
| `syslog_port` | UDP port to listen on. Use the same port in UniFi's syslog setting. |

Full setup steps, including the UniFi syslog setting, are in the "Log archive"
section of the repository README.

## Checking it works

On the **Log** tab, look for `Successfully uploaded object` lines. Upload
errors show as `[error] [output:s3:s3.0]` lines; they're expected while the
internet is down and stop once it's back.
