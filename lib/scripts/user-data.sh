#!/bin/bash
set -euo pipefail
exec > >(tee /var/log/user-data.log) 2>&1

DOMAIN="${DOMAIN}"
ADMIN_EMAIL="${ADMIN_EMAIL}"
BACKUP_BUCKET="${BACKUP_BUCKET}"
REGION="${REGION}"
MONGO_SECRET_ARN="${MONGO_SECRET_ARN}"
API_KEY_SECRET_ARN="${API_KEY_SECRET_ARN}"

# ── System setup ─────────────────────────────────────────────────────────────
dnf update -y
dnf install -y docker python3-pip nginx aws-cli jq

# 2GB swap — t3.small has 2GB RAM and MongoDB + Unifi JVM can exhaust it
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

systemctl enable docker
systemctl start docker

# Docker Compose plugin
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# ── Certbot + Route 53 DNS-01 challenge ──────────────────────────────────────
pip3 install certbot certbot-dns-route53

# Restore cached cert from S3 first (avoids Let's Encrypt rate limits on instance rotation)
mkdir -p /etc/letsencrypt
aws s3 sync "s3://${BACKUP_BUCKET}/letsencrypt/" /etc/letsencrypt/ --exact-timestamps 2>/dev/null || true

CERT_FILE="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
if [ -f "${CERT_FILE}" ] && openssl x509 -checkend 86400 -noout -in "${CERT_FILE}" 2>/dev/null; then
  echo "Valid certificate restored from S3 — skipping certbot request"
else
  echo "No valid certificate in S3 — requesting new certificate from Let's Encrypt"
  certbot certonly \
    --dns-route53 \
    -d "${DOMAIN}" \
    -d "*.${DOMAIN}" \
    --non-interactive \
    --agree-tos \
    --email "${ADMIN_EMAIL}" \
    --no-eff-email

  # Cache the new cert in S3 for future instances
  aws s3 sync /etc/letsencrypt/ "s3://${BACKUP_BUCKET}/letsencrypt/" --exact-timestamps
fi

# ── Nginx as SSL reverse proxy ────────────────────────────────────────────────
cat > /etc/nginx/conf.d/unifi.conf << NGINX
server {
    listen 80;
    server_name ${DOMAIN};
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    server_name ${DOMAIN};

    ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    location / {
        proxy_pass          https://127.0.0.1:8443;
        proxy_ssl_verify    off;
        proxy_http_version  1.1;
        proxy_set_header    Host              \$host;
        proxy_set_header    X-Real-IP         \$remote_addr;
        proxy_set_header    X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header    X-Forwarded-Proto \$scheme;
        proxy_read_timeout  90s;
    }
}
NGINX

nginx -t
systemctl enable nginx
systemctl start nginx

# ── Fetch MongoDB password from Secrets Manager ───────────────────────────────
MONGO_PASS=$(aws secretsmanager get-secret-value \
  --secret-id "${MONGO_SECRET_ARN}" \
  --region "${REGION}" \
  --query 'SecretString' \
  --output text)

# ── Directory structure ───────────────────────────────────────────────────────
mkdir -p /opt/unifi/{config,db,backup}
chown -R 1000:1000 /opt/unifi

# MongoDB init script — creates unifi user on first launch
cat > /opt/unifi/init-mongo.js << MONGO
db.getSiblingDB("unifi").createUser({
  user: "unifi",
  pwd: "${MONGO_PASS}",
  roles: [{ role: "dbOwner", db: "unifi" }]
});
db.getSiblingDB("unifi_stat").createUser({
  user: "unifi",
  pwd: "${MONGO_PASS}",
  roles: [{ role: "dbOwner", db: "unifi_stat" }]
});
MONGO

# ── Docker Compose ────────────────────────────────────────────────────────────
cat > /opt/unifi/docker-compose.yml << COMPOSE
version: "3.8"

