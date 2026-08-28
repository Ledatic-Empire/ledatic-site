#!/usr/bin/env bash
# Deploy static pages to Cloudflare KV — proof-native pipeline (spec §5.4, §8 Wave 0).
#
# Usage:
#   ./deploy.sh              # full deploy: gates → stage → upload → sign → byte-diff
#   ./deploy.sh index.html   # deploy one file (gated; signed manifest NOT updated)
#   CF_TOKEN=... ./deploy.sh # explicit token override
#
# Pipeline (full deploy):
#   1. clean-tree check      git status -s must be empty (DEPLOY_ALLOW_DIRTY=1 overrides)
#   2. stats generation      tools/gen_stats.sh → _shared/stats.json (substrate-derived)
#   3. honesty gate          tools/honesty_gate.sh — nonzero exit BLOCKS the deploy
#   4. physics gate          the entropy beacon must be advancing
#   5. stage                 final bytes per file: Figure injection (HTML) + ?v= stamps
#   6. upload                staged bytes → KV
#   7. sign                  Ed25519 deploy manifest (file list + sha256s + pulse_id),
#                            published at attest/site/<n>.json + attest/site/latest.json
#   8. byte-diff verify      fetch every uploaded file, sha256 vs the signed manifest;
#                            mismatch → one re-upload retry, then exit nonzero loudly
#
# Signing key: ~/.ledatic/secrets/site_deploy_ed25519.pem — DEDICATED site-deploy
# keypair (generated 2026-06-10, never shared with witness/fleet infrastructure).
# Public half committed at attest/site_deploy.pub.pem.
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
SIGN_KEY="$HOME/.ledatic/secrets/site_deploy_ed25519.pem"
SIGN_PUB="attest/site_deploy.pub.pem"
STATS="_shared/stats.json"

# Token: env override > ~/.fleet/cf_token (TCC-safe for launchd) > ~/Desktop/rings (legacy)
if [ -z "${CF_TOKEN:-}" ]; then
  CF_TOKEN=$(cat "$HOME/.fleet/cf_token" 2>/dev/null || cat "$HOME/Desktop/rings" 2>/dev/null || true)
fi
: "${CF_TOKEN:?set CF_TOKEN or create ~/.fleet/cf_token}"

# Staging area: the exact bytes we upload live here until verification is
# done, so the byte-diff retry can re-upload identical content.
STAGE_DIR=$(mktemp -d)
MANIFEST_TSV="$STAGE_DIR/.manifest.tsv"   # key<TAB>sha256<TAB>bytes
SKIPPED=0; WRITTEN=0                       # KV write accounting (free tier: 1k/day)
: > "$MANIFEST_TSV"
trap 'rm -rf "$STAGE_DIR"' EXIT

# ── Gate 0: clean tree (house rule) ─────────────────────────────────────
# Half-merged files and conflict markers must never reach live KV. The
# generated _shared/stats.json is exempt (it is a deploy artifact).
check_clean_tree() {
  if [ "${DEPLOY_ALLOW_DIRTY:-0}" = "1" ]; then
    echo "deploy: clean-tree check SKIPPED via DEPLOY_ALLOW_DIRTY=1" >&2
    return 0
  fi
  local dirty
  dirty=$(git status -s | grep -vE '^\?\? _shared/stats\.json$' || true)
  if [ -n "$dirty" ]; then
    echo "deploy: working tree not clean — refusing to deploy:" >&2
    echo "$dirty" >&2
    echo "        commit/stash first, or DEPLOY_ALLOW_DIRTY=1 to override." >&2
    exit 2
  fi
}

# ── Gate 1: substrate stats (no human types these numbers) ──────────────
gen_stats() {
  ./tools/gen_stats.sh || { echo "deploy: stats generation failed" >&2; exit 3; }
}

# ── Gate 2: honesty CI gate — nonzero exit blocks the deploy ────────────
honesty_gate() {
  ./tools/honesty_gate.sh || {
    echo "deploy: HONESTY GATE FAILED — deploy blocked. Fix the page or, for a" >&2
    echo "        legitimately true line, anchor it in tools/honesty_allowlist.txt." >&2
    exit 3
  }
}

