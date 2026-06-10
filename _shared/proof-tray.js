/* ============================================================
   LEDATIC 2040 — proof-tray.js (ES module, zero deps)

   §5.1 Proof Tray   Every attested claim is a <button class="prove">
                     wrapping its value. Press → inline tray runs the
                     proof live in-tab: FETCH → HASH → KEY → SIG →
                     CHAIN, each step printed on actual completion.
                     Verification is WebCrypto Ed25519 in the
                     visitor's browser; nothing executes server-side.

   §5.1 popover      Small inline Figures: data-proof="popover" gets
                     a native Popover API 3-line proof card instead
                     of the full tray. Zero library; falls back to
                     the tray where the Popover API is missing.

   §5.1 receipt      Every proof ends with a pasteable receipt:
                     artifact hash · pulse · key fingerprint · result.

   §4 sentinel       Liveness grammar state machine. Default state is
                     `unknown` — hollow, unlit, claiming nothing —
                     until a check passes. Only this module writes
                     the word "live". Auto-demotes live → stale after
                     data-fresh-pulses (default 5) cadences. The CSS
                     grammar (hue/glyph) lives in site.css; tray and
                     popover skins live in proof.css.

   §5.4 selfCheck    Page-vs-signed-deploy-manifest self check.
                     ALARM (inverse video) is reserved for THIS
                     failure alone. Red (--st-fail) is reserved for
                     an artifact proof failing. (§0 rule 2.)

   Honesty rules encoded here:
   - outcome 'unverified' (dim, never red) when verification simply
     cannot run here (unpinned key, no Ed25519 engine, artifact
     bytes unreachable) — red means *checked and wrong*, only that.
   - the trust line never claims zero trust: pin the key once,
     verify everything after.
   - DOM-free engine: runProof / verifyManifestObject run headless
     (node 18+) — the same code path the browser uses.

   EMBED CONTRACT (for page authors) ──────────────────────────
     <link rel="stylesheet" href="/_shared/proof.css">      (after site.css)
     <script type="module" src="/_shared/proof-tray.js"></script>

     <button class="prove" aria-expanded="false"
             data-manifest="/releases/v5.1.0/rail_native.attestation.json">
       <data class="fig" value="1193744">1.2 MB</data>
       <span class="affix" aria-hidden="true">⌁</span>
     </button>
     <div class="tray" role="log" aria-live="polite" hidden></div>

     - data-manifest   required. URL of the attestation JSON.
     - data-artifact   optional. Override artifact bytes URL.
     - data-name       optional. Display name in the tray title.
     - data-proof="popover"  optional. 3-line popover card variant.
     - .tray sibling   optional — created after the button's block
       ancestor if absent. aria-controls is wired automatically.
     - Zero JS: the button renders as plain text; the claim stays
       readable; nothing opens. That is the degraded contract.

     Sentinels:  <span data-state="unknown" data-sentinel
                       data-fresh-pulses="5">checking…</span>
     data-sentinel="pulse" auto-feeds from the pulse-bus when
     pulse-clock.js is on the page. Anything else is fed by page
     code: LedaticProof.sentinel(el).feed(pulseId) / .set(state,…).

     Self-check:  LedaticProof.mountSelfCheck(stripEl) — footer
     trust strip; flips to ALARM only on a real mismatch.
   ============================================================ */

const ED = { name: 'Ed25519' };
const subtle = (globalThis.crypto && globalThis.crypto.subtle) || null;
const hasDOM = typeof document !== 'undefined';
const THIN = ' ';                    // narrow no-break space (§2 grouping)
const DEFAULT_CADENCE_MS = 2000;          // beacon publishes every ~2 s
const MANIFEST_TIMEOUT_MS = 8000;
const ARTIFACT_TIMEOUT_MS = 30000;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;   // honesty cap, not a promise

const prm = hasDOM && typeof matchMedia === 'function'
  ? matchMedia('(prefers-reduced-motion: reduce)')
  : { matches: false };

/* ── One-time explicit trust: the pinned keys (§5.1) ─────────────
   pk_fp = first 16 hex of sha256 over the DER(SPKI) public key —
   same rule as attest/verify.sh. The SPKI bytes are pinned here so
   the page never trusts the wire for the key; the out-of-band copy
   lives in the public site repo. */
export const PINNED_KEYS = {
  fleet0: {
    pk_fp: 'cac5f21a70564aeb',
    spki_b64: 'MCowBQYDK2VwAyEABYCyN+fTbPuRA0BKpSmWhzW+auY1IXiOo99C4cmXBQI=',
    role: 'artifact witness',
    pem_url: 'https://ledatic.org/attest/fleet0.pub.pem',
  },
  site_deploy: {
    pk_fp: '7b4391d64aecb9ac',
    spki_b64: 'MCowBQYDK2VwAyEABwvSJfEqrE+9ied5AjgTdQmZFcPBrQpSxSUJYPcl04s=',
    role: 'site deploy signer',
    pem_url: 'https://ledatic.org/attest/site_deploy.pub.pem',
  },
};
const KEY_SOURCE_URL = 'https://github.com/Ledatic-Empire/ledatic-site/tree/master/attest';

/* ── tiny utils (self-contained: this module must run headless) ── */
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function fmtPulse(n) {
  const s = String(Math.trunc(Math.abs(Number(n) || 0)));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += THIN;
    out += s[i];
  }
  return out;
}
export function groupHex(hex, every = 8) {
  return String(hex || '').replace(new RegExp(`(.{${every}})(?=.)`, 'g'), `$1${THIN}`);
}
const group4 = (hex) => groupHex(hex, 4);
export function fmtDur(pulses, cadenceMs = DEFAULT_CADENCE_MS) {
  const s = pulses * (cadenceMs / 1000);
  if (s < 90) return `≈ ${Math.round(s)} s`;
  if (s < 5400) return `≈ ${Math.round(s / 60)} min`;
  if (s < 172800) return `≈ ${(s / 3600).toFixed(1)} h`;
  return `≈ ${(s / 86400).toFixed(1)} d`;
}

