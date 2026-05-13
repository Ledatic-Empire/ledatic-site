// _shared/rail_playground.js — playground runner.
//
// Pipeline:
//   1. POST {src} to /api/playground/compile (Worker-proxied to Rail
//      compile_server). Server returns {ok:true, wasm_b64, build_ms}
//      or {ok:false, error:"..."} (sanitize/compile rejection).
//   2. base64-decode wasm bytes.
//   3. Instantiate with WASI shims:
//        - fd_write: walk the iovec, append decoded UTF-8 to stdout buffer.
//        - proc_exit: capture exit code, throw a tagged exception so
//          control returns to JS even though _start has called it.
//   4. Run _start() inside a 5s race.
//   5. Return {kind, stdout, exit, buildMs} or rejection variants.
//
// Designed to run both in a browser tab AND in JavaScriptCore CLI
// (Apple's `jsc`) so the e2e test can drive the same code path the
// browser uses. fetch() is polyfillable; we accept a `fetchFn`
// override in opts for headless tests where we POST via subprocess.
//
// Reference: rail_wasm_abi.md (Rail-WASM emit shape, proc_exit/fd_write
// usage); existing 8-demo runner pattern in tools/deploy/gen_site.rail
// :408 (single fd_write iovec assumption — we generalize to N iovecs
// for correctness on multi-print programs).

// ── starter snippets (mirror /rail's 8 embedded demos) ────────────────
export const STARTERS = [
  { label: 'hello',      src: 'main =\n  let _ = print "Hello from Rail!"\n  let _ = print "Running as WebAssembly."\n  0\n' },
  { label: 'fibonacci',  src: 'fib n =\n  if n < 2 then n\n  else fib (n - 1) + fib (n - 2)\n\nmain =\n  let _ = print (fib 10)\n  let _ = print (fib 20)\n  let _ = print (fib 30)\n  0\n' },
  { label: 'arithmetic', src: 'square x = x * x\ncube x = x * x * x\n\nmain =\n  let _ = print (square 7)\n  let _ = print (cube 5)\n  let _ = print (square 12 + cube 3)\n  0\n' },
  { label: 'lists',      src: 'main =\n  let xs = [10, 20, 30, 40]\n  let _ = print (show (head xs))\n  let _ = print (show (length xs))\n  let _ = print (show (head (tail (tail xs))))\n  0\n' },
  { label: 'adt+match',  src: 'type Shape =\n  | Circle r\n  | Rect w h\n\narea s = match s\n  | Circle r -> r * r * 3\n  | Rect w h -> w * h\n\nmain =\n  let _ = print (show (area (Circle 5)))\n  let _ = print (show (area (Rect 4 7)))\n  let _ = print (show (area (Circle 10)))\n  0\n' },
  { label: 'closures',   src: 'apply f x = f x\n\nmain =\n  let scale = 10\n  let mul = \\x -> x * scale\n  let _ = print (show (apply mul 7))\n  let offset = 100\n  let add = \\x -> x + offset\n  let _ = print (show (apply add 42))\n  0\n' },
  { label: 'fizzbuzz',   src: 'fizzbuzz n = if n > 20 then 0\n  else\n    let _ = if (n % 15) == 0\n      then print "FizzBuzz"\n      else if (n % 3) == 0\n      then print "Fizz"\n      else if (n % 5) == 0\n      then print "Buzz"\n      else print (show n)\n    fizzbuzz (n + 1)\n\nmain =\n  let _ = fizzbuzz 1\n  0\n' },
  { label: 'gc-stress',  src: 'loop n =\n  if n == 0 then 0\n  else\n    let _ = cons n []\n    loop (n - 1)\n\nmain =\n  let _ = print "GC stress: 100000 cons in 1MB heap..."\n  let _ = loop 100000\n  let _ = print "Done — GC reclaimed garbage."\n  0\n' },
];

