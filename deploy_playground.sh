#!/usr/bin/env bash
# deploy_playground.sh — Session C orchestration for shipping the
# public Rail playground v0 to https://ledatic.org/playground.
#
# STAGED. Every line that mutates production is comment-prefixed
#   # AUTHORIZED?
# so a reviewer can grep for the production-mutating ops:
#
#   grep -n '# AUTHORIZED?' deploy_playground.sh
#
# ## Pre-flight
#   - CF_TOKEN must be readable (default: ssh the Mini 'cat ~/.fleet/cf_token')
#   - wrangler installed (or curl-only fallback used; see notes per step)
#   - Mini reachable on Tailscale (its Tailscale IP)
#   - Session A binary built on Mini at
#     $HOME/projects/rail/tools/playground/compile_server
#
# ## Steps (each --from-step N skippable)
#   1. Mini service: scp plist, launchctl load, verify port :8090 listens
#   2. Worker bindings: write PLAYGROUND_BACKEND secret (via API)
#   3. Worker upload: invoke worker/deploy_worker.sh
#   4. KV upload: playground.html + _shared/rail_playground.js (cache-busted)
#   5. Smoke: curl /playground (HTML), POST /api/playground/compile (wasm)
#   6. Print DEPLOY OK with per-step timestamps
#
# ## Usage
#   ./deploy_playground.sh                  # full deploy (interactive)
#   ./deploy_playground.sh --from-step 3    # resume from step 3
#   ./deploy_playground.sh --dry-run        # echo every # AUTHORIZED? line, run nothing
#
# Co-located: rollback in this same file (--rollback flag).

set -euo pipefail

# ─── Config ────────────────────────────────────────────────────────────
# CF resource IDs + Mini host from a local, gitignored config (not committed).
# ~/.ledatic/cf_ids.env: CF_ACCOUNT=... CF_KV_NS=... MINI_HOST=... MINI_TS_IP=...
[ -f "$HOME/.ledatic/cf_ids.env" ] && . "$HOME/.ledatic/cf_ids.env"
: "${CF_ACCOUNT:?set CF_ACCOUNT (in ~/.ledatic/cf_ids.env)}"
: "${CF_KV_NS:?set CF_KV_NS (in ~/.ledatic/cf_ids.env)}"
CF_SCRIPT="ledatic"
: "${MINI_HOST:?set MINI_HOST (in ~/.ledatic/cf_ids.env)}"
: "${MINI_TS_IP:?set MINI_TS_IP (in ~/.ledatic/cf_ids.env)}"
MINI_PORT="8090"
PLAYGROUND_BACKEND_URL="http://${MINI_TS_IP}:${MINI_PORT}"
PROD_HOST="https://ledatic.org"
RAIL_REPO_MINI="$HOME/projects/rail"
PLAYGROUND_BIN="${RAIL_REPO_MINI}/tools/playground/compile_server"
LAUNCHD_PLIST_NAME="com.ledatic.playground.plist"

FROM_STEP="${FROM_STEP:-1}"
DRY_RUN="${DRY_RUN:-0}"
ROLLBACK="${ROLLBACK:-0}"

# Parse flags
while [ $# -gt 0 ]; do
  case "$1" in
    --from-step) FROM_STEP="$2"; shift 2 ;;
    --dry-run)   DRY_RUN=1; shift ;;
    --rollback)  ROLLBACK=1; shift ;;
    -h|--help)   sed -n '2,40p' "$0"; exit 0 ;;
    *)           echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

ts() { date "+%Y-%m-%dT%H:%M:%S%z"; }
say() { printf "[%s] %s\n" "$(ts)" "$*"; }
hr()  { printf -- "----------------------------------------------------------\n"; }

# Wrap any production-mutating line. In dry-run we just echo it and skip.
gate() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "  DRY-RUN # AUTHORIZED? would run: $*"
    return 0
  fi
  eval "$@"
}

