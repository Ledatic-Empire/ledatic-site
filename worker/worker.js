/**
 * Ledatic Worker — ledatic.org (public site) + reports.ledatic.org (client portal)
 *
 * Design:
 *   - ledatic.org: hybrid allow/deny. Internal KV keys (client:*, reports:*,
 *     session:*, entropy:* internals, snapshot, devlog, intakes, dead-page
 *     orphans) are denied at the Worker level. Everything else is served
 *     directly from KV with extension-based MIME + cache policy, so new
 *     pages (mission control, plasma landing, future tools) ship without
 *     Worker edits.
 *   - reports.ledatic.org: authed client portal, KV-backed client/session
 *     records, R2-backed PDF downloads.
 *   - Every response carries the strict-CSP security header stack.
 *
 * Bindings:
 *   LEDATIC_KV  — KV namespace (site content + client/report/session records)
 *   REPORTS_R2  — R2 bucket `ledatic-reports` (PDF storage)
 *
 * Source of truth: worker/worker.js in the ledatic-site repo. Deploy via
 *   worker/deploy_worker.sh
 */

// ─── Security ────────────────────────────────────────────────────────────────

const CSP = [
  "default-src 'self'",
  // 'unsafe-inline' is load-bearing for the plasma viewers (mobile.html,
  // live4k.html, holo.html) — they ship their entire poll/render loop as
  // an inline <script> per page, intentionally so each viewer is
  // self-contained and cacheable independently. Without this, iOS Safari
  // (and any strict-CSP browser) silently blocks the inline script — page
  // renders the static HUD but pulse/step/rho stay on `…` placeholders
  // forever and no /entropy/* fetch ever fires. Earned 2026-05-02 from
  // an iPhone test of /mobile.html that black-screened with no console
  // signal anywhere on the page. Migration to per-script SHA-256 hashes
  // is a future tightening, not a now-fix.
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://static.cloudflareinsights.com",
  // Inline styles are load-bearing on site2030 (animation-delay, per-page page-style blocks).
  // Google Fonts are pulled from fonts.googleapis.com.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https://pub-e9d7c87d3a1b43bea50d3bd0d8ba9ffb.r2.dev",
  "connect-src 'self' https://cloudflareinsights.com https://liveplasma.ledatic.org",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

// Per-route CSP for the /greatlakes demo. Loosens script-src + style-src to
// allow Leaflet from unpkg (with SRI), and img-src to allow CARTO basemap
// tiles. Scoped to this one page so the strict CSP stays intact everywhere
// else. Eventually replace Leaflet with hand-rolled canvas + self-hosted
// tiles, then retire this override.
const GREATLAKES_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://unpkg.com https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.basemaps.cartocdn.com https://pub-e9d7c87d3a1b43bea50d3bd0d8ba9ffb.r2.dev",
  "connect-src 'self' https://cloudflareinsights.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const SECURITY_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "content-security-policy": CSP,
};

function sec(headers) {
  return { ...SECURITY_HEADERS, ...headers };
}

// Defense-in-depth noindex for the gated /greatlakes demo. The engagement
// redline requires the page stay out of search indexes; today that rests on
// the Basic-auth gate plus an unverified <meta name=robots> inside the KV
// HTML. Stamp X-Robots-Tag at the layer the Worker controls so the page is
// non-indexable even if the gate ever regresses or the password leaks.
function secGreatlakes(headers) {
  return sec({ "X-Robots-Tag": "noindex, nofollow, noarchive", ...headers });
}

