#!/bin/bash
# deploy_worker.sh — push worker/worker.js to Cloudflare as the `ledatic`
# Worker. Preserves bindings (LEDATIC_KV + REPORTS_R2 + BEACON_TOKEN +
# API_BEARER + DDA_FLEET_TOKEN + DDA_PORTAL_TOKEN + GREATLAKES_PASS +
# LAKES_FLEET_URL + LAKES_FLEET_TOKEN + SDK_WITNESS_KEY) exactly as
# configured. Each new secret needs its source file + a binding entry.
#
# BINDING-DRIFT RULE (earned 2026-05-29, validated 2026-06-09): this is a
# full-replace deploy — any live binding NOT listed below gets WIPED. Before
# adding/removing bindings, diff against the live list:
#   curl -s -H "Authorization: Bearer $(cat ~/.fleet/cf_token)" \
#     "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/workers/scripts/ledatic/bindings"
#
# Usage: ./worker/deploy_worker.sh   (run from ledatic-site/ or anywhere)
# Env:   CF_TOKEN read from ~/.fleet/cf_token, fallback ~/Desktop/rings (Account:Workers:Edit)

set -e
cd "$(dirname "$0")/.."

TOKEN=$(cat "$HOME/.fleet/cf_token" 2>/dev/null || cat ~/Desktop/rings)
[ -f "$HOME/.ledatic/cf_ids.env" ] && . "$HOME/.ledatic/cf_ids.env"
ACC="${CF_ACCOUNT:?set CF_ACCOUNT (in ~/.ledatic/cf_ids.env)}"
SCRIPT=ledatic
SRC=worker/worker.js
META=$(mktemp -t ledatic_worker_meta.XXXXXX)
trap 'rm -f "$META"' EXIT
BACKUP_DIR=$HOME/ledatic-site/worker_backups
TS=$(date +%Y%m%d_%H%M%S)

mkdir -p "$BACKUP_DIR"

echo "> Backing up current Worker to $BACKUP_DIR/ledatic_worker_$TS.txt"
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/$SCRIPT" \
  > "$BACKUP_DIR/ledatic_worker_$TS.txt"

echo "> Writing metadata"
BEACON_TOKEN_VAL=$(cat ~/.ledatic/entropy/beacon_token)
API_BEARER_VAL=$(cat ~/.ledatic/api/bearer_token)
DDA_FLEET_TOKEN_VAL=$(cat ~/.ledatic/dda_portal/fleet_token)
DDA_PORTAL_TOKEN_VAL=$(cat ~/.ledatic/dda_portal/portal_token)
GREATLAKES_PASS_VAL=$(cat ~/.ledatic/greatlakes_pass)
LAKES_FLEET_URL_VAL=https://lakes-fleet.ledatic.org
LAKES_FLEET_TOKEN_VAL=$(cat ~/.ledatic/lakes_fleet_token)
# SDK witness signing key (verifiability SDK, shipped 2026-05-29). The Worker's
# Ed25519 key — derives pinned pubkey 45ad2e2d… . NOT ~/.ledatic/sdk/key.hex
# (that's the CALLER's key). Was live-only until 2026-06-09; a deploy without
# this line wipes it.
SDK_WITNESS_KEY_VAL=$(cat ~/.ledatic/sdk_witness/key.hex)
cat > "$META" <<JSON
{
  "main_module": "worker.js",
  "compatibility_date": "2024-01-01",
  "bindings": [
    {"type":"kv_namespace","name":"LEDATIC_KV","namespace_id":"${CF_KV_NS:?set CF_KV_NS}"},
    {"type":"r2_bucket","name":"REPORTS_R2","bucket_name":"ledatic-reports"},
    {"type":"secret_text","name":"BEACON_TOKEN","text":"$BEACON_TOKEN_VAL"},
    {"type":"secret_text","name":"API_BEARER","text":"$API_BEARER_VAL"},
    {"type":"secret_text","name":"DDA_FLEET_TOKEN","text":"$DDA_FLEET_TOKEN_VAL"},
    {"type":"secret_text","name":"DDA_PORTAL_TOKEN","text":"$DDA_PORTAL_TOKEN_VAL"},
    {"type":"secret_text","name":"GREATLAKES_PASS","text":"$GREATLAKES_PASS_VAL"},
    {"type":"secret_text","name":"LAKES_FLEET_URL","text":"$LAKES_FLEET_URL_VAL"},
    {"type":"secret_text","name":"LAKES_FLEET_TOKEN","text":"$LAKES_FLEET_TOKEN_VAL"},
    {"type":"secret_text","name":"SDK_WITNESS_KEY","text":"$SDK_WITNESS_KEY_VAL"}
  ]
}
JSON

echo "> Uploading $SRC"
RESP=$(curl -s -X PUT -H "Authorization: Bearer $TOKEN" \
  -F "metadata=@$META;type=application/json" \
  -F "worker.js=@$SRC;filename=worker.js;type=application/javascript+module" \
  "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/$SCRIPT")

echo "$RESP" | python3 -m json.tool
echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('success') else 1)"
