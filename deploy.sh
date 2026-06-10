#!/usr/bin/env bash
# Deploy static pages to Cloudflare KV.
# Usage:
#   ./deploy.sh              # deploy all pages (token auto-read from ~/.fleet/cf_token)
#   ./deploy.sh index.html   # deploy one file
#   CF_TOKEN=... ./deploy.sh # explicit token override
#
# KV key convention: relative path from repo root, except index.html lives at
# the key "index.html" and the Worker mounts it at "/".

set -euo pipefail

# CF resource IDs from a local, gitignored config (not committed). Create
# ~/.ledatic/cf_ids.env with: CF_ACCOUNT=... CF_KV_NS=... CF_ZONE=...
[ -f "$HOME/.ledatic/cf_ids.env" ] && . "$HOME/.ledatic/cf_ids.env"
: "${CF_ACCOUNT:?set CF_ACCOUNT (in ~/.ledatic/cf_ids.env)}"
: "${CF_KV_NS:?set CF_KV_NS (in ~/.ledatic/cf_ids.env)}"
: "${CF_ZONE:?set CF_ZONE (in ~/.ledatic/cf_ids.env)}"
SITE_ORIGIN="https://ledatic.org"

# Token: env override > ~/.fleet/cf_token (TCC-safe for launchd) > ~/Desktop/rings (legacy)
if [ -z "${CF_TOKEN:-}" ]; then
  CF_TOKEN=$(cat "$HOME/.fleet/cf_token" 2>/dev/null || cat "$HOME/Desktop/rings" 2>/dev/null || true)
fi
: "${CF_TOKEN:?set CF_TOKEN or create ~/.fleet/cf_token}"

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
  # HTML pages are served at the extensionless canonical route (/rail), so
  # purge both that and the raw key URL. Post-deploy verify catches any
  # purge that didn't take.
  local purge_urls
  purge_urls="\"$(key_to_url "$key")\""
  case "$key" in
    index.html) ;;  # key URL is already the canonical /
    *.html) purge_urls="$purge_urls,\"$(page_url "$key")\"" ;;
  esac
  curl -sS -X POST \
    -H "Authorization: Bearer $CF_TOKEN" \
    -H 'Content-Type: application/json' \
    --data "{\"files\":[$purge_urls]}" \
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
# Idempotent: an existing ?v=<stamp> in the source (e.g. aliens.html ships
# with hardcoded stamps) is replaced, never double-stamped.
upload_html_versioned() {
  local rel="$1"
  local tmp
  tmp=$(mktemp)
  sed -E \
      -e "s|_shared/site\.css(\?v=[0-9A-Za-z]+)?|_shared/site.css?v=${CSS_VER}|g" \
      -e "s|_shared/site\.js(\?v=[0-9A-Za-z]+)?|_shared/site.js?v=${JS_VER}|g" \
      -e "s|(_shared/shaders/[A-Za-z0-9_-]+\.frag)(\?v=[0-9A-Za-z]+)?|\1?v=${SHADER_VER}|g" \
      "$rel" > "$tmp"
  upload "$tmp" "$rel"
  rm -f "$tmp"
}

# ── Post-deploy verification ────────────────────────────────────────────
# Fetch routes live and confirm the bytes we just uploaded are actually
# being served (marker = the fresh ?v= stamp where available). Retries
# briefly to ride out edge-cache lag, then fails the deploy (exit 5) so a
# deploy that didn't take effect can never pass silently.
VERIFY_FAILS=0

verify_route() {
  local url="$1" marker="$2" tries=3 body
  while :; do
    if body=$(curl -sf --max-time 10 "$url") \
       && printf '%s' "$body" | grep -qF -- "$marker"; then
      echo "verify ok   $url"
      return 0
    fi
    tries=$((tries - 1))
    if [ "$tries" -le 0 ]; then
      echo "verify FAIL $url (marker not served: $marker)" >&2
      VERIFY_FAILS=$((VERIFY_FAILS + 1))
      return 0
    fi
    sleep 5
  done
}

# Canonical user-facing URL for a repo file (pages serve extensionless).
page_url() {
  case "$1" in
    index.html) echo "$SITE_ORIGIN/" ;;
    *.html)     echo "$SITE_ORIGIN/${1%.html}" ;;
    *)          echo "$SITE_ORIGIN/$1" ;;
  esac
}

# Verify one deployed HTML page at its canonical route. Pages referencing
# the shared CSS are checked for the fresh stamp (proves new bytes are
# live); others fall back to their <title> text (proves the page itself is
# served, not the extensionless homepage fallback).
verify_one_html() {
  local rel="$1" marker
  if grep -q '_shared/site\.css' "$rel"; then
    marker="_shared/site.css?v=${CSS_VER}"
  else
    marker=$(tr -d '\n' < "$rel" \
      | sed -n 's|.*<title>\([^<]*\)</title>.*|\1|p' | cut -c1-40)
  fi
  verify_route "$(page_url "$rel")" "$marker"
}

verify_finish() {
  if [ "$VERIFY_FAILS" -gt 0 ]; then
    echo "deploy: POST-DEPLOY VERIFY FAILED ($VERIFY_FAILS route(s)) — live site does not match this deploy" >&2
    exit 5
  fi
  echo "verify: live routes match this deploy"
}

verify_deploy_all() {
  echo "— post-deploy verify —"
  verify_route "$SITE_ORIGIN/"        "_shared/site.css?v=${CSS_VER}"
  verify_route "$SITE_ORIGIN/rail"    "_shared/site.css?v=${CSS_VER}"
  verify_route "$SITE_ORIGIN/entropy" "_shared/shaders/beacon.frag?v=${SHADER_VER}"
  verify_route "$SITE_ORIGIN/_shared/site.css" "."
  verify_route "$SITE_ORIGIN/_shared/site.js"  "."
  verify_route "$SITE_ORIGIN/_shared/shaders/beacon.frag" "."
  verify_finish
}

deploy_one() {
  local rel="$1"
  [ -f "$rel" ] || { echo "no such file: $rel" >&2; exit 1; }
  case "$rel" in
    *.html)
      compute_asset_versions
      upload_html_versioned "$rel"
      verify_one_html "$rel"
      ;;
    *)
      upload "$rel" "$rel"
      verify_route "$(page_url "$rel")" "."
      ;;
  esac
}

deploy_all() {
  compute_asset_versions
  # Top-level HTML pages — playground.html is live at /playground but deploys
  # only via deploy_playground.sh, which keeps the HTML in lockstep with its
  # rail_playground.js + WASM worker pieces. Refreshing the HTML alone here
  # could desync it from those assets.
  for f in *.html; do
    [ -f "$f" ] || continue
    [ "$f" = "playground.html" ] && { echo "skip $f (deploys via deploy_playground.sh)"; continue; }
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
  verify_deploy_all
else
  for arg in "$@"; do deploy_one "$arg"; done
  verify_finish
fi
echo "done."
