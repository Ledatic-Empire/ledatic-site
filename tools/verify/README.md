# Standalone Provenance Verifier

A zero-trust, zero-CDN, single-file verifier for Ledatic provenance
manifests. The file `standalone.html` contains everything: HTML, CSS,
witness public keys, signature-verification logic. The only thing it
loads at runtime that is not in the file is the manifest you give it.

## Why this exists

The live verifier at `https://ledatic.org/verify/<id>` is also
browser-side, but it is delivered by the Cloudflare Worker. A casual
auditor on the live URL trusts Cloudflare's CDN to serve unmodified
JavaScript. This standalone file closes that trust gap: download it,
verify the SHA-256 once, and run it from disk forever.

See audit finding F-52 in `docs/audits/findings_2026-05-09/06_public_claims.md`
in the `rail` repo for the original recommendation.

## How to use

1. Download `standalone.html` from this repo (raw GitHub link, or
   `git clone` the `ledatic-site` repo).
2. Verify the SHA-256 hash. The expected value is published in two
   places that you should cross-check:
   - the **Hash** section below, and
   - the FAQ on https://ledatic.org/provenance .
   Compute locally with one of:
   ```bash
   shasum -a 256 standalone.html
   openssl dgst -sha256 standalone.html
   sha256sum standalone.html       # Linux
   ```
   One-liner with grep:
   ```bash
   shasum -a 256 standalone.html | grep fe114e269380c5b47883a12ccf3c6740b414e98eadb7cc72a667ac8ae24df821
   ```
   (exit code 0 = match, exit code 1 = mismatch, do not trust the file)
3. Open `standalone.html` in a modern browser (Chrome 137+, Safari
   17+, Firefox 138+ for Ed25519 in WebCrypto). It works from
   `file://`; no web server needed.
4. Paste a manifest URL (e.g.
   `https://ledatic.org/provenance/manifest/<id>`) **or** paste the
   manifest JSON directly into the textarea. Click verify. The browser
   will compute SHA-256 of the inner_message, rebuild it from the
   individual manifest fields, and run `crypto.subtle.verify` against
   each witness's Ed25519 public key.

You can also pre-fill the URL via query param:
`standalone.html?url=https://ledatic.org/provenance/manifest/<id>`

## Hash

Build date: 2026-05-13
File size:  31005 bytes (30.3 KB)
SHA-256:    `fe114e269380c5b47883a12ccf3c6740b414e98eadb7cc72a667ac8ae24df821`

To regenerate this README + hash after editing `standalone.html`:

```bash
bash tools/verify/build.sh
```

## What the verifier proves

Identical to the live verifier (same algorithm, same baked-in pubkeys):

- The `inner_message` field hashes to `inner_digest_sha256`
  (browser computes SHA-256 itself, doesn't trust the manifest).
- The `inner_message` rebuilt field-by-field matches what was hashed
  (catches post-signing field tampering).
- For v2 manifests, the beacon `pulse_id` is bound inside the digest
  (catches capture-replay across pulses).
- Each declared witness's signature verifies against the corresponding
  public key (`fleet0`, `studio`, or `mini`).
- Consensus marker (CONSENSUS / VERIFIED / PARTIAL / INVALID) reflects
  how many independent witnesses signed.

## What the verifier does NOT prove

- That `https://ledatic.org/provenance/manifest/<id>` returned a real
  manifest (the manifest could be fabricated). The `inner_message` +
  Ed25519 signature is what makes it trustworthy: a fabricated manifest
  would fail signature verification because it would not have a real
  witness signature.
- That the model identity in `generation_event.model.name` is the
  model that actually ran. The `weights_hash` makes that assertion
  cryptographically; you'd cross-check that hash against a publicly
  attested weights manifest separately.

## Witness pubkeys (also baked into the HTML)

```
fleet0  pk_fp cac5f21a70564aeb  Pi Zero 2 W,        on the tailnet
studio  pk_fp 47cb7773241d8ac2  Mac Studio,         Detroit
mini    pk_fp <see verify.html>  Mac Mini M4 Pro,    Detroit
```

(The base64 raw-32-byte values are constants in `standalone.html`
near `const PUBKEYS = {...}`.)
