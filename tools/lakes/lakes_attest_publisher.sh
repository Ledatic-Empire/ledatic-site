#!/usr/bin/env bash
# lakes_attest_publisher.sh — physicify the Great Lakes AIS stream
#
# Every tick (~30 s), atomically rotates ~/.ledatic/lakes/ais.jsonl,
# hashes the batch, asks fleet0 to sign sha256(batch) ⊗ pulse_id ⊗ value_hex,
# and (optionally) PUTs the attestation to ledatic.org.
#
# Mirrors the proven frame_attest_publisher.sh shape from tools/attest/.
#
# Usage:
#   ./lakes_attest_publisher.sh                 # local-only: signs + writes batch dir, no upload
#   ./lakes_attest_publisher.sh --publish       # also PUTs to /lakes/ais/<batch_id>.* on ledatic.org
#   ./lakes_attest_publisher.sh --skip-witness  # POC mode: skip Pi signing (digest-only attest)

set -uo pipefail

AIS_LOG=${AIS_LOG:-$HOME/.ledatic/lakes/ais.jsonl}
BATCH_DIR=${BATCH_DIR:-$HOME/.ledatic/lakes/batches}
BEACON_URL=${BEACON_URL:-https://ledatic.org/entropy/pulse}
BEACON_TOKEN_FILE=${BEACON_TOKEN_FILE:-$HOME/.ledatic/entropy/beacon_token}
WITNESS_HOST_FILE=${WITNESS_HOST_FILE:-$HOME/.ledatic/witness/host}
WITNESS_HOST=${WITNESS_HOST:-$(cat "$WITNESS_HOST_FILE" 2>/dev/null || echo "")}
SIGNER=${SIGNER:-\$HOME/.ledatic/witness/sign_attestation.sh}
SITE=${SITE:-https://ledatic.org}

PUBLISH=0
SKIP_WITNESS=0
for arg in "$@"; do
  case "$arg" in
    --publish) PUBLISH=1 ;;
    --skip-witness) SKIP_WITNESS=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 64 ;;
  esac
done

mkdir -p "$BATCH_DIR"

[ -f "$AIS_LOG" ] || { echo "no ais log at $AIS_LOG (start lakes_ingest.py first)" >&2; exit 2; }

# Atomic rotation: rename the live log out from under the writer (it'll
# recreate via append). Any record landing between mv and the next write
# starts a fresh log; we never double-count.
batch_id=$(date -u +%Y%m%dT%H%M%SZ)
batch_path="$BATCH_DIR/$batch_id.jsonl"
mv "$AIS_LOG" "$batch_path"
: > "$AIS_LOG"
chmod 600 "$AIS_LOG"

records=$(wc -l < "$batch_path" | tr -d ' ')
size=$(stat -f%z "$batch_path" 2>/dev/null || stat -c%s "$batch_path")

if [ "$records" = "0" ]; then
  rm -f "$batch_path"
  echo "[$(date -u +%FT%TZ)] no records this tick; skipping"
  exit 0
fi

digest=$(shasum -a 256 "$batch_path" | awk '{print $1}')

raw=$(curl -sf --max-time 4 "$BEACON_URL") || { echo "beacon unreachable" >&2; exit 3; }
pulse_id=$(printf '%s' "$raw" | python3 -c "import sys,json;print(json.load(sys.stdin)['pulse_id'])")
value_hex=$(printf '%s' "$raw" | python3 -c "import sys,json;print(json.load(sys.stdin)['value_hex'])")

# Per-vessel summary so the attestation doesn't require the raw batch to
# show interesting structure.
summary=$(python3 - "$batch_path" <<'PY'
import json, sys, collections
vessels = collections.defaultdict(int)
positions = 0
static = 0
with open(sys.argv[1]) as f:
    for line in f:
        try:
            r = json.loads(line)
        except Exception:
            continue
        mmsi = r.get("mmsi")
        if mmsi is not None:
            vessels[mmsi] += 1
        kind = r.get("kind", "")
        if kind == "ais.position":
            positions += 1
        elif kind == "ais.static":
            static += 1
print(json.dumps({
    "unique_vessels": len(vessels),
    "position_reports": positions,
    "static_reports": static,
    "top_vessels": sorted(vessels.items(), key=lambda kv: -kv[1])[:5],
}))
PY
)

inner='{"witness":"skipped"}'
if [ "$SKIP_WITNESS" = "0" ]; then
  [ -n "$WITNESS_HOST" ] || { echo "no witness host (set WITNESS_HOST or write $WITNESS_HOST_FILE)" >&2; exit 4; }
  inner_raw=$(ssh -o ConnectTimeout=4 -o BatchMode=yes "$WITNESS_HOST" \
    "$SIGNER $digest $pulse_id $value_hex" 2>/dev/null || true)
  if [ -z "$inner_raw" ]; then
    echo "witness unreachable; saving local-only attestation" >&2
    inner='{"witness":"unreachable"}'
  else
    inner="$inner_raw"
  fi
fi

published=$(python3 - "$batch_id" "$digest" "$size" "$records" "$pulse_id" "$value_hex" "$summary" "$inner" <<'PY'
import json, sys
batch_id, digest, size, records, pulse_id, value_hex, summary_json, inner_json = sys.argv[1:]
out = {
    "kind": "ledatic.lakes.ais.attestation",
    "version": 1,
    "artifact": {
        "sha256": digest,
        "url": f"https://ledatic.org/lakes/ais/{batch_id}.jsonl",
        "name": f"lakes/ais/{batch_id}.jsonl",
    },
    "batch": {
        "id": batch_id,
        "url": f"https://ledatic.org/lakes/ais/{batch_id}.jsonl",
        "size_bytes": int(size),
        "records": int(records),
        "sha256": digest,
        "summary": json.loads(summary_json),
    },
    "beacon": {"pulse_id": int(pulse_id), "value_hex": value_hex},
    "witness": json.loads(inner_json),
}
print(json.dumps(out, indent=2))
PY
)

att_path="$BATCH_DIR/$batch_id.attestation.json"
printf '%s\n' "$published" > "$att_path"

# Also update the "latest" pointer locally
ln -sf "$batch_id.attestation.json" "$BATCH_DIR/latest.attestation.json"
ln -sf "$batch_id.jsonl"             "$BATCH_DIR/latest.jsonl"

ts=$(date -u +%FT%TZ)
echo "[$ts] batch=$batch_id records=$records sha=${digest:0:16} pulse=$pulse_id"

if [ "$PUBLISH" = "1" ]; then
  [ -s "$BEACON_TOKEN_FILE" ] || { echo "no beacon token at $BEACON_TOKEN_FILE; skip upload" >&2; exit 5; }
  TOKEN=$(cat "$BEACON_TOKEN_FILE")
  put() {
    local file="$1" key="$2" ct="$3"
    curl -sS -X PUT \
      -H "x-beacon-token: $TOKEN" \
      -H "content-type: $ct" \
      --data-binary @"$file" \
      --max-time 30 \
      -o /dev/null -w '%{http_code}' \
      "$SITE/greatlakes/ais/$key" || echo "000"
  }
  c_att=$(put       "$att_path"   "$batch_id.attestation.json" "application/json")
  c_bat=$(put       "$batch_path" "$batch_id.jsonl"            "application/x-ndjson")
  c_latt=$(put      "$att_path"   "latest.attestation.json"    "application/json")
  c_lbat=$(put      "$batch_path" "latest.jsonl"               "application/x-ndjson")
  echo "[$ts] publish: att=$c_att batch=$c_bat latest_att=$c_latt latest_batch=$c_lbat"
fi