// ── /portcall single-password splash (one field, password = GREATLAKES_PASS).
// Friendlier than the /greatlakes Basic dialog: no username, sets a cookie.
function pcCookieOk(request) {
  return /(?:^|;\s*)pc_ok=1(?:;|$)/.test(request.headers.get("Cookie") || "");
}
function pcSplash(wrong) {
  const err = wrong ? '<div class="e">Incorrect password — try again.</div>' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#08172a"><meta name="robots" content="noindex,nofollow"><title>Great Lakes — Port Call</title><style>
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{min-height:100vh;display:grid;place-items:center;padding:24px;color:#eef5fd;font-family:'Inter',system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:radial-gradient(900px 500px at 70% -10%,rgba(86,164,240,.12),transparent 60%),radial-gradient(700px 400px at 0% 10%,rgba(52,204,190,.10),transparent 55%),#08172a}
.card{width:100%;max-width:362px;background:linear-gradient(180deg,#0f2740,#143655);border:1px solid rgba(125,175,215,.22);border-radius:16px;padding:30px 26px;text-align:center;box-shadow:0 30px 80px rgba(0,0,0,.45)}
.logo{width:46px;height:46px;border-radius:12px;margin:0 auto 16px;background:linear-gradient(135deg,#34ccbe,#56a4f0);display:grid;place-items:center}
.logo svg{width:26px;height:26px}
h1{font-size:19px;margin:0 0 5px;letter-spacing:-.2px;font-weight:700}
.sub{color:#a3c0dc;font-size:13.5px;margin:0 0 18px}
.e{color:#f26b83;font-size:12.5px;margin:-6px 0 14px;font-weight:500}
input{width:100%;background:#08172a;border:1px solid rgba(125,175,215,.4);color:#eef5fd;font:inherit;font-size:15px;padding:12px 14px;border-radius:10px;text-align:center;letter-spacing:.3px}
input::placeholder{color:#6c8eac}
input:focus{outline:none;border-color:#34ccbe;box-shadow:0 0 0 3px rgba(52,204,190,.15)}
button{width:100%;margin-top:12px;border:0;border-radius:10px;padding:12px;font:inherit;font-weight:700;font-size:14px;color:#04121f;background:linear-gradient(135deg,#34ccbe,#56a4f0);cursor:pointer}
.f{margin-top:16px;font-size:11px;color:#7693b1;letter-spacing:.2px}
</style></head><body><form class="card" method="POST" action="/portcall">
<div class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="#04121f" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v7"/><path d="M5 9h14l-7 12L5 9z"/></svg></div>
<h1>Great Lakes — Port Call</h1><div class="sub">Enter the password to view the demo.</div>
${err}<input type="password" name="pw" placeholder="Password" autofocus autocomplete="current-password" aria-label="Password">
<button type="submit">View demo →</button><div class="f">Private demo · Ledatic</div></form></body></html>`;
}

// ─── Deny list ───────────────────────────────────────────────────────────────

// Any KV key whose raw value must never be exposed via a public URL.
// Colon-namespaced keys (client:*, reports:*, session:*, entropy:* internals)
// are denied by pattern. Everything else is enumerated.
const DENY_EXACT = new Set([
  // Internal data with no dedicated /data/ handler
  "intakes",
  "snapshot",          // written via /api/update; public read route retired 2026-06-10
  "devlog",            // written via /api/update; public read route retired 2026-06-10
  "_test_ping",
  // Dead-page orphans from older site incarnations
  "agent.html",
  "demo.html",
  "pipeline.html",
  "tls",
  "tls/main.css",
  "assets/app.js",
  "assets/index-De4AavCV.js",
  "css/style.css",
  "js/main.js",
  // NOTE: "playground" and "playground.html" used to be denied here as
  // dead-page orphans from a 2024 site incarnation. v0 playground (2026-05-13)
  // re-uses the slug for the live editor + /api/playground/compile route.
]);

function isPrivateKey(key) {
  return key.includes(":") || DENY_EXACT.has(key);
}

// ─── MIME + cache ────────────────────────────────────────────────────────────

const MIME = {
  html: "text/html; charset=utf-8",
  htm:  "text/html; charset=utf-8",
  css:  "text/css; charset=utf-8",
  js:   "application/javascript; charset=utf-8",
  mjs:  "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  xml:  "application/xml; charset=utf-8",
  xsl:  "text/xsl; charset=utf-8",
  txt:  "text/plain; charset=utf-8",
  py:   "text/plain; charset=utf-8",
  sha256: "text/plain; charset=utf-8",
  svg:  "image/svg+xml",
  png:  "image/png",
  jpg:  "image/jpeg",
  jpeg: "image/jpeg",
  gif:  "image/gif",
  webp: "image/webp",
  ico:  "image/x-icon",
  woff: "font/woff",
  woff2:"font/woff2",
  ttf:  "font/ttf",
  wasm: "application/wasm",
  pck:  "application/octet-stream",
  frag: "text/plain; charset=utf-8",
  glsl: "text/plain; charset=utf-8",
  sh:   "text/x-shellscript; charset=utf-8",
  pem:  "application/x-pem-file",
  // Generic binary blobs — recording frames, packed-float arrays, etc.
  // MUST live in BINARY_EXT below or KV.get() decodes as text and the
  // bytes get UTF-8-mangled (every non-ASCII byte → U+FFFD, 3 bytes).
  // A 393 KB binary frame bloats to ~675 KB on the wire, unreadable.
  // Earned 2026-05-02 on the ot-stable recording deploy.
  bin:  "application/octet-stream",
  // /aliens content types — pursue mirror surface.
  pdf:  "application/pdf",
  csv:  "text/csv; charset=utf-8",
  jsonl: "application/jsonl",
  // DVIDS-hosted video records get inline-playable MIME so the browser
  // streams them instead of force-downloading.
  mp4:  "video/mp4",
  mov:  "video/quicktime",
  m4v:  "video/x-m4v",
  webm: "video/webm",
};

const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico",
  "woff", "woff2", "ttf",
  "wasm",
  "pck",
  "bin",
  "pdf",
  "mp4", "mov", "m4v", "webm",
]);

const LONG_CACHE_EXT = new Set([
  "css", "js", "mjs", "json", "xml", "xsl", "txt", "svg",
  "woff", "woff2", "ttf",
  "png", "jpg", "jpeg", "gif", "webp", "ico",
  "wasm",
  "pck",
  "frag", "glsl",
  "bin",
  "pdf",
]);

function extOf(key) {
  const slash = key.lastIndexOf("/");
  const dot = key.lastIndexOf(".");
  if (dot < 0 || dot < slash) return "";
  return key.slice(dot + 1).toLowerCase();
}

function notFound() {
  return new Response("Not Found", {
    status: 404,
    headers: sec({
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=60",
    }),
  });
}

// Branded 404 for page-shaped URLs — an honest empty state instead of the
// old homepage fallback, which 200'd every unknown path and lied to both
// humans and crawlers about what exists. Inline + dependency-free so it
// renders even if KV is unreachable.
function notFoundPage() {
  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>404 — Ledatic</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0a; color: #33ff33; font-family: 'Courier New', monospace;
    min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .box { text-align: center; padding: 24px; }
  .code { font-size: 2.2em; font-weight: bold; letter-spacing: 4px;
    text-shadow: 0 0 12px rgba(51,255,51,0.35); }
  .msg { color: #1a8a1a; margin-top: 12px; font-size: 0.9em; }
  a { color: #33ff33; }
</style></head><body>
<div class="box">
  <div class="code">&gt; 404</div>
  <div class="msg">no such page on this server.</div>
  <div class="msg"><a href="/">return home</a></div>
</div></body></html>`;
  return new Response(html, {
    status: 404,
    headers: sec({
      "content-type": MIME.html,
      "cache-control": "public, max-age=60",
    }),
  });
}

// ── Playground per-IP rate limiter ───────────────────────────────────
// KV-backed token bucket (Session C, 2026-05-13). Replaces the
// per-isolate Map limiter that under-counted across isolates — CF
// load-balances POSTs to multiple isolates so a 10/min cap could
// effectively become Nx10/min when traffic spread out. Now globally
// honest: the bucket lives in LEDATIC_KV under
//   pg:rl:<ip>:<minute_bucket>
// where minute_bucket = floor(now_ms / 60000). KV TTL is 70 s so a
// fresh bucket auto-expires shortly after its window closes; no
// cleanup pass needed.
//
// Function signature + return shape preserved (true=allow, false=deny)
// so the call site doesn't have to change beyond awaiting it.
//
// Failure mode: if KV.get/put throws (e.g. KV namespace 5xx), we
// FAIL OPEN — return true. Rationale: a flaky KV must not take down
// the playground; the upstream compile_server's 5 s wall-time cap is
// the real DoS backstop, and Worker isolate-affinity still soaks up
// most repeat traffic. We log to console.warn so the metrics endpoint
// can surface it later.
const PG_RL_RATE   = 10;           // requests per window
const PG_RL_WINDOW_MS = 60 * 1000; // 60 s
const PG_RL_TTL    = 70;           // KV TTL seconds (must be > window/1000)

async function playgroundRateLimit(ip, env) {
  // Defensive: missing env binding (e.g. local wrangler dev without KV) =>
  // fail open with a clear console mark so the metrics path can detect.
  if (!env || !env.LEDATIC_KV) {
    console.warn("pg-ratelimit: LEDATIC_KV missing, failing open");
    return true;
  }
  const minuteBucket = Math.floor(Date.now() / PG_RL_WINDOW_MS);
  const key = `pg:rl:${ip}:${minuteBucket}`;
  try {
    const raw = await env.LEDATIC_KV.get(key);
    const count = raw ? parseInt(raw, 10) || 0 : 0;
    if (count >= PG_RL_RATE) {
      return false;
    }
    // Increment + write back. Race window: two concurrent requests can
    // both read N and both write N+1 (we lose one count). At v0 traffic
    // levels this under-rejects by at most 1 per IP per minute — strictly
    // looser than intent, never tighter, which is the correct safety
    // direction for a public playground.
    await env.LEDATIC_KV.put(key, String(count + 1), { expirationTtl: PG_RL_TTL });
    return true;
  } catch (e) {
    console.warn(`pg-ratelimit: KV error (${e && e.message || e}), failing open`);
    return true;
  }
}

// ── Playground metrics (KV-backed, best-effort) ─────────────────────
// Spec/standalone copy: worker/playground_metrics.js. Inlined here
// because the deployed Worker is a single-file ESM upload. Keep both
// in sync if you change either.
const PGM_COUNTERS_KEY = "pgm:counters";
const PGM_TIMING_KEY   = "pgm:timing:build_ms";
const PGM_REJECT_KEY   = "pgm:rejections";
const PGM_LAST_KEY     = "pgm:last";
const PGM_TIMING_CAP   = 256;
const PGM_REJECT_CAP   = 10;
const PGM_COUNTER_NAMES = [
  "total_compiles", "ok_compiles", "sanitize_rejected", "compile_error",
  "http_error", "timeout", "rate_limited", "upstream_unreachable",
];
async function pgMetricsInc(env, name) {
  if (!env || !env.LEDATIC_KV) return;
  if (!PGM_COUNTER_NAMES.includes(name)) return;
  try {
    const raw = await env.LEDATIC_KV.get(PGM_COUNTERS_KEY);
    const c = raw ? JSON.parse(raw) : {};
    c[name] = (c[name] || 0) + 1;
    await env.LEDATIC_KV.put(PGM_COUNTERS_KEY, JSON.stringify(c));
  } catch (_) {}
}
async function pgMetricsRecordBuildMs(env, ms) {
  if (!env || !env.LEDATIC_KV) return;
  if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return;
  try {
    const raw = await env.LEDATIC_KV.get(PGM_TIMING_KEY);
    const t = raw ? JSON.parse(raw) : { samples: [], total: 0 };
    t.samples.push(ms | 0);
    if (t.samples.length > PGM_TIMING_CAP) t.samples = t.samples.slice(-PGM_TIMING_CAP);
    t.total = (t.total || 0) + 1;
    await env.LEDATIC_KV.put(PGM_TIMING_KEY, JSON.stringify(t));
  } catch (_) {}
}
async function pgMetricsRecordRejection(env, reason) {
  if (!env || !env.LEDATIC_KV) return;
  if (typeof reason !== "string" || reason.length === 0) return;
  const key = reason.slice(0, 80);
  try {
    const raw = await env.LEDATIC_KV.get(PGM_REJECT_KEY);
    const r = raw ? JSON.parse(raw) : {};
    r[key] = (r[key] || 0) + 1;
    const entries = Object.entries(r).sort((a, b) => b[1] - a[1]).slice(0, PGM_REJECT_CAP);
    await env.LEDATIC_KV.put(PGM_REJECT_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch (_) {}
}
function pgmPercentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}
async function pgMetricsRead(env) {
  if (!env || !env.LEDATIC_KV) return { error: "no KV binding" };
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
  return {
    schema_version: 1,
    counters,
    build_ms: {
      samples_in_window: sorted.length,
      total_observed: timing.total || 0,
      p50_ms: pgmPercentile(sorted, 50),
      p95_ms: pgmPercentile(sorted, 95),
      p99_ms: pgmPercentile(sorted, 99),
      min_ms: sorted[0] || 0,
      max_ms: sorted[sorted.length - 1] || 0,
    },
    top_rejections: rRaw ? JSON.parse(rRaw) : {},
    last: lRaw ? JSON.parse(lRaw) : null,
    note: "best-effort; KV last-writer-wins under concurrency",
  };
}

async function serveFromKV(key, env) {
  const ext = extOf(key);
  const isBin = BINARY_EXT.has(ext);
  const val = isBin
    ? await env.LEDATIC_KV.get(key, "arrayBuffer")
    : await env.LEDATIC_KV.get(key);
  if (val === null || val === undefined) return null;
  const mime = MIME[ext] || MIME.html;
  const cache = LONG_CACHE_EXT.has(ext)
    ? "public, max-age=3600, s-maxage=3600"
    : "public, max-age=300, s-maxage=300";
  return new Response(val, {
    headers: sec({
      "content-type": mime,
      "cache-control": cache,
    }),
  });
}

// ─── reports.ledatic.org helpers ─────────────────────────────────────────────

const SESSION_TTL = 86400 * 30; // 30 days

// TODO(security): unsalted single SHA-256. Migrating to salted PBKDF2 via
// crypto.subtle.deriveBits would invalidate every client.password_hash already
// stored in KV (provisioned via /api/update create_client), so it must ship as
// a coordinated re-hash/rotation of stored client records — not a drive-by
// edit here. Brute-force exposure is mitigated by the login rate limit below.
async function hashPassword(password) {
  const data = new TextEncoder().encode(password);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Login brute-force guard — KV-counted POST /login attempts per IP.
// 10 attempts per 15-minute window; KV TTL handles cleanup. Colon-namespaced
// key is auto-denied from public KV reads. Fails OPEN on KV errors (same
// rationale as the playground limiter: a flaky KV must not lock out clients).
const LOGIN_RL_MAX = 10;
const LOGIN_RL_WINDOW_MS = 15 * 60 * 1000;
async function loginRateLimited(request, env) {
  try {
    const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
    const bucket = Math.floor(Date.now() / LOGIN_RL_WINDOW_MS);
    const key = `reports:rl:${ip}:${bucket}`;
    const n = parseInt((await env.LEDATIC_KV.get(key)) || "0", 10);
    if (n >= LOGIN_RL_MAX) return true;
    await env.LEDATIC_KV.put(key, String(n + 1), { expirationTtl: 16 * 60 });
    return false;
  } catch (_) {
    return false; // fail open
  }
}

async function createSession(clientId, env) {
  const token = crypto.randomUUID();
  await env.LEDATIC_KV.put(`session:${token}`, clientId, { expirationTtl: SESSION_TTL });
  return token;
}

async function getSession(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/lr_session=([^;]+)/);
  if (!match) return null;
  return await env.LEDATIC_KV.get(`session:${match[1]}`);
}

function setCookie(token, host) {
  const secure = host.includes("ledatic.org") ? "; Secure" : "";
  return `lr_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}${secure}`;
}

function clearCookie(host) {
  const secure = host.includes("ledatic.org") ? "; Secure" : "";
  return `lr_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

async function getClient(clientId, env) {
  return await env.LEDATIC_KV.get(`client:${clientId}`, { type: "json" });
}

async function getClientReports(clientId, env) {
  return (await env.LEDATIC_KV.get(`reports:${clientId}`, { type: "json" })) || [];
}

function loginPage(error) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ledatic Reports</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0a; color: #e2e8f0; font-family: 'Courier New', monospace;
    min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .login { width: 100%; max-width: 380px; padding: 24px; }
  .brand { color: #33ff33; font-size: 1.4em; font-weight: bold; letter-spacing: 2px;
    text-shadow: 0 0 10px rgba(51,255,51,0.3); margin-bottom: 4px; text-align: center; }
  .sub { color: #1a8a1a; font-size: 0.8em; margin-bottom: 32px; text-align: center; }
  label { display: block; color: #1a8a1a; font-size: 0.75em; letter-spacing: 2px;
    text-transform: uppercase; margin-bottom: 6px; margin-top: 16px; }
  input { width: 100%; background: #111; border: 1px solid #1a3a1a; color: #e2e8f0;
    font-family: inherit; font-size: 1em; padding: 10px 12px; outline: none; }
  input:focus { border-color: #33ff33; }
  button { width: 100%; background: #33ff3322; border: 1px solid #33ff3344; color: #33ff33;
    font-family: inherit; font-size: 0.9em; padding: 10px; margin-top: 24px; cursor: pointer;
    letter-spacing: 1px; text-transform: uppercase; font-weight: bold; }
  button:hover { background: #33ff3333; }
  .err { color: #ff3333; font-size: 0.8em; margin-top: 12px; text-align: center; }
</style></head><body>
<div class="login">
  <div class="brand">&gt; LEDATIC REPORTS</div>
  <div class="sub">client portal</div>
  <form method="POST" action="/login">
    <label>Client ID</label>
    <input type="text" name="client_id" autocomplete="username" required autofocus>
    <label>Password</label>
    <input type="password" name="password" autocomplete="current-password" required>
    <button type="submit">Log In</button>
    ${error ? `<div class="err">${error}</div>` : ""}
  </form>
</div></body></html>`;
}

function dashboardPage(client, reports) {
  const byVertical = {};
  for (const r of reports) {
    if (!byVertical[r.vertical]) byVertical[r.vertical] = [];
    byVertical[r.vertical].push(r);
  }
  const verticalCards = Object.entries(byVertical).sort(([a],[b]) => a.localeCompare(b)).map(([vertical, rpts]) => {
    const niceName = vertical.replace(/_/g, " ");
    const fileLinks = rpts.sort((a,b) => (b.uploaded||"").localeCompare(a.uploaded||"")).map(r => {
      const sz = r.size > 1048576 ? (r.size/1048576).toFixed(1)+" MB" : Math.round(r.size/1024)+" KB";
      const date = r.uploaded ? r.uploaded.slice(0,10) : "";
      return `<div class="rpt"><a href="/dl/${encodeURIComponent(r.r2_key)}" target="_blank">${r.name}</a><span class="meta">${sz} &middot; ${date}</span></div>`;
    }).join("");
    return `<div class="vertical"><div class="v-header"><span class="v-name">${niceName}</span><span class="v-count">${rpts.length} report${rpts.length!==1?"s":""}</span></div>${fileLinks}</div>`;
  }).join("");
  const totalReports = reports.length;
  const totalVerticals = Object.keys(byVertical).length;
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ledatic Reports — ${client.name}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0a; color: #e2e8f0; font-family: 'Courier New', monospace;
    min-height: 100vh; padding: 40px 24px; max-width: 760px; margin: 0 auto; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; }
  .brand { color: #33ff33; font-size: 1.4em; font-weight: bold; letter-spacing: 2px;
    text-shadow: 0 0 10px rgba(51,255,51,0.3); margin-bottom: 4px; }
  .sub { color: #1a8a1a; font-size: 0.8em; }
  .logout { color: #333; font-size: 0.75em; text-decoration: none; padding: 4px 12px;
    border: 1px solid #222; }
  .logout:hover { color: #666; border-color: #444; }
  .section-title { color: #33ff33; font-size: 0.7em; letter-spacing: 3px;
    text-transform: uppercase; margin-bottom: 12px; padding-bottom: 8px;
    border-bottom: 1px solid #1a3a1a; }
  .vertical { border: 1px solid #1a2a1a; padding: 16px 20px; margin-bottom: 8px;
    border-radius: 6px; }
  .vertical:hover { border-color: #33ff3344; }
  .v-header { display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 10px; }
  .v-name { font-weight: bold; font-size: 1em; }
  .v-count { font-size: 0.7em; color: #666; }
  .rpt { padding: 4px 0; font-size: 0.8em; display: flex; justify-content: space-between;
    align-items: center; }
  .rpt a { color: #33ff33; text-decoration: none; }
  .rpt a:hover { text-decoration: underline; }
  .rpt .meta { color: #1a6a1a; font-size: 0.85em; }
  .stats { margin-top: 32px; padding-top: 16px; border-top: 1px solid #1a2a1a;
    display: flex; gap: 32px; font-size: 0.8em; color: #1a8a1a; }
  .stats .num { color: #33ff33; font-weight: bold; }
  .empty { color: #333; font-size: 0.85em; padding: 40px 0; text-align: center; }
</style></head><body>
<div class="top">
  <div>
    <div class="brand">&gt; LEDATIC REPORTS</div>
    <div class="sub">${client.name}</div>
  </div>
  <a href="/logout" class="logout">log out</a>
</div>
<div class="section-title">Your Reports</div>
${verticalCards || '<div class="empty">No reports yet. They will appear here as they are generated.</div>'}
<div class="stats">
  <div><span class="num">${totalVerticals}</span> verticals</div>
  <div><span class="num">${totalReports}</span> reports</div>
  <div><span class="num">$0</span> per report</div>
</div>
</body></html>`;
}

// ─── reports.ledatic.org handler ─────────────────────────────────────────────

// Public access switch. false = portal archived (410 + honest page); all
// portal code below is preserved and the /api/update ingestion endpoint
// stays live, so flipping this back fully restores the product.
const REPORTS_PUBLIC = false;

function reportsArchivedPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>archived — ledatic</title>
<style>body{background:#050805;color:#7dff9a;font:16px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:34rem;padding:2rem;text-align:center}
h1{font-size:1.1rem;letter-spacing:.12em;font-weight:600}
p{color:#4eae68}a{color:#7dff9a}</style></head><body><main>
<h1>// REPORT PORTAL — ARCHIVED</h1>
<p>This client portal completed its engagement and has been archived
from public view. The reports, their attestations, and the software
that produced them are preserved intact.</p>
<p><a href="https://ledatic.org/">ledatic.org</a></p>
</main></body></html>`;
}

async function handleReports(request, env, pathname) {
  const method = request.method;
  const host = request.headers.get("Host") || "";

  if (pathname === "/" || pathname === "/login") {
    if (method === "GET") {
      const clientId = await getSession(request, env);
      if (clientId) return Response.redirect(new URL("/dashboard", request.url).href, 302);
      return new Response(loginPage(), { headers: sec({ "content-type": MIME.html }) });
    }
    if (method === "POST") {
      if (await loginRateLimited(request, env)) {
        return new Response(loginPage("Too many attempts — try again in a few minutes"), {
          status: 429, headers: sec({ "content-type": MIME.html, "retry-after": "900" }),
        });
      }
      const form = await request.formData();
      const clientId = (form.get("client_id") || "").trim().toLowerCase();
      const password = form.get("password") || "";
      const client = await getClient(clientId, env);
      if (!client) {
        return new Response(loginPage("Invalid client ID or password"), {
          status: 401, headers: sec({ "content-type": MIME.html }),
        });
      }
      const hash = await hashPassword(password);
      if (hash !== client.password_hash) {
        return new Response(loginPage("Invalid client ID or password"), {
          status: 401, headers: sec({ "content-type": MIME.html }),
        });
      }
      const token = await createSession(clientId, env);
      return new Response(null, {
        status: 302,
        headers: sec({ "location": "/dashboard", "set-cookie": setCookie(token, host) }),
      });
    }
  }

  if (pathname === "/logout") {
    return new Response(null, {
      status: 302,
      headers: sec({ "location": "/", "set-cookie": clearCookie(host) }),
    });
  }

  // Authed-only below
  const clientId = await getSession(request, env);
  if (!clientId) return Response.redirect(new URL("/", request.url).href, 302);
  const client = await getClient(clientId, env);
  if (!client) {
    return new Response(null, {
      status: 302,
      headers: sec({ "location": "/", "set-cookie": clearCookie(host) }),
    });
  }

  if (pathname === "/dashboard") {
    const reports = await getClientReports(clientId, env);
    return new Response(dashboardPage(client, reports), { headers: sec({ "content-type": MIME.html }) });
  }

  if (pathname.startsWith("/dl/")) {
    const r2Key = decodeURIComponent(pathname.slice(4));
    if (!r2Key.startsWith(clientId + "/")) {
      return new Response("Forbidden", { status: 403, headers: sec({ "content-type": "text/plain" }) });
    }
    const obj = await env.REPORTS_R2.get(r2Key);
    if (!obj) return notFound();
    const filename = r2Key.split("/").pop();
    return new Response(obj.body, {
      headers: sec({
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${filename}"`,
        "cache-control": "private, max-age=3600",
      }),
    });
  }

  return notFound();
}

// ─── Internal API (Bearer-authed, shared across hosts) ───────────────────────
// Token lives in the env.API_BEARER secret binding (deploy_worker.sh reads it
// from ~/.ledatic/api/bearer_token and uploads as secret_text).

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: sec({ "content-type": "application/json" }),
  });
}

// ─── Verifiability SDK witness counter-signer (WebCrypto Ed25519) ────────────
// Backs POST /attest/witness. The pubkey is public and pinned in the SDK
// verifier (rail repo: tools/verify_sdk/sdk.rail); only the 32-byte seed is
// secret, held as the SDK_WITNESS_KEY env binding — a DEDICATED key, not
// the fleet witness key, so a CF-secret leak is contained to this product.
// Verified byte-identical to the Rail reference signer
// (tools/verify_sdk/witness_sign.rail) over RFC 8032, so prod is a drop-in
// for the selftest's offline oracle.
const SDK_WITNESS_PUBKEY = "45ad2e2d671eab439f1e201b9b52bc40803c3f09fd2553d1e751e4a9afe768a7";
const SDK_WITNESS_PK_FP  = SDK_WITNESS_PUBKEY.slice(0, 16);
// PKCS8 DER header for an Ed25519 private key: SEQUENCE(version=0,
// AlgorithmId(1.3.101.112), OCTET STRING(OCTET STRING(seed))). Fixed 16 bytes,
// then the raw 32-byte seed — the standard way to feed a seed to WebCrypto.
const ED25519_PKCS8_PREFIX = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
function sdkHexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function sdkBytesToHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

// Constant-time compare of two equal-length hex strings — no early exit, so
// signature verification leaks no timing signal about how many chars matched.
function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─── Dataset delivery (R2-gated downloads) ───────────────────────────────────
// Each data SKU maps to an R2 object under the REPORTS_R2 bucket. A purchase
// (or admin grant) mints a random, time-limited, download-capped token in KV;
// GET /data/download/<token> streams the object. No public bucket, no S3 creds.
const DATA_DELIVERABLES = {
  pairs: {
    r2_key: "data-deliverables/rail-verified-pairs-v2.tar.gz",
    filename: "rail-verified-pairs-v2.tar.gz",
    size_bytes: 805232,
  },
  corpus: {
    r2_key: "data-deliverables/attested-text-corpus-v2.tar.gz",
    filename: "attested-text-corpus-v2.tar.gz",
    size_bytes: 2449467895,
  },
};

async function mintDownloadToken(env, pack, ref) {
  const meta = DATA_DELIVERABLES[pack];
  if (!meta) return null;
  const token = sdkBytesToHex(crypto.getRandomValues(new Uint8Array(24)));
  const now = Math.floor(Date.now() / 1000);
  const grant = {
    pack, r2_key: meta.r2_key, filename: meta.filename,
    created_at: now, expires_at: now + 30 * 24 * 3600, max: 25, used: 0, ref,
  };
  // KV TTL as a backstop to the explicit expiry check.
  await env.LEDATIC_KV.put(`dl:${token}`, JSON.stringify(grant), { expirationTtl: 30 * 24 * 3600 });
  return token;
}
async function sdkWitnessSign(seedHex, msg) {
  const seed = sdkHexToBytes(seedHex);
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + 32);
  pkcs8.set(ED25519_PKCS8_PREFIX, 0);
  pkcs8.set(seed, ED25519_PKCS8_PREFIX.length);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(msg));
  return sdkBytesToHex(new Uint8Array(sig));
}

async function handleAPI(request, env) {
  if (!env.API_BEARER || request.headers.get("Authorization") !== `Bearer ${env.API_BEARER}`) {
    return new Response("Unauthorized", { status: 401, headers: sec({ "content-type": "text/plain" }) });
  }

  const body = await request.json();

  if (body.type === "devlog") {
    const today = body.date || new Date().toISOString().slice(0, 10);
    const tagList = Array.isArray(body.tags) ? body.tags : (body.tags || "").split(",").map(t => t.trim()).filter(Boolean);
    const entries = await env.LEDATIC_KV.get("devlog", { type: "json" }) || [];
    entries.unshift({ date: today, title: body.title, body: body.entry_body, tags: tagList });
    await env.LEDATIC_KV.put("devlog", JSON.stringify(entries.slice(0, 20)));
    return jsonResponse({ ok: true });
  }

  if (body.type === "snapshot") {
    const cur = await env.LEDATIC_KV.get("snapshot", { type: "json" }) || {};
    const updated = Object.assign({}, cur, {
      updated: new Date().toISOString().slice(0, 10),
      stats: Object.assign({}, cur.stats, body.stats || {}),
      services: Object.assign({}, cur.services, body.services || {}),
    });
    await env.LEDATIC_KV.put("snapshot", JSON.stringify(updated));
    return jsonResponse({ ok: true });
  }

  if (body.type === "focus") {
    const cur = await env.LEDATIC_KV.get("snapshot", { type: "json" }) || {};
    cur.focus = { big_picture: body.big_picture, next_up: body.next_up, set_at: body.set_at };
    await env.LEDATIC_KV.put("snapshot", JSON.stringify(cur));
    return jsonResponse({ ok: true });
  }

  if (body.type === "oversight_status") {
    const cur = await env.LEDATIC_KV.get("snapshot", { type: "json" }) || {};
    cur.oversight_status = { tuning: body.tuning, regime: body.regime, this_week: body.this_week || [], updated_at: body.updated_at };
    await env.LEDATIC_KV.put("snapshot", JSON.stringify(cur));
    return jsonResponse({ ok: true });
  }

  if (body.type === "report_meta") {
    const { client_id, vertical, report } = body;
    if (!client_id || !report) return jsonResponse({ error: "Missing fields" }, 400);
    const key = `reports:${client_id}`;
    const existing = await env.LEDATIC_KV.get(key, { type: "json" }) || [];
    existing.unshift({ ...report, vertical });
    await env.LEDATIC_KV.put(key, JSON.stringify(existing));
    return jsonResponse({ ok: true, count: existing.length });
  }

  if (body.type === "create_client") {
    const { client_id, name, password } = body;
    if (!client_id || !name || !password) return jsonResponse({ error: "Missing fields" }, 400);
    const hash = await hashPassword(password);
    const client = {
      id: client_id,
      name: name,
      password_hash: hash,
      created: new Date().toISOString(),
      preferences: {},
    };
    await env.LEDATIC_KV.put(`client:${client_id}`, JSON.stringify(client));
    return jsonResponse({ ok: true, client_id });
  }

  if (body.type === "update_client_prefs") {
    const { client_id, preferences } = body;
    if (!client_id) return jsonResponse({ error: "Missing client_id" }, 400);
    const client = await env.LEDATIC_KV.get(`client:${client_id}`, { type: "json" });
    if (!client) return jsonResponse({ error: "Client not found" }, 404);
    client.preferences = Object.assign({}, client.preferences, preferences);
    await env.LEDATIC_KV.put(`client:${client_id}`, JSON.stringify(client));
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "Unknown type" }, 400);
}

// ─── ledatic.org handler ─────────────────────────────────────────────────────

async function handleSite(request, env, url) {
  // http → https
  if (url.protocol === "http:") {
    url.protocol = "https:";
    return Response.redirect(url.toString(), 301);
  }

  // www → apex
  if (url.hostname === "www.ledatic.org") {
    url.hostname = "ledatic.org";
    return Response.redirect(url.toString(), 301);
  }

  // api.ledatic.org is a retired subdomain (formerly served a Solana-token
  // signal API). Capture residual traffic by 301-redirecting it to /work on
  // the apex. Search engines treat 301 as canonical reassignment, so they
  // will eventually drop the old surface from their index and pin the new
  // one in its place.
  if (url.hostname === "api.ledatic.org") {
    return Response.redirect("https://ledatic.org/work", 301);
  }

  const pathname = url.pathname;
  const method = request.method;

  // NOTE: /data/devlog.json + /data/snapshot.json read routes were retired
  // 2026-06-10 — zero consumers in any site page or generator. The underlying
  // KV keys ("devlog", "snapshot") are still written via /api/update and stay
  // on the deny list below.

  // ── /portcall — single-password demo (password = GREATLAKES_PASS, e.g. "lakes").
  // One-field splash → sets cookie pc_ok=1 → serves the page. No username, unlike
  // the /greatlakes Basic gate. noindex stays. The /portcall/*.json feeds below
  // are public (real AIS is public data); this gate is for the demo page itself.
  if (pathname === "/portcall" || pathname === "/portcall/") {
    if (method === "POST") {
      const pw = new URLSearchParams(await request.text()).get("pw") || "";
      if (env.GREATLAKES_PASS && pw === env.GREATLAKES_PASS) {
        return new Response(null, {
          status: 303,
          headers: secGreatlakes({
            "Location": "/portcall",
            "Set-Cookie": "pc_ok=1; Path=/portcall; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax",
            "cache-control": "no-store",
          }),
        });
      }
      return new Response(pcSplash(true), { status: 401, headers: secGreatlakes({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": GREATLAKES_CSP }) });
    }
    if (!pcCookieOk(request)) {
      return new Response(pcSplash(false), { status: 401, headers: secGreatlakes({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": GREATLAKES_CSP }) });
    }
    const html = await env.LEDATIC_KV.get("portcall.html");
    if (!html) {
      return new Response("portcall page not deployed", { status: 503, headers: sec({ "content-type": "text/plain" }) });
    }
    return new Response(html, {
      headers: secGreatlakes({
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": GREATLAKES_CSP,
      }),
    });
  }
  // Public read-only mirrors of the two feeds the portcall map renders (real
  // AIS snapshot + latest attestation). Same R2 objects /greatlakes serves
  // behind auth; exposed here unauthenticated because the demo is public now.
  if (pathname === "/portcall/fleet.json" && method === "GET") {
    const obj = await env.REPORTS_R2.get("greatlakes/data/vessels/index.json");
    const body = obj ? await obj.arrayBuffer() : '{"vessels":[]}';
    return new Response(body, { headers: secGreatlakes({ "content-type": "application/json", "cache-control": "no-store" }) });
  }
  if (pathname === "/portcall/attestation.json" && method === "GET") {
    const obj = await env.REPORTS_R2.get("greatlakes/ais/latest.attestation.json");
    const body = obj ? await obj.arrayBuffer() : "{}";
    return new Response(body, { headers: secGreatlakes({ "content-type": "application/json", "cache-control": "no-store" }) });
  }
  // Real order pipeline: the ship app POSTs an attested order; the operator
  // console polls them back. Capped ring in KV (demo-scale — bounded at 25, no
  // cleanup needed). Public so the bundled APK can submit too; size-guarded.
  if (pathname === "/portcall/order" && method === "POST") {
    const txt = await request.text();
    if (txt.length > 8192) {
      return new Response('{"error":"too large"}', { status: 413, headers: secGreatlakes({ "content-type": "application/json" }) });
    }
    let body;
    try { body = JSON.parse(txt); } catch (e) {
      return new Response('{"error":"bad json"}', { status: 400, headers: secGreatlakes({ "content-type": "application/json" }) });
    }
    if (!body || typeof body !== "object" || !body.order || !body.receipt) {
      return new Response('{"error":"order+receipt required"}', { status: 400, headers: secGreatlakes({ "content-type": "application/json" }) });
    }
    let arr = [];
    try { const cur = await env.LEDATIC_KV.get("portcall_orders"); if (cur) arr = JSON.parse(cur); } catch (e) {}
    arr.unshift({ order: body.order, receipt: body.receipt, received_at: new Date().toISOString() });
    if (arr.length > 25) arr = arr.slice(0, 25);
    await env.LEDATIC_KV.put("portcall_orders", JSON.stringify(arr));
    return new Response(JSON.stringify({ ok: true, count: arr.length }), { headers: secGreatlakes({ "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" }) });
  }
  if (pathname === "/portcall/orders" && method === "GET") {
    const cur = await env.LEDATIC_KV.get("portcall_orders");
    return new Response(cur || "[]", { headers: secGreatlakes({ "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" }) });
  }
  // CORS preflight for the bundled APK's cross-origin order POST.
  if (pathname === "/portcall/order" && method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    } });
  }
  // Second attested leg: the operator signs an ack of the order's sha (anchored
  // to the beacon) and we attach it to the order, so the ship can verify the
  // supplier actually committed. Two-sided, both legs independently provable.
  if (pathname === "/portcall/order/ack" && method === "POST") {
    const txt = await request.text();
    if (txt.length > 8192) return new Response('{"error":"too large"}', { status: 413, headers: secGreatlakes({ "content-type": "application/json", "access-control-allow-origin": "*" }) });
    let body;
    try { body = JSON.parse(txt); } catch (e) { return new Response('{"error":"bad json"}', { status: 400, headers: secGreatlakes({ "content-type": "application/json", "access-control-allow-origin": "*" }) }); }
    if (!body || !body.sha || !body.ack) return new Response('{"error":"sha+ack required"}', { status: 400, headers: secGreatlakes({ "content-type": "application/json", "access-control-allow-origin": "*" }) });
    let arr = [];
    try { const cur = await env.LEDATIC_KV.get("portcall_orders"); if (cur) arr = JSON.parse(cur); } catch (e) {}
    let found = false;
    for (const o of arr) { if (o.receipt && o.receipt.sha === body.sha) { o.ack = body.ack; o.status = "acknowledged"; o.acked_at = new Date().toISOString(); found = true; break; } }
    if (!found) return new Response('{"error":"order not found"}', { status: 404, headers: secGreatlakes({ "content-type": "application/json", "access-control-allow-origin": "*" }) });
    await env.LEDATIC_KV.put("portcall_orders", JSON.stringify(arr));
    return new Response('{"ok":true}', { headers: secGreatlakes({ "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" }) });
  }
  if (pathname === "/portcall/order/ack" && method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    } });
  }
  // Anchor proxy: lets the bundled APK fetch the live beacon pulse cross-origin.
  if (pathname === "/portcall/pulse.json" && method === "GET") {
    const obj = await env.REPORTS_R2.get("entropy/pulse.json");
    const body = obj ? await obj.text() : "{}";
    return new Response(body, { headers: secGreatlakes({ "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" }) });
  }
  // Vendored Ed25519 (noble) served same-origin so the page needs no CDN.
  if (pathname === "/portcall/ed25519.js" && method === "GET") {
    const js = await env.LEDATIC_KV.get("ed25519.js");
    if (!js) return new Response("// ed25519 not deployed", { status: 503, headers: sec({ "content-type": "application/javascript" }) });
    return new Response(js, { headers: secGreatlakes({ "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" }) });
  }

  // ── /greatlakes — password-gated commercial demo ──────────────────────
  // Page + AIS attestation feed for the Great Lakes logistics POC.  Gated
  // by HTTP Basic over env.GREATLAKES_PASS (single shared password, user
  // "demo").  Server-to-server PUTs use the existing BEACON_TOKEN secret
  // and bypass Basic auth.
  if (pathname === "/greatlakes" || pathname.startsWith("/greatlakes/")) {
    // 1. Publisher PUTs (token-guarded, no basic auth) — must come first.
    if (pathname.startsWith("/greatlakes/ais/") && method === "PUT") {
      if (request.headers.get("x-beacon-token") !== env.BEACON_TOKEN) {
        return new Response("forbidden", { status: 403, headers: sec({ "content-type": "text/plain" }) });
      }
      const tail = pathname.slice("/greatlakes/ais/".length);
      if (!/^(latest|\d{8}T\d{6}Z)\.(jsonl|attestation\.json)$/.test(tail)) {
        return new Response("bad path", { status: 400, headers: sec({ "content-type": "text/plain" }) });
      }
      const ct = tail.endsWith(".jsonl") ? "application/x-ndjson" : "application/json";
      const body = await request.arrayBuffer();
      if (body.byteLength === 0 || body.byteLength > 4 * 1024 * 1024) {
        return new Response("bad body", { status: 400, headers: sec({ "content-type": "text/plain" }) });
      }
      await env.REPORTS_R2.put("greatlakes/ais/" + tail, body, { httpMetadata: { contentType: ct } });
      return new Response("ok", { headers: sec({ "content-type": "text/plain" }) });
    }

    // 1b. Derived data PUTs (vessels/, calls.json, brief.json, anomalies.json)
    // Same token guard as /greatlakes/ais/. Allowed sub-paths are validated.
    if (pathname.startsWith("/greatlakes/data/") && method === "PUT") {
      if (request.headers.get("x-beacon-token") !== env.BEACON_TOKEN) {
        return new Response("forbidden", { status: 403, headers: sec({ "content-type": "text/plain" }) });
      }
      const tail = pathname.slice("/greatlakes/data/".length);
      const ok =
        /^vessels\/\d{6,10}\.json$/.test(tail) ||
        /^(vessels\/index|calls|brief|anomalies)\.json$/.test(tail);
      if (!ok) {
        return new Response("bad path", { status: 400, headers: sec({ "content-type": "text/plain" }) });
      }
      const body = await request.arrayBuffer();
      if (body.byteLength === 0 || body.byteLength > 8 * 1024 * 1024) {
        return new Response("bad body", { status: 400, headers: sec({ "content-type": "text/plain" }) });
      }
      await env.REPORTS_R2.put("greatlakes/data/" + tail, body,
        { httpMetadata: { contentType: "application/json" } });
      return new Response("ok", { headers: sec({ "content-type": "text/plain" }) });
    }

    // 1c. Nightly DB backup PUTs — token-guarded, no basic auth.
    // Accepts gzip archives from the housekeeping curl; validates name +
    // content-length before streaming to R2 so stray writes can't land garbage.
    if (pathname.startsWith("/greatlakes/backup/") && method === "PUT") {
      if (request.headers.get("x-beacon-token") !== env.BEACON_TOKEN) {
        return new Response("forbidden", { status: 403, headers: sec({ "content-type": "text/plain" }) });
      }
      const name = pathname.slice("/greatlakes/backup/".length);
      if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        return new Response("bad name", { status: 400, headers: sec({ "content-type": "text/plain" }) });
      }
      const clHeader = request.headers.get("content-length");
      if (!clHeader) {
        return new Response("content-length required", { status: 400, headers: sec({ "content-type": "text/plain" }) });
      }
      const contentLength = parseInt(clHeader, 10);
      if (isNaN(contentLength) || contentLength <= 0 || contentLength >= 100 * 1024 * 1024) {
        return new Response("content-length out of range", { status: 413, headers: sec({ "content-type": "text/plain" }) });
      }
      const body = await request.arrayBuffer();
      await env.REPORTS_R2.put("greatlakes/backup/" + name, body,
        { httpMetadata: { contentType: "application/octet-stream" } });
      return new Response("ok", { headers: sec({ "content-type": "text/plain" }) });
    }

    // 1c'. Nightly DB backup GETs — token-guarded (never public).
    if (pathname.startsWith("/greatlakes/backup/") && method === "GET") {
      if (request.headers.get("x-beacon-token") !== env.BEACON_TOKEN) {
        return new Response("forbidden", { status: 401, headers: sec({ "content-type": "text/plain" }) });
      }
      const name = pathname.slice("/greatlakes/backup/".length);
      if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        return new Response("bad name", { status: 400, headers: sec({ "content-type": "text/plain" }) });
      }
      const obj = await env.REPORTS_R2.get("greatlakes/backup/" + name);
      if (!obj) {
        return new Response("not found", { status: 404, headers: sec({ "content-type": "text/plain" }) });
      }
      return new Response(await obj.arrayBuffer(), {
        headers: sec({ "content-type": "application/octet-stream", "cache-control": "no-store" }),
      });
    }

    // 2. Everything else under /greatlakes — HTTP Basic gate.
    if (!env.GREATLAKES_PASS) {
      return new Response("demo not configured", { status: 503, headers: sec({ "content-type": "text/plain" }) });
    }
    // btoa() throws on non-Latin1 input, so a malformed secret (emoji/accented
    // char/smart-quote pasted into the password file) would 500 on EVERY
    // /greatlakes request and brick the demo. Encode UTF-8 → binary string
    // first (byte-identical to btoa for ASCII), and fail closed with a clean
    // 503 if the secret can't be encoded.
    let expected;
    try {
      const credBytes = new TextEncoder().encode("demo:" + env.GREATLAKES_PASS);
      let bin = "";
      for (const b of credBytes) bin += String.fromCharCode(b);
      expected = "Basic " + btoa(bin);
    } catch (e) {
      return new Response("demo misconfigured", { status: 503, headers: sec({ "content-type": "text/plain" }) });
    }
    if (request.headers.get("Authorization") !== expected) {
      return new Response("Authentication required.\n", {
        status: 401,
        headers: sec({
          "WWW-Authenticate": 'Basic realm="Lakes Demo", charset="UTF-8"',
          "content-type": "text/plain",
          "cache-control": "no-store",
        }),
      });
    }

    // 3a. Authenticated page request.
    if (pathname === "/greatlakes" || pathname === "/greatlakes/") {
      const html = await env.LEDATIC_KV.get("greatlakes.html");
      if (!html) {
        return new Response("demo page not deployed", { status: 503, headers: sec({ "content-type": "text/plain" }) });
      }
      return new Response(html, {
        headers: secGreatlakes({
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": GREATLAKES_CSP,
        }),
      });
    }

    // 3a'. Per-vessel detail page. /greatlakes/vessel/<mmsi> serves vessel.html;
    // the page reads the MMSI from window.location and fetches the snapshot.
    {
      const mVessel = pathname.match(/^\/greatlakes\/vessel\/(\d{6,10})\/?$/);
      if (mVessel) {
        const html = await env.LEDATIC_KV.get("vessel.html");
        if (!html) {
          return new Response("vessel page not deployed", { status: 503, headers: sec({ "content-type": "text/plain" }) });
        }
        return new Response(html, {
          headers: secGreatlakes({
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": GREATLAKES_CSP,
          }),
        });
      }
    }

    // 3a''. Anomaly board page.
    if (pathname === "/greatlakes/anomalies" || pathname === "/greatlakes/anomalies/") {
      const html = await env.LEDATIC_KV.get("anomalies.html");
      if (!html) {
        return new Response("anomaly page not deployed", { status: 503, headers: sec({ "content-type": "text/plain" }) });
      }
      return new Response(html, {
        headers: secGreatlakes({
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": GREATLAKES_CSP,
        }),
      });
    }

    // 3a''b. Port Call product demo. /greatlakes/portcall serves portcall.html
    // (self-contained, no external deps). Same gate + CSP as the other pages.
    if (pathname === "/greatlakes/portcall" || pathname === "/greatlakes/portcall/") {
      const html = await env.LEDATIC_KV.get("portcall.html");
      if (!html) {
        return new Response("portcall page not deployed", { status: 503, headers: sec({ "content-type": "text/plain" }) });
      }
      return new Response(html, {
        headers: secGreatlakes({
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": GREATLAKES_CSP,
        }),
      });
    }

    // 3a'''. Derived-data GETs (vessels, calls, brief, anomalies JSON) — R2 read.
    if (pathname.startsWith("/greatlakes/data/") && method === "GET") {
      const tail = pathname.slice("/greatlakes/data/".length);
      const ok =
        /^vessels\/\d{6,10}\.json$/.test(tail) ||
        /^(vessels\/index|calls|brief|anomalies)\.json$/.test(tail);
      if (!ok) {
        return new Response("bad path", { status: 400, headers: sec({ "content-type": "text/plain" }) });
      }
      const obj = await env.REPORTS_R2.get("greatlakes/data/" + tail);
      if (!obj) {
        return new Response('{"error":"no data yet"}', {
          status: 404,
          headers: secGreatlakes({ "content-type": "application/json", "cache-control": "no-store" }),
        });
      }
      return new Response(await obj.arrayBuffer(), {
        headers: secGreatlakes({ "content-type": "application/json", "cache-control": "no-store" }),
      });
    }

    // 3a''''. AI proxy — page POSTs natural-language queries; Worker forwards
    // them to the configured upstream (env.LAKES_FLEET_URL, a secret_text
    // binding). If unset, this route returns a friendly "AI offline"
    // instead of crashing.
    if (pathname.startsWith("/greatlakes/api/ai/") && method === "POST") {
      if (!env.LAKES_FLEET_URL || !env.LAKES_FLEET_TOKEN) {
        return new Response('{"error":"ai offline"}', {
          status: 503,
          headers: sec({ "content-type": "application/json", "cache-control": "no-store" }),
        });
      }
      const subpath = pathname.slice("/greatlakes/api/ai/".length);
      if (!/^(ask|brief)$/.test(subpath)) {
        return new Response("bad path", { status: 400, headers: sec({ "content-type": "text/plain" }) });
      }
      const upstream = env.LAKES_FLEET_URL.replace(/\/+$/, "") + "/ai/" + subpath;
      const body = await request.arrayBuffer();
      // Never pass an upstream error body straight through — it may carry a
      // stack trace, internal hostname, model name, or prompt that the
      // engagement redline forbids on the client surface. Fail closed: a
      // generic 502/503 JSON on throw or non-2xx; only proxy the body on 2xx.
      let resp;
      try {
        resp = await fetch(upstream, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-lakes-token": env.LAKES_FLEET_TOKEN,
          },
          body,
        });
      } catch (e) {
        return new Response('{"error":"ai upstream error"}', {
          status: 503,
          headers: sec({ "content-type": "application/json", "cache-control": "no-store" }),
        });
      }
      if (!resp.ok) {
        return new Response('{"error":"ai upstream error"}', {
          status: 502,
          headers: sec({ "content-type": "application/json", "cache-control": "no-store" }),
        });
      }
      const respBody = await resp.arrayBuffer();
      return new Response(respBody, {
        status: resp.status,
        headers: sec({
          "content-type": "application/json",
          "cache-control": "no-store",
        }),
      });
    }

    // 3b. Authenticated GET on /greatlakes/ais/* — read R2.
    if (pathname.startsWith("/greatlakes/ais/") && method === "GET") {
      const tail = pathname.slice("/greatlakes/ais/".length);
      if (!/^(latest|\d{8}T\d{6}Z)\.(jsonl|attestation\.json)$/.test(tail)) {
        return new Response("bad path", { status: 400, headers: sec({ "content-type": "text/plain" }) });
      }
      const obj = await env.REPORTS_R2.get("greatlakes/ais/" + tail);
      if (!obj) {
        return new Response('{"error":"no data yet"}', {
          status: 503,
          headers: secGreatlakes({ "content-type": "application/json", "cache-control": "no-store" }),
        });
      }
      const ct = tail.endsWith(".jsonl") ? "application/x-ndjson" : "application/json";
      return new Response(await obj.arrayBuffer(), {
        headers: secGreatlakes({ "content-type": ct, "cache-control": "no-store" }),
      });
    }

    return new Response("not found", { status: 404, headers: sec({ "content-type": "text/plain" }) });
  }

  // Entropy beacon page is now served by site2030 as entropy.html via the
  // extension-less → .html routing below. Legacy entropy:index KV key ignored.
  if (pathname === "/entropy/pulse" && method === "PUT") {
    // Beacon-daemon write path. R2 has no 60s runtime cache, so reads
    // from /entropy/pulse go live within ~1s of each write. Auth via
    // shared BEACON_TOKEN env secret.
    if (request.headers.get("x-beacon-token") !== env.BEACON_TOKEN) {
      return new Response("forbidden", { status: 403, headers: sec({ "content-type": "text/plain" }) });
    }
    const body = await request.text();
    await env.REPORTS_R2.put("entropy/pulse.json", body, {
      httpMetadata: { contentType: "application/json" },
    });
    // Also append to the rolling log so visitors can walk the chain in one
    // request. Cap at last 50 to bound KV size. Best-effort — log failures
    // don't block the primary write.
    try {
      const log = await env.LEDATIC_KV.get("entropy:pulse:log", { type: "json" }) || [];
      log.push(JSON.parse(body));
      if (log.length > 50) log.splice(0, log.length - 50);
      await env.LEDATIC_KV.put("entropy:pulse:log", JSON.stringify(log));
    } catch (e) { /* swallow — primary write already succeeded */ }
    // Persist this pulse under a by-id key so a verifier can confirm a
    // receipt's cited pulse_id -> value_hex on the public chain. This is what
    // lights up the SDK's already-built `verify --check-beacon` membership
    // proof (forward time-binding). Best-effort; forward-only — pulses from
    // before this write path shipped are not backfilled.
    try {
      const p = JSON.parse(body);
      if (p && Number.isInteger(p.pulse_id)) {
        await env.REPORTS_R2.put(`entropy/pulse/${p.pulse_id}.json`, body, {
          httpMetadata: { contentType: "application/json" },
        });
      }
    } catch (e) { /* swallow — primary write already succeeded */ }
    return new Response("ok", { headers: sec({ "content-type": "text/plain" }) });
  }
  if (pathname === "/entropy/pulse") {
    // Read from R2 (strongly consistent, no KV 60s edge cache) with
    // KV fallback during transition.
    const obj = await env.REPORTS_R2.get("entropy/pulse.json");
    const pulse = obj ? await obj.text() : await env.LEDATIC_KV.get("entropy:pulse:current");
    if (!pulse) return new Response('{"error":"no pulse yet"}', {
      status: 503,
      headers: sec({ "content-type": "application/json", "access-control-allow-origin": "*" }),
    });
    return new Response(pulse, {
      headers: sec({ "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" }),
    });
  }
  if (pathname === "/entropy/pulse/log") {
    const log = await env.LEDATIC_KV.get("entropy:pulse:log");
    return new Response(log || "[]", {
      headers: sec({ "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" }),
    });
  }
  // Pulse-by-id (free, public): the membership oracle for `verify --check-beacon`.
  // Digits-only, so it never shadows /entropy/pulse or /entropy/pulse/log above.
  const pulseByIdMatch = pathname.match(/^\/entropy\/pulse\/(\d+)$/);
  if (pulseByIdMatch && method === "GET") {
    const obj = await env.REPORTS_R2.get(`entropy/pulse/${pulseByIdMatch[1]}.json`);
    if (!obj) return new Response('{"error":"no pulse for that id"}', {
      status: 404,
      headers: sec({ "content-type": "application/json", "access-control-allow-origin": "*" }),
    });
    return new Response(await obj.text(), {
      headers: sec({ "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" }),
    });
  }
  // Witness surface — fleet nodes sign observations of /entropy/pulse and
  // publish their signed latest here. Shape mirrors the beacon write path:
  // PUT writes R2 (strongly consistent), GET reads R2. Auth reuses the shared
  // BEACON_TOKEN — witnesses are fleet-internal writers, same trust bucket.
  // Node name is path-restricted to known witnesses to limit attack surface.
  const WITNESSES = new Set(["fleet0"]);
  const witnessMatch = pathname.match(/^\/witness\/([^/]+)\/latest$/);
  if (witnessMatch) {
    const node = witnessMatch[1];
    if (!WITNESSES.has(node)) return notFound();
    const r2Key = `witness/${node}/latest.json`;
    if (method === "PUT") {
      if (request.headers.get("x-beacon-token") !== env.BEACON_TOKEN) {
        return new Response("forbidden", { status: 403, headers: sec({ "content-type": "text/plain" }) });
      }
      const body = await request.text();
      await env.REPORTS_R2.put(r2Key, body, {
        httpMetadata: { contentType: "application/json" },
      });
      return new Response("ok", { headers: sec({ "content-type": "text/plain" }) });
    }
    if (method === "GET") {
      const obj = await env.REPORTS_R2.get(r2Key);
      if (!obj) return new Response('{"error":"no witness record yet"}', {
        status: 503,
        headers: sec({ "content-type": "application/json", "access-control-allow-origin": "*" }),
      });
      return new Response(await obj.text(), {
        headers: sec({ "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" }),
      });
    }
  }

  // Fleet attestation snapshot — Mini-side publisher PUTs here every ~60s
  // with {nodes, pulse_id, sig}.  The pulse_id binds the snapshot to
  // physical time; the sig binds the bundle to fleet0's Ed25519 key, so
  // tampering between writer and reader is detectable.  Cache: no-store
  // (fresh state each request, like the witness endpoint).
  if (pathname === "/fleet/status.json") {
    const r2Key = "fleet/status.json";
    if (method === "PUT") {
      if (request.headers.get("x-beacon-token") !== env.BEACON_TOKEN) {
        return new Response("forbidden", { status: 403, headers: sec({ "content-type": "text/plain" }) });
      }
      const body = await request.text();
      if (!body || body.length > 64 * 1024) {
        return new Response("bad body", { status: 400, headers: sec({ "content-type": "text/plain" }) });
      }
      try { JSON.parse(body); }
      catch { return new Response("not json", { status: 400, headers: sec({ "content-type": "text/plain" }) }); }
      await env.REPORTS_R2.put(r2Key, body, {
        httpMetadata: { contentType: "application/json" },
      });
      return new Response("ok", { headers: sec({ "content-type": "text/plain" }) });
    }
    if (method === "GET") {
      const obj = await env.REPORTS_R2.get(r2Key);
      if (!obj) return new Response('{"error":"no fleet snapshot yet"}', {
        status: 503,
        headers: sec({ "content-type": "application/json", "access-control-allow-origin": "*" }),
      });
      return new Response(await obj.text(), {
        headers: sec({
          "content-type": "application/json",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        }),
      });
    }
  }

  // ─── Verifiability SDK: metered witness counter-signature ────────────────
  // The paid grade of the SDK (rail repo: tools/verify_sdk). A "bare" receipt
  // is the caller's own Ed25519 sig, verified fully offline and never touching
  // us — the free distribution flywheel. An ANCHORED receipt additionally
  // carries OUR counter-signature over the same canonical attest message the
  // rest of the attest infra uses:
  //   attest|v1|<sha256>|<pulse_id>|<value_hex>|<witnessed_at>
  // proving "Ledatic observed digest D at pulse N at server-time T". We set
  // witnessed_at, so an anchored receipt cannot be backdated. We sign the
  // tuple as presented (no PII, opaque digests only); whether value_hex truly
  // belongs to pulse_id is the verifier's job via the free /entropy/pulse/<id>
  // chain — that separation keeps this endpoint cheap and stateless.
  //
  // PHASING: ship token-gated first (un-metered beta) by minting keys with a
  // large balance. The balance check below IS the metering, so beta vs paid is
  // a provisioning choice, not a code change.
  if (pathname === "/attest/witness" && method === "POST") {
    const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
    if (!(await playgroundRateLimit(ip, env))) return jsonResponse({ error: "rate_limited" }, 429);

    const apiKey = request.headers.get("x-sdk-key") || "";
    if (!apiKey) return jsonResponse({ error: "unauthorized" }, 401);
    const acctRaw = await env.LEDATIC_KV.get(`account:${apiKey}`);
    if (!acctRaw) return jsonResponse({ error: "unauthorized" }, 401);
    let acct;
    try { acct = JSON.parse(acctRaw); } catch { return jsonResponse({ error: "unauthorized" }, 401); }
    const now = Math.floor(Date.now() / 1000);
    if ((acct.expires_at && now > acct.expires_at) || (acct.balance || 0) <= 0) {
      return jsonResponse({ error: "payment_required" }, 402);
    }

    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "bad_request" }, 400); }
    const sha256 = String(body.sha256 || "");
    const value_hex = String(body.value_hex || "");
    const pulse_id = body.pulse_id;
    if (!/^[0-9a-f]{64}$/.test(sha256) || !/^[0-9a-f]{64}$/.test(value_hex) || !Number.isInteger(pulse_id)) {
      return jsonResponse({ error: "bad_request" }, 400);
    }
    if (!env.SDK_WITNESS_KEY || !/^[0-9a-f]{64}$/.test(env.SDK_WITNESS_KEY)) {
      return jsonResponse({ error: "witness_unconfigured" }, 503);
    }

    const witnessed_at = now;
    const msg = `attest|v1|${sha256}|${pulse_id}|${value_hex}|${witnessed_at}`;
    const sig = await sdkWitnessSign(env.SDK_WITNESS_KEY, msg);

    // Commit the spend. A race can under-charge by <=1 (two requests read the
    // same balance), never over — the same safety direction as the limiter.
    acct.balance = (acct.balance || 0) - 1;
    await env.LEDATIC_KV.put(`account:${apiKey}`, JSON.stringify(acct));

    return jsonResponse({ witnessed_at, alg: "ed25519", pk_fp: SDK_WITNESS_PK_FP, sig }, 200);
  }

  // POST /attest/admin/mint {pack} — manual provisioning, Bearer API_BEARER.
  // Zero-human-compatible: no signup flow. Keys are minted out of band and
  // handed to the buyer; the 402 wall above is the whole retention mechanism.
  // Stripe self-serve top-up is a later phase, not this.
  if (pathname === "/attest/admin/mint" && method === "POST") {
    if (!env.API_BEARER || request.headers.get("Authorization") !== `Bearer ${env.API_BEARER}`) {
      return jsonResponse({ error: "forbidden" }, 403);
    }
    let body;
    try { body = await request.json(); } catch { body = {}; }
    const PACKS = { micro: 100, starter: 10000, growth: 100000, scale: 1000000 };
    const pack = String(body.pack || "starter");
    const credits = PACKS[pack];
    if (!credits) return jsonResponse({ error: "unknown_pack", packs: Object.keys(PACKS) }, 400);
    const apiKey = "lsk_" + sdkBytesToHex(crypto.getRandomValues(new Uint8Array(24)));
    const now = Math.floor(Date.now() / 1000);
    const expires_at = now + 365 * 24 * 3600; // ~12 months
    const acct = { balance: credits, expires_at, pack, created_at: now };
    await env.LEDATIC_KV.put(`account:${apiKey}`, JSON.stringify(acct));
    return jsonResponse({ api_key: apiKey, pack, balance: credits, expires_at }, 200);
  }

  // ─── Stripe autopilot (self-serve fulfillment, zero-human) ──────────────
  //
  // Flow: Payment Link (metadata.pack = starter|growth|scale|pairs|corpus,
  // success URL → /thanks?session_id={CHECKOUT_SESSION_ID})
  //   → Stripe POSTs checkout.session.completed to /attest/stripe/webhook
  //   → signature verified (HMAC-SHA256, STRIPE_WEBHOOK_SECRET binding)
  //   → receipts packs: mint an lsk_ key; data products: record the order
  //   → sale stored at KV stripesale:<session_id>
  //   → the /thanks page calls GET /attest/stripe/claim?session_id=… and
  //     shows the customer their key immediately. No email in the loop.
  //
  // Fails closed: missing secret → 503; bad signature → 401; unknown pack →
  // recorded but nothing minted (manual follow-up via sales ledger).
  // Dataset orders are recorded + surfaced on claim as "delivery by email
  // within 24h" — data delivery stays manual until R2 links exist.
  if (pathname === "/attest/stripe/webhook" && method === "POST") {
    if (!env.STRIPE_WEBHOOK_SECRET) return jsonResponse({ error: "unconfigured" }, 503);
    const sigHeader = request.headers.get("stripe-signature") || "";
    const rawBody = await request.text();
    const parts = Object.fromEntries(
      sigHeader.split(",").map((kv) => kv.split("=", 2)).filter((p) => p.length === 2)
    );
    const t = parts.t, v1 = parts.v1;
    if (!t || !v1) return jsonResponse({ error: "bad_signature_header" }, 401);
    // 5-minute tolerance window against replay.
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > 300) {
      return jsonResponse({ error: "timestamp_out_of_tolerance" }, 401);
    }
    const enc = new TextEncoder();
    const hmacKey = await crypto.subtle.importKey(
      "raw", enc.encode(env.STRIPE_WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const mac = await crypto.subtle.sign("HMAC", hmacKey, enc.encode(`${t}.${rawBody}`));
    const expected = sdkBytesToHex(new Uint8Array(mac));
    if (!timingSafeEqualHex(expected, v1)) return jsonResponse({ error: "bad_signature" }, 401);

    let event;
    try { event = JSON.parse(rawBody); } catch { return jsonResponse({ error: "bad_json" }, 400); }
    if (event.type !== "checkout.session.completed") {
      return jsonResponse({ received: true, ignored: event.type }, 200);
    }
    const session = event.data?.object || {};
    const sessionId = String(session.id || "");
    if (!sessionId) return jsonResponse({ error: "no_session_id" }, 400);
    // Idempotent: Stripe retries webhooks — never mint twice for one session.
    const existing = await env.LEDATIC_KV.get(`stripesale:${sessionId}`);
    if (existing) return jsonResponse({ received: true, duplicate: true }, 200);

    const pack = String(session.metadata?.pack || "");
    const email = String(session.customer_details?.email || session.customer_email || "");
    const now = Math.floor(Date.now() / 1000);
    const sale = {
      session_id: sessionId, pack, email,
      amount_total: session.amount_total, currency: session.currency,
      created_at: now, kind: "unknown",
      // The session_id rides in the /thanks URL, so cap how long it can be
      // exchanged for the secret. The key/download itself has its own
      // lifetime; this only bounds re-fetch via the URL param.
      claim_until: now + 24 * 3600,
    };
    const PACKS = { micro: 100, starter: 10000, growth: 100000, scale: 1000000 };
    if (PACKS[pack]) {
      const apiKey = "lsk_" + sdkBytesToHex(crypto.getRandomValues(new Uint8Array(24)));
      const acct = { balance: PACKS[pack], expires_at: now + 365 * 24 * 3600, pack, created_at: now };
      await env.LEDATIC_KV.put(`account:${apiKey}`, JSON.stringify(acct));
      sale.kind = "receipts";
      sale.api_key = apiKey;
    } else if (DATA_DELIVERABLES[pack]) {
      sale.kind = "data";
      sale.download_token = await mintDownloadToken(env, pack, sessionId);
    }
    await env.LEDATIC_KV.put(`stripesale:${sessionId}`, JSON.stringify(sale));
    // Running order log for reconciliation (best-effort, last-writer-wins).
    try {
      const logRaw = (await env.LEDATIC_KV.get("stripesales:log")) || "[]";
      const log = JSON.parse(logRaw);
      log.push({ session_id: sessionId, pack, email, kind: sale.kind, ts: now });
      await env.LEDATIC_KV.put("stripesales:log", JSON.stringify(log.slice(-500)));
    } catch (e) { /* best-effort */ }
    return jsonResponse({ received: true, kind: sale.kind }, 200);
  }

  // The /thanks page exchanges the Stripe session id for the purchase
  // result. Session ids are unguessable (cs_live_… high entropy) and the
  // response contains only what the buyer already owns.
  if (pathname === "/attest/stripe/claim" && method === "GET") {
    const sessionId = url.searchParams.get("session_id") || "";
    if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(sessionId)) {
      return jsonResponse({ error: "bad_session_id" }, 400);
    }
    const raw = await env.LEDATIC_KV.get(`stripesale:${sessionId}`);
    if (!raw) return jsonResponse({ error: "not_found_yet", hint: "webhook may lag a few seconds; retry" }, 404);
    const sale = JSON.parse(raw);
    // After the claim window, the session_id URL no longer yields the secret.
    if (sale.claim_until && Math.floor(Date.now() / 1000) > sale.claim_until) {
      return jsonResponse({
        kind: sale.kind, pack: sale.pack, expired: true,
        note: "This confirmation link has expired for security. If you saved your key or download, keep using it — otherwise email 31zemogyllier@gmail.com with your Stripe receipt and we'll re-send it.",
      }, 200);
    }
    if (sale.kind === "receipts") {
      return jsonResponse({ kind: "receipts", pack: sale.pack, api_key: sale.api_key }, 200);
    }
    if (sale.kind === "data" && sale.download_token) {
      const meta = DATA_DELIVERABLES[sale.pack] || {};
      return jsonResponse({
        kind: "data", pack: sale.pack,
        download_url: `https://ledatic.org/data/download/${sale.download_token}`,
        filename: meta.filename, size_bytes: meta.size_bytes,
      }, 200);
    }
    return jsonResponse({ kind: sale.kind, pack: sale.pack, note: "delivery by email within 24h" }, 200);
  }

  // Gated dataset download. The token is minted at purchase (or by admin
  // grant), unguessable, time-limited, and download-capped — a worker-native
  // stand-in for an S3 presigned URL that needs no S3 credentials. Streams
  // the object straight from R2; the bucket is never public.
  if (pathname.startsWith("/data/download/") && (method === "GET" || method === "HEAD")) {
    const token = pathname.slice("/data/download/".length);
    if (!/^[0-9a-f]{48}$/.test(token)) return notFound();
    const raw = await env.LEDATIC_KV.get(`dl:${token}`);
    if (!raw) return new Response("link expired or invalid", { status: 404, headers: sec({ "content-type": "text/plain" }) });
    const grant = JSON.parse(raw);
    const now = Math.floor(Date.now() / 1000);
    if (grant.expires_at && now > grant.expires_at) {
      return new Response("download link expired — contact 31zemogyllier@gmail.com", { status: 410, headers: sec({ "content-type": "text/plain" }) });
    }
    if ((grant.used || 0) >= (grant.max || 25)) {
      return new Response("download limit reached — contact 31zemogyllier@gmail.com", { status: 429, headers: sec({ "content-type": "text/plain" }) });
    }
    const obj = await env.REPORTS_R2.get(grant.r2_key);
    if (!obj) return notFound();
    if (method === "GET") {
      grant.used = (grant.used || 0) + 1;
      await env.LEDATIC_KV.put(`dl:${token}`, JSON.stringify(grant)); // best-effort meter
    }
    return new Response(method === "HEAD" ? null : obj.body, {
      headers: sec({
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${grant.filename}"`,
        "content-length": String(obj.size),
        "cache-control": "private, no-store",
      }),
    });
  }

  // Admin: mint a dataset download link out of band (manual fulfillment /
  // re-issue). Bearer API_BEARER. Body {pack}. Returns the download URL so
  // fulfill.sh can email a link instead of a 2.4 GB attachment.
  if (pathname === "/attest/data/grant" && method === "POST") {
    if (!env.API_BEARER || request.headers.get("Authorization") !== `Bearer ${env.API_BEARER}`) {
      return jsonResponse({ error: "forbidden" }, 403);
    }
    let body; try { body = await request.json(); } catch { body = {}; }
    const pack = String(body.pack || "");
    if (!DATA_DELIVERABLES[pack]) return jsonResponse({ error: "unknown_pack", packs: Object.keys(DATA_DELIVERABLES) }, 400);
    const token = await mintDownloadToken(env, pack, `admin:${body.note || ""}`);
    const meta = DATA_DELIVERABLES[pack];
    return jsonResponse({
      pack, download_url: `https://ledatic.org/data/download/${token}`,
      filename: meta.filename, expires_in_days: 30,
    }, 200);
  }

  // 256² OT MHD on Studio's M1 Ultra GPU — sister surface to the 128²
  // beacon on Mini.  Same frame format (16B header + 32B metrics +
  // planes), 4× resolution, ~388 fps.  Studio publisher PUTs the raw
  // frame bytes here; the attestation sidecar lives at
  // /entropy/frame/ot256/latest.attestation.json (signed by fleet0).
  if (pathname === "/entropy/frame/ot256/current") {
    if (method === "PUT") {
      if (request.headers.get("x-beacon-token") !== env.BEACON_TOKEN) {
        return new Response("forbidden", { status: 403, headers: sec({ "content-type": "text/plain" }) });
      }
      const body = await request.arrayBuffer();
      if (!body.byteLength || body.byteLength > 16 * 1024 * 1024) {
        return new Response("bad body", { status: 400, headers: sec({ "content-type": "text/plain" }) });
      }
      await env.REPORTS_R2.put("entropy/frame_ot256.bin", body, {
        httpMetadata: { contentType: "application/octet-stream" },
      });
      return new Response("ok", { headers: sec({ "content-type": "text/plain" }) });
    }
    const obj = await env.REPORTS_R2.get("entropy/frame_ot256.bin");
    if (!obj) return new Response("No 256² frame yet", {
      status: 503, headers: sec({ "content-type": "text/plain" }),
    });
    return new Response(await obj.arrayBuffer(), {
      headers: sec({
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
        "content-disposition": 'attachment; filename="plasma_ot256.bin"',
      }),
    });
  }
  if (pathname === "/entropy/frame/ot256/latest.attestation.json") {
    const r2Key = "entropy/frame_ot256.latest.attestation.json";
    if (method === "PUT") {
      if (request.headers.get("x-beacon-token") !== env.BEACON_TOKEN) {
        return new Response("forbidden", { status: 403, headers: sec({ "content-type": "text/plain" }) });
      }
      const body = await request.text();
      if (!body || body.length > 16 * 1024) {
        return new Response("bad body", { status: 400, headers: sec({ "content-type": "text/plain" }) });
      }
      try { JSON.parse(body); }
      catch { return new Response("not json", { status: 400, headers: sec({ "content-type": "text/plain" }) }); }
      await env.REPORTS_R2.put(r2Key, body, {
        httpMetadata: { contentType: "application/json" },
      });
      return new Response("ok", { headers: sec({ "content-type": "text/plain" }) });
    }
    if (method === "GET") {
      const obj = await env.REPORTS_R2.get(r2Key);
      if (!obj) return new Response('{"error":"no ot256 attestation yet"}', {
        status: 503,
        headers: sec({ "content-type": "application/json", "access-control-allow-origin": "*" }),
      });
      return new Response(await obj.text(), {
        headers: sec({
          "content-type": "application/json",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        }),
      });
    }
  }

  // Per-frame attestation snapshot — frame_attest_publisher signs
  // sha256(/tmp/plasma_live.bin) every ~30 s and PUTs here.  Anyone
  // pulling /entropy/frame/current at the same time can re-derive the
  // hash and check the sig — proves "this frame existed at pulse N".
  if (pathname === "/entropy/frame/latest.attestation.json") {
    const r2Key = "entropy/frame.latest.attestation.json";
    if (method === "PUT") {
      if (request.headers.get("x-beacon-token") !== env.BEACON_TOKEN) {
        return new Response("forbidden", { status: 403, headers: sec({ "content-type": "text/plain" }) });
      }
      const body = await request.text();
      if (!body || body.length > 16 * 1024) {
        return new Response("bad body", { status: 400, headers: sec({ "content-type": "text/plain" }) });
      }
      try { JSON.parse(body); }
      catch { return new Response("not json", { status: 400, headers: sec({ "content-type": "text/plain" }) }); }
      await env.REPORTS_R2.put(r2Key, body, {
        httpMetadata: { contentType: "application/json" },
      });
      return new Response("ok", { headers: sec({ "content-type": "text/plain" }) });
    }
    if (method === "GET") {
      const obj = await env.REPORTS_R2.get(r2Key);
      if (!obj) return new Response('{"error":"no frame attestation yet"}', {
        status: 503,
        headers: sec({ "content-type": "application/json", "access-control-allow-origin": "*" }),
      });
      return new Response(await obj.text(), {
        headers: sec({
          "content-type": "application/json",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        }),
      });
    }
  }

  // ─── Provenance Tier ────────────────────────────────────────────────
  // Provenance manifests for AI reports. Pattern mirrors the entropy frame
  // attestations: a Studio-side publisher composes the manifest, SSHes to
  // fleet0 to get an Ed25519 witness signature, then PUTs here. Anyone can
  // GET the manifest and re-derive the digest from individual fields, then
  // verify the signature in-browser at /verify/<id>. See
  // docs/proposals/provable_ai.md for the threat model + buyer.
  if (pathname.startsWith("/provenance/manifest/")) {
    const reportId = pathname.slice("/provenance/manifest/".length);
    if (!reportId || !/^[A-Za-z0-9_-]{1,64}$/.test(reportId)) {
      return new Response("bad report_id", { status: 400, headers: sec({ "content-type": "text/plain" }) });
    }
    const r2Key = `provenance/manifests/${reportId}.json`;
    if (method === "PUT") {
      if (request.headers.get("x-beacon-token") !== env.BEACON_TOKEN) {
        return new Response("forbidden", { status: 403, headers: sec({ "content-type": "text/plain" }) });
      }
      const body = await request.text();
      if (!body || body.length > 64 * 1024) {
        return new Response("bad body", { status: 400, headers: sec({ "content-type": "text/plain" }) });
      }
      let m;
      try { m = JSON.parse(body); }
      catch { return new Response("not json", { status: 400, headers: sec({ "content-type": "text/plain" }) }); }
      if (m.kind !== "ledatic.report.provenance" || m.report_id !== reportId) {
        return new Response("bad manifest shape", { status: 400, headers: sec({ "content-type": "text/plain" }) });
      }
      // Per-version structural sanity (security-b H5, 2026-05-12). Verifier
      // logic lives in verify.html; here we just refuse manifests whose
      // declared version disagrees with their inner_message prefix, so a
      // freshly-signed v2 cannot be downgraded by PUTting a v1-prefixed body.
      const version       = (m.version === 2 || m.format_version === "v2") ? 2
                          : ((m.version === 1 || m.format_version === "v1") ? 1 : 0);
      const innerMsg      = m && m.attest && typeof m.attest.inner_message === "string" ? m.attest.inner_message : "";
      const innerPrefix   = innerMsg.startsWith("report|v2|") ? 2
                          : (innerMsg.startsWith("report|v1|") ? 1 : 0);
      if (version === 0 || innerPrefix === 0 || version !== innerPrefix) {
        return new Response("version/inner_message disagreement", { status: 400, headers: sec({ "content-type": "text/plain" }) });
      }
      await env.REPORTS_R2.put(r2Key, body, {
        httpMetadata: { contentType: "application/json" },
      });
      return new Response("ok", { headers: sec({ "content-type": "text/plain" }) });
    }
    if (method === "GET") {
      const obj = await env.REPORTS_R2.get(r2Key);
      if (!obj) return new Response('{"error":"manifest not found","report_id":"' + reportId + '"}', {
        status: 404,
        headers: sec({ "content-type": "application/json", "access-control-allow-origin": "*" }),
      });
      return new Response(await obj.text(), {
        headers: sec({
          "content-type": "application/json",
          "cache-control": "public, max-age=60",
          "access-control-allow-origin": "*",
        }),
      });
    }
    return new Response("method not allowed", { status: 405, headers: sec({ "content-type": "text/plain" }) });
  }

  // /api/intel/waitlist — public email capture for /intel landing.
  // Stored under KV key `intel:waitlist:<rand>` (colon-prefix → isPrivateKey
  // auto-denies public reads). Rate-limited per IP via cf-connecting-ip + KV.
  if (pathname === "/api/intel/waitlist" && method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid JSON" }), {
        status: 400, headers: sec({ "content-type": "application/json" }),
      });
    }
    const email = (body.email || "").trim().toLowerCase();
    const ref   = String(body.ref || "/intel").slice(0, 200);
    // Honeypot: a hidden `hp_field` lives in the form; real browsers leave it
    // empty, drive-by bots auto-fill every text input. Silently 200 so the bot
    // doesn't learn to skip it next time.
    const hp = (body.hp_field || "").toString();
    if (hp.length > 0) {
      return new Response(JSON.stringify({ ok: true, status: "added" }), {
        headers: sec({ "content-type": "application/json" }),
      });
    }
    // Cheap email shape check — full RFC 5322 isn't worth it for a waitlist.
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return new Response(JSON.stringify({ error: "invalid email" }), {
        status: 400, headers: sec({ "content-type": "application/json" }),
      });
    }
    // Disposable-mail denylist — 10 of the most common throwaway providers.
    // Substring match catches subdomains like *.mailinator.com.
    const DISPOSABLE_DOMAINS = [
      "mailinator.com", "tempmail", "guerrillamail", "10minutemail",
      "throwaway", "yopmail.com", "trashmail", "fakeinbox",
      "sharklasers.com", "dispostable.com",
    ];
    const emailDomain = email.split("@")[1] || "";
    if (DISPOSABLE_DOMAINS.some(d => emailDomain.includes(d))) {
      return new Response(JSON.stringify({ error: "disposable email not accepted" }), {
        status: 400, headers: sec({ "content-type": "application/json" }),
      });
    }
    // Dedup: if this email is already on the list, return success (idempotent).
    const dedupKey = `intel:waitlist:by_email:${email}`;
    const existing = await env.LEDATIC_KV.get(dedupKey);
    const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
    if (existing) {
      return new Response(JSON.stringify({ ok: true, status: "already_on_list" }), {
        headers: sec({ "content-type": "application/json" }),
      });
    }
    // Rate-limit: max 5 signups per IP per hour. KV TTL handles cleanup.
    const ipKey = `intel:waitlist:ip:${ip}`;
    const ipCount = parseInt((await env.LEDATIC_KV.get(ipKey)) || "0", 10);
    if (ipCount >= 5) {
      return new Response(JSON.stringify({ error: "rate limited" }), {
        status: 429, headers: sec({ "content-type": "application/json" }),
      });
    }
    const id = crypto.randomUUID().split("-")[0];
    const ts = new Date().toISOString();
    const record = JSON.stringify({ email, ref, ip, ts, id });
    await env.LEDATIC_KV.put(`intel:waitlist:${ts}:${id}`, record);
    await env.LEDATIC_KV.put(dedupKey, ts, { expirationTtl: 86400 * 365 });
    await env.LEDATIC_KV.put(ipKey, String(ipCount + 1), { expirationTtl: 3600 });
    return new Response(JSON.stringify({ ok: true, status: "added", id }), {
      headers: sec({ "content-type": "application/json" }),
    });
  }

  // /admin/intel/waitlist — list waitlist entries (bearer auth, internal use).
  if (pathname === "/admin/intel/waitlist" && method === "GET") {
    if (request.headers.get("Authorization") !== `Bearer ${env.API_BEARER}`) {
      return new Response("Unauthorized", { status: 401, headers: sec({ "content-type": "text/plain" }) });
    }
    const list = await env.LEDATIC_KV.list({ prefix: "intel:waitlist:", limit: 1000 });
    const entries = [];
    for (const k of list.keys) {
      if (k.name.startsWith("intel:waitlist:by_email:") || k.name.startsWith("intel:waitlist:ip:")) continue;
      const v = await env.LEDATIC_KV.get(k.name);
      if (v) try { entries.push(JSON.parse(v)); } catch {}
    }
    entries.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
    return new Response(JSON.stringify({ count: entries.length, entries }, null, 2), {
      headers: sec({ "content-type": "application/json" }),
    });
  }

  // /verify/<report_id> — public verification page. Static HTML lives in KV
  // as `verify.html`; the page reads the report_id from window.location and
  // verifies the Ed25519 signature in-browser via crypto.subtle. Same KV key
  // serves all report IDs — no backend templating needed.
  if (pathname.startsWith("/verify/") && method === "GET") {
    const reportId = pathname.slice("/verify/".length);
    if (!reportId || !/^[A-Za-z0-9_-]{1,64}$/.test(reportId)) {
      return new Response("bad report_id", { status: 400, headers: sec({ "content-type": "text/plain" }) });
    }
    const html = await env.LEDATIC_KV.get("verify.html");
    if (!html) return notFound();
    return new Response(html, {
      headers: sec({ "content-type": MIME.html, "cache-control": "public, max-age=300" }),
    });
  }

  // Frame binary — beacon daemon PUTs here (auth via BEACON_TOKEN) and the
  // plasma viewport reads. R2-backed because KV has a 60s edge cache that
  // would freeze the live viz at 1Hz publish rate.
  if (pathname === "/entropy/frame/current") {
    if (method === "PUT") {
      if (request.headers.get("x-beacon-token") !== env.BEACON_TOKEN) {
        return new Response("forbidden", { status: 403, headers: sec({ "content-type": "text/plain" }) });
      }
      const body = await request.arrayBuffer();
      await env.REPORTS_R2.put("entropy/frame.bin", body, {
        httpMetadata: { contentType: "application/octet-stream" },
      });
      return new Response("ok", { headers: sec({ "content-type": "text/plain" }) });
    }
    const obj = await env.REPORTS_R2.get("entropy/frame.bin");
    const frame = obj
      ? await obj.arrayBuffer()
      : await env.LEDATIC_KV.get("entropy:frame:current", { type: "arrayBuffer" });
    if (!frame) return new Response("No frame yet", {
      status: 503, headers: sec({ "content-type": "text/plain" }),
    });
    return new Response(frame, {
      headers: sec({
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
        "content-disposition": 'attachment; filename="plasma_frame.bin"',
      }),
    });
  }

  // Shields.io endpoint badges — composed from /<kind>/latest +
  // /<kind>/<sha>/result.json so a single img URL renders live state.
  // Returns the schemaVersion=1 endpoint format Shields expects.
  // Cached 60 s — Shields caches its own renders for ~5 min anyway.
  const badgeMatch = pathname.match(/^\/attest\/badge\/(builds|selfhost)\.json$/);
  if (badgeMatch && method === "GET") {
    const kind = badgeMatch[1];
    const fetchJson = async (path) => {
      const obj = await env.REPORTS_R2.get(`attest${path}`);
      if (!obj) return null;
      try { return JSON.parse(await obj.text()); } catch { return null; }
    };
    const ptr = await fetchJson(`/${kind}/latest/index.json`);
    let label, message, color = "lightgrey";
    if (kind === "builds") {
      label = "build";
      const r = ptr ? await fetchJson(`/builds/${ptr.short}/result.json`) : null;
      if (!r) {
        message = "no record";
      } else {
        message = `${r.short} · ${r.pass}/${r.total} · pulse ${r.pulse_end}`;
        color = r.status === "ok" ? "brightgreen" : "red";
      }
    } else {
      label = "self-host";
      const r = ptr ? await fetchJson(`/selfhost/${ptr.short}/result.json`) : null;
      if (!r) {
        message = "no record";
      } else {
        const fp = r.fixed_point && r.seed_match;
        message = `${r.short} · ${fp ? "fixed point" : "drift"} · pulse ${r.pulse_end}`;
        color = fp ? "brightgreen" : "red";
      }
    }
    const body = JSON.stringify({
      schemaVersion: 1, label, message, color, cacheSeconds: 60,
    });
    return new Response(body, {
      headers: sec({
        "content-type": "application/json",
        "cache-control": "public, max-age=60",
        "access-control-allow-origin": "*",
      }),
    });
  }

  // Canonical "what is the current attested state" pointer — one URL that
  // names the freshest builds/selfhost records.  Composes the existing R2
  // latest pointers (same data the badges read); read-only, no new writer
  // surface.  Wired 2026-06-09: the PAOS audit found /attest/latest fell
  // through to the homepage.
  if (pathname === "/attest/latest" && method === "GET") {
    const fetchJson = async (path) => {
      const obj = await env.REPORTS_R2.get(`attest${path}`);
      if (!obj) return null;
      try { return JSON.parse(await obj.text()); } catch { return null; }
    };
    const out = { kind: "ledatic.attest.latest", version: 1 };
    for (const k of ["builds", "selfhost"]) {
      const ptr = await fetchJson(`/${k}/latest/index.json`);
      const rec = ptr ? await fetchJson(`/${k}/${ptr.short}/result.json`) : null;
      out[k] = ptr ? {
        short: ptr.short,
        updated_utc: ptr.updated_utc ?? null,
        record: rec ? `https://ledatic.org/${k}/${ptr.short}/result.json` : null,
        status: rec
          ? (k === "builds" ? rec.status : ((rec.fixed_point && rec.seed_match) ? "ok" : "drift"))
          : null,
        pulse_end: rec ? (rec.pulse_end ?? null) : null,
      } : null;
    }
    return new Response(JSON.stringify(out), {
      headers: sec({
        "content-type": "application/json",
        "cache-control": "public, max-age=60",
        "access-control-allow-origin": "*",
      }),
    });
  }

  // Signed site-deploy manifests (spec §5.4) — written to KV by deploy.sh
  // (attest/site/<n>.json + attest/site/latest.json: file list + sha256s +
  // pulse anchor + Ed25519 signature; pubkey at /attest/site_deploy.pub.pem).
  // Public read, no-store so latest.json is never edge-stale — the /replay
  // ledger and per-page self-checks poll it. (/replay itself needs no route
  // here: replay.html in KV is served by the extension-less fallback below,
  // same as every other page.) Explicit handler beats the generic KV
  // fallthrough, which would apply default caching.
  const siteManifestMatch = pathname.match(/^\/attest\/site\/(latest|[0-9]{1,9})\.json$/);
  if (siteManifestMatch && method === "GET") {
    const body = await env.LEDATIC_KV.get(`attest/site/${siteManifestMatch[1]}.json`);
    if (!body) {
      return new Response('{"error":"no site deploy manifest"}', {
        status: 404,
        headers: sec({
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        }),
      });
    }
    return new Response(body, {
      headers: sec({
        "content-type": "application/json",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      }),
    });
  }

  // Attestation surfaces — releases, builds, selfhost.
  // Authoring path = R2.  Public reads, BEACON_TOKEN-gated writes.
  // Each attestation.json was signed by fleet0's Ed25519 witness key,
  // so the live endpoint is a delivery channel, not a trust root —
  // tampering at this layer is detectable by `tools/attest/verify.sh`.
  // Path components restricted to [A-Za-z0-9._-]+ to keep R2 key shape
  // predictable.  File names: any *.json (validated as parseable JSON,
  // capped at 256 KB) OR the binary allowlist below.  The allowlist
  // keeps the surface narrow — release bytes go here, nothing else.
  const ATTEST_BINARY_ALLOW = new Set(["rail_native", "compile.rail"]);
  const attestMatch = pathname.match(
    /^\/(releases|builds|selfhost)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/
  );
  if (attestMatch) {
    const [, kind, ident, file] = attestMatch;
    const isJson = file.endsWith(".json");
    const isBinary = ATTEST_BINARY_ALLOW.has(file);
    if (!isJson && !isBinary) {
      return new Response("not allowed", { status: 404, headers: sec({ "content-type": "text/plain" }) });
    }
    const r2Key = `attest/${kind}/${ident}/${file}`;
    if (method === "PUT") {
      if (request.headers.get("x-beacon-token") !== env.BEACON_TOKEN) {
        return new Response("forbidden", { status: 403, headers: sec({ "content-type": "text/plain" }) });
      }
      if (isJson) {
        const body = await request.text();
        if (!body || body.length > 256 * 1024) {
          return new Response("bad body", { status: 400, headers: sec({ "content-type": "text/plain" }) });
        }
        try { JSON.parse(body); }
        catch { return new Response("not json", { status: 400, headers: sec({ "content-type": "text/plain" }) }); }
        await env.REPORTS_R2.put(r2Key, body, {
          httpMetadata: { contentType: "application/json" },
        });
      } else {
        // Binary upload — cap at 16 MB to keep the surface honest.
        const body = await request.arrayBuffer();
        if (!body.byteLength || body.byteLength > 16 * 1024 * 1024) {
          return new Response("bad body", { status: 400, headers: sec({ "content-type": "text/plain" }) });
        }
        await env.REPORTS_R2.put(r2Key, body, {
          httpMetadata: { contentType: "application/octet-stream" },
        });
      }
      return new Response("ok", { headers: sec({ "content-type": "text/plain" }) });
    }
    if (method === "GET") {
      const obj = await env.REPORTS_R2.get(r2Key);
      if (!obj) {
        return new Response(isJson ? '{"error":"not found"}' : "not found", {
          status: 404,
          headers: sec({
            "content-type": isJson ? "application/json" : "text/plain",
            "access-control-allow-origin": "*",
          }),
        });
      }
      if (isJson) {
        return new Response(await obj.text(), {
          headers: sec({
            "content-type": "application/json",
            "cache-control": "public, max-age=300",
            "access-control-allow-origin": "*",
          }),
        });
      }
      return new Response(await obj.arrayBuffer(), {
        headers: sec({
          "content-type": "application/octet-stream",
          "cache-control": "public, max-age=3600",
          "access-control-allow-origin": "*",
          "content-disposition": `attachment; filename="${file}"`,
        }),
      });
    }
  }

  // ─── DDA archive (engagement closed 2026-05-12) ──────────────────────────
  // /dda             → static portal HTML from KV (key: dda.html)
  // /dda/handoff.pdf → R2-served handoff document
  // The live Q&A engine that once backed /dda/api/* was decommissioned when
  // the engagement closed; those routes now return an honest 410 below.
  if (pathname === "/dda" || pathname === "/dda/") {
    const html = await env.LEDATIC_KV.get("dda.html");
    if (!html) return notFound();
    return new Response(html, {
      headers: sec({
        "content-type": MIME.html,
        "cache-control": "public, max-age=300, s-maxage=300",
      }),
    });
  }
  if (pathname === "/dda/handoff.pdf" && method === "GET") {
    const obj = await env.REPORTS_R2.get("dda/handoff.pdf");
    if (!obj) return notFound();
    return new Response(obj.body, {
      headers: sec({
        "content-type": "application/pdf",
        "content-disposition": 'inline; filename="DDA_POC_Handoff_2026-05-12.pdf"',
        "cache-control": "public, max-age=600",
      }),
    });
  }
  // /dda/api/* — Q&A engine retired with the engagement (closed 2026-05-12,
  // backend decommissioned). Honest 410 Gone, not a dead proxy or a silent
  // homepage fallthrough. Attestation archive + static surfaces stay live.
  if (pathname.startsWith("/dda/api/")) {
    return jsonResponse({ error: "gone", message: "This engagement closed 2026-05-12; the Q&A engine has been retired." }, 410);
  }

  // DDA brief attestation surface — pulse + sig + sha256 only, NEVER
  // brief bytes.  The moat is "Reilly holds the briefs; the world can
  // prove they existed at a given moment under a given model."
  // Allowed shapes (file regex below enforces structurally):
  //   /dda/index.json                                          (top-level rollup)
  //   /dda/<model>/<week>/<vertical>/manifest.json             (per-week rollup)
  //   /dda/<model>/<week>/<vertical>/<brief>.<ext>.attestation.json
  // Anything else 404s — no path can name a brief content file.
  if (pathname === "/dda/index.json") {
    const r2Key = "dda/index.json";
    if (method === "PUT") {
      if (request.headers.get("x-beacon-token") !== env.BEACON_TOKEN) {
        return new Response("forbidden", { status: 403, headers: sec({ "content-type": "text/plain" }) });
      }
      const body = await request.text();
      if (!body || body.length > 256 * 1024) {
        return new Response("bad body", { status: 400, headers: sec({ "content-type": "text/plain" }) });
      }
      try { JSON.parse(body); }
      catch { return new Response("not json", { status: 400, headers: sec({ "content-type": "text/plain" }) }); }
      await env.REPORTS_R2.put(r2Key, body, {
        httpMetadata: { contentType: "application/json" },
      });
      return new Response("ok", { headers: sec({ "content-type": "text/plain" }) });
    }
    if (method === "GET") {
      const obj = await env.REPORTS_R2.get(r2Key);
      if (!obj) return new Response('{"error":"no dda index yet"}', {
        status: 404, headers: sec({ "content-type": "application/json", "access-control-allow-origin": "*" }),
      });
      return new Response(await obj.text(), {
        headers: sec({
          "content-type": "application/json",
          "cache-control": "public, max-age=300",
          "access-control-allow-origin": "*",
        }),
      });
    }
  }
  const ddaMatch = pathname.match(
    /^\/dda\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/
  );
  if (ddaMatch) {
    const [, model, week, vertical, file] = ddaMatch;
    // File-name allowlist: manifest.json or *.attestation.json only.
    // No way to name `monday.json` or `monday.md` — brief content is
    // structurally unreachable through this surface.
    const isManifest = file === "manifest.json";
    const isAttest = file.endsWith(".attestation.json");
    if (!isManifest && !isAttest) {
      return new Response("not allowed", { status: 404, headers: sec({ "content-type": "text/plain" }) });
    }
    const r2Key = `dda/${model}/${week}/${vertical}/${file}`;
    if (method === "PUT") {
      if (request.headers.get("x-beacon-token") !== env.BEACON_TOKEN) {
        return new Response("forbidden", { status: 403, headers: sec({ "content-type": "text/plain" }) });
      }
      const body = await request.text();
      if (!body || body.length > 256 * 1024) {
        return new Response("bad body", { status: 400, headers: sec({ "content-type": "text/plain" }) });
      }
      try { JSON.parse(body); }
      catch { return new Response("not json", { status: 400, headers: sec({ "content-type": "text/plain" }) }); }
      await env.REPORTS_R2.put(r2Key, body, {
        httpMetadata: { contentType: "application/json" },
      });
      return new Response("ok", { headers: sec({ "content-type": "text/plain" }) });
    }
    if (method === "GET") {
      const obj = await env.REPORTS_R2.get(r2Key);
      if (!obj) return new Response('{"error":"not found"}', {
        status: 404, headers: sec({ "content-type": "application/json", "access-control-allow-origin": "*" }),
      });
      return new Response(await obj.text(), {
        headers: sec({
          "content-type": "application/json",
          "cache-control": "public, max-age=300",
          "access-control-allow-origin": "*",
        }),
      });
    }
  }

  // ── Playground compile proxy (v0, 2026-05-13) ───────────────────────
  // POST /api/playground/compile  →  { src }  →  proxied to the Rail
  // compile_server (tools/playground/compile_server.rail) at the
  // env.PLAYGROUND_BACKEND origin. Returns the upstream JSON response
  // verbatim with CORS headers.
  //
  // Caps:
  //   - body ≤ 32 KB (matches sanitize.rail's source-size guard)
  //   - per-IP rate limit: 10 compiles / minute (in-memory token bucket
  //     scoped to the current Worker isolate — coarse enough for v0
  //     "unannounced launch" traffic; KV-backed limiter is a v1 thing).
  //   - upstream timeout: 8 s (compile_server itself uses 5 s)
  if (pathname === "/api/playground/compile" && method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: sec({
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "Content-Type",
        "access-control-max-age": "600",
      }),
    });
  }
  if (pathname === "/api/playground/compile" && method === "POST") {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (!(await playgroundRateLimit(ip, env))) {
      // Best-effort metrics increment; don't fail the response if it throws.
      try { await pgMetricsInc(env, "rate_limited"); } catch (_) {}
      return new Response(JSON.stringify({ ok: false, error: "rate limit (10/min)" }), {
        status: 429,
        headers: sec({
          "content-type": "application/json",
          "access-control-allow-origin": "*",
          "retry-after": "60",
        }),
      });
    }
    // 32 KB cap on the POST body.
    const cl = parseInt(request.headers.get("content-length") || "0", 10);
    if (cl > 32 * 1024) {
      return new Response(JSON.stringify({ ok: false, error: "source too large (>32 KB)" }), {
        status: 413,
        headers: sec({ "content-type": "application/json", "access-control-allow-origin": "*" }),
      });
    }
    const body = await request.text();
    if (body.length > 32 * 1024) {
      return new Response(JSON.stringify({ ok: false, error: "source too large (>32 KB)" }), {
        status: 413,
        headers: sec({ "content-type": "application/json", "access-control-allow-origin": "*" }),
      });
    }
    const upstreamBase = env.PLAYGROUND_BACKEND || "";
    if (!upstreamBase) {
      return new Response(JSON.stringify({ ok: false, error: "playground backend not configured" }), {
        status: 503,
        headers: sec({ "content-type": "application/json", "access-control-allow-origin": "*" }),
      });
    }
    try { await pgMetricsInc(env, "total_compiles"); } catch (_) {}
    try {
      const upstream = await fetch(`${upstreamBase}/api/playground/compile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(8000),
      });
      const upstreamText = await upstream.text();
      // Best-effort: classify response for metrics. Don't fail the
      // user request if metrics writes throw.
      try {
        const j = JSON.parse(upstreamText);
        if (j && j.ok === true) {
          await pgMetricsInc(env, "ok_compiles");
          if (typeof j.build_ms === "number") {
            await pgMetricsRecordBuildMs(env, j.build_ms);
          }
        } else if (j && j.ok === false && typeof j.error === "string") {
          if (j.error.startsWith("sanitize:")) {
            await pgMetricsInc(env, "sanitize_rejected");
            await pgMetricsRecordRejection(env, j.error.slice("sanitize:".length).trim());
          } else if (j.error.startsWith("compile failed:")) {
            await pgMetricsInc(env, "compile_error");
          } else {
            await pgMetricsInc(env, "http_error");
          }
        }
      } catch (_) { /* non-JSON upstream; skip metrics */ }
      return new Response(upstreamText, {
        status: upstream.status,
        headers: sec({
          "content-type": upstream.headers.get("content-type") || "application/json",
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
        }),
      });
    } catch (e) {
      const msg = e && e.message || String(e);
      // AbortSignal.timeout() throws TimeoutError / DOMException("...timed out").
      const isTimeout = /timeout|aborted/i.test(msg);
      try { await pgMetricsInc(env, isTimeout ? "timeout" : "upstream_unreachable"); } catch (_) {}
      // Generic error only — raw e.message can name the backend origin on an
      // unauthenticated route.
      return new Response(JSON.stringify({ ok: false, error: isTimeout ? "upstream timeout" : "upstream unreachable" }), {
        status: 502,
        headers: sec({ "content-type": "application/json", "access-control-allow-origin": "*" }),
      });
    }
  }

  // GET /api/playground/metrics — bearer-token authed read of the
  // KV-backed counters/timing/rejections. Same API_BEARER as
  // /api/update + /api/intel/waitlist (read).
  if (pathname === "/api/playground/metrics" && method === "GET") {
    const auth = request.headers.get("Authorization") || "";
    if (!env.API_BEARER || auth !== `Bearer ${env.API_BEARER}`) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: sec({ "content-type": "application/json" }),
      });
    }
    const data = await pgMetricsRead(env);
    return new Response(JSON.stringify(data, null, 2), {
      headers: sec({
        "content-type": "application/json",
        "cache-control": "no-store",
      }),
    });
  }

  // API
  if (pathname === "/api/update" && method === "POST") {
    return handleAPI(request, env);
  }

  // /pursue/files/<path>  →  R2 (REPORTS_R2 bucket, prefix "pursue/files/").
  // Used by /aliens to serve the byte-for-byte mirrored gov files.  Read-only
  // public surface — uploads happen via wrangler / direct R2 API on our end.
  // Decode percent-escapes in the URL so keys with literal spaces (e.g.
  // "department of war/...") match what wrangler/R2 stored.
  // HEAD returns just headers (no body) so the recheck pipeline can ask
  // "is this already mirrored?" without downloading.
  if (pathname.startsWith("/pursue/files/") && (method === "GET" || method === "HEAD")) {
    let r2key;
    try { r2key = decodeURIComponent(pathname.slice(1)); }
    catch { return notFound(); }
    if (r2key.includes("..") || r2key.length > 512) {
      return notFound();
    }
    if (method === "HEAD") {
      const obj = await env.REPORTS_R2.head(r2key);
      if (!obj) return notFound();
      const ext = (r2key.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || "";
      const ct = MIME[ext] || "application/octet-stream";
      return new Response(null, {
        headers: sec({
          "content-type": ct,
          "content-length": String(obj.size),
          "cache-control": "public, max-age=3600, s-maxage=3600",
        }),
      });
    }
    const obj = await env.REPORTS_R2.get(r2key);
    if (!obj) return notFound();
    const ext = (r2key.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || "";
    const ct = MIME[ext] || "application/octet-stream";
    return new Response(obj.body, {
      headers: sec({
        "content-type": ct,
        "cache-control": "public, max-age=3600, s-maxage=3600",
      }),
    });
  }

  // /pursue/manifest.jsonl → R2 (small JSONL, not KV, so we can grow past 25MB).
  if (pathname === "/pursue/manifest.jsonl" && method === "GET") {
    const obj = await env.REPORTS_R2.get("pursue/manifest.jsonl");
    if (!obj) return notFound();
    return new Response(obj.body, {
      headers: sec({
        "content-type": "application/jsonl",
        "cache-control": "public, max-age=300, s-maxage=300",
      }),
    });
  }

  // /admin/pursue-upload?key=<r2-key>  →  single-shot PUT body to R2.
  // Cloudflare's edge caps request bodies before they reach the worker,
  // so this path only works for files within the edge body limit (~100 MiB).
  // Use the multipart endpoints below for larger files.
  if (pathname === "/admin/pursue-upload" && method === "PUT") {
    if (request.headers.get("x-beacon-token") !== env.BEACON_TOKEN) {
      return new Response("forbidden", { status: 403, headers: sec({ "content-type": "text/plain" }) });
    }
    const key = url.searchParams.get("key") || "";
    if (!key.startsWith("pursue/files/") || key.includes("..") || key.length > 512) {
      return new Response("bad key", { status: 400, headers: sec({ "content-type": "text/plain" }) });
    }
    const ct = request.headers.get("content-type") || "application/octet-stream";
    await env.REPORTS_R2.put(key, request.body, { httpMetadata: { contentType: ct } });
    return new Response(JSON.stringify({ ok: true, key }), {
      headers: sec({ "content-type": "application/json" }),
    });
  }

  // R2 multipart for files past the CF edge body cap.  Three endpoints:
  //   POST /admin/pursue-mp-init?key=<r2-key>
  //   PUT  /admin/pursue-mp-part?key=<r2-key>&uploadId=<id>&part=<N>
  //   POST /admin/pursue-mp-complete?key=<r2-key>&uploadId=<id>
  // The client splits the file locally; R2 assembles.
  if (pathname.startsWith("/admin/pursue-mp-")) {
    if (request.headers.get("x-beacon-token") !== env.BEACON_TOKEN) {
      return new Response("forbidden", { status: 403, headers: sec({ "content-type": "text/plain" }) });
    }
    const key = url.searchParams.get("key") || "";
    if (!key.startsWith("pursue/files/") || key.includes("..") || key.length > 512) {
      return new Response("bad key", { status: 400, headers: sec({ "content-type": "text/plain" }) });
    }
    if (pathname === "/admin/pursue-mp-init" && method === "POST") {
      const ct = request.headers.get("x-target-content-type") || "application/pdf";
      const mp = await env.REPORTS_R2.createMultipartUpload(key, {
        httpMetadata: { contentType: ct },
      });
      return new Response(JSON.stringify({ ok: true, key, uploadId: mp.uploadId }), {
        headers: sec({ "content-type": "application/json" }),
      });
    }
    if (pathname === "/admin/pursue-mp-part" && method === "PUT") {
      const uploadId = url.searchParams.get("uploadId") || "";
      const part = parseInt(url.searchParams.get("part") || "0", 10);
      if (!uploadId || !part || part < 1) {
        return new Response("bad part", { status: 400, headers: sec({ "content-type": "text/plain" }) });
      }
      const mp = env.REPORTS_R2.resumeMultipartUpload(key, uploadId);
      const uploaded = await mp.uploadPart(part, request.body);
      return new Response(JSON.stringify({ ok: true, partNumber: part, etag: uploaded.etag }), {
        headers: sec({ "content-type": "application/json" }),
      });
    }
    if (pathname === "/admin/pursue-mp-complete" && method === "POST") {
      const uploadId = url.searchParams.get("uploadId") || "";
      if (!uploadId) {
        return new Response("bad uploadId", { status: 400, headers: sec({ "content-type": "text/plain" }) });
      }
      const body = await request.json().catch(() => null);
      if (!body || !Array.isArray(body.parts)) {
        return new Response("bad parts manifest", { status: 400, headers: sec({ "content-type": "text/plain" }) });
      }
      const mp = env.REPORTS_R2.resumeMultipartUpload(key, uploadId);
      const obj = await mp.complete(body.parts);
      return new Response(JSON.stringify({ ok: true, key, etag: obj.httpEtag }), {
        headers: sec({ "content-type": "application/json" }),
      });
    }
    return new Response("bad multipart endpoint", { status: 404, headers: sec({ "content-type": "text/plain" }) });
  }

  // ─── /tios telemetry — every public match feeds the AI harness ─────────
  // POST /api/tios/match: anonymous match record (doctrine/outcome/metrics,
  // no identity — disclosed on /tios). Validated + size-capped, stored one
  // R2 object per record (append-safe, unlike KV last-writer-wins).
  if (pathname === "/api/tios/match" && method === "POST") {
    const raw = await request.text();
    if (raw.length > 4096) return new Response("too large", { status: 413, headers: sec({}) });
    let rec;
    try { rec = JSON.parse(raw); } catch { return new Response("bad json", { status: 400, headers: sec({}) }); }
    if (typeof rec.doctrine !== "string" || typeof rec.proctor_win !== "boolean"
        || typeof rec.duration_s !== "number") {
      return new Response("bad record", { status: 400, headers: sec({}) });
    }
    const key = `tios/matches/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`;
    await env.REPORTS_R2.put(key, raw, { httpMetadata: { contentType: "application/json" } });
    return new Response(null, { status: 204, headers: sec({}) });
  }
  // GET /api/tios/matches: harvest the corpus (bearer-protected, JSONL).
  if (pathname === "/api/tios/matches" && method === "GET") {
    const auth = request.headers.get("authorization") || "";
    if (auth !== `Bearer ${env.API_BEARER}`) {
      return new Response("unauthorized", { status: 401, headers: sec({}) });
    }
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "500", 10), 1000);
    const listed = await env.REPORTS_R2.list({ prefix: "tios/matches/", limit });
    const lines = [];
    for (const obj of listed.objects) {
      const o = await env.REPORTS_R2.get(obj.key);
      if (o) lines.push(await o.text());
    }
    return new Response(lines.join("\n") + "\n", {
      headers: sec({ "content-type": "application/jsonl" }),
    });
  }

  // ─── /tios — the playable web build ────────────────────────────────────
  // Guide page lives at KV "tios.html" (generic fallthrough serves it at
  // /tios). Versioned immutable bundles live at tios/v-<ver>/…; /tios/play
  // 302s to the current version (KV "tios/current"). Game responses carry
  // COOP/COEP (threaded build needs crossOriginIsolated) and a game CSP with
  // worker-src blob: (emscripten pthreads). The 37 MB engine wasm exceeds
  // KV's 25 MB value cap, so it's stored gzipped (~11 MB) and served
  // pre-encoded with encodeBody:"manual".
  if (pathname === "/tios/play" || pathname === "/tios/play/") {
    const ver = await env.LEDATIC_KV.get("tios/current");
    if (!ver) return notFound();
    return Response.redirect(
      new URL(`/tios/v-${ver.trim()}/index.html`, request.url).href, 302);
  }
  if (pathname.startsWith("/tios/v-")) {
    const key = pathname.slice(1);
    const gameHeaders = {
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "content-security-policy": CSP.replace(
        "default-src 'self'", "default-src 'self'; worker-src 'self' blob:"),
      "cache-control": "public, max-age=31536000, immutable", // versioned = immutable
    };
    if (key.endsWith(".wasm")) {
      const gz = await env.LEDATIC_KV.get(key + ".gz", "arrayBuffer");
      if (!gz) return notFound();
      return new Response(gz, {
        encodeBody: "manual",
        headers: sec({
          "content-type": MIME.wasm,
          "content-encoding": "gzip",
          ...gameHeaders,
        }),
      });
    }
    const served = await serveFromKV(key, env);
    if (!served) return notFound();
    const h = new Headers(served.headers);
    for (const [k, v] of Object.entries(gameHeaders)) h.set(k, v);
    return new Response(served.body, { status: served.status, headers: h });
  }

  // Canonicalize /index.html → /
  if (pathname === "/index.html") {
    return Response.redirect(new URL("/", request.url).href, 301);
  }

  // Static content via KV
  let key = pathname === "/" ? "index.html" : pathname.slice(1);
  // Trailing slash → directory-style: serve <key>index.html (e.g. /rail/docs/ → rail/docs/index.html)
  if (key.endsWith("/")) key = key + "index.html";

  // Deny internal namespaces + dead orphans
  if (isPrivateKey(key)) return notFound();

  const served = await serveFromKV(key, env);
  if (served) return served;

  // Extension-less URLs: try <key>.html before falling back.
  // This lets `/rail` serve the `rail.html` KV entry without ugly URLs.
  if (!extOf(key)) {
    const htmlKey = key + ".html";
    if (!isPrivateKey(htmlKey)) {
      const htmlServed = await serveFromKV(htmlKey, env);
      if (htmlServed) return htmlServed;
    }
  }

  // Unknown page-shaped URL → honest branded 404. (Previously fell back to
  // serving the homepage with a 200, which misrepresented what exists.)
  if (!extOf(key) || extOf(key) === "html" || extOf(key) === "htm") {
    return notFoundPage();
  }

  return notFound();
}

// ─── Top-level dispatch ──────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // HEAD = GET minus body. Route handlers below branch on GET, so HEAD on
    // real resources (/dda/handoff.pdf, /fleet/status.json, …) used to fall
    // through to 404. Re-dispatch as GET, then strip the body but keep
    // status + headers. /pursue/files/ keeps its native HEAD path — its
    // R2 .head() answers without fetching the object bytes at all.
    const isHead = request.method === "HEAD" && !url.pathname.startsWith("/pursue/files/");
    if (isHead) {
      request = new Request(request.url, { method: "GET", headers: request.headers });
    }

    let resp;
    if (url.hostname.startsWith("reports.") || url.hostname.startsWith("reports-")) {
      if (url.pathname === "/api/update" && request.method === "POST") {
        resp = await handleAPI(request, env);
      } else if (!REPORTS_PUBLIC) {
        // Portal archived from public view 2026-06-10 (engagement closed;
        // data, format, and software fully preserved). Flip REPORTS_PUBLIC
        // to true to restore the login-gated portal as-was.
        resp = new Response(reportsArchivedPage(), {
          status: 410,
          headers: sec({ "content-type": MIME.html, "x-robots-tag": "noindex" }),
        });
      } else {
        resp = await handleReports(request, env, url.pathname);
      }
    } else {
      resp = await handleSite(request, env, url);
    }

    if (isHead) {
      return new Response(null, { status: resp.status, headers: resp.headers });
    }
    return resp;
  },
};