# ─── Pre-flight ────────────────────────────────────────────────────────
preflight() {
  say "Pre-flight checks..."
  if [ -z "${CF_TOKEN:-}" ]; then
    say "  CF_TOKEN not in env. Trying ssh ${MINI_HOST} 'cat ~/.fleet/cf_token'..."
    CF_TOKEN=$(ssh "${MINI_HOST}" 'cat ~/.fleet/cf_token 2>/dev/null || cat ~/Desktop/rings' 2>/dev/null) || {
      echo "  FAIL: could not source CF_TOKEN" >&2
      echo "  Either: export CF_TOKEN=...; or fix Mini SSH access" >&2
      exit 10
    }
    export CF_TOKEN
    say "  CF_TOKEN sourced (${#CF_TOKEN} chars)"
  else
    say "  CF_TOKEN present (${#CF_TOKEN} chars)"
  fi

  say "  Checking Mini reachability..."
  ssh -o BatchMode=yes -o ConnectTimeout=5 "${MINI_HOST}" 'echo mini-ok' >/dev/null 2>&1 || {
    echo "  FAIL: Mini unreachable via ${MINI_HOST}" >&2
    exit 11
  }
  say "  Mini OK"

  say "  Checking Mini-side compile_server binary..."
  if ! ssh "${MINI_HOST}" "test -x ${PLAYGROUND_BIN}" 2>/dev/null; then
    say "  WARN: ${PLAYGROUND_BIN} missing on Mini."
    say "        On Mini, run: cd ${RAIL_REPO_MINI} && ./rail_native tools/playground/compile_server.rail && cp /tmp/rail_out tools/playground/compile_server"
    echo "  FAIL: pre-flight (compile_server not built on Mini)" >&2
    exit 12
  fi
  say "  Mini compile_server present"
}

# ─── Step 1: Mini service ──────────────────────────────────────────────
step1_mini_service() {
  hr; say "STEP 1/5: Mini launchd service"
  say "  Copying plist to Mini..."
  # AUTHORIZED?  scp plist to Mini's LaunchAgents
  gate scp -p "${RAIL_REPO_MINI}/tools/playground/${LAUNCHD_PLIST_NAME}" "${MINI_HOST}:~/Library/LaunchAgents/${LAUNCHD_PLIST_NAME}" || {
    say "  NOTE: plist not in Mini repo yet — scp from Studio worktree:"
    # AUTHORIZED?  fallback scp from studio repo
    gate scp -p "$HOME/projects/rail/tools/playground/${LAUNCHD_PLIST_NAME}" "${MINI_HOST}:~/Library/LaunchAgents/${LAUNCHD_PLIST_NAME}"
  }
  say "  Loading via launchctl..."
  # AUTHORIZED?  unload-then-load avoids stale "already loaded" errors
  gate ssh "${MINI_HOST}" "launchctl unload ~/Library/LaunchAgents/${LAUNCHD_PLIST_NAME} 2>/dev/null; launchctl load ~/Library/LaunchAgents/${LAUNCHD_PLIST_NAME}"
  # AUTHORIZED?  start the agent (KeepAlive will respawn but explicit start is idempotent)
  gate ssh "${MINI_HOST}" "launchctl start com.ledatic.playground"
  say "  Verifying listener on :${MINI_PORT}..."
  sleep 2
  if [ "$DRY_RUN" = "0" ]; then
    ssh "${MINI_HOST}" "lsof -nP -iTCP:${MINI_PORT} -sTCP:LISTEN" || {
      echo "  FAIL: nothing listening on :${MINI_PORT} after launchctl start" >&2
      ssh "${MINI_HOST}" "tail -20 ~/Library/Logs/ledatic-playground.err 2>/dev/null || true"
      exit 21
    }
  fi
  say "  Step 1 OK"
}

