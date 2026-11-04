#!/bin/bash
# Installs Fluent Bit and starts shipping the UniFi controller's server.log
# to S3. user-data downloads this directory as a CDK asset and runs this
# script with LOG_BUCKET, REGION and DOMAIN set. A failure here must not
# stop the rest of the boot, so user-data treats a non-zero exit as a warning.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

cat > /etc/yum.repos.d/fluent-bit.repo << 'REPO'
[fluent-bit]
name=Fluent Bit
baseurl=https://packages.fluentbit.io/amazonlinux/2023/
gpgcheck=1
repo_gpgcheck=1
gpgkey=https://packages.fluentbit.io/fluentbit.key
enabled=1
REPO
dnf install -y fluent-bit

install -d -m 0755 /etc/fluent-bit /var/lib/fluent-bit
install -m 0644 "$HERE/controller.conf" /etc/fluent-bit/fluent-bit.conf
install -m 0644 "$HERE/unifi.lua" "$HERE/unifi-parsers.conf" /etc/fluent-bit/

TOKEN=$(curl -sf -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
INSTANCE_ID=$(curl -sf -H "X-aws-ec2-metadata-token: ${TOKEN}" http://169.254.169.254/latest/meta-data/instance-id)

mkdir -p /etc/systemd/system/fluent-bit.service.d
cat > /etc/systemd/system/fluent-bit.service.d/unifi.conf << DROPIN
[Service]
Environment=LOG_BUCKET=${LOG_BUCKET}
Environment=AWS_REGION=${REGION}
Environment=UNIFI_HOST=${DOMAIN}
Environment=UNIFI_HOSTNAME=${INSTANCE_ID}
Restart=always
RestartSec=10
DROPIN

systemctl daemon-reload
systemctl enable --now fluent-bit
echo "Fluent Bit installed: shipping server.log to s3://${LOG_BUCKET}/unifi/controller/"
