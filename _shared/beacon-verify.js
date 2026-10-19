/* beacon-verify.js: check entropy beacon pulses (format 2) in the browser.

   A port of the reference verifier /entropy/verify_v2.py: canonical() and
   verify() below follow its functions line for line, so the page and the
   script count the same things and fail on the same things (spec:
   /entropy/spec). No DOM and no network here: the caller hands in records
   and a key, so this same file runs headless under node for its tests.

   One addition the script does not need: check === null means "this
   browser has no Ed25519", and signatures are then counted as unchecked
   instead of failed. Never green for a check that did not run. */

export const UNCOMMITTED = 16, FRAME_REPEAT = 2, FORMAT_CHANGE = 32;

/* The operator key, pinned in this source like the witness key in
   proof-tray.js (and deliberately not added to PINNED_KEYS there, which
   would let the beacon key vouch for prove-button manifests). key_id is
   the first 16 hex of SHA-256 of the DER SubjectPublicKeyInfo. */
export const BEACON_V2_PIN = {
  key_id: '5780ca472c3db50d',
  spki_b64: 'MCowBQYDK2VwAyEAjZal/9zPWZryIa0+n/A0cBtaCVf/SJI4fwk1pEXYID8=',
  pem_url: '/entropy/v2/key',
};

const SPKI_PREFIX = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
const enc = new TextEncoder();
const hexOf = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const sha256hex = async (bytes) => hexOf(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));

function fromHex(h) {
  if (typeof h !== 'string' || h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error('not hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

/* PEM -> { der, keyId, check }. check is null when this engine cannot
   import an Ed25519 key. Mirrors load_pubkey() in verify_v2.py. */
export async function loadKey(pem) {
  const body = String(pem).trim().split(/\r?\n/).filter((ln) => !ln.includes('-----')).join('');
  return loadDer(b64(body));
}
export async function loadDer(der) {
  if (der.length !== 44 || SPKI_PREFIX.some((b, i) => der[i] !== b)) {
    throw new Error('not an Ed25519 SubjectPublicKeyInfo');
  }
  const keyId = (await sha256hex(der)).slice(0, 16);
  let key = null;
  try { key = await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']); }
  catch {
    try { key = await crypto.subtle.importKey('raw', der.slice(-32), { name: 'Ed25519' }, false, ['verify']); }
    catch { key = null; }
  }
  const check = key ? (msg, sig) => crypto.subtle.verify({ name: 'Ed25519' }, key, sig, msg) : null;
  return { der, keyId, check };
}

/* The canonical message: twelve \n-terminated lines, in spec order. */
export function canonical(r) {
  const f = r.frame;
  const lines = ['ledatic-beacon/2', r.pulse_id, r.unix_ms, r.prev_value_hex, f.digest,
    f.run_frame, f.epoch_seed, f.epoch_frame, r.local_random_hex,
    r.precommit_hex, r.external, r.status];
  return enc.encode(lines.map((x) => `${x}\n`).join(''));
}

/* Walk records in pulse order. Returns { n, fails }; fails holds
   [kind, pulse_id, why]. Counts are verify_v2.py's: links and precommits
   are pairs CHECKED, hash and sig are checks PASSED. */
export async function verify(records, check, keyId) {
  const n = { pulses: 0, v1: 0, v2: 0, hash: 0, sig: 0, links: 0, precommits: 0,
    uncommitted: 0, gaps_in_input: 0, sig_unchecked: 0 };
  const fails = [];
  const fail = (kind, pid, why) => fails.push([kind, pid, why]);

  let prev = null;
  for (const r of [...records].sort((a, b) => a.pulse_id - b.pulse_id)) {
    const pid = r.pulse_id;
    n.pulses += 1;
    const consecutive = prev !== null && pid === prev.pulse_id + 1;
    if (prev !== null && !consecutive) n.gaps_in_input += 1;
    if (consecutive) {
      n.links += 1;
      if (r.prev_value_hex !== prev.value_hex) fail('link', pid, "prev_value_hex is not the previous pulse's value_hex");
    }
    if (r.version !== 2) {
      n.v1 += 1;
      prev = r;
      continue;
    }
    n.v2 += 1;
    let msg = null;
    try { msg = canonical(r); } catch { msg = null; }
    if (msg && (await sha256hex(msg)) === r.value_hex) n.hash += 1;
    else fail('hash', pid, msg ? 'SHA-256(canonical message) != value_hex' : 'record lacks a canonical field');
    if (r.key_id !== keyId) fail('key', pid, `key_id ${r.key_id} is not the published key ${keyId}`);
    if (check === null) {
      n.sig_unchecked += 1;
    } else {
      let sigOk = false;
      try { sigOk = !!msg && (await check(msg, b64(r.signature))); } catch { sigOk = false; }
      if (sigOk) n.sig += 1;
      else fail('signature', pid, 'Ed25519 signature does not verify');
    }
    if (r.status & UNCOMMITTED) n.uncommitted += 1;
    if (consecutive) {
      if (prev.version === 2) {
        if (!(r.status & UNCOMMITTED)) {
          n.precommits += 1;
          let got = null;
          try { got = await sha256hex(fromHex(r.local_random_hex)); } catch { got = null; }
          if (got !== prev.precommit_hex) fail('precommit', pid, 'SHA-256(local_random) != previous precommit_hex');
        }
        const same = !!(r.frame && prev.frame) && r.frame.digest === prev.frame.digest;
        if (same !== Boolean(r.status & FRAME_REPEAT)) fail('status', pid, 'FRAME_REPEAT bit disagrees with the digests');
      } else if (!(r.status & FORMAT_CHANGE)) {
        fail('status', pid, 'follows a format 1 pulse without FORMAT_CHANGE');
      }
    }
    prev = r;
  }
  return { n, fails };
}

/* Checks that PASSED, per kind, for the one-line summary. */
export function passed(n, fails) {
  const count = (kind) => fails.filter((f) => f[0] === kind).length;
  return {
    hashes: n.hash,
    signatures: n.sig,
    links: n.links - count('link'),
    precommits: n.precommits - count('precommit'),
  };
}
