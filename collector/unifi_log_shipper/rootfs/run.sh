#!/usr/bin/with-contenv bashio
# Starts Fluent Bit with the add-on's options. AWS credentials come from IAM
# Roles Anywhere: Fluent Bit runs aws_signing_helper (credential_process),
# which signs with the Pi's certificate and returns 1-hour credentials.
set -e

for option in bucket region trust_anchor_arn profile_arn role_arn certificate private_key; do
  if ! bashio::config.has_value "${option}"; then
    bashio::exit.nok "The '${option}' option is empty. Set it on the add-on's Configuration tab."
  fi
done

CERT="/ssl/$(bashio::config 'certificate')"
KEY="/ssl/$(bashio::config 'private_key')"
for file in "${CERT}" "${KEY}"; do
  if [ ! -f "${file}" ]; then
    bashio::exit.nok "${file} not found. Copy the Pi's certificate and key into Home Assistant's ssl folder."
  fi
done

export S3_BUCKET="$(bashio::config 'bucket')"
export S3_REGION="$(bashio::config 'region')"
export SYSLOG_PORT="$(bashio::config 'syslog_port')"

HELPER_ARGS="--certificate ${CERT} --private-key ${KEY} --region ${S3_REGION}"
HELPER_ARGS+=" --trust-anchor-arn $(bashio::config 'trust_anchor_arn')"
HELPER_ARGS+=" --profile-arn $(bashio::config 'profile_arn')"
HELPER_ARGS+=" --role-arn $(bashio::config 'role_arn')"

export AWS_CONFIG_FILE=/tmp/aws-config
cat > "${AWS_CONFIG_FILE}" << CONFIG
[default]
credential_process = /usr/local/bin/aws_signing_helper credential-process ${HELPER_ARGS}
region = ${S3_REGION}
CONFIG

# Report the certificate's expiry, and try getting credentials once so setup
# problems show up here instead of as upload errors an hour later. A failure
# isn't fatal: the internet may just be down, and logs buffer until it's back.
EXPIRES="$(openssl x509 -enddate -noout -in "${CERT}" 2>/dev/null | cut -d= -f2 || true)"
bashio::log.info "Certificate ${CERT} expires ${EXPIRES:-(unreadable)}"
# shellcheck disable=SC2086
if ERR="$(/usr/local/bin/aws_signing_helper credential-process ${HELPER_ARGS} 2>&1 >/dev/null)"; then
  bashio::log.info "IAM Roles Anywhere: got temporary credentials"
else
  bashio::log.warning "IAM Roles Anywhere: couldn't get credentials yet (offline, or a setting is wrong): ${ERR}"
fi

# Both live under /data, which survives add-on restarts and Home Assistant reboots.
mkdir -p /data/flb-storage /data/s3-buffer

bashio::log.info "Listening for syslog on UDP port ${SYSLOG_PORT}"
bashio::log.info "Uploading to s3://${S3_BUCKET}/unifi/devices/ in ${S3_REGION}, at least hourly"
bashio::log.info "Look for 'Successfully uploaded object' below to confirm uploads"

exec /opt/fluent-bit/bin/fluent-bit -c /etc/fluent-bit/fluent-bit.conf
