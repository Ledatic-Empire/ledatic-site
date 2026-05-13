#!/usr/bin/env bash
# build.sh - rebuild + verify tools/verify/standalone.html metadata.
#
# Idempotent. After any edit to standalone.html:
#   1. recomputes the SHA-256 hash;
#   2. updates README.md's hash block in place;
#   3. greps standalone.html for external resource references and warns
#      if any escape (this file is supposed to be self-contained);
#   4. prints the new hash for copy/paste into provenance.html.
#
# No deploy. No commit. Caller integrates.

set -euo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
HTML="$DIR/standalone.html"
README="$DIR/README.md"

if [ ! -f "$HTML" ]; then
  echo "ERROR: $HTML not found" >&2
  exit 1
fi

# --- 1. Hash ----------------------------------------------------------
HASH=$(shasum -a 256 "$HTML" | awk '{print $1}')
SIZE=$(wc -c < "$HTML" | tr -d ' ')
SIZE_KB=$(awk "BEGIN { printf \"%.1f\", $SIZE / 1024 }")
echo "[1] sha256:    $HASH"
echo "    size:      $SIZE bytes ($SIZE_KB KB)"

# --- 2. Self-containment audit ----------------------------------------
# A genuinely self-contained file should have:
#   - zero `src=` (no external scripts / images)
#   - zero `<link rel="stylesheet" href="...">` (CSS is inline)
#   - zero font CDN refs (googleapis, gstatic, cdnjs, etc.)
#   - any `fetch(...)` or `XMLHttpRequest` calls only fire on user action,
#     against URLs the user supplies (we don't grep that here; manual
#     inspection of the JS is required for the full guarantee).
#
# We warn rather than fail: an `href` to a documentation link (e.g. the
# provenance page) is fine because the browser only follows it on click.

WARN=0

if grep -nE '<script[^>]+src=' "$HTML" >/dev/null; then
  echo "WARN: external <script src=...> found:" >&2
  grep -nE '<script[^>]+src=' "$HTML" >&2
  WARN=$((WARN+1))
fi

if grep -nE '<link[^>]+rel="stylesheet"' "$HTML" >/dev/null; then
  echo "WARN: external <link rel=stylesheet> found:" >&2
  grep -nE '<link[^>]+rel="stylesheet"' "$HTML" >&2
  WARN=$((WARN+1))
fi

if grep -nE 'googleapis|gstatic|cdnjs|jsdelivr|unpkg|fonts\.com' "$HTML" >/dev/null; then
  echo "WARN: font/CDN reference found:" >&2
  grep -nE 'googleapis|gstatic|cdnjs|jsdelivr|unpkg|fonts\.com' "$HTML" >&2
  WARN=$((WARN+1))
fi

# Image src= (inlining-as-data-uri is fine; remote refs are not)
if grep -nE 'src="https?://' "$HTML" >/dev/null; then
  echo "WARN: remote src= reference found:" >&2
  grep -nE 'src="https?://' "$HTML" >&2
  WARN=$((WARN+1))
fi

if [ $WARN -eq 0 ]; then
  echo "[2] self-contained: OK (no external script/style/font/image refs)"
else
  echo "[2] self-contained: $WARN WARNING(S) above" >&2
fi

# --- 3. README rewrite -------------------------------------------------
# Generate a fresh README from scratch (idempotent, deterministic).
TS=$(date -u +%Y-%m-%d)

cat > "$README" <<EOF
# Standalone Provenance Verifier