# ─── Step 2: Worker secret + bindings ──────────────────────────────────
step2_worker_bindings() {
  hr; say "STEP 2/5: Worker secret PLAYGROUND_BACKEND"
  # The deploy_worker.sh upload includes binding metadata. Adding
  # PLAYGROUND_BACKEND requires augmenting that metadata block; we do it
  # here via the inline-binding API (or the user can edit deploy_worker.sh
  # to include it permanently — preferred).
  say "  Setting PLAYGROUND_BACKEND=${PLAYGROUND_BACKEND_URL} via Workers script-settings API"
  local META
  META=$(mktemp)
  cat > "$META" <<JSON
{
  "bindings": [
    {"type":"plain_text","name":"PLAYGROUND_BACKEND","text":"${PLAYGROUND_BACKEND_URL}"}
  ]
}
JSON
  # AUTHORIZED?  PATCH the script settings to add the env var binding
  gate curl -sS -X PATCH \
    -H "Authorization: Bearer ${CF_TOKEN}" \
    -H "Content-Type: application/json" \
    --data-binary "@${META}" \
    "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/workers/scripts/${CF_SCRIPT}/settings"
  rm -f "$META"
  echo
  say "  Step 2 OK (PLAYGROUND_BACKEND staged; full binding set re-applied in step 3)"
}

# ─── Step 3: Worker upload ─────────────────────────────────────────────
step3_worker_upload() {
  hr; say "STEP 3/5: Worker upload (worker/worker.js)"
  # AUTHORIZED?  re-upload Worker — preserves bindings via deploy_worker.sh metadata block
  gate "$(dirname "$0")/worker/deploy_worker.sh"
  say "  Step 3 OK"
}

# ─── Step 4: KV upload (cache-busted HTML + shim) ──────────────────────
step4_kv_upload() {
  hr; say "STEP 4/5: KV upload — playground.html + rail_playground.js"
  # The repo's deploy.sh already handles cache-bust on _shared/site.{css,js}
  # refs in HTML. playground.html ALSO references _shared/rail_playground.js;
  # that ref is plain (no version) but we upload the shim under the same
  # canonical key so cache invalidation is purely time-based on the shim
  # (its own ?v= bust isn't wired in playground.html v0 — acceptable since
  # the shim only changes across full deploys).
  cd "$(dirname "$0")"
  # AUTHORIZED?  upload playground.html (with site.css?v= bust applied by deploy.sh)
  gate ./deploy.sh playground.html
  # AUTHORIZED?  upload _shared/rail_playground.js (the shim Session B added)
  gate ./deploy.sh _shared/rail_playground.js
  say "  Step 4 OK"
}

# ─── Step 5: smoke ─────────────────────────────────────────────────────
step5_smoke() {
  hr; say "STEP 5/5: production smoke"
  if [ "$DRY_RUN" = "1" ]; then
    say "  DRY-RUN: skipping live smoke"
    return 0
  fi
  say "  GET ${PROD_HOST}/playground (expect HTTP 200, content-type html)"
  local headers
  headers=$(curl -sI "${PROD_HOST}/playground" || true)
  echo "$headers" | head -5 | sed 's/^/    /'
  echo "$headers" | grep -qi "^HTTP/.* 200" || { echo "  FAIL: /playground not 200" >&2; exit 51; }
  echo "$headers" | grep -qi "content-type:.*html" || { echo "  FAIL: /playground not HTML" >&2; exit 52; }
  say "  POST ${PROD_HOST}/api/playground/compile (expect ok:true + wasm_b64)"
  local resp
  resp=$(curl -s -X POST "${PROD_HOST}/api/playground/compile" \
    -H "content-type: application/json" \
    --data '{"src":"main = 42"}')
  echo "  resp first 200: $(printf '%s' "$resp" | head -c 200)"
  printf '%s' "$resp" | grep -q '"ok":true' || { echo "  FAIL: compile not ok" >&2; exit 53; }
  printf '%s' "$resp" | grep -q '"wasm_b64":"' || { echo "  FAIL: no wasm_b64" >&2; exit 54; }

  # WASM exit-42 instantiation check via jsc (Apple's JS engine).
  say "  Instantiating returned WASM under jsc to verify exit=42..."
  local jsc=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
  if [ ! -x "$jsc" ]; then
    say "  WARN: jsc not present; skipping wasm exec verification"
  else
    local wasm_b64
    wasm_b64=$(printf '%s' "$resp" | python3 -c "import sys,json;print(json.load(sys.stdin)['wasm_b64'])")
    local harness
    harness=$(mktemp /tmp/pg_smoke_XXXXXX.mjs)
    cat > "$harness" <<JSEOF
const b64 = "${wasm_b64}";
const bin = atob(b64);
const u8 = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
let exitCode = -1;
const imports = { wasi_snapshot_preview1: {
  fd_write: () => 0,
  proc_exit: (c) => { exitCode = c|0; throw new Error("exit:"+c); }
}};
try {
  const m = await WebAssembly.instantiate(u8, imports);
  m.instance.exports._start();
} catch (e) {}
print("EXIT=" + exitCode);
if (typeof quit === "function") quit(exitCode === 42 ? 0 : 1);
JSEOF
    if "$jsc" -m "$harness" 2>&1 | tee /tmp/pg_smoke_jsc.log | grep -q '^EXIT=42'; then
      say "  jsc verified exit=42"
    else
      echo "  FAIL: wasm exit != 42" >&2
      cat /tmp/pg_smoke_jsc.log
      exit 55
    fi
    rm -f "$harness"
  fi
  say "  Step 5 OK"
}