function b64ToBytes(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));    // node
}
function bytesToHex(buf) {
  const v = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < v.length; i++) s += v[i].toString(16).padStart(2, '0');
  return s;
}
const utf8 = (s) => new TextEncoder().encode(s);

async function sha256Hex(data) {
  if (!subtle) {
    const err = new Error('WebCrypto unavailable (insecure context?)');
    err.unavailable = true;
    throw err;
  }
  return bytesToHex(await subtle.digest('SHA-256', data));
}

async function fetchT(url, timeoutMs, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function cadenceMs() {
  if (hasDOM && window.LedaticPulse && window.LedaticPulse.CADENCE_MS) {
    return window.LedaticPulse.CADENCE_MS;
  }
  return DEFAULT_CADENCE_MS;
}
function confirmedPulse() {
  // last CONFIRMED pulse via the pulse-bus, if pulse-clock.js is present.
  // Never extrapolated (§0 rule 9). Null = honestly unknown.
  if (hasDOM && window.LedaticPulse && window.LedaticPulse.bus && window.LedaticPulse.bus.latest) {
    const id = Number(window.LedaticPulse.bus.latest.pulse_id);
    return Number.isFinite(id) && id > 0 ? id : null;
  }
  return null;
}

/* ── Ed25519 engine ──────────────────────────────────────────────
   WebCrypto first (importKey spki, raw fallback); then the Rail
   WASM verifier hook (globalThis.LedaticWasmVerifier.verify(
   rawPub32, msgBytes, sigBytes) → bool) when a page has lazy-loaded
   it; else honestly unavailable → outcome 'unverified', never red. */
async function importEdKey(spkiDer) {
  try {
    return await subtle.importKey('spki', spkiDer, ED, false, ['verify']);
  } catch (e) {
    // raw = the 32-byte public key (last 32 bytes of the Ed25519 SPKI)
    return await subtle.importKey('raw', spkiDer.slice(-32), ED, false, ['verify']);
  }
}
async function verifySig(entry, msgBytes, sigBytes) {
  const der = b64ToBytes(entry.spki_b64);
  if (subtle) {
    try {
      if (!entry._key) entry._key = await importEdKey(der);
      const ok = await subtle.verify(ED, entry._key, sigBytes, msgBytes);
      return { ok, engine: 'WebCrypto Ed25519' };
    } catch (e) { /* engine missing here — try the wasm hook */ }
  }
  const wasm = globalThis.LedaticWasmVerifier;
  if (wasm && typeof wasm.verify === 'function') {
    const ok = await wasm.verify(der.slice(-32), msgBytes, sigBytes);
    return { ok: !!ok, engine: 'Rail WASM verifier' };
  }
  const err = new Error('no Ed25519 engine in this browser');
  err.unavailable = true;
  throw err;
}

function findPinned(fp16, keys) {
  for (const [name, entry] of Object.entries(keys)) {
    if (entry.pk_fp === fp16) return { name, entry };
  }
  return null;
}

/* ── schema detection ──────────────────────────────────────────── */
export function detectSchema(m) {
  if (m && m.kind === 'ledatic.site.deploy' && typeof m.signed_message === 'string') return 'site-deploy';
  if (m && m.witness && typeof m.witness.sig === 'string') return 'witness';
  return null;
}

/* canonical messages — must match the signers byte-for-byte:
   witness     attest|v1|<digest>|<pulse_id>|<value_hex>|<witnessed_at>
   site-deploy site-deploy|v1|<n>|<files_digest>|<pulse_id>|<deployed_at> */
export function witnessMessage(w) {
  return `attest|v1|${w.digest_sha256}|${w.pulse_id}|${w.value_hex}|${w.witnessed_at}`;
}
export function siteDeployMessage(m) {
  return `site-deploy|v1|${m.n}|${m.files_digest}|${m.pulse_id}|${m.deployed_at}`;
}
export async function filesDigest(files) {
  // sha256 over "key<SP>sha256<LF>" lines sorted by key (deploy.sh rule)
  const lines = [...files]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((f) => `${f.key} ${f.sha256}\n`)
    .join('');
  return sha256Hex(utf8(lines));
}

/* ── the engine (§5.1) — DOM-free ────────────────────────────────
   verifyManifestObject(manifest, opts) → ProofResult
   opts: { manifestUrl, manifestBytes, artifactBytes, artifactUrl,
           keys, onStep, currentPulse, maxArtifactBytes }
   ProofResult: { outcome:'ok'|'fail'|'unverified', failedAt, steps,
                  schema, name, sha256, hashed, pulse, witnessName,
                  pkFp, engine, ms, manifestUrl, manifest, receipt }
   Steps stream through onStep twice: {status:'run'} then final
   ('ok'|'fail'|'skip'|'info') — the tray stagger is truthful. */
export async function verifyManifestObject(m, opts = {}) {
  const t0 = now();
  const keys = opts.keys || PINNED_KEYS;
  const steps = [];
  const emit = (s) => {
    if (s.status !== 'run') steps.push(s);
    if (opts.onStep) opts.onStep(s);
    return s;
  };
  const r = {
    outcome: 'unverified', failedAt: null, steps,
    schema: detectSchema(m), name: '', sha256: '', hashed: false,
    bytes: null, hashMismatch: false, rotatedLive: false,
    pulse: null, witnessName: '', pkFp: '', engine: '',
    ms: 0, manifestUrl: opts.manifestUrl || '', manifest: m, receipt: '',
  };
  const finish = (outcome, failedAt, note) => {
    r.outcome = outcome;
    r.failedAt = failedAt || null;
    r.note = note || '';
    r.ms = now() - t0;
    r.receipt = buildReceipt(r);
    return r;
  };
  const skipRest = (ids) => ids.forEach((id) => emit({ id, label: '', status: 'skip' }));

  if (opts.manifestStep) emit(opts.manifestStep);   // FETCH step from runProof

  if (!r.schema) {
    emit({ id: 'HASH', label: 'manifest schema', status: 'fail', note: 'unrecognized attestation schema — nothing here can be checked' });
    skipRest(['KEY', 'SIG', 'CHAIN']);
    return finish('fail', 'HASH', 'unrecognized attestation schema');
  }

  /* ---- subject + HASH ------------------------------------------ */
  let declared, fp16, msg, sigB64, anchorPulse;
  if (r.schema === 'witness') {
    const subject = m.artifact || m.frame || {};
    const w = m.witness;
    declared = subject.sha256 || w.digest_sha256 || '';
    r.name = subject.name || subject.url || 'artifact';
    r.sha256 = declared;
    fp16 = String(w.pk_fp || '').slice(0, 16);
    msg = witnessMessage(w);
    sigB64 = w.sig;
    anchorPulse = Number(w.pulse_id);
    r.witnessName = w.witness || '';

    if (!declared) {
      emit({ id: 'HASH', label: 'sha256(artifact)', status: 'fail', note: 'manifest carries no sha256 — there is nothing to verify against' });
      skipRest(['KEY', 'SIG', 'CHAIN']);
      return finish('fail', 'HASH', 'manifest carries no sha256');
    }
    if (w.digest_sha256 && subject.sha256 && w.digest_sha256 !== subject.sha256) {
      emit({ id: 'HASH', label: 'sha256(artifact)', status: 'fail', note: 'witness digest disagrees with the artifact digest in the same manifest' });
      skipRest(['KEY', 'SIG', 'CHAIN']);
      return finish('fail', 'HASH', 'witness digest ≠ artifact digest');
    }

    let bytes = opts.artifactBytes || null;
    /* artifact bytes location, in trust order:
       1. opts.artifactBytes — bytes the page already holds (the only
          sound way to prove a rotating subject, e.g. a live frame)
       2. data-artifact / opts.artifactUrl — author-declared binding
       3. manifest subject.url — manifest-declared binding
       4. derived sibling path (<manifest> minus .attestation.json) —
          a CONVENTION, not a binding: a mismatch there is never red,
          because nothing attested that those bytes live there. */
    let aUrl = opts.artifactUrl || subject.url || null;
    let derivedUrl = false;
    if (!aUrl && opts.manifestUrl && /\.attestation\.json(\?|$)/.test(opts.manifestUrl)) {
      aUrl = opts.manifestUrl.replace(/\.attestation\.json(\?.*)?$/, '');
      derivedUrl = true;
    }
    const maxB = opts.maxArtifactBytes || MAX_ARTIFACT_BYTES;
    emit({ id: 'HASH', label: 'sha256(artifact)', status: 'run' });
    try {
      if (!bytes && aUrl && (!subject.size_bytes || subject.size_bytes <= maxB)) {
        const res = await fetchT(aUrl, ARTIFACT_TIMEOUT_MS);
        if (!res.ok) throw Object.assign(new Error(`artifact fetch ${res.status}`), { unavailable: true });
        bytes = await res.arrayBuffer();
        if (bytes.byteLength > maxB) throw Object.assign(new Error('artifact larger than the in-browser cap'), { unavailable: true });
      }
      if (bytes) {
        const got = await sha256Hex(bytes);
        const nB = bytes.byteLength != null ? bytes.byteLength : bytes.length;
        if (got !== declared) {
          /* a moving endpoint (…/current, …/latest) serves whatever is
             newest — an attestation of it is a snapshot, and a mismatch
             there is rotation, not tampering. Red only for bytes that
             were attested to stay put. */
          const moving = !opts.artifactBytes && aUrl
            && /(^|\/)(current|latest)(\.[A-Za-z0-9.]+)?$/.test(aUrl.split('?')[0]);
          if (derivedUrl) {
            // an unattested guess that didn't pan out — honest, not red
            emit({ id: 'HASH', label: 'sha256(artifact)', status: 'info', res: 'not authoritative', note: 'bytes at the conventional sibling path do not match — no attested artifact location; signature checked over the attested digest only' });
          } else if (moving) {
            r.rotatedLive = true;
            emit({ id: 'HASH', label: 'sha256(artifact)', status: 'info', res: 'rotated on', note: `the live endpoint has rotated past this attestation — the attested bytes are no longer served at ${aUrl}; signature still checked over the attested digest` });
          } else {
            r.hashMismatch = true;
            emit({ id: 'HASH', label: 'sha256(artifact)', status: 'fail', res: `✗ ${groupHex(got.slice(0, 16))}`, note: `sha256 mismatch — fetched bytes hash ${got.slice(0, 16)}…, attestation says ${declared.slice(0, 16)}…` });
            skipRest(['KEY', 'SIG', 'CHAIN']);
            return finish('fail', 'HASH', 'artifact bytes do not match the attested sha256');
          }
        } else {
          r.hashed = true;
          r.bytes = nB;
          emit({ id: 'HASH', label: 'sha256(artifact)', status: 'ok', res: `${groupHex(got.slice(0, 16))} … · ${fmtPulse(nB)} B` });
        }
      } else {
        emit({ id: 'HASH', label: 'sha256(artifact)', status: 'info', res: 'not fetched', note: aUrl ? 'artifact too large for the in-browser cap — signature still checked over the attested digest' : 'artifact bytes not published — signature checked over the attested digest only' });
      }
    } catch (e) {
      if (e && e.unavailable) {
        emit({ id: 'HASH', label: 'sha256(artifact)', status: 'info', res: 'unreachable', note: `artifact bytes could not be fetched (${e.message}) — signature still checked over the attested digest` });
      } else {
        emit({ id: 'HASH', label: 'sha256(artifact)', status: 'fail', note: String(e && e.message || e) });
        skipRest(['KEY', 'SIG', 'CHAIN']);
        return finish('fail', 'HASH', String(e && e.message || e));
      }
    }
  } else {
    /* site-deploy: the "artifact" is the file list itself */
    r.name = `site deploy #${m.n}`;
    fp16 = String(m.pubkey_der_sha256 || '').slice(0, 16);
    msg = m.signed_message;
    sigB64 = m.signature_b64;
    anchorPulse = Number(m.pulse_id);
    r.witnessName = 'site_deploy';
    r.sha256 = m.files_digest || '';

    emit({ id: 'HASH', label: `files_digest (${(m.files || []).length} files)`, status: 'run' });
    try {
      const got = await filesDigest(m.files || []);
      if (got !== m.files_digest) {
        emit({ id: 'HASH', label: 'files_digest', status: 'fail', note: `recomputed files digest ${got.slice(0, 16)}… disagrees with the manifest's ${String(m.files_digest).slice(0, 16)}…` });
        skipRest(['KEY', 'SIG', 'CHAIN']);
        return finish('fail', 'HASH', 'file list does not match its digest');
      }
      r.hashed = true;
      emit({ id: 'HASH', label: `files_digest (${(m.files || []).length} files)`, status: 'ok', res: `${groupHex(got.slice(0, 16))} …` });
    } catch (e) {
      emit({ id: 'HASH', label: 'files_digest', status: e && e.unavailable ? 'info' : 'fail', note: String(e && e.message || e) });
      if (!(e && e.unavailable)) { skipRest(['KEY', 'SIG', 'CHAIN']); return finish('fail', 'HASH', String(e && e.message || e)); }
    }
  }
  r.pkFp = fp16;
  r.pulse = Number.isFinite(anchorPulse) ? anchorPulse : null;

  /* ---- KEY ------------------------------------------------------ */
  emit({ id: 'KEY', label: 'pinned pk_fp', status: 'run' });
  const pinned = findPinned(fp16, keys);
  if (!pinned) {
    emit({ id: 'KEY', label: 'pinned pk_fp', status: 'info', res: fp16 ? `${group4(fp16)} unpinned` : 'missing', note: 'this key is not pinned here — cannot verify in this browser; check it out-of-band against the public repo' });
    skipRest(['SIG', 'CHAIN']);
    return finish('unverified', null, 'unpinned signing key');
  }
  r.witnessName = pinned.name;
  try {
    const derFp = (await sha256Hex(b64ToBytes(pinned.entry.spki_b64))).slice(0, 16);
    if (derFp !== fp16) {
      emit({ id: 'KEY', label: 'pinned pk_fp', status: 'fail', note: `pinned key fingerprint ${derFp} does not match the manifest's ${fp16}` });
      skipRest(['SIG', 'CHAIN']);
      return finish('fail', 'KEY', 'key fingerprint mismatch');
    }
    emit({ id: 'KEY', label: 'pinned pk_fp', status: 'ok', res: `${group4(fp16)} (${pinned.name})` });
  } catch (e) {
    emit({ id: 'KEY', label: 'pinned pk_fp', status: 'info', res: 'unchecked', note: String(e && e.message || e) });
    skipRest(['SIG', 'CHAIN']);
    return finish('unverified', null, String(e && e.message || e));
  }

  /* ---- SIG ------------------------------------------------------ */
  emit({ id: 'SIG', label: 'Ed25519.verify', status: 'run' });
  if (r.schema === 'site-deploy' && siteDeployMessage(m) !== msg) {
    emit({ id: 'SIG', label: 'Ed25519.verify', status: 'fail', note: 'signed message disagrees with the manifest fields it claims to cover' });
    skipRest(['CHAIN']);
    return finish('fail', 'SIG', 'signed message ≠ manifest fields');
  }
  try {
    const { ok, engine } = await verifySig(pinned.entry, utf8(msg), b64ToBytes(sigB64));
    r.engine = engine;
    if (!ok) {
      emit({ id: 'SIG', label: 'Ed25519.verify', status: 'fail', note: 'signature did not verify — the record or its signature has been altered' });
      skipRest(['CHAIN']);
      return finish('fail', 'SIG', 'Ed25519 signature did not verify');
    }
    emit({ id: 'SIG', label: 'Ed25519.verify', status: 'ok', res: '✓' });
  } catch (e) {
    if (e && e.unavailable) {
      emit({ id: 'SIG', label: 'Ed25519.verify', status: 'info', res: 'no engine', note: 'this browser has no Ed25519 engine — use the shell recipe in the receipt to verify out-of-band' });
      skipRest(['CHAIN']);
      return finish('unverified', null, 'no Ed25519 engine in this browser');
    }
    emit({ id: 'SIG', label: 'Ed25519.verify', status: 'fail', note: String(e && e.message || e) });
    skipRest(['CHAIN']);
    return finish('fail', 'SIG', String(e && e.message || e));
  }

  /* ---- CHAIN ---------------------------------------------------- */
  emit({ id: 'CHAIN', label: 'anchored', status: 'run' });
  if (!Number.isFinite(anchorPulse) || anchorPulse <= 0) {
    emit({ id: 'CHAIN', label: 'anchored', status: 'fail', note: 'no pulse anchor — an attestation without a pulse is not anchored to anything' });
    return finish('fail', 'CHAIN', 'no pulse anchor');
  }
  const cur = typeof opts.currentPulse === 'function' ? opts.currentPulse() : confirmedPulse();
  if (cur && anchorPulse > cur + 30) {
    emit({ id: 'CHAIN', label: 'anchored', status: 'fail', res: `@ p#${fmtPulse(anchorPulse)}`, note: `anchor p#${fmtPulse(anchorPulse)} is ahead of the confirmed chain (p#${fmtPulse(cur)})` });
    return finish('fail', 'CHAIN', 'anchored in the future of the confirmed chain');
  }
  const age = cur ? ` · +${fmtPulse(cur - anchorPulse)} pulses old` : ' · age unknown (no confirmed pulse this session)';
  emit({ id: 'CHAIN', label: 'anchored', status: 'ok', res: `@ p#${fmtPulse(anchorPulse)}${age}` });

  return finish('ok', null, '');
}

/* runProof: fetch the manifest, then verify. The browser path and
   the headless node path are this same function.

   Rotating subjects (e.g. a live frame re-attested every pulse) can
   legitimately change between the manifest fetch and the artifact
   fetch. Red means CHECKED AND WRONG, so on a declared-URL hash
   mismatch the manifest is re-fetched once: if the attested digest
   moved, the proof re-runs against the fresh attestation; if it is
   still moving, the outcome is an honest 'unverified' (pages that
   hold the bytes should pass artifactBytes instead). Only a
   mismatch against a STABLE attestation earns the red. */
const subjectSha = (m) => ((m && (m.artifact || m.frame)) || {}).sha256 || null;

export async function runProof(manifestUrl, opts = {}) {
  const onStep = opts.onStep || (() => {});

  const fetchManifest = async () => {
    const res = await fetchT(manifestUrl, MANIFEST_TIMEOUT_MS, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    return { m: JSON.parse(new TextDecoder().decode(buf)), nBytes: buf.byteLength };
  };

  onStep({ id: 'FETCH', label: 'manifest', status: 'run' });
  let m, nBytes;
  try {
    ({ m, nBytes } = await fetchManifest());
  } catch (e) {
    const step = { id: 'FETCH', label: 'manifest', status: 'fail', note: `manifest unreachable: ${String(e && e.message || e)}` };
    onStep(step);
    ['HASH', 'KEY', 'SIG', 'CHAIN'].forEach((id) => onStep({ id, label: '', status: 'skip' }));
    const r = {
      outcome: 'unverified', failedAt: 'FETCH', steps: [step], schema: null,
      name: '', sha256: '', hashed: false, bytes: null, hashMismatch: false,
      pulse: null, witnessName: '', pkFp: '', engine: '', ms: 0, manifestUrl, manifest: null,
      note: `manifest unreachable: ${String(e && e.message || e)}`, receipt: '',
    };
    r.receipt = buildReceipt(r);
    return r;
  }

  const verify = (mm, label) => verifyManifestObject(mm, {
    ...opts, manifestUrl,
    manifestStep: { id: 'FETCH', label, status: 'ok', res: `${fmtPulse(nBytes)} B` },
  });
  const mismatched = (res) => res.outcome === 'fail' && res.failedAt === 'HASH' && res.hashMismatch;

  let r = await verify(m, 'manifest');
  if (mismatched(r) && !opts.artifactBytes) {
    try {
      const second = await fetchManifest();
      if (subjectSha(second.m) && subjectSha(second.m) !== subjectSha(m)) {
        m = second.m; nBytes = second.nBytes;
        r = await verify(m, 'manifest (subject rotated · re-proving)');
        if (mismatched(r)) {
          const third = await fetchManifest();
          if (subjectSha(third.m) !== subjectSha(m)) {
            onStep({ id: 'HASH', label: 'sha256(artifact)', status: 'info', res: 'rotating', note: 'the subject re-attests faster than it can be fetched — a page holding the bytes should pass them directly' });
            ['KEY', 'SIG', 'CHAIN'].forEach((id) => onStep({ id, label: '', status: 'skip' }));
            r.outcome = 'unverified';
            r.failedAt = null;
            r.note = 'subject rotated during the proof — bytes could not be pinned to one attestation';
            r.receipt = buildReceipt(r);
          }
        }
      }
    } catch { /* re-fetch failed — the first verdict stands */ }
  }
  return r;
}

/* ── the receipt (§5.1) — proof-of-proof, pasteable anywhere ───── */
export function buildReceipt(r) {
  const hashGloss = r.hashed ? ''
    : r.rotatedLive ? ' · attested digest verified, live bytes have rotated on'
    : ' · artifact bytes not fetched';
  const verdict =
    r.outcome === 'ok' ? `OK — verified in browser (${r.engine || 'WebCrypto'})${hashGloss}`
    : r.outcome === 'fail' ? `FAIL at ${r.failedAt} — ${r.note}`
    : `UNVERIFIED — ${r.note}`;
  const lines = [
    'ledatic proof receipt',
    `result:   ${verdict}`,
    `artifact: ${r.name || '—'}${r.bytes ? ` · ${r.bytes} B` : ''}`,
    `sha256:   ${r.sha256 || '—'}`,
    `pulse:    ${r.pulse ? 'p#' + r.pulse : '—'}`,
    `key:      ${r.witnessName || 'unpinned'}${r.pkFp ? ' · pk_fp ' + r.pkFp : ''}`,
    `manifest: ${r.manifestUrl || '(local object)'}`,
    `checked:  ${new Date().toISOString()} · ${(r.ms / 1000).toFixed(2)} s`,
    'recipe:   attest/verify.sh in the public site repo reproduces this offline',
  ];
  return lines.join('\n');
}

/* ============================================================
   §4 — Sentinel: the liveness grammar state machine.
   Default 'unknown'. Only this code writes the word "live".
   ============================================================ */
export class Sentinel {
  constructor(el, opts = {}) {
    this.el = el;
    this.freshPulses = Number(opts.freshPulses ?? el.dataset.freshPulses ?? 5) || 5;
    this._lastFeedAt = 0;
    this._lastPulse = null;
    this._demote = null;
    this._tick = null;
    if (!el.dataset.state) el.dataset.state = 'unknown';
    if (!el.hasAttribute('aria-live')) el.setAttribute('aria-live', 'polite');
    if (el.dataset.state === 'unknown' && !el.textContent.trim()) this.set('unknown');
  }

  /* set(state, info)
     info: { pulse, from, to, note, at, agePulses } */
  set(state, info = {}) {
    clearTimeout(this._demote); this._demote = null;
    clearInterval(this._tick); this._tick = null;
    const el = this.el;
    el.classList.remove('alarm');
    el.dataset.state = state;
    el.removeAttribute('title');
    switch (state) {
      case 'unknown':
        el.textContent = 'checking…';
        break;
      case 'live': {
        const p = info.pulse ?? this._lastPulse;
        el.textContent = `live${p ? ` · p#${fmtPulse(p)}` : ''}`;
        this._armDemotion();
        break;
      }
      case 'paused': {
        const p = info.pulse;
        el.textContent = `paused${p ? ` @ p#${fmtPulse(p)}` : ''}${info.note ? ` · ${info.note}` : ''}`;
        break;
      }
      case 'replay':
        el.textContent = (info.from && info.to)
          ? `replay · recorded p#${fmtPulse(info.from)} → p#${fmtPulse(info.to)}`
          : `replay${info.note ? ` · ${info.note}` : ''}`;
        break;
      case 'stale':
        this._startStaleAge(info.agePulses);
        break;
      case 'fail':
        el.textContent = `proof failed${info.at ? ` at ${info.at}` : ''}${info.note ? ` · ${info.note}` : ''}`;
        break;
      case 'alarm':
        // inverse video — ONLY a page failing its own self-check (§0 rule 2)
        el.classList.add('alarm');
        el.setAttribute('role', 'alert');
        el.textContent = info.note || 'THIS PAGE DOES NOT MATCH ITS MANIFEST';
        break;
      default:
        el.textContent = String(state);
    }
    return this;
  }

  /* feed(pulseId): real data arrived — earn live, breathe once,
     re-arm the demotion clock. Motion is event-driven (§3). */
  feed(pulseId) {
    this._lastFeedAt = Date.now();
    if (pulseId != null) this._lastPulse = Number(pulseId);
    this.set('live', { pulse: this._lastPulse });
    if (!prm.matches) {
      this.el.classList.remove('breathe');
      void this.el.offsetWidth;
      this.el.classList.add('breathe');
    }
    return this;
  }

  /* verified(): a client-side proof passed — earn the bloom (e3→e2). */
  verified() {
    if (this.el.dataset.state === 'live') this.el.setAttribute('data-verified', '');
    return this;
  }

  _armDemotion() {
    clearTimeout(this._demote);
    this._demote = setTimeout(() => {
      this.set('stale', { agePulses: this.freshPulses });
    }, this.freshPulses * cadenceMs());
  }

  /* STALE: the only live element on a stale panel is its age,
     counting up in pulses — proof the page itself is awake (§4). */
  _startStaleAge(basePulses) {
    const cad = cadenceMs();
    const baseAt = this._lastFeedAt || Date.now() - (Number(basePulses) || 0) * cad;
    const render = () => {
      const age = Math.max(0, Math.floor((Date.now() - baseAt) / cad));
      this.el.textContent = `last verified +${fmtPulse(age)} pulses ago`;
      this.el.setAttribute('title', fmtDur(age, cad));   // italic gloss channel
    };
    render();
    this._tick = setInterval(render, cad);
  }

  destroy() {
    clearTimeout(this._demote);
    clearInterval(this._tick);
  }
}

export function sentinel(elOrSel, opts) {
  const el = typeof elOrSel === 'string' ? document.querySelector(elOrSel) : elOrSel;
  if (!el) return null;
  if (!el._ledaticSentinel) el._ledaticSentinel = new Sentinel(el, opts);
  return el._ledaticSentinel;
}

/* ============================================================
   §5.4 — page self-check vs the signed deploy manifest.
   ALARM is earned only by a real mismatch. A missing manifest is
   honestly 'unknown', never alarm, never green.
   ============================================================ */
function pageKeyCandidates(path) {
  let p = String(path || '/').split('?')[0].split('#')[0];
  if (p.endsWith('/')) p += 'index.html';
  p = p.replace(/^\/+/, '') || 'index.html';
  const out = [p];
  if (!/\.[a-z0-9]+$/i.test(p)) out.push(`${p}.html`);
  return out;
}

export async function selfCheck(opts = {}) {
  const manifestUrl = opts.manifestUrl || '/attest/site/latest.json';
  const pagePath = opts.pagePath ?? (hasDOM ? location.pathname : null);

  let m;
  try {
    const res = await fetchT(manifestUrl, MANIFEST_TIMEOUT_MS, { cache: 'no-store' });
    if (res.status === 404) return { outcome: 'unknown', reason: 'no signed deploy manifest published yet' };
    if (!res.ok) return { outcome: 'unknown', reason: `manifest endpoint ${res.status}` };
    m = await res.json();
  } catch (e) {
    return { outcome: 'unknown', reason: `manifest unreachable (${String(e && e.message || e)})` };
  }

  // The manifest must verify before it can vouch for anything.
  const proof = await verifyManifestObject(m, { manifestUrl, keys: opts.keys, currentPulse: opts.currentPulse });
  if (proof.outcome === 'fail') {
    return { outcome: 'alarm', reason: `deploy manifest failed verification at ${proof.failedAt}`, proof };
  }
  if (proof.outcome === 'unverified') {
    return { outcome: 'unknown', reason: proof.note || 'manifest could not be verified here', proof };
  }
  if (!pagePath) return { outcome: 'ok', n: m.n, pulse: m.pulse_id, deployed_at: m.deployed_at, page: null, proof };

  const cands = pageKeyCandidates(pagePath);
  const entry = (m.files || []).find((f) => cands.includes(f.key));
  if (!entry) {
    return { outcome: 'unknown', reason: `this page (${cands[0]}) is not listed in deploy #${m.n}`, n: m.n, proof };
  }
  let pageHash;
  try {
    const res = await fetchT(pagePath, ARTIFACT_TIMEOUT_MS, { cache: 'no-store' });
    if (!res.ok) return { outcome: 'unknown', reason: `could not re-fetch this page (${res.status})`, proof };
    pageHash = await sha256Hex(await res.arrayBuffer());
  } catch (e) {
    return { outcome: 'unknown', reason: `could not re-fetch this page (${String(e && e.message || e)})`, proof };
  }
  if (pageHash !== entry.sha256) {
    return {
      outcome: 'alarm',
      reason: `served bytes ${pageHash.slice(0, 16)}… do not match deploy #${m.n}'s ${entry.sha256.slice(0, 16)}…`,
      n: m.n, pulse: m.pulse_id, page: entry.key, proof,
    };
  }
  return { outcome: 'ok', n: m.n, pulse: m.pulse_id, deployed_at: m.deployed_at, page: entry.key, sha256: pageHash, proof };
}

export async function mountSelfCheck(el, opts = {}) {
  if (!el) return null;
  el.dataset.selfcheck = 'unknown';
  const r = await selfCheck(opts);
  if (r.outcome === 'ok') {
    el.dataset.selfcheck = 'ok';
    el.textContent = `build #${r.n} verified @ p#${fmtPulse(r.pulse)} ⌁`;
    if (r.deployed_at) el.setAttribute('title', r.deployed_at);
  } else if (r.outcome === 'alarm') {
    el.dataset.selfcheck = 'alarm';
    el.classList.add('alarm');
    el.setAttribute('role', 'alert');
    el.textContent = 'THIS PAGE DOES NOT MATCH ITS MANIFEST';
    el.setAttribute('title', r.reason);
  } else {
    el.dataset.selfcheck = 'unknown';
    el.textContent = `self-check unavailable · ${r.reason}`;
  }
  return r;
}

/* ============================================================
   DOM layer — tray + popover rendering. Engine stays headless.
   ============================================================ */
let uid = 0;

function trayFor(btn) {
  const id = btn.getAttribute('aria-controls');
  let tray = id ? document.getElementById(id) : null;
  if (!tray) {
    const sib = btn.nextElementSibling;
    if (sib && sib.classList.contains('tray')) tray = sib;
  }
  if (!tray) {
    tray = document.createElement('div');
    tray.className = 'tray';
    tray.hidden = true;
    const anchor = btn.closest('p,li,h1,h2,h3,h4,h5,h6,td,th,dt,dd,figcaption,summary,label') || btn;
    anchor.insertAdjacentElement('afterend', tray);
  }
  if (!tray.id) tray.id = `tray-${++uid}`;
  btn.setAttribute('aria-controls', tray.id);
  tray.setAttribute('role', 'log');
  tray.setAttribute('aria-live', 'polite');
  return tray;
}

function tickSvg() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'tick');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M2 6.5 5 9.5 10 3');
  svg.appendChild(path);
  return svg;
}

