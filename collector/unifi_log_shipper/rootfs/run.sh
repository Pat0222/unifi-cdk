#!/usr/bin/with-contenv bashio
# Starts Fluent Bit with the add-on's options. Fluent Bit reads these
# environment variables in /etc/fluent-bit/fluent-bit.conf.
set -e

for option in bucket region aws_access_key_id aws_secret_access_key; do
  if ! bashio::config.has_value "${option}"; then
    bashio::exit.nok "The '${option}' option is empty. Set it on the add-on's Configuration tab."
  fi
done

export S3_BUCKET="$(bashio::config 'bucket')"
export S3_REGION="$(bashio::config 'region')"
export SYSLOG_PORT="$(bashio::config 'syslog_port')"
export AWS_ACCESS_KEY_ID="$(bashio::config 'aws_access_key_id')"
export AWS_SECRET_ACCESS_KEY="$(bashio::config 'aws_secret_access_key')"

# Both live under /data, which survives add-on restarts and Home Assistant reboots.
mkdir -p /data/flb-storage /data/s3-buffer

bashio::log.info "Listening for syslog on UDP port ${SYSLOG_PORT}"
bashio::log.info "Uploading to s3://${S3_BUCKET}/unifi/devices/ in ${S3_REGION}, at least hourly"
bashio::log.info "Look for 'Successfully uploaded object' below to confirm uploads"

exec /opt/fluent-bit/bin/fluent-bit -c /etc/fluent-bit/fluent-bit.conf
