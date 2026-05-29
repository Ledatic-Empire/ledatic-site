#!/usr/bin/env bash
# Deploy static pages to Cloudflare KV.
# Usage:
#   CF_TOKEN=$(cat ~/Desktop/rings) ./deploy.sh              # deploy all pages
#   CF_TOKEN=$(cat ~/Desktop/rings) ./deploy.sh index.html   # deploy one file
#
# KV key convention: relative path from repo root, except index.html lives at
# the key "index.html" and the Worker mounts it at "/".

set -euo pipefail

CF_ACCOUNT="2acd6ceb3a0c57f1f2b470433d94bc87"
CF_KV_NS="be34022eeedc4d6fb802087156eb1aae"
CF_ZONE="81e23388aca8fee359f7c40b09828b29"
SITE_ORIGIN="https://ledatic.org"

: "${CF_TOKEN:?set CF_TOKEN (e.g. CF_TOKEN=\$(cat ~/Desktop/rings))}"

# Physics gate — refuse to deploy if the entropy beacon is stale.
# This binds every site deploy to a live physical process: deploys can
# happen only when production physics is producing distinct hashes at
# the expected cadence.  A frozen beacon = a frozen deploy.
#
# Override with DEPLOY_SKIP_PHYSICS_GATE=1 (use sparingly; defeats the
# whole point).
gate_on_beacon() {
  [ "${DEPLOY_SKIP_PHYSICS_GATE:-0}" = "1" ] && {
    echo "deploy: physics gate SKIPPED via DEPLOY_SKIP_PHYSICS_GATE=1" >&2
    return 0
  }
  local p1 p2 hex1 hex2 url="https://ledatic.org/entropy/pulse"
  local snap1 snap2
  snap1=$(curl -sf --max-time 5 "$url") || {
    echo "deploy: beacon unreachable ($url) — refusing deploy" >&2
    echo "        export DEPLOY_SKIP_PHYSICS_GATE=1 to override" >&2
    exit 4
  }
  p1=$(printf '%s' "$snap1" | python3 -c "import sys,json;print(json.load(sys.stdin)['pulse_id'])")
  hex1=$(printf '%s' "$snap1" | python3 -c "import sys,json;print(json.load(sys.stdin)['value_hex'])")
  sleep 4
  snap2=$(curl -sf --max-time 5 "$url") || {
    echo "deploy: beacon vanished mid-check — refusing deploy" >&2
    exit 4
  }
  p2=$(printf '%s' "$snap2" | python3 -c "import sys,json;print(json.load(sys.stdin)['pulse_id'])")
  hex2=$(printf '%s' "$snap2" | python3 -c "import sys,json;print(json.load(sys.stdin)['value_hex'])")
  if [ "$p1" = "$p2" ] || [ "$hex1" = "$hex2" ]; then
    echo "deploy: beacon is stale — pulse $p1 didn't advance in 4 s. Refusing deploy." >&2
    echo "        check com.ledatic.mhd; export DEPLOY_SKIP_PHYSICS_GATE=1 to force." >&2
    exit 4
  fi
  echo "deploy: physics gate ok — pulse $p1 → $p2 in 4 s"
}
gate_on_beacon

mime_of() {
  case "$1" in
    *.css)  echo "text/css" ;;
    *.js)   echo "application/javascript" ;;
    *.wasm) echo "application/wasm" ;;
    *.svg)  echo "image/svg+xml" ;;
    *.json) echo "application/json" ;;
    *.png)  echo "image/png" ;;
    *.jpg|*.jpeg) echo "image/jpeg" ;;
    *.webp) echo "image/webp" ;;
    *.frag) echo "text/plain; charset=utf-8" ;;
    *.xsl)  echo "text/xsl; charset=utf-8" ;;
    *.xml)  echo "application/atom+xml; charset=utf-8" ;;
    *.sh)   echo "text/x-shellscript; charset=utf-8" ;;
    *.pem)  echo "application/x-pem-file" ;;
    *.txt)  echo "text/plain; charset=utf-8" ;;
    *)      echo "text/html; charset=utf-8" ;;
  esac
}

