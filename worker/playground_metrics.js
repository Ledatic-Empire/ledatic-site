// worker/playground_metrics.js
// ----------------------------------------------------------------------
// Standalone reference implementation of the playground metrics module.
// The deployed Worker (worker.js) inlines these functions because the
// upload pipeline (deploy_worker.sh) sends a single .js file. This file
// is the "spec" — keep it in sync if you change the inline copy in
// worker.js. Tests can `import` from here directly.
//
// Storage: KV keys
//   pgm:counters             -> JSON { total_compiles, ok_compiles,
//                                       sanitize_rejected, compile_error,
//                                       http_error, timeout, rate_limited,
//                                       upstream_unreachable }
//   pgm:timing:build_ms      -> JSON { samples: [N0, N1, ...] (capped 256),
//                                       total: N }
//   pgm:rejections           -> JSON { "<reason>": count, ... } (cap 10)
//   pgm:last                 -> JSON { ts, last_status }
//
// All ops are best-effort. Counter writes use last-writer-wins (a
// concurrent miss under-counts by ~1; acceptable at v0 traffic). For
// strict counters use Cloudflare Analytics Engine or a Durable Object;
// neither is wired into this Worker today.
//
// Read endpoint: GET /api/playground/metrics  (Bearer-token authed via
// env.API_BEARER, same as /api/update).

const PGM_COUNTERS_KEY = "pgm:counters";
const PGM_TIMING_KEY   = "pgm:timing:build_ms";
const PGM_REJECT_KEY   = "pgm:rejections";
const PGM_LAST_KEY     = "pgm:last";
const PGM_TIMING_CAP   = 256;
const PGM_REJECT_CAP   = 10;

const PGM_COUNTER_NAMES = [
  "total_compiles",
  "ok_compiles",
  "sanitize_rejected",
  "compile_error",
  "http_error",
  "timeout",
  "rate_limited",
  "upstream_unreachable",
];

export async function pgMetricsInc(env, name) {
  if (!env || !env.LEDATIC_KV) return;
  if (!PGM_COUNTER_NAMES.includes(name)) return;
  try {
    const raw = await env.LEDATIC_KV.get(PGM_COUNTERS_KEY);
    const c = raw ? JSON.parse(raw) : {};
    c[name] = (c[name] || 0) + 1;
    await env.LEDATIC_KV.put(PGM_COUNTERS_KEY, JSON.stringify(c));
  } catch (_) { /* swallow */ }
}

export async function pgMetricsRecordBuildMs(env, ms) {
  if (!env || !env.LEDATIC_KV) return;
  if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return;
  try {
    const raw = await env.LEDATIC_KV.get(PGM_TIMING_KEY);
    const t = raw ? JSON.parse(raw) : { samples: [], total: 0 };
    t.samples.push(ms | 0);
    if (t.samples.length > PGM_TIMING_CAP) {
      t.samples = t.samples.slice(-PGM_TIMING_CAP);
    }
    t.total = (t.total || 0) + 1;
    await env.LEDATIC_KV.put(PGM_TIMING_KEY, JSON.stringify(t));
  } catch (_) { /* swallow */ }
}

export async function pgMetricsRecordRejection(env, reason) {
  if (!env || !env.LEDATIC_KV) return;
  if (typeof reason !== "string" || reason.length === 0) return;
  // Truncate to keep KV value small.
  const key = reason.slice(0, 80);
  try {
    const raw = await env.LEDATIC_KV.get(PGM_REJECT_KEY);
    const r = raw ? JSON.parse(raw) : {};
    r[key] = (r[key] || 0) + 1;
    // Cap to top 10 by count.
    const entries = Object.entries(r).sort((a, b) => b[1] - a[1]).slice(0, PGM_REJECT_CAP);
    const trimmed = Object.fromEntries(entries);
    await env.LEDATIC_KV.put(PGM_REJECT_KEY, JSON.stringify(trimmed));
  } catch (_) { /* swallow */ }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export async function pgMetricsRead(env) {
  if (!env || !env.LEDATIC_KV) {
    return { error: "no KV binding" };
  }
  const [cRaw, tRaw, rRaw, lRaw] = await Promise.all([
    env.LEDATIC_KV.get(PGM_COUNTERS_KEY),
    env.LEDATIC_KV.get(PGM_TIMING_KEY),
    env.LEDATIC_KV.get(PGM_REJECT_KEY),
    env.LEDATIC_KV.get(PGM_LAST_KEY),
  ]);
  const counters = cRaw ? JSON.parse(cRaw) : {};
  for (const n of PGM_COUNTER_NAMES) if (counters[n] === undefined) counters[n] = 0;
  const timing = tRaw ? JSON.parse(tRaw) : { samples: [], total: 0 };
  const sorted = [...(timing.samples || [])].sort((a, b) => a - b);
  const out_timing = {
    samples_in_window: sorted.length,
    total_observed: timing.total || 0,
    p50_ms: percentile(sorted, 50),
    p95_ms: percentile(sorted, 95),
    p99_ms: percentile(sorted, 99),
    min_ms: sorted[0] || 0,
    max_ms: sorted[sorted.length - 1] || 0,
  };
  const rejections = rRaw ? JSON.parse(rRaw) : {};
  const last = lRaw ? JSON.parse(lRaw) : null;
  return {
    schema_version: 1,
    counters,
    build_ms: out_timing,
    top_rejections: rejections,
    last,
    note: "best-effort; KV last-writer-wins under concurrency",
  };
}

export async function pgMetricsHandler(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!env || !env.API_BEARER || auth !== `Bearer ${env.API_BEARER}`) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  const data = await pgMetricsRead(env);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export const PGM_INTERNALS = {
  PGM_COUNTERS_KEY,
  PGM_TIMING_KEY,
  PGM_REJECT_KEY,
  PGM_LAST_KEY,
  PGM_COUNTER_NAMES,
  PGM_TIMING_CAP,
  PGM_REJECT_CAP,
};