A zero-trust, zero-CDN, single-file verifier for Ledatic provenance
manifests. The file \`standalone.html\` contains everything: HTML, CSS,
witness public keys, signature-verification logic. The only thing it
loads at runtime that is not in the file is the manifest you give it.

## Why this exists

The live verifier at \`https://ledatic.org/verify/<id>\` is also
browser-side, but it is delivered by the Cloudflare Worker. A casual
auditor on the live URL trusts Cloudflare's CDN to serve unmodified
JavaScript. This standalone file closes that trust gap: download it,
verify the SHA-256 once, and run it from disk forever.

See audit finding F-52 in \`docs/audits/findings_2026-05-09/06_public_claims.md\`
in the \`rail\` repo for the original recommendation.

## How to use

1. Download \`standalone.html\` from this repo (raw GitHub link, or
   \`git clone\` the \`ledatic-site\` repo).
2. Verify the SHA-256 hash. The expected value is published in two
   places that you should cross-check:
   - the **Hash** section below, and
   - the FAQ on https://ledatic.org/provenance .
   Compute locally with one of:
   \`\`\`bash
   shasum -a 256 standalone.html
   openssl dgst -sha256 standalone.html
   sha256sum standalone.html       # Linux
   \`\`\`
   One-liner with grep:
   \`\`\`bash
   shasum -a 256 standalone.html | grep $HASH
   \`\`\`
   (exit code 0 = match, exit code 1 = mismatch, do not trust the file)
3. Open \`standalone.html\` in a modern browser (Chrome 137+, Safari
   17+, Firefox 138+ for Ed25519 in WebCrypto). It works from
   \`file://\`; no web server needed.
4. Paste a manifest URL (e.g.
   \`https://ledatic.org/provenance/manifest/<id>\`) **or** paste the
   manifest JSON directly into the textarea. Click verify. The browser
   will compute SHA-256 of the inner_message, rebuild it from the
   individual manifest fields, and run \`crypto.subtle.verify\` against
   each witness's Ed25519 public key.

You can also pre-fill the URL via query param:
\`standalone.html?url=https://ledatic.org/provenance/manifest/<id>\`

## Hash

Build date: $TS
File size:  $SIZE bytes ($SIZE_KB KB)
SHA-256:    \`$HASH\`

To regenerate this README + hash after editing \`standalone.html\`:

\`\`\`bash
bash tools/verify/build.sh
\`\`\`

## What the verifier proves

Identical to the live verifier (same algorithm, same baked-in pubkeys):

- The \`inner_message\` field hashes to \`inner_digest_sha256\`
  (browser computes SHA-256 itself, doesn't trust the manifest).
- The \`inner_message\` rebuilt field-by-field matches what was hashed
  (catches post-signing field tampering).
- For v2 manifests, the beacon \`pulse_id\` is bound inside the digest
  (catches capture-replay across pulses).
- Each declared witness's signature verifies against the corresponding
  public key (\`fleet0\`, \`studio\`, or \`mini\`).
- Consensus marker (CONSENSUS / VERIFIED / PARTIAL / INVALID) reflects
  how many independent witnesses signed.

## What the verifier does NOT prove

- That \`https://ledatic.org/provenance/manifest/<id>\` returned a real
  manifest (the manifest could be fabricated). The \`inner_message\` +
  Ed25519 signature is what makes it trustworthy: a fabricated manifest
  would fail signature verification because it would not have a real
  witness signature.
- That the model identity in \`generation_event.model.name\` is the
  model that actually ran. The \`weights_hash\` makes that assertion
  cryptographically; you'd cross-check that hash against a publicly
  attested weights manifest separately.

## Witness pubkeys (also baked into the HTML)

\`\`\`
fleet0  pk_fp cac5f21a70564aeb  Pi Zero 2 W,        Tailscale 100.87.231.45
studio  pk_fp 47cb7773241d8ac2  Mac Studio,         Detroit
mini    pk_fp <see verify.html>  Mac Mini M4 Pro,    Detroit
\`\`\`

(The base64 raw-32-byte values are constants in \`standalone.html\`
near \`const PUBKEYS = {...}\`.)
EOF

echo "[3] README.md rewritten ($(wc -l < "$README" | tr -d ' ') lines)"

# --- 4. Final report --------------------------------------------------
echo
echo "Done."
echo "Publish this hash on https://ledatic.org/provenance:"
echo "  $HASH"