# ── Gate 2b: citations — every proof affordance must resolve ────────────
# The honesty gate proves our NUMBERS come from the substrate. This proves
# our PROOFS are takeable: prove-button manifests, figure provenance URLs,
# and published curl recipes all have to resolve (live, or in this deploy).
# A dead proof link fails exactly the reader who believed us and tried.
#
# Override with DEPLOY_SKIP_CITATION_GATE=1 (same spirit as the physics
# skip: available, but it defeats the point).
# ── Gate 2c: the public ledger matches the release history ─────────────
# /changelog and CHANGELOG.md were both hand-maintained and had drifted in
# both directions: the page was missing six releases including the two most
# recent, while listing five the changelog never documented. Nothing
# compared them, on a site whose argument is that you can check its claims.
changelog_gate() {
  python3 ./tools/changelog_gate.py --quiet || {
    echo "deploy: CHANGELOG GATE FAILED - deploy blocked. Add the release to" >&2
    echo "        /changelog, or document it in CHANGELOG.md, whichever is" >&2
    echo "        actually missing." >&2
    exit 3
  }
}

citation_gate() {
  [ "${DEPLOY_SKIP_CITATION_GATE:-0}" = "1" ] && {
    echo "deploy: citation gate SKIPPED via DEPLOY_SKIP_CITATION_GATE=1" >&2
    return 0
  }
  python3 ./tools/citation_gate.py --quiet || {
    echo "deploy: CITATION GATE FAILED — deploy blocked. Either restore the" >&2
    echo "        cited artifact, or stop offering the proof." >&2
    exit 3
  }
}

# ── Gate 3: physics — refuse to deploy if the entropy beacon is stale ───
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
  local p1 p2 hex1 hex2 url="$SITE_ORIGIN/entropy/pulse"
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
    echo "        check the beacon publisher; export DEPLOY_SKIP_PHYSICS_GATE=1 to force." >&2
    exit 4
  fi
  echo "deploy: physics gate ok — pulse $p1 → $p2 in 4 s"
}

# ── Gate 4: signing pre-flight (full deploys only) ──────────────────────
# A full deploy that uploads everything and THEN discovers it can't sign
# (key missing/unreadable, or a LibreSSL openssl without Ed25519 -rawin)
# leaves the live site updated but unattested. Prove the whole sign+verify
# path with the real key pair BEFORE the first upload.
gate_on_signing() {
  [ -f "$SIGN_KEY" ] || {
    echo "deploy: signing key missing at $SIGN_KEY — every full deploy must be signed." >&2
    echo "        generate: openssl genpkey -algorithm ed25519 -out $SIGN_KEY && chmod 600 $SIGN_KEY" >&2
    exit 7
  }
  [ -f "$SIGN_PUB" ] || { echo "deploy: $SIGN_PUB missing from repo" >&2; exit 7; }
  local d; d=$(mktemp -d)
  printf 'site-deploy|preflight' > "$d/msg"
  if ! openssl pkeyutl -sign -inkey "$SIGN_KEY" -rawin -in "$d/msg" -out "$d/sig" 2>"$d/err" \
     || ! openssl pkeyutl -verify -pubin -inkey "$SIGN_PUB" -rawin -in "$d/msg" -sigfile "$d/sig" >/dev/null 2>>"$d/err"; then
    echo "deploy: Ed25519 sign/verify pre-flight FAILED — refusing to start an unattestable deploy" >&2
    cat "$d/err" >&2
    rm -rf "$d"; exit 7
  fi
  rm -rf "$d"
  echo "deploy: signing pre-flight ok — $(openssl version)"
}

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
    *.woff2) echo "font/woff2" ;;
    *.txt)  echo "text/plain; charset=utf-8" ;;
    *.py)   echo "text/plain; charset=utf-8" ;;
    *.jsonl) echo "application/jsonl" ;;
    *.sha256) echo "text/plain; charset=utf-8" ;;
    *)      echo "text/html; charset=utf-8" ;;
  esac
}

key_to_url() {
  case "$1" in
    index.html) echo "$SITE_ORIGIN/" ;;
    *)          echo "$SITE_ORIGIN/$1" ;;
  esac
}

