#!/bin/bash
set -euo pipefail
exec > >(tee /var/log/user-data.log) 2>&1

DOMAIN="${DOMAIN}"
ADMIN_EMAIL="${ADMIN_EMAIL}"
BACKUP_BUCKET="${BACKUP_BUCKET}"
REGION="${REGION}"
MONGO_SECRET_ARN="${MONGO_SECRET_ARN}"

# ── System setup ─────────────────────────────────────────────────────────────
dnf update -y
dnf install -y docker python3-pip nginx aws-cli jq

systemctl enable docker
systemctl start docker

# Docker Compose plugin
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# ── Certbot + Route 53 DNS-01 challenge ──────────────────────────────────────
pip3 install certbot certbot-dns-route53

certbot certonly \
  --dns-route53 \
  -d "${DOMAIN}" \
  -d "*.${DOMAIN}" \
  --non-interactive \
  --agree-tos \
  --email "${ADMIN_EMAIL}" \
  --no-eff-email

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

    # Fetch CSRF token if available
    CSRF_TOKEN=$(curl -sk -b /tmp/unifi-cookies.txt \
      "https://localhost:8443/api/auth/csrf" 2>/dev/null \
      | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")
    echo "CSRF token: ${CSRF_TOKEN:-none}"

    echo "Submitting backup restore via setup API..."
    RESTORE_HTTP="000"
    for attempt in $(seq 1 5); do
      RESTORE_HTTP=$(curl -sk -X POST "https://localhost:8443/upload/backup" \
        -b /tmp/unifi-cookies.txt \
        ${CSRF_TOKEN:+-H "x-csrf-token: ${CSRF_TOKEN}"} \
        -F "file=@/opt/unifi/backup/restore.unf" \
        --max-time 120 \
        -w "%{http_code}" \
        -o /tmp/restore_response.txt 2>/dev/null || echo "000")
      echo "Restore attempt ${attempt} — HTTP: ${RESTORE_HTTP}"
      echo "Restore response body: $(cat /tmp/restore_response.txt 2>/dev/null)"
      if [ "${RESTORE_HTTP}" = "200" ]; then
        echo "Restore submitted successfully"
        break
      fi
      echo "Attempt ${attempt} failed, waiting 30s before retry..."
      sleep 30
    done

    if [ "${RESTORE_HTTP}" = "200" ]; then
      # Controller restarts itself after restore — wait for it to come back up
      echo "Waiting for controller to restart after restore..."
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
    else
      echo "WARNING: Restore failed after 5 attempts — instance will start fresh"
    fi
  else
    echo "WARNING: Unifi never became available — skipping restore"
  fi
fi

# ── Cron jobs ─────────────────────────────────────────────────────────────────
# Hourly: sync Unifi auto-backups to S3
cat > /etc/cron.hourly/unifi-backup-sync << 'CRON'
#!/bin/bash
aws s3 sync /opt/unifi/config/data/backup/autobackup/ \
  "s3://${BACKUP_BUCKET}/backups/" \
  --region "${REGION}" \
  --exclude "*" --include "*.unf" \
  --delete
CRON
chmod +x /etc/cron.hourly/unifi-backup-sync

# Daily: certbot renewal (nginx reloads automatically via --deploy-hook)
cat > /etc/cron.daily/certbot-renew << 'CRON'
#!/bin/bash
certbot renew --quiet --deploy-hook "systemctl reload nginx"
CRON
chmod +x /etc/cron.daily/certbot-renew

echo "User data script complete."