// ── base64 → Uint8Array (works in browser, Node, and jsc) ─────────────
function base64ToBytes(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Node (no atob in older Node, present in 16+) — Buffer fallback.
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(b64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  throw new Error('no base64 decoder available');
}

// ── WASI shim factory ─────────────────────────────────────────────────
// Returns { imports, getStdout, getExit }. Call after instantiation,
// after running _start, to read what was captured.
function makeWasiShim() {
  const chunks = [];           // stdout chunks (Uint8Array)
  const exitBox = { code: 0, set: false };
  const decoder = (typeof TextDecoder !== 'undefined')
    ? new TextDecoder('utf-8', { fatal: false })
    : { decode: (u8) => {
        // jsc has TextDecoder (modern WebKit). This branch is a paranoid
        // fallback if some host strips it; concatenate as latin-1.
        let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
        return s;
      }};

  // memBox is filled in after instantiation so the shim sees the right buffer.
  const memBox = { mem: null };

  const imports = {
    wasi_snapshot_preview1: {
      // fd_write(fd: i32, iovs_ptr: i32, iovs_len: i32, nwritten_ptr: i32) -> errno: i32
      // iovec is { iov_base: i32, iov_len: i32 } — 8 bytes per iov.
      // We sum the bytes written and store at nwritten_ptr.
      fd_write: (fd, iovs_ptr, iovs_len, nwritten_ptr) => {
        try {
          const v = new DataView(memBox.mem.buffer);
          let total = 0;
          for (let i = 0; i < iovs_len; i++) {
            const base = iovs_ptr + i * 8;
            const p = v.getUint32(base, true);
            const l = v.getUint32(base + 4, true);
            if (l > 0) {
              // Copy out of the wasm memory — `Uint8Array(buffer, p, l)` is a
              // view; if memory.grow() ever fires the underlying buffer is
              // detached. Slice into a fresh array immediately.
              const slice = new Uint8Array(memBox.mem.buffer, p, l).slice();
              chunks.push(slice);
              total += l;
            }
          }
          if (nwritten_ptr) v.setUint32(nwritten_ptr, total, true);
          return 0;
        } catch (e) {
          return 5; // EIO — never seen in practice, but explicit > silent.
        }
      },
      // proc_exit(code: i32) -> never. Rail's _start ALWAYS calls this as
      // the terminal instruction. We capture the code and throw a tagged
      // exception so JS regains control (otherwise _start runs to the
      // host trap and we lose the value).
      proc_exit: (code) => {
        exitBox.code = code | 0;
        exitBox.set = true;
        throw new ExitException(code | 0);
      },
    },
  };

  return {
    imports,
    bindMemory: (mem) => { memBox.mem = mem; },
    getStdout: () => {
      // Concatenate chunks then decode once (UTF-8 across chunk boundaries
      // is rare for `print` output but safer this way).
      let len = 0;
      for (const c of chunks) len += c.length;
      const all = new Uint8Array(len);
      let off = 0;
      for (const c of chunks) { all.set(c, off); off += c.length; }
      return decoder.decode(all);
    },
    getExit: () => exitBox,
  };
}

// Tagged exception type — we identify by name, not instanceof, because
// some runtimes (jsc, older Safari) lose the prototype across the WASM
// host boundary.
class ExitException extends Error {
  constructor(code) { super('proc_exit'); this.name = 'ExitException'; this.exitCode = code; }
}
function isExit(e) {
  return e && (e.name === 'ExitException' || (typeof e.exitCode === 'number'));
}

// ── HTTP transport (overridable for headless tests) ───────────────────
async function defaultPost(endpoint, body) {
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); }
  catch (_) {
    return { httpStatus: r.status, parseError: true, raw: text.slice(0, 4000) };
  }
  return { httpStatus: r.status, json };
}