# Canonical user-facing URL for a repo file (pages serve extensionless).
page_url() {
  case "$1" in
    index.html) echo "$SITE_ORIGIN/" ;;
    *.html)     echo "$SITE_ORIGIN/${1%.html}" ;;
    *)          echo "$SITE_ORIGIN/$1" ;;
  esac
}

# ── Only write keys whose bytes actually changed ────────────────────────
#
# Every deploy used to rewrite all ~85 KV keys whether or not a byte moved.
# Cloudflare's free tier allows 1,000 KV writes a day, and the standing
# budget already spends most of it: the fleet0 witness persists roughly 480
# a day and /fleet/status.json another 144. Four site deploys on 2026-08-28
# spent ~340 more and exhausted the quota, at which point every KV write
# started failing with error 10048. That did not look like a quota problem
# from the outside: the witness PUT throws inside the Worker, Cloudflare
# serves 1101, and the self-healer's circuit breaker tripped on a witness
# that had gone silent while the Pi was healthy and signing normally.
#
# A deploy that changes one page should cost one write, not eighty-five.
# The previous signed manifest already records a sha256 for every key, so
# it is the natural comparison. Skipping is safe because the manifest is
# built from staged files rather than from uploads, and because step 8
# byte-diffs the LIVE site against the new manifest afterwards: if a key
# was skipped but is genuinely missing upstream, that check fails loudly.
#
# This only became possible today. Until gen_stats stopped re-anchoring the
# beacon pulse on every run, identical content produced different bytes
# each deploy, so nothing would ever have compared equal.
PREV_SHA_FILE="$STAGE_DIR/.prev_manifest.tsv"

load_prev_manifest() {
  : > "$PREV_SHA_FILE"
  curl -s --max-time 15 -H "User-Agent: Mozilla/5.0 Chrome/126" \
    "https://ledatic.org/attest/site/latest.json" 2>/dev/null \
    | python3 -c '
import sys, json
try:
    m = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for e in m.get("files", []):
    k, h = e.get("key"), e.get("sha256")
    if k and h:
        print(f"{k}\t{h}")
' > "$PREV_SHA_FILE" 2>/dev/null || true
  local n
  n=$(wc -l < "$PREV_SHA_FILE" | tr -d " ")
  echo "deploy: previous manifest has $n keys; unchanged keys will be skipped"
}

prev_sha() {
  [ -s "$PREV_SHA_FILE" ] || return 1
  awk -F'\t' -v k="$1" '$1 == k { print $2; found=1; exit } END { exit !found }' "$PREV_SHA_FILE"
}