function renderStep(tray, rows, s) {
  let row = rows.get(s.id);
  if (!row) {
    row = document.createElement('div');
    row.className = 'tray-step';
    row.append(
      Object.assign(document.createElement('span'), { className: 'st-name', textContent: s.id }),
      Object.assign(document.createElement('span'), { className: 'st-label', textContent: s.label || '' }),
      Object.assign(document.createElement('span'), { className: 'st-dots' }),
      Object.assign(document.createElement('span'), { className: 'st-res' }),
    );
    tray.appendChild(row);
    rows.set(s.id, row);
  }
  row.dataset.status = s.status;
  if (s.label) row.querySelector('.st-label').textContent = s.label;
  const res = row.querySelector('.st-res');
  res.textContent = '';
  if (s.status === 'run') {
    res.textContent = '◌';
  } else if (s.status === 'ok') {
    const tick = tickSvg();
    res.append(tick, ` ${s.res || ''}`);
    requestAnimationFrame(() => tick.classList.add('draw'));   // 140ms draw, truthful stagger
  } else if (s.status === 'fail') {
    res.textContent = `✗ ${s.res || ''}`;
  } else if (s.status === 'skip') {
    res.textContent = '– skipped';
  } else {
    res.textContent = s.res || '–';
  }
  const oldNote = row.nextElementSibling;
  if (oldNote && oldNote.classList.contains('tray-note') && oldNote.dataset.for === s.id) oldNote.remove();
  if (s.note) {
    const note = document.createElement('div');
    note.className = 'tray-note';
    note.dataset.for = s.id;
    if (s.status !== 'fail') note.dataset.tone = 'info';
    note.textContent = s.note;
    row.insertAdjacentElement('afterend', note);
  }
}