// ── public entry point ────────────────────────────────────────────────
export async function runRailSource(src, opts) {
  opts = opts || {};
  const endpoint = opts.endpoint || '/api/playground/compile';
  const post = opts.fetchFn || defaultPost;
  const timeoutMs = opts.timeoutMs || 5000;

  if (typeof src !== 'string' || src.length === 0) {
    return { kind: 'compile-error', reason: 'empty source' };
  }
  if (src.length > 32 * 1024) {
    return { kind: 'compile-error', reason: 'source too large (>32 KB)' };
  }

  // 1. POST to compile_server (via Worker proxy in production).
  let resp;
  try {
    resp = await post(endpoint, { src });
  } catch (e) {
    return { kind: 'http-error', reason: `POST failed: ${e.message || e}` };
  }
  if (resp.parseError) {
    return { kind: 'http-error', reason: `non-JSON response (HTTP ${resp.httpStatus}): ${resp.raw}` };
  }
  const body = resp.json;
  if (!body) {
    return { kind: 'http-error', reason: `no body (HTTP ${resp.httpStatus})` };
  }
  if (body.ok === false) {
    // Distinguish sanitize-rejection from compile-failure by the error
    // prefix the server uses. compile_server.rail formats:
    //   sanitize: <reason>     → security rejection
    //   compile failed: <stderr> → parser/codegen error
    // Anything else → generic.
    const err = body.error || 'unknown';
    if (err.startsWith('sanitize:')) {
      return { kind: 'sanitize-rejected', reason: err.slice('sanitize:'.length).trim() };
    }
    if (err.startsWith('compile failed:')) {
      return { kind: 'compile-error', reason: err.slice('compile failed:'.length).trim() };
    }
    return { kind: 'compile-error', reason: err };
  }
  if (!body.wasm_b64) {
    return { kind: 'http-error', reason: 'server returned ok=true with no wasm_b64' };
  }

  // 2. Decode + instantiate.
  let bytes;
  try { bytes = base64ToBytes(body.wasm_b64); }
  catch (e) { return { kind: 'http-error', reason: `bad base64: ${e.message || e}` }; }

  const shim = makeWasiShim();
  let instance;
  try {
    const m = await WebAssembly.instantiate(bytes, shim.imports);
    instance = m.instance;
  } catch (e) {
    return { kind: 'http-error', reason: `wasm instantiation failed: ${e.message || e}` };
  }
  if (!instance.exports || !instance.exports.memory || !instance.exports._start) {
    return { kind: 'http-error', reason: 'wasm missing memory or _start export' };
  }
  shim.bindMemory(instance.exports.memory);

  // 3. Run _start under a 5s race. _start is synchronous in Rail-WASM
  // (no JS-await in the module), so we wrap in a Promise.resolve and
  // race against a setTimeout. Important: a synchronous _start that
  // hits an infinite loop will BLOCK the event loop — Promise.race
  // can't actually preempt it. WebAssembly has no native interrupt;
  // for v0 we accept that the timeout only catches async paths
  // (network errors, host-side throws). The Worker's per-request
  // wall-time limit (the proxy has its own deadline) is the real
  // backstop. Document this honestly in the spec follow-up.
  const exitPromise = new Promise((resolve) => {
    try {
      instance.exports._start();
      // _start returned normally — Rail always calls proc_exit, so we
      // SHOULD have thrown. If we didn't, default to exit 0.
      resolve({ tag: 'done' });
    } catch (e) {
      if (isExit(e)) resolve({ tag: 'exit', code: e.exitCode });
      else resolve({ tag: 'trap', error: e });
    }
  });
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve({ tag: 'timeout' }), timeoutMs);
  });
  const race = await Promise.race([exitPromise, timeoutPromise]);

  const stdout = shim.getStdout();
  if (race.tag === 'timeout') {
    return { kind: 'timeout', stdout, buildMs: body.build_ms || 0 };
  }
  if (race.tag === 'trap') {
    return {
      kind: 'runtime-error',
      reason: (race.error && (race.error.message || String(race.error))) || 'wasm trap',
      stdout,
      buildMs: body.build_ms || 0,
    };
  }
  const exitCode = race.tag === 'exit' ? race.code : (shim.getExit().set ? shim.getExit().code : 0);
  return {
    kind: 'ok',
    stdout,
    exit: exitCode,
    buildMs: body.build_ms || 0,
  };
}

// CommonJS fallback for jsc/test harnesses that load via plain script
// rather than ESM. Browser ESM consumers ignore this branch.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { runRailSource, STARTERS };
}