services:
  unifi-db:
    image: mongo:4.4
    container_name: unifi-db
    volumes:
      - /opt/unifi/db:/data/db
      - /opt/unifi/init-mongo.js:/docker-entrypoint-initdb.d/init-mongo.js:ro
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "mongo", "--eval", "db.adminCommand('ping')"]
      interval: 10s
      timeout: 5s
      retries: 5

  unifi-network-application:
    image: lscr.io/linuxserver/unifi-network-application:latest
    container_name: unifi-network-application
    depends_on:
      unifi-db:
        condition: service_healthy
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=America/New_York
      - MONGO_USER=unifi
      - MONGO_PASS=${MONGO_PASS}
      - MONGO_HOST=unifi-db
      - MONGO_PORT=27017
      - MONGO_DBNAME=unifi
      - MEM_LIMIT=1024
      - MEM_STARTUP=512
    volumes:
      - /opt/unifi/config:/config
    ports:
      - "8443:8443"
      - "8080:8080"
      - "3478:3478/udp"
      - "10001:10001/udp"
      - "6789:6789"
    restart: unless-stopped

  watchtower:
    image: containrrr/watchtower:latest
    container_name: watchtower
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: --interval 86400 --cleanup unifi-network-application
    restart: unless-stopped
COMPOSE

# ── Restore from S3 backup (if one exists) ────────────────────────────────────
LATEST_BACKUP=$(aws s3 ls "s3://${BACKUP_BUCKET}/backups/" \
  --recursive | grep "\.unf$" | sort | tail -1 | awk '{print $4}' || true)

if [ -n "${LATEST_BACKUP}" ]; then
  echo "Found backup: ${LATEST_BACKUP} — downloading..."
  aws s3 cp "s3://${BACKUP_BUCKET}/${LATEST_BACKUP}" /opt/unifi/backup/restore.unf
  chown 1000:1000 /opt/unifi/backup/restore.unf
fi

# ── Start containers ──────────────────────────────────────────────────────────
cd /opt/unifi
docker compose up -d