function copyControls(text) {
  const wrap = document.createElement('span');
  if (!(navigator.clipboard && navigator.clipboard.writeText)) return wrap;   // receipt stays selectable
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-btn';
  btn.textContent = 'copy';
  const echo = document.createElement('span');
  echo.className = 'copy-echo';
  echo.textContent = 'copied';
  echo.setAttribute('aria-hidden', 'true');
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      btn.classList.add('copied');
      echo.classList.add('show');
      setTimeout(() => { btn.classList.remove('copied'); echo.classList.remove('show'); }, 2000);
    } catch { /* clipboard refused — the text is still selectable */ }
  });
  wrap.append(btn, echo);
  return wrap;
}

function renderVerdict(tray, r) {
  const v = document.createElement('div');
  v.className = 'tray-verdict';
  if (r.outcome === 'ok') {
    const secs = (r.ms / 1000).toFixed(2);
    const gloss = r.hashed ? ''
      : r.rotatedLive ? ' · attested digest verified, live bytes have rotated on'
      : ' · artifact bytes not fetched';
    v.textContent = `verified in your browser · ${secs} s · nothing executed server-side${gloss}`;
  } else if (r.outcome === 'fail') {
    v.dataset.tone = 'fail';
    v.textContent = `proof FAILED at ${r.failedAt} — ${r.note}`;
  } else {
    v.dataset.tone = 'unverified';
    v.textContent = `could not verify here — ${r.note}`;
  }
  tray.appendChild(v);

  const rec = document.createElement('details');
  rec.className = 'receipt';
  const sum = document.createElement('summary');
  sum.textContent = 'receipt';
  sum.appendChild(copyControls(r.receipt));
  const pre = document.createElement('pre');
  pre.textContent = r.receipt;
  rec.append(sum, pre);
  tray.appendChild(rec);

  const pin = document.createElement('div');
  pin.className = 'tray-keypin';
  const entry = PINNED_KEYS[r.witnessName];
  pin.append('pin the key once — verify everything after');
  if (r.pkFp) pin.append(` · ${r.witnessName || 'key'} ${group4(r.pkFp)}`);
  if (entry && entry.pem_url) {
    pin.append(' · ');
    const a = document.createElement('a');
    a.href = entry.pem_url;
    a.textContent = 'public key';
    pin.appendChild(a);
  }
  pin.append(' · ');
  const repo = document.createElement('a');
  repo.href = KEY_SOURCE_URL;
  repo.rel = 'noopener';
  repo.textContent = 'out-of-band copy';
  pin.appendChild(repo);
  tray.appendChild(pin);
}

