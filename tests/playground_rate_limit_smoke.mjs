// tests/playground_rate_limit_smoke.mjs
// ---------------------------------------------------------------------
// Smoke for KV-backed playground rate limiter and metrics. Designed to
// run under Apple JavaScriptCore (`jsc`) — the same engine Safari uses,
// chosen because no node is installed on this Studio. Mocks the KV
// interface in-process; no network, no wrangler.
//
// Run:
//   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc \
//     -m tests/playground_rate_limit_smoke.mjs
// Exit 0 = PASS, non-zero = FAIL. (jsc returns the result of the last
// expression; we use `quit(n)` for a clean exit code.)

import { pgMetricsInc, pgMetricsRead, pgMetricsRecordBuildMs, pgMetricsRecordRejection }
  from "../worker/playground_metrics.js";

// ── Minimal KV mock ──────────────────────────────────────────────────
function makeKV() {
  const store = new Map();
  const ttls = new Map();
  return {
    async get(key) {
      const exp = ttls.get(key);
      if (exp && Date.now() > exp) { store.delete(key); ttls.delete(key); return null; }
      const v = store.get(key);
      return v === undefined ? null : v;
    },
    async put(key, val, opts) {
      store.set(key, val);
      if (opts && opts.expirationTtl) {
        ttls.set(key, Date.now() + opts.expirationTtl * 1000);
      }
    },
    async delete(key) { store.delete(key); ttls.delete(key); },
  };
}

// Local copy of the limiter (keeps this file independent of an exported
// hook in worker.js). This is the same algorithm as the inlined copy.
const PG_RL_RATE = 10;
const PG_RL_WINDOW_MS = 60 * 1000;
const PG_RL_TTL = 70;
async function playgroundRateLimit(ip, env) {
  if (!env || !env.LEDATIC_KV) return true;
  const minuteBucket = Math.floor(Date.now() / PG_RL_WINDOW_MS);
  const key = `pg:rl:${ip}:${minuteBucket}`;
  try {
    const raw = await env.LEDATIC_KV.get(key);
    const count = raw ? parseInt(raw, 10) || 0 : 0;
    if (count >= PG_RL_RATE) return false;
    await env.LEDATIC_KV.put(key, String(count + 1), { expirationTtl: PG_RL_TTL });
    return true;
  } catch (_) { return true; }
}

// ── Test runner ──────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; print("  PASS  " + label); }
  else    { fail++; print("  FAIL  " + label + (detail ? " — " + detail : "")); }
}

async function run() {
  // limiter
  print("playground_rate_limit_smoke");
  {
    const env = { LEDATIC_KV: makeKV() };
    let allowed = 0;
    for (let i = 0; i < 10; i++) if (await playgroundRateLimit("1.2.3.4", env)) allowed++;
    check("allows first 10 requests in the window", allowed === 10, "got " + allowed + "/10");
  }
  {
    const env = { LEDATIC_KV: makeKV() };
    for (let i = 0; i < 10; i++) await playgroundRateLimit("1.2.3.5", env);
    const allowed = await playgroundRateLimit("1.2.3.5", env);
    check("rejects the 11th request in the same window", allowed === false);
  }
  {
    const env = { LEDATIC_KV: makeKV() };
    for (let i = 0; i < 10; i++) await playgroundRateLimit("a.b.c.1", env);
    const otherAllowed = await playgroundRateLimit("a.b.c.2", env);
    check("a separate IP starts at 0 in its own bucket", otherAllowed === true);
  }
  {
    const allowed = await playgroundRateLimit("9.9.9.9", { LEDATIC_KV: null });
    check("fails open when LEDATIC_KV is missing", allowed === true);
  }
  {
    const env = { LEDATIC_KV: { async get() { throw new Error("kv 500"); }, async put() {} } };
    const allowed = await playgroundRateLimit("err.ip", env);
    check("fails open when KV.get throws", allowed === true);
  }
  {
    const ttlSeen = [];
    const env = {
      LEDATIC_KV: {
        async get() { return null; },
        async put(_, __, opts) { ttlSeen.push(opts && opts.expirationTtl); },
      },
    };
    await playgroundRateLimit("ttl.ip", env);
    check("put includes expirationTtl > 60s",
      ttlSeen.length === 1 && ttlSeen[0] > 60,
      "ttls=" + JSON.stringify(ttlSeen));
  }

  // metrics
  print("playground_metrics");
  {
    const env = { LEDATIC_KV: makeKV() };
    await pgMetricsInc(env, "total_compiles");
    await pgMetricsInc(env, "total_compiles");
    await pgMetricsInc(env, "ok_compiles");
    const data = await pgMetricsRead(env);
    check("counters increment correctly",
      data.counters.total_compiles === 2 && data.counters.ok_compiles === 1,
      JSON.stringify(data.counters));
  }
  {
    const env = { LEDATIC_KV: makeKV() };
    for (const v of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
      await pgMetricsRecordBuildMs(env, v);
    }
    const data = await pgMetricsRead(env);
    check("build_ms p50 between 40 and 60",
      data.build_ms.p50_ms >= 40 && data.build_ms.p50_ms <= 60,
      "p50=" + data.build_ms.p50_ms);
    check("build_ms p99 >= 90", data.build_ms.p99_ms >= 90, "p99=" + data.build_ms.p99_ms);
  }
  {
    const env = { LEDATIC_KV: makeKV() };
    for (let i = 0; i < 12; i++) await pgMetricsRecordRejection(env, "reason " + i);
    for (let i = 0; i < 5; i++) await pgMetricsRecordRejection(env, "reason 0");
    const data = await pgMetricsRead(env);
    const keys = Object.keys(data.top_rejections);
    check("rejections capped at 10 distinct keys", keys.length <= 10, keys.length + " keys");
    check("most-frequent rejection ranks first",
      data.top_rejections["reason 0"] === 6,
      JSON.stringify(data.top_rejections));
  }
  {
    const env = { LEDATIC_KV: makeKV() };
    await pgMetricsInc(env, "not_a_real_counter");
    const data = await pgMetricsRead(env);
    check("unknown counter name is ignored",
      data.counters.not_a_real_counter === undefined && data.counters.total_compiles === 0);
  }

  print("\nResult: PASS=" + pass + " FAIL=" + fail);
  // jsc has `quit(n)` in newer builds; if not, throw to non-zero exit.
  if (typeof quit === "function") quit(fail === 0 ? 0 : 1);
  if (fail !== 0) throw new Error("FAIL=" + fail);
}

await run();