upload() {
  local file="$1" key="$2"
  local ct
  ct=$(mime_of "$key")
  # Skip the write when the bytes are identical to what is already live.
  local now_sha old_sha
  now_sha=$(shasum -a 256 "$file" | cut -d" " -f1)
  if old_sha=$(prev_sha "$key" 2>/dev/null) && [ "$old_sha" = "$now_sha" ]; then
    echo "= $key  (unchanged, no KV write)"
    SKIPPED=$((SKIPPED + 1))
    return 0
  fi
  WRITTEN=$((WRITTEN + 1))
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

# Compute short hashes for asset cache-busting (call before staging HTML).
compute_asset_versions() {
  CSS_VER=$(shasum -a 256 _shared/site.css | cut -c1-8)
  JS_VER=$(shasum -a 256 _shared/site.js | cut -c1-8)
  # One hash over all .frag → a shader edit busts every shader ref. Shaders
  # are tiny so over-busting is free; closes the bare-path stale-edge gap.
  SHADER_VER=$(cat _shared/shaders/*.frag | shasum -a 256 | cut -c1-8)
  # Per-file ?v= stamps for EVERY shared css/js — historically only
  # site.css/site.js were stamped and shader/asset edits served stale from
  # the CF edge (documented bug class). Each file gets its own hash so an
  # edit busts exactly its own refs.
  STAMP_SED_ARGS=()
  local f base h
  for f in _shared/*.css _shared/*.js; do
    [ -f "$f" ] || continue
    base=$(basename "$f")
    h=$(shasum -a 256 "$f" | cut -c1-8)
    STAMP_SED_ARGS+=(-e "s|_shared/${base//./\\.}(\?v=[0-9A-Za-z]+)?|_shared/${base}?v=${h}|g")
  done
  echo "asset versions: css=$CSS_VER  js=$JS_VER  shaders=$SHADER_VER  (+$((${#STAMP_SED_ARGS[@]}/2)) shared files stamped per-file)"
}

# Record a staged file in the deploy manifest (key, sha256, byte count).
record_manifest() {
  local key="$1" dst="$STAGE_DIR/$1"
  local sha bytes
  sha=$(shasum -a 256 "$dst" | cut -d' ' -f1)
  bytes=$(stat -f%z "$dst")
  printf '%s\t%s\t%s\n' "$key" "$sha" "$bytes" >> "$MANIFEST_TSV"
}

# Stage a non-HTML file verbatim.
stage_raw() {
  local rel="$1" dst="$STAGE_DIR/$1"
  mkdir -p "$(dirname "$dst")"
  cp "$rel" "$dst"
  record_manifest "$rel"
}

# Stage an HTML page: Figure injection (substrate stats → <data class="fig">
# elements, spec §5.4 — the injector owns the SI rounding rule via
# gen_stats.sh) then ?v=<hash> stamping of shared-asset refs. Idempotent:
# an existing ?v=<stamp> or stale Figure text is replaced, never doubled.
# An unresolved Figure (unknown data-src) makes the injector exit nonzero
# and aborts the deploy.
stage_html_versioned() {
  local rel="$1" dst="$STAGE_DIR/$1"
  mkdir -p "$(dirname "$dst")"
  python3 tools/inject_figures.py "$STATS" "$rel" | sed -E \
      "${STAMP_SED_ARGS[@]}" \
      -e "s|(_shared/shaders/[A-Za-z0-9_-]+\.frag)(\?v=[0-9A-Za-z]+)?|\1?v=${SHADER_VER}|g" \
      > "$dst"
  record_manifest "$rel"
}

# ── Signed deploy manifest (spec §5.4) ──────────────────────────────────
# The manifest is the deploy's attestation: every uploaded key + sha256 +
# byte count, anchored to the live beacon pulse, Ed25519-signed with the
# dedicated site-deploy key. Published at attest/site/<n>.json and
# attest/site/latest.json — the /replay ledger and every page's runtime
# self-check read these.
#
# Canonical signed message (exact bytes, no trailing newline):
#   site-deploy|v1|<n>|<files_digest>|<pulse_id>|<deployed_at>
# where files_digest = sha256 over "key<SP>sha256<LF>" lines sorted by key
# in BYTE ORDER (LC_ALL=C). Locale collation is machine-dependent and broke
# the in-browser recompute for deploys 1-4 (caught live 2026-06-10).
publish_signed_manifest() {
  [ -f "$SIGN_KEY" ] || {
    echo "deploy: signing key missing at $SIGN_KEY — every full deploy must be signed." >&2
    echo "        generate: openssl genpkey -algorithm ed25519 -out $SIGN_KEY && chmod 600 $SIGN_KEY" >&2
    exit 7
  }
  [ -f "$SIGN_PUB" ] || { echo "deploy: $SIGN_PUB missing from repo" >&2; exit 7; }

  # Sequence number: live pointer + 1 (first signed deploy = 1).
  # Only an explicit 404 means "no manifest yet". Any other failure aborts:
  # treating a transient fetch error as prev=0 would re-issue an existing
  # sequence number and silently overwrite a published manifest.
  local prev n code body
  body=$(curl -s --max-time 8 -w $'\n%{http_code}' "$SITE_ORIGIN/attest/site/latest.json" 2>/dev/null) || body=$'\n000'
  code=${body##*$'\n'}
  if [ "$code" = "404" ]; then
    prev=0
  elif [ "$code" = "200" ]; then
    prev=$(printf '%s' "${body%$'\n'*}" \
      | python3 -c "import sys,json;print(json.load(sys.stdin)['n'])" 2>/dev/null) || true
    case "$prev" in (''|*[!0-9]*)
      echo "deploy: attest/site/latest.json returned 200 but no usable 'n' — refusing to guess a sequence number" >&2
      exit 7 ;;
    esac
  else
    echo "deploy: could not read attest/site/latest.json (HTTP $code) — refusing to guess a sequence number" >&2
    exit 7
  fi
  n=$((prev + 1))

  # Pulse anchor — a deploy manifest without a pulse is not a manifest.
  local snap pulse vhex deployed_at
  snap=$(curl -sf --max-time 8 "$SITE_ORIGIN/entropy/pulse") || {
    echo "deploy: beacon unreachable — cannot pulse-anchor the deploy manifest" >&2
    exit 7
  }
  pulse=$(printf '%s' "$snap" | python3 -c "import sys,json;print(json.load(sys.stdin)['pulse_id'])")
  vhex=$(printf '%s' "$snap" | python3 -c "import sys,json;print(json.load(sys.stdin)['value_hex'])")
  deployed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  local files_digest msg sig_b64 pub_fp
  files_digest=$(LC_ALL=C sort "$MANIFEST_TSV" | awk -F'\t' '{printf "%s %s\n", $1, $2}' | shasum -a 256 | cut -d' ' -f1)
  msg="site-deploy|v1|$n|$files_digest|$pulse|$deployed_at"
  printf '%s' "$msg" > "$STAGE_DIR/.sign_msg"
  openssl pkeyutl -sign -inkey "$SIGN_KEY" -rawin -in "$STAGE_DIR/.sign_msg" -out "$STAGE_DIR/.sign_sig"
  sig_b64=$(base64 < "$STAGE_DIR/.sign_sig" | tr -d '\n')
  pub_fp=$(openssl pkey -pubin -in "$SIGN_PUB" -outform DER | shasum -a 256 | cut -d' ' -f1)

  mkdir -p "$STAGE_DIR/attest/site"
  MANIFEST_TSV="$MANIFEST_TSV" N="$n" PULSE="$pulse" VHEX="$vhex" \
  DEPLOYED_AT="$deployed_at" FILES_DIGEST="$files_digest" MSG="$msg" \
  SIG_B64="$sig_b64" PUB_FP="$pub_fp" STATS="$STATS" \
  OUT="$STAGE_DIR/attest/site/$n.json" python3 <<'PYEOF'
import json, os
files = []
with open(os.environ["MANIFEST_TSV"]) as f:
    for line in f:
        key, sha, size = line.rstrip("\n").split("\t")
        files.append({"key": key, "sha256": sha, "bytes": int(size)})
files.sort(key=lambda e: e["key"])
stats_meta = {}
try:
    s = json.load(open(os.environ["STATS"]))
    stats_meta = {"stats_generated_at": s.get("generated_at"), "stats_pulse_id": s.get("pulse_id")}
except Exception:
    pass
out = {
    "kind": "ledatic.site.deploy",
    "version": 1,
    "n": int(os.environ["N"]),
    "deployed_at": os.environ["DEPLOYED_AT"],
    "pulse_id": int(os.environ["PULSE"]),
    "pulse_value_hex": os.environ["VHEX"],
    "files": files,
    "files_digest": os.environ["FILES_DIGEST"],
    "files_digest_rule": "sha256 over 'key<SP>sha256<LF>' lines sorted by key (byte order)",
    "signed_message": os.environ["MSG"],
    "signature_b64": os.environ["SIG_B64"],
    "pubkey": "https://ledatic.org/attest/site_deploy.pub.pem",
    "pubkey_der_sha256": os.environ["PUB_FP"],
    "verify": "printf '%s' \"$signed_message\" > msg; base64 -d <<< \"$signature_b64\" > sig; "
              "openssl pkeyutl -verify -pubin -inkey site_deploy.pub.pem -rawin -in msg -sigfile sig",
    **stats_meta,
}
with open(os.environ["OUT"], "w") as f:
    json.dump(out, f, indent=2)
    f.write("\n")
print(f"manifest: deploy #{out['n']} · {len(files)} files · pulse {out['pulse_id']} · digest {out['files_digest'][:16]}…")
PYEOF

  upload "$STAGE_DIR/attest/site/$n.json" "attest/site/$n.json"
  upload "$STAGE_DIR/attest/site/$n.json" "attest/site/latest.json"
  # Public key alongside (idempotent; lets verifiers fetch it from the site)
  upload "$SIGN_PUB" "attest/site_deploy.pub.pem"
  MANIFEST_N="$n"
}

# ── Post-deploy byte-diff (spec §5.4 rule 6, deviation: no auto-revert) ──
# Fetch every uploaded file and compare sha256 against the signed manifest.
# Mismatch → one re-upload retry from the staged bytes, then exit nonzero
# loudly. No silent auto-revert: a deploy that doesn't verify is a FAILED
# deploy and the operator must see it.
#
# KNOWN EDGE REWRITE (found 2026-06-10): Cloudflare Bot Fight Mode "JS
# Detections" appends one per-request challenge <script> (rotating ray id +
# timestamp, marker /cdn-cgi/challenge-platform/) to every text/html
# response. The KV bytes ARE the signed bytes; the edge decorates them in
# transit, so raw-byte HTML comparison can never pass while the zone
# feature is on. We strip exactly that one known injection before hashing
# HTML and say so in the output. The honest fix is zone-level (disable JS
# Detections) — needs a dashboard / bot-management-scope token decision.
strip_cf_injection() {
  python3 -c '
import re, sys
b = sys.stdin.buffer.read()
b = re.sub(rb"<script>(?:(?!</script>).)*challenge-platform(?:(?!</script>).)*</script>",
           b"", b, count=1, flags=re.S)
# Cloudflare Web Analytics appends a beacon <script> too. It is served to
# browsers but not to curl, which is why it hid from this gate for weeks
# while making every browser self-check fail.
b = re.sub(rb"\n?<script[^>]*data-cf-beacon[^>]*>\s*</script>",
           b"", b, count=1, flags=re.S)
sys.stdout.buffer.write(b)
'
}

served_sha() { # url, key — sha256 of served bytes (HTML: modulo CF injection)
  case "$2" in
    (*.html) curl -sf --max-time 15 "$1" | strip_cf_injection | shasum -a 256 | cut -d' ' -f1 ;;
    (*)      curl -sf --max-time 15 "$1" | shasum -a 256 | cut -d' ' -f1 ;;
  esac
}

verify_manifest_bytes() {
  echo "— post-deploy byte-diff (served bytes vs signed manifest; HTML compared modulo the CF bot-script injection) —"
  local fails=0 cb key sha bytes url got
  cb=$(date +%s)
  while IFS=$'	' read -r key sha bytes; do
    url="$(key_to_url "$key")?cb=$cb"
    got=$(served_sha "$url" "$key") || got="fetch-failed"
    if [ "$got" != "$sha" ]; then
      echo "byte-diff MISMATCH $key (got ${got:0:12}, manifest ${sha:0:12}) — re-uploading once" >&2
      upload "$STAGE_DIR/$key" "$key" || true
      sleep 3
      got=$(served_sha "$(key_to_url "$key")?cb=$((cb + 1))" "$key") || got="fetch-failed"
      if [ "$got" != "$sha" ]; then
        echo "byte-diff FAIL $key — served bytes still do not match the signed manifest" >&2
        fails=$((fails + 1))
        continue
      fi
    fi
    echo "byte-diff ok   $key"
  done < "$MANIFEST_TSV"
  if [ "$fails" -gt 0 ]; then
    echo "deploy: BYTE-DIFF VERIFY FAILED ($fails file(s)) — the live site DOES NOT match deploy manifest #${MANIFEST_N:-?}." >&2
    echo "        The signed manifest at attest/site/latest.json now describes bytes the edge is not serving." >&2
    exit 6
  fi
  echo "byte-diff: live site matches signed manifest #${MANIFEST_N:-?} (HTML modulo CF bot-script injection)"
}

# ── Legacy route verification (markers at canonical extensionless URLs) ──
# Confirms the canonical routes (/rail, /entropy …) serve the fresh stamp —
# catches edge-cache staleness the raw-key byte-diff can't see. Retries
# briefly to ride out edge-cache lag, then fails the deploy (exit 5).
VERIFY_FAILS=0

verify_route() {
  local url="$1" marker="$2" tries=${3:-3} body
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

# Verify one deployed HTML page at its canonical route. Pages referencing
# the shared CSS are checked for the fresh stamp (proves new bytes are
# live); others fall back to their <title> text (proves the page itself is
# served, not the extensionless homepage fallback).
verify_one_html() {
  # Takes the repo-relative name; the route must NEVER be built from the
  # staged path (a /var/folders tmp path glued onto SITE_ORIGIN). Marker
  # extraction reads the staged copy — the exact bytes uploaded.
  local rel="$1" marker src="$STAGE_DIR/$1"
  [ -f "$src" ] || src="$rel"
  if grep -q '_shared/site\.css' "$src"; then
    marker="_shared/site.css?v=${CSS_VER}"
  else
    marker=$(tr -d '\n' < "$src" \
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
  echo "— post-deploy route verify —"
  verify_route "$SITE_ORIGIN/"        "_shared/site.css?v=${CSS_VER}"
  verify_route "$SITE_ORIGIN/rail"    "_shared/site.css?v=${CSS_VER}"
  verify_route "$SITE_ORIGIN/entropy" "_shared/site.css?v=${CSS_VER}"
  verify_route "$SITE_ORIGIN/_shared/site.css" "."
  verify_route "$SITE_ORIGIN/_shared/site.js"  "."
  verify_route "$SITE_ORIGIN/_shared/shaders/field.frag" "."
  if [ -n "${MANIFEST_N:-}" ]; then
    # KV writes are eventually consistent (~60 s) and the worker's KV read
    # holds a ~60 s edge cache — give latest.json up to ~80 s before failing.
    verify_route "$SITE_ORIGIN/attest/site/latest.json" "site-deploy|v1|${MANIFEST_N}|" 16
  fi
  verify_finish
}

deploy_one() {
  local rel="$1"
  [ -f "$rel" ] || { echo "no such file: $rel" >&2; exit 1; }
  case "$rel" in
    *.html)
      compute_asset_versions
      stage_html_versioned "$rel"
      upload "$STAGE_DIR/$rel" "$rel"
      verify_one_html "$rel"
      ;;
    *)
      stage_raw "$rel"
      upload "$STAGE_DIR/$rel" "$rel"
      verify_route "$(page_url "$rel")" "."
      ;;
  esac
}

deploy_all() {
  compute_asset_versions
  # Top-level HTML pages. playground.html is the static honest placard since
  # the 2040 rebuild (no rail_playground.js/WASM dependency), so it deploys
  # with everything else. If the live WASM playground ever returns, restore
  # the lockstep skip and ship it via deploy_playground.sh again.
  for f in *.html; do
    [ -f "$f" ] || continue
    stage_html_versioned "$f"
    upload "$STAGE_DIR/$f" "$f"
  done
  # Shared CSS + JS — uploaded at the canonical (unversioned) key. The
  # ?v=<hash> on HTML refs is purely a cache-buster; KV serves the same
  # content regardless of query string. rail_playground.js stays coupled
  # to deploy_playground.sh for the same lockstep reason as the HTML.
  for f in _shared/*.css _shared/*.js _shared/stats.json; do
    [ -f "$f" ] || continue
    [ "$f" = "_shared/rail_playground.js" ] && { echo "skip $f (deploys via deploy_playground.sh)"; continue; }
    stage_raw "$f"
    upload "$STAGE_DIR/$f" "$f"
  done
  # Fragment shaders
  for f in _shared/shaders/*.frag; do
    [ -f "$f" ] || continue
    stage_raw "$f"
    upload "$STAGE_DIR/$f" "$f"
  done
  # Self-hosted fonts — content-hashed filenames (sha256-8 in the name), so
  # the bytes at a given key never change; long-lived immutable caching is
  # safe and handled by the Worker's asset cache headers.
  for f in _shared/fonts/*.woff2 _shared/fonts/LICENSES.txt; do
    [ -f "$f" ] || continue
    stage_raw "$f"
    upload "$STAGE_DIR/$f" "$f"
  done
  # Photographic / static images (drop new ones in _shared/img/, no script edit needed)
  for f in _shared/img/*.jpg _shared/img/*.jpeg _shared/img/*.png _shared/img/*.webp; do
    [ -f "$f" ] || continue
    stage_raw "$f"
    upload "$STAGE_DIR/$f" "$f"
  done
  # Root-level static assets: social card (https://ledatic.org/og.png) +
  # crawler/agent surface (robots.txt, llms.txt, sitemap.xml). These drift
  # silently if left out of deploy_all — the live sitemap had 4 URLs while
  # the repo's had 17 (found 2026-06-10).
  for f in og.png robots.txt llms.txt sitemap.xml; do
    [ -f "$f" ] || continue
    stage_raw "$f"
    upload "$STAGE_DIR/$f" "$f"
  done
  # SDK client downloads (/receipts quickstart step 1). Fetched via curl -o,
  # so the worker's text/html fallback MIME for .py is tolerable for now.
  for f in sdk/*.py; do
    [ -f "$f" ] || continue
    stage_raw "$f"
    upload "$STAGE_DIR/$f" "$f"
  done
  # /data free-tier artifacts: samples, signed ledgers, tarball hashes.
  for f in data/*; do
    [ -f "$f" ] || continue
    stage_raw "$f"
    upload "$STAGE_DIR/$f" "$f"
  done
  # Rail docs (/rail/docs/*), built from ~/projects/rail/docs/site by
  # tools/build_rail_docs.sh.
  #
  # These were never in deploy_all. The build script wrote them into the
  # repo and nothing carried them to the site, so /rail/docs served whatever
  # a hand-run push last left there. On 2026-08-28 that meant a fix for 75
  # bold spans rendering as literal "\1" across 25 pages was committed,
  # verified locally, and still broken in public: the repo and the live site
  # disagreed and no gate compared them, because the byte-diff only checks
  # keys deploy_all actually uploads. An unuploaded directory is invisible
  # to a manifest built from uploads.
  for f in rail/docs/*.html rail/docs/examples/*.html; do
    [ -f "$f" ] || continue
    stage_raw "$f"
    upload "$STAGE_DIR/$f" "$f"
  done
}

# ── Main ────────────────────────────────────────────────────────────────
cd "$(dirname "$0")"
check_clean_tree
gen_stats
honesty_gate
changelog_gate
citation_gate
gate_on_beacon
load_prev_manifest
if [ $# -eq 0 ]; then
  gate_on_signing
  deploy_all
  publish_signed_manifest
  verify_manifest_bytes
  verify_deploy_all
  echo "deploy: KV writes this run: $WRITTEN written, $SKIPPED skipped as unchanged"
else
  # A single-file deploy cannot re-sign: publish_signed_manifest needs the
  # staged sha of EVERY key, and only the named files were staged. For most
  # assets that is merely stale. For an HTML page carrying <data class="fig">
  # it is worse than stale: inject_figures stamps a LIVE beacon pulse into
  # every figure, so the page is re-stamped on each stage and can never again
  # match the signed manifest. The page then renders its own inverse-video
  # ALARM ("THIS PAGE DOES NOT MATCH ITS MANIFEST") for every visitor, and
  # because data-pulse is always the same digit-width the byte COUNT does not
  # change, so nothing downstream notices.
  #
  # That is exactly how the live site came to alarm on 5 of 7 pages while the
  # deploy log stayed clean. The old behaviour printed a warning and carried
  # on; a warning nobody reads is not a gate. Figure-bearing HTML now requires
  # a full deploy, which re-stages and re-signs atomically.
  refused=0
  for arg in "$@"; do
    case "$arg" in
      *.html)
        if grep -q 'class="fig"' "$arg" 2>/dev/null; then
          echo "deploy: REFUSING $arg — it carries <data class=\"fig\"> figures." >&2
          echo "        Figures are stamped with a live beacon pulse at stage time, so a" >&2
          echo "        single-file deploy would leave this page permanently mismatched" >&2
          echo "        against the signed manifest and alarming in every browser." >&2
          echo "        Run ./deploy.sh with no arguments to re-stage and re-sign." >&2
          refused=1
        fi ;;
    esac
  done
  [ "$refused" -eq 1 ] && exit 1
  for arg in "$@"; do deploy_one "$arg"; done
  echo "deploy: single-file deploy — signed site manifest NOT updated (attest/site/latest.json still describes the last full deploy; run ./deploy.sh with no args to re-sign)."
  verify_finish
fi
echo "done."