function rememberOutcome(btn, manifestUrl, outcome) {
  if (outcome !== 'ok' && outcome !== 'fail') return;
  btn.dataset.proved = outcome;                       // §5.1 session persistence
  try { sessionStorage.setItem(`ledatic:proof:${manifestUrl}`, outcome); } catch { /* private mode */ }
}

async function openTray(btn, tray) {
  const manifestUrl = btn.dataset.manifest;
  btn.setAttribute('aria-expanded', 'true');
  tray.hidden = false;
  tray.textContent = '';
  delete tray.dataset.outcome;
  if (!prm.matches) {
    tray.classList.remove('sweep');
    void tray.offsetWidth;
    tray.classList.add('sweep');                      // 120ms prove-press scanline
  }
  const name = btn.dataset.name
    || (btn.querySelector('data') && btn.querySelector('data').textContent.trim())
    || 'attested claim';
  const title = document.createElement('div');
  title.className = 'tray-title';
  const affix = Object.assign(document.createElement('span'), { className: 'affix', textContent: '⌁' });
  affix.setAttribute('aria-hidden', 'true');
  title.append(affix, `PROVE  ${name}`);
  tray.appendChild(title);

  const rows = new Map();
  const r = await runProof(manifestUrl, {
    artifactUrl: btn.dataset.artifact || undefined,
    onStep: (s) => renderStep(tray, rows, s),
  });
  renderVerdict(tray, r);
  tray.dataset.outcome = r.outcome;
  rememberOutcome(btn, manifestUrl, r.outcome);
  if (r.outcome === 'ok' && !prm.matches) {
    tray.classList.add('bloom');                      // charge to --e3 …
    requestAnimationFrame(() => requestAnimationFrame(() => tray.classList.remove('bloom'))); // … decay 1.6s
  }
  return r;
}