# ─── Step 6: summary ───────────────────────────────────────────────────
step6_summary() {
  hr
  say "DEPLOY OK"
  say "  Mini service:    ${MINI_TS_IP}:${MINI_PORT} (com.ledatic.playground)"
  say "  Worker:          ${CF_SCRIPT} (PLAYGROUND_BACKEND=${PLAYGROUND_BACKEND_URL})"
  say "  Public URL:      ${PROD_HOST}/playground"
  say "  Metrics:         curl -H 'Authorization: Bearer \$API_BEARER' ${PROD_HOST}/api/playground/metrics"
  say "  Acceptance:      ./tests/playground_acceptance.sh"
  say "  Rollback:        $0 --rollback"
}

# ─── Rollback (in-file; same # AUTHORIZED? gating) ─────────────────────
rollback() {
  hr; say "ROLLBACK starting"
  # AUTHORIZED?  stop + unload Mini service
  gate ssh "${MINI_HOST}" "launchctl unload ~/Library/LaunchAgents/${LAUNCHD_PLIST_NAME} 2>/dev/null || true"
  say "  Mini service stopped"
  # AUTHORIZED?  remove plist (so a Mini reboot doesn't auto-resurrect)
  gate ssh "${MINI_HOST}" "rm -f ~/Library/LaunchAgents/${LAUNCHD_PLIST_NAME}"
  say "  Mini plist removed"
  # AUTHORIZED?  unset PLAYGROUND_BACKEND so the Worker returns 503 cleanly
  local META
  META=$(mktemp)
  cat > "$META" <<JSON
{
  "bindings": [
    {"type":"plain_text","name":"PLAYGROUND_BACKEND","text":""}
  ]
}
JSON
  # AUTHORIZED?  blank the secret (Worker handler returns 503 "playground backend not configured")
  gate curl -sS -X PATCH \
    -H "Authorization: Bearer ${CF_TOKEN}" \
    -H "Content-Type: application/json" \
    --data-binary "@${META}" \
    "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/workers/scripts/${CF_SCRIPT}/settings"
  rm -f "$META"
  echo
  say "  Worker binding cleared. (Static playground.html stays; Run button will surface a clean 503.)"
  # NOTE: To restore a prior worker.js or playground.html, use the backups
  # under ~/ledatic-site/worker_backups/ (deploy_worker.sh writes them) and
  # KV history (Cloudflare retains the previous value briefly; for stronger
  # guarantees, keep a known-good HTML in git and re-deploy via deploy.sh).
  say "ROLLBACK done"
}

# ─── Main ──────────────────────────────────────────────────────────────
main() {
  if [ "$ROLLBACK" = "1" ]; then
    preflight
    rollback
    exit 0
  fi

  preflight
  if [ "$FROM_STEP" -le 1 ]; then step1_mini_service;  fi
  if [ "$FROM_STEP" -le 2 ]; then step2_worker_bindings; fi
  if [ "$FROM_STEP" -le 3 ]; then step3_worker_upload;   fi
  if [ "$FROM_STEP" -le 4 ]; then step4_kv_upload;       fi
  if [ "$FROM_STEP" -le 5 ]; then step5_smoke;           fi
  step6_summary
}

main "$@"
