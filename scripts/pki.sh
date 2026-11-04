#!/bin/bash
# Certificate authority for IAM Roles Anywhere (the Home Assistant log shipper).
#
#   scripts/pki.sh init    Create the CA once. Writes its public certificate to
#                          lib/pki/unifi-log-shipper-ca.pem for CDK to register
#                          as the trust anchor. Commit that file and deploy.
#   scripts/pki.sh issue   Create or renew the Pi's certificate (valid 1 year).
#                          Copy the .crt and .key it prints to the Pi's /ssl folder.
#
# Private keys stay in PKI_DIR (default ~/Documents/unifi-pki), outside the repo.
# Anyone with ca.key can issue certificates the role will trust, so keep it
# private and backed up. Losing it only means running init again and redeploying.
set -euo pipefail

PKI_DIR="${PKI_DIR:-$HOME/Documents/unifi-pki}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CA_PUBLIC="$REPO_DIR/lib/pki/unifi-log-shipper-ca.pem"
# Must match the CN condition on the role's trust policy in lib/constructs/logs.ts.
CLIENT_CN="unifi-log-shipper"

init() {
  if [ -f "$PKI_DIR/ca.key" ]; then
    echo "A CA already exists in $PKI_DIR. Delete it first if you really want a new one." >&2
    exit 1
  fi
  mkdir -p "$PKI_DIR" "$(dirname "$CA_PUBLIC")"
  chmod 700 "$PKI_DIR"
  (umask 077; openssl ecparam -name prime256v1 -genkey -noout -out "$PKI_DIR/ca.key")
  openssl req -x509 -new -sha256 -days 3650 -key "$PKI_DIR/ca.key" \
    -subj "/CN=UniFi Log Shipper CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash" \
    -out "$PKI_DIR/ca.pem"
  cp "$PKI_DIR/ca.pem" "$CA_PUBLIC"
  echo "CA created (valid 10 years)."
  echo "  Private key:        $PKI_DIR/ca.key  (keep private, back it up)"
  echo "  Public certificate: $CA_PUBLIC  (commit this, then deploy)"
}

issue() {
  if [ ! -f "$PKI_DIR/ca.key" ]; then
    echo "No CA in $PKI_DIR. Run: scripts/pki.sh init" >&2
    exit 1
  fi
  local ext
  ext="$(mktemp)"
  trap 'rm -f "$ext"' RETURN
  printf '%s\n' \
    "basicConstraints=critical,CA:FALSE" \
    "keyUsage=critical,digitalSignature" \
    "extendedKeyUsage=clientAuth" \
    "subjectKeyIdentifier=hash" \
    "authorityKeyIdentifier=keyid" > "$ext"

  (umask 077; openssl ecparam -name prime256v1 -genkey -noout -out "$PKI_DIR/$CLIENT_CN.key.new")
  openssl req -new -sha256 -key "$PKI_DIR/$CLIENT_CN.key.new" -subj "/CN=$CLIENT_CN" -out "$PKI_DIR/$CLIENT_CN.csr"
  openssl x509 -req -sha256 -days 365 -in "$PKI_DIR/$CLIENT_CN.csr" \
    -CA "$PKI_DIR/ca.pem" -CAkey "$PKI_DIR/ca.key" -CAcreateserial \
    -extfile "$ext" -out "$PKI_DIR/$CLIENT_CN.crt.new"
  mv "$PKI_DIR/$CLIENT_CN.key.new" "$PKI_DIR/$CLIENT_CN.key"
  mv "$PKI_DIR/$CLIENT_CN.crt.new" "$PKI_DIR/$CLIENT_CN.crt"
  rm -f "$PKI_DIR/$CLIENT_CN.csr"
  echo "Certificate issued, valid until $(openssl x509 -enddate -noout -in "$PKI_DIR/$CLIENT_CN.crt" | cut -d= -f2)."
  echo "Copy both files to the Pi's /ssl folder, then restart the add-on:"
  echo "  $PKI_DIR/$CLIENT_CN.crt"
  echo "  $PKI_DIR/$CLIENT_CN.key"
}

case "${1:-}" in
  init) init ;;
  issue) issue ;;
  *) echo "Usage: $0 init|issue" >&2; exit 1 ;;
esac