function bindTray(btn) {
  const tray = trayFor(btn);
  if (!btn.hasAttribute('aria-expanded')) btn.setAttribute('aria-expanded', 'false');
  btn.addEventListener('click', () => {
    if (btn.getAttribute('aria-expanded') === 'true') {
      btn.setAttribute('aria-expanded', 'false');
      tray.hidden = true;
    } else {
      openTray(btn, tray);
    }
  });
}

/* popover variant (§5.1) — 3-line proof card via the native
   Popover API. No support → the full tray is the fallback. */
function bindPopover(btn) {
  const pop = document.createElement('div');
  pop.className = 'proof-pop';
  pop.id = `proof-pop-${++uid}`;
  pop.setAttribute('popover', 'auto');
  document.body.appendChild(pop);
  btn.setAttribute('popovertarget', pop.id);

  const place = () => {
    const rect = btn.getBoundingClientRect();
    const w = pop.offsetWidth || 280;
    pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - w - 8))}px`;
    pop.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 16)}px`;
  };

  pop.addEventListener('toggle', async (e) => {
    if (e.newState !== 'open') return;
    pop.textContent = '⌁ proving…';
    delete pop.dataset.outcome;
    place();
    const r = await runProof(btn.dataset.manifest, { artifactUrl: btn.dataset.artifact || undefined });
    pop.textContent = '';
    pop.dataset.outcome = r.outcome;
    const line = (cls, status) => {
      const div = document.createElement('div');
      div.className = 'pop-line';
      if (status) div.dataset.status = status;
      pop.appendChild(div);
      return div;
    };
    const mark = (ok) => Object.assign(document.createElement('span'), { className: ok ? 'ok-mark' : '', textContent: ok ? '✓ ' : '✗ ' });
    if (r.outcome === 'ok') {
      const l1 = line('', 'ok'); l1.append('sha256 ', mark(true), groupHex((r.sha256 || '').slice(0, 16)), ' …');
      const l2 = line('', 'ok'); l2.append('sig ', mark(true), `${r.witnessName} · @ p#${fmtPulse(r.pulse)}`);
    } else if (r.outcome === 'fail') {
      const l1 = line('', 'fail'); l1.append(mark(false), `proof failed at ${r.failedAt} — ${r.note}`);
    } else {
      const l1 = line('', 'info'); l1.textContent = `could not verify here — ${r.note}`;
    }
    const l3 = line('');
    l3.append('receipt ');
    l3.appendChild(copyControls(r.receipt));
    l3.append(' · ');
    const a = document.createElement('a');
    a.href = btn.dataset.manifest;
    a.textContent = 'manifest →';
    l3.appendChild(a);
    rememberOutcome(btn, btn.dataset.manifest, r.outcome);
    place();
  });
}

