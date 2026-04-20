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

mime_of() {
  case "$1" in
    *.css)  echo "text/css" ;;
    *.js)   echo "application/javascript" ;;
    *.wasm) echo "application/wasm" ;;
    *.svg)  echo "image/svg+xml" ;;
    *.json) echo "application/json" ;;
    *.png)  echo "image/png" ;;
    *.frag) echo "text/plain; charset=utf-8" ;;
    *.xsl)  echo "text/xsl; charset=utf-8" ;;
    *.xml)  echo "application/atom+xml; charset=utf-8" ;;
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

deploy_one() {
  local rel="$1"
  [ -f "$rel" ] || { echo "no such file: $rel" >&2; exit 1; }
  upload "$rel" "$rel"
}

deploy_all() {
  # 8 top-level HTML pages
  for f in *.html; do
    [ -f "$f" ] || continue
    upload "$f" "$f"
  done
  # Shared CSS + JS
  upload "_shared/site.css" "_shared/site.css"
  upload "_shared/site.js"  "_shared/site.js"
  # Fragment shaders
  for f in _shared/shaders/*.frag; do
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