key_to_url() {
  case "$1" in
    index.html) echo "$SITE_ORIGIN/" ;;
    *)          echo "$SITE_ORIGIN/$1" ;;
  esac
}

upload() {
  local file="$1" key="$2"
  local ct
  ct=$(mime_of "$key")
  local meta
  meta=$(mktemp)
  printf '{"ct":"%s"}' "$ct" > "$meta"
  echo "→ $key  ($ct)"
  local out
  out=$(curl -sS -X PUT \
    -H "Authorization: Bearer $CF_TOKEN" \
    -F "metadata=<$meta" \
    -F "value=@$file" \
    "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/storage/kv/namespaces/$CF_KV_NS/values/$key")
  rm -f "$meta"
  if ! echo "$out" | grep -q '"success":true'; then
    echo "  FAILED: $out" >&2
    return 1
  fi
  # Best-effort cache purge. Silently skips if token lacks Zone:Cache:Purge.
  curl -sS -X POST \
    -H "Authorization: Bearer $CF_TOKEN" \
    -H 'Content-Type: application/json' \
    --data "{\"files\":[\"$(key_to_url "$key")\"]}" \
    "https://api.cloudflare.com/client/v4/zones/$CF_ZONE/purge_cache" > /dev/null || true
}

# Compute short hashes for asset cache-busting (call before deploying HTML).
compute_asset_versions() {
  CSS_VER=$(shasum -a 256 _shared/site.css | cut -c1-8)
  JS_VER=$(shasum -a 256 _shared/site.js | cut -c1-8)
  # One hash over all .frag → a shader edit busts every shader ref. Shaders
  # are tiny so over-busting is free; closes the bare-path stale-edge gap.
  SHADER_VER=$(cat _shared/shaders/*.frag | shasum -a 256 | cut -c1-8)
  echo "asset versions: css=$CSS_VER  js=$JS_VER  shaders=$SHADER_VER"
}

# Rewrite _shared/site.{css,js} refs in $1 to include ?v=<hash>, upload result.
upload_html_versioned() {
  local rel="$1"
  local tmp
  tmp=$(mktemp)
  sed -e "s|_shared/site\.css|_shared/site.css?v=${CSS_VER}|g" \
      -e "s|_shared/site\.js|_shared/site.js?v=${JS_VER}|g" \
      -e "s|\(_shared/shaders/[A-Za-z0-9_-]*\.frag\)|\1?v=${SHADER_VER}|g" \
      "$rel" > "$tmp"
  upload "$tmp" "$rel"
  rm -f "$tmp"
}

deploy_one() {
  local rel="$1"
  [ -f "$rel" ] || { echo "no such file: $rel" >&2; exit 1; }
  case "$rel" in
    *.html)
      compute_asset_versions
      upload_html_versioned "$rel"
      ;;
    *)
      upload "$rel" "$rel"
      ;;
  esac
}

deploy_all() {
  compute_asset_versions
  # Top-level HTML pages — playground.html is intentionally not deployed
  # (orphan: not linked in nav, kept in repo for future use).
  for f in *.html; do
    [ -f "$f" ] || continue
    [ "$f" = "playground.html" ] && { echo "skip $f (orphan)"; continue; }
    upload_html_versioned "$f"
  done
  # Shared CSS + JS — uploaded at the canonical (unversioned) key. The
  # ?v=<hash> on HTML refs is purely a cache-buster; KV serves the same
  # content regardless of query string.
  upload "_shared/site.css" "_shared/site.css"
  upload "_shared/site.js"  "_shared/site.js"
  # Fragment shaders
  for f in _shared/shaders/*.frag; do
    [ -f "$f" ] || continue
    upload "$f" "$f"
  done
  # Photographic / static images (drop new ones in _shared/img/, no script edit needed)
  for f in _shared/img/*.jpg _shared/img/*.jpeg _shared/img/*.png _shared/img/*.webp; do
    [ -f "$f" ] || continue
    upload "$f" "$f"
  done
}

cd "$(dirname "$0")"
if [ $# -eq 0 ]; then
  deploy_all
else
  for arg in "$@"; do deploy_one "$arg"; done
fi
echo "done."