function bindProve(btn) {
  if (btn._ledaticProve) return;
  btn._ledaticProve = true;
  if (!btn.dataset.manifest) return;
  try {
    const prior = sessionStorage.getItem(`ledatic:proof:${btn.dataset.manifest}`);
    if (prior === 'ok' || prior === 'fail') btn.dataset.proved = prior;
  } catch { /* private mode */ }
  const popoverOK = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;
  if (btn.dataset.proof === 'popover' && popoverOK) bindPopover(btn);
  else bindTray(btn);
}

/* ── init / public surface ───────────────────────────────────── */
export function scan(root) {
  const r = root || document;
  r.querySelectorAll('button.prove[data-manifest]').forEach(bindProve);
  r.querySelectorAll('[data-sentinel]').forEach((el) => {
    const s = sentinel(el);
    if (el.dataset.sentinel === 'pulse') wirePulseSentinel(s);
  });
}

/* data-sentinel="pulse": live while the beacon actually delivers,
   via the shared pulse-bus (§5.3) — this module never polls. */
function wirePulseSentinel(s) {
  if (!s || s._pulseWired) return;
  s._pulseWired = true;
  const hook = (LP) => { if (LP && LP.bus) LP.bus.subscribe((p) => s.feed(p && p.pulse_id)); };
  if (window.LedaticPulse) hook(window.LedaticPulse);
  else window.addEventListener('ledatic:pulsebus', (e) => hook(e.detail), { once: true });
}

if (hasDOM && !window.LedaticProof) {
  window.LedaticProof = {
    runProof, verifyManifestObject, buildReceipt, selfCheck, mountSelfCheck,
    Sentinel, sentinel, scan, detectSchema, witnessMessage, siteDeployMessage,
    filesDigest, fmtPulse, fmtDur, groupHex, PINNED_KEYS, version: '1.0.0',
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scan(), { once: true });
  } else {
    scan();
  }
  window.dispatchEvent(new CustomEvent('ledatic:proof', { detail: window.LedaticProof }));
}