# If a backup was downloaded, restore it via the Unifi setup wizard API
if [ -f /opt/unifi/backup/restore.unf ]; then
  echo "Waiting for Unifi setup wizard to become available..."
  WIZARD_READY=false
  for i in $(seq 1 36); do
    HTTP_CODE=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 5 "https://localhost:8443" 2>/dev/null || echo "000")
    if [ "${HTTP_CODE}" = "200" ] || [ "${HTTP_CODE}" = "302" ]; then
      echo "Unifi is responding (HTTP ${HTTP_CODE})"
      WIZARD_READY=true
      break
    fi
    echo "Attempt $i/36 — not ready yet (HTTP ${HTTP_CODE}), waiting 10s..."
    sleep 10
  done

  if [ "${WIZARD_READY}" = "true" ]; then
    # Extra buffer to ensure Unifi web server is fully accepting requests
    echo "Waiting 30s for Unifi to fully initialize before restore..."
    sleep 30

    echo "Establishing session with setup wizard..."
    curl -sk -c /tmp/unifi-cookies.txt -L "https://localhost:8443" -o /dev/null

    # Extract CSRF token from cookie jar (Unifi sets it on first page load)
    CSRF_TOKEN=$(grep -i csrf_token /tmp/unifi-cookies.txt 2>/dev/null | awk '{print $NF}' || echo "")
    echo "CSRF token: ${CSRF_TOKEN:-none}"

    echo "Uploading backup file..."
    UPLOAD_HTTP="000"
    for attempt in $(seq 1 5); do
      UPLOAD_HTTP=$(curl -sk -X POST "https://localhost:8443/upload/backup" \
        -b /tmp/unifi-cookies.txt \
        ${CSRF_TOKEN:+-H "x-csrf-token: ${CSRF_TOKEN}"} \
        -F "file=@/opt/unifi/backup/restore.unf" \
        --max-time 120 \
        -w "%{http_code}" \
        -o /tmp/upload_response.txt 2>/dev/null || echo "000")
      echo "Upload attempt ${attempt} — HTTP: ${UPLOAD_HTTP}"
      if [ "${UPLOAD_HTTP}" = "200" ]; then
        echo "Backup uploaded successfully"
        break
      fi
      echo "Attempt ${attempt} failed, waiting 30s before retry..."
      sleep 30
    done

    if [ "${UPLOAD_HTTP}" = "200" ]; then
      BACKUP_ID=$(python3 -c "import json; d=json.load(open('/tmp/upload_response.txt')); print(d['data'][0]['backup_id'])" 2>/dev/null || echo "")
      echo "Backup ID: ${BACKUP_ID:-none}"

      if [ -n "${BACKUP_ID}" ]; then
        echo "Triggering restore..."
        RESTORE_HTTP=$(curl -sk -X POST "https://localhost:8443/api/cmd/backup" \
          -b /tmp/unifi-cookies.txt \
          -H "Content-Type: application/json" \
          ${CSRF_TOKEN:+-H "x-csrf-token: ${CSRF_TOKEN}"} \
          -d "{\"cmd\":\"restore\",\"backup_id\":\"${BACKUP_ID}\"}" \
          --max-time 30 \
          -w "%{http_code}" \
          -o /tmp/restore_response.txt 2>/dev/null || echo "000")
        echo "Restore trigger — HTTP: ${RESTORE_HTTP}"
        echo "Restore response: $(cat /tmp/restore_response.txt 2>/dev/null)"

        if [ "${RESTORE_HTTP}" = "200" ]; then
          echo "Restore triggered — waiting for controller to restart..."
          sleep 30
          for i in $(seq 1 30); do
            HTTP_CODE=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 5 "https://localhost:8443" 2>/dev/null || echo "000")
            if [ "${HTTP_CODE}" = "200" ] || [ "${HTTP_CODE}" = "302" ]; then
              echo "Controller is back up (HTTP ${HTTP_CODE})"
              break
            fi
            echo "Still restarting... attempt $i/30"
            sleep 10
          done

          # Force all devices to re-provision immediately so they come online faster
          echo "Force-provisioning devices across all sites..."
          API_KEY=$(aws secretsmanager get-secret-value --secret-id "${API_KEY_SECRET_ARN}" --query 'SecretString' --output text 2>/dev/null || echo "")
          if [ -n "${API_KEY}" ]; then
            SITE_NAMES=$(python3 -c "import json; d=json.load(open('/tmp/upload_response.txt')); print(' '.join([s['name'] for s in d['data'][0]['sites']]))" 2>/dev/null || echo "")
            for SITE in ${SITE_NAMES}; do
              PROVISION_HTTP=$(curl -sk -X POST "https://localhost:8443/api/s/${SITE}/cmd/devmgr" \
                -H "X-API-KEY: ${API_KEY}" \
                -H "Content-Type: application/json" \
                -d '{"cmd":"force-provision"}' \
                -w "%{http_code}" -o /dev/null 2>/dev/null || echo "000")
              echo "Force-provision site ${SITE} — HTTP: ${PROVISION_HTTP}"
            done
          else
            echo "WARNING: Could not retrieve API key — skipping force-provision"
          fi
        else
          echo "WARNING: Restore trigger failed — instance will start fresh"
        fi
      else
        echo "WARNING: Could not parse backup_id from upload response — skipping restore"
      fi
    else
      echo "WARNING: Backup upload failed after 5 attempts — instance will start fresh"
    fi
  else
    echo "WARNING: Unifi never became available — skipping restore"
  fi
fi

# ── Cron jobs ─────────────────────────────────────────────────────────────────
# Hourly: sync Unifi auto-backups to S3
cat > /etc/cron.hourly/unifi-backup-sync << CRON
#!/bin/bash
aws s3 sync /opt/unifi/config/data/backup/autobackup/ \
  "s3://${BACKUP_BUCKET}/backups/" \
  --exclude "*" --include "*.unf" \
  --delete
CRON
chmod +x /etc/cron.hourly/unifi-backup-sync

# Daily: certbot renewal — reload nginx and sync renewed cert back to S3
cat > /etc/cron.daily/certbot-renew << CRON
#!/bin/bash
certbot renew --quiet --deploy-hook "systemctl reload nginx && aws s3 sync /etc/letsencrypt/ s3://${BACKUP_BUCKET}/letsencrypt/ --exact-timestamps"
CRON
chmod +x /etc/cron.daily/certbot-renew

echo "User data script complete."
