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
 * Source of truth: tools/deploy/worker.js in the rail repo. Deploy via
 *   tools/deploy/deploy_worker.sh
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

// ─── Deny list ───────────────────────────────────────────────────────────────

// Any KV key whose raw value must never be exposed via a public URL.
// Colon-namespaced keys (client:*, reports:*, session:*, entropy:* internals)
// are denied by pattern. Everything else is enumerated.
const DENY_EXACT = new Set([
  // Internal data with no dedicated /data/ handler
  "intakes",
  "snapshot",          // served via /data/snapshot.json
  "devlog",            // served via /data/devlog.json
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
  "bin",
  "pdf",
  "mp4", "mov", "m4v", "webm",
]);

const LONG_CACHE_EXT = new Set([
  "css", "js", "mjs", "json", "xml", "xsl", "txt", "svg",
  "woff", "woff2", "ttf",
  "png", "jpg", "jpeg", "gif", "webp", "ico",
  "wasm",
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

async function hashPassword(password) {
  const data = new TextEncoder().encode(password);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
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

  // Dynamic public JSON. KV values may be malformed (e.g. legacy "undefined"
  // strings from earlier deploy tooling); fall through to empty default rather
  // than 500.
  if (pathname === "/data/devlog.json") {
    const raw = await env.LEDATIC_KV.get("devlog");
    let data = [];
    try { if (raw) data = JSON.parse(raw); } catch (_) { data = []; }
    return new Response(JSON.stringify(data), {
      headers: sec({ "content-type": "application/json", "cache-control": "no-store" }),
    });
  }
  if (pathname === "/data/snapshot.json") {
    const raw = await env.LEDATIC_KV.get("snapshot");
    let data = {};
    try { if (raw) data = JSON.parse(raw); } catch (_) { data = {}; }
    return new Response(JSON.stringify(data), {
      headers: sec({ "content-type": "application/json", "cache-control": "no-store" }),
    });
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
    // to the Mini fleet tunnel which then talks to Studio's 122B over TB mesh.
    // env.LAKES_FLEET_URL is the Cloudflare Tunnel public hostname for the
    // Mini's AI proxy endpoint (set as a secret_text binding). If unset, this
    // route returns a friendly "AI offline" instead of crashing.
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

  // ─── DDA Live Q&A portal ─────────────────────────────────────────────────
  // /dda             → static portal HTML from KV (key: dda.html)
  // /dda/handoff.pdf → R2-served handoff document
  // /dda/api/ask     → POST {question}; Worker validates token, rate-limits,
  //                     forwards to Mini's fleet HTTP control plane.
  // /dda/api/health  → GET; returns engine state {idle|warming|ready}.
  //
  // Auth: env.DDA_PORTAL_TOKEN is the shared client-side bearer token that
  // every DDA team member uses (sent as X-DDA-Token by the page). The Worker
  // re-authenticates to Mini using env.DDA_FLEET_TOKEN. env.DDA_API_HOST is
  // the cftunnel hostname (e.g. dda-api.ledatic.org) that points at Mini :9101.
  // Rate limit: env.DDA_RATE_PER_DAY (default 50) per token+UTC-day, KV-backed.
  // The corpus never traverses the Worker — only the question text in, answer text out.
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
  if (pathname === "/dda/api/ask" && method === "POST") {
    if (!env.DDA_PORTAL_TOKEN || request.headers.get("X-DDA-Token") !== env.DDA_PORTAL_TOKEN) {
      return jsonResponse({ message: "Unauthorized" }, 401);
    }
    if (!env.DDA_API_HOST || !env.DDA_FLEET_TOKEN) {
      return jsonResponse({ message: "Portal misconfigured server-side" }, 500);
    }
    // Rate limit: defense in depth — token-wide bucket AND per-IP bucket.
    // The token-wide bucket caps total abuse if the shared token leaks; the
    // per-IP bucket protects against one bad actor exhausting the global cap.
    const today = new Date().toISOString().slice(0, 10);
    const ddaIp = request.headers.get("cf-connecting-ip") || "0.0.0.0";
    const rateKey   = `dda:rate:${env.DDA_PORTAL_TOKEN.slice(0, 8)}:${today}`;
    const rateKeyIp = `dda:rate:${env.DDA_PORTAL_TOKEN.slice(0, 8)}:${ddaIp}:${today}`;
    const rawCount = await env.LEDATIC_KV.get(rateKey);
    const rawCountIp = await env.LEDATIC_KV.get(rateKeyIp);
    const count   = rawCount   ? parseInt(rawCount,   10) || 0 : 0;
    const countIp = rawCountIp ? parseInt(rawCountIp, 10) || 0 : 0;
    const cap = parseInt(env.DDA_RATE_PER_DAY || "50", 10);
    const capIp = parseInt(env.DDA_RATE_PER_IP_PER_DAY || "20", 10);
    if (count >= cap) {
      return jsonResponse({ message: `Daily limit (${cap}) reached.` }, 429);
    }
    if (countIp >= capIp) {
      return jsonResponse({ message: `Per-IP daily limit (${capIp}) reached.` }, 429);
    }
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ message: "Bad JSON" }, 400); }
    const question = (body.question || "").toString().slice(0, 4000);
    if (!question.trim()) return jsonResponse({ message: "Empty question" }, 400);
    let upstream;
    try {
      upstream = await fetch(`https://${env.DDA_API_HOST}/dda_ask`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Fleet-Token": env.DDA_FLEET_TOKEN,
        },
        body: JSON.stringify({ question }),
      });
    } catch (e) {
      return jsonResponse({ message: "Engine unreachable: " + e.message }, 503);
    }
    if (upstream.status === 503) {
      const j = await upstream.json().catch(() => ({}));
      return jsonResponse(j.message ? j : { message: "Engine warming up — try again in 60s." }, 503);
    }
    const text = await upstream.text();
    if (!upstream.ok) {
      return jsonResponse({ message: "Engine error: " + upstream.status }, 502);
    }
    // Increment both rate-limit counters only on successful answer
    await env.LEDATIC_KV.put(rateKey,   String(count   + 1), { expirationTtl: 86400 * 2 });
    await env.LEDATIC_KV.put(rateKeyIp, String(countIp + 1), { expirationTtl: 86400 * 2 });
    return new Response(text, {
      headers: sec({
        "content-type": "application/json",
        "cache-control": "no-store",
      }),
    });
  }
  if (pathname === "/dda/api/health" && method === "GET") {
    if (!env.DDA_PORTAL_TOKEN || request.headers.get("X-DDA-Token") !== env.DDA_PORTAL_TOKEN) {
      return jsonResponse({ message: "Unauthorized" }, 401);
    }
    if (!env.DDA_API_HOST || !env.DDA_FLEET_TOKEN) {
      return jsonResponse({ state: "idle", note: "portal not configured" });
    }
    try {
      const r = await fetch(`https://${env.DDA_API_HOST}/dda_health`, {
        headers: { "X-Fleet-Token": env.DDA_FLEET_TOKEN },
      });
      const t = await r.text();
      return new Response(t, {
        headers: sec({ "content-type": "application/json", "cache-control": "no-store" }),
      });
    } catch (e) {
      return jsonResponse({ state: "idle", note: "engine unreachable" });
    }
  }
  if (pathname.startsWith("/dda/api/poll/") && method === "GET") {
    if (!env.DDA_PORTAL_TOKEN || request.headers.get("X-DDA-Token") !== env.DDA_PORTAL_TOKEN) {
      return jsonResponse({ message: "Unauthorized" }, 401);
    }
    if (!env.DDA_API_HOST || !env.DDA_FLEET_TOKEN) {
      return jsonResponse({ message: "Portal misconfigured server-side" }, 500);
    }
    const jobId = pathname.slice("/dda/api/poll/".length);
    if (!/^[a-f0-9]{8,64}$/i.test(jobId)) {
      return jsonResponse({ message: "Bad job_id" }, 400);
    }
    try {
      const r = await fetch(`https://${env.DDA_API_HOST}/dda_job/${jobId}`, {
        headers: { "X-Fleet-Token": env.DDA_FLEET_TOKEN },
      });
      const text = await r.text();
      return new Response(text, {
        status: r.status,
        headers: sec({ "content-type": "application/json", "cache-control": "no-store" }),
      });
    } catch (e) {
      return jsonResponse({ message: "Engine unreachable: " + e.message }, 503);
    }
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
  // compile_server (tools/playground/compile_server.rail) running on
  // Mini (or Studio fallback) over Tailscale. Returns the upstream
  // JSON response verbatim with CORS headers.
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
      return new Response(JSON.stringify({ ok: false, error: `upstream unreachable: ${msg}` }), {
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

  // Last-resort fallback: clean URL without extension → homepage.
  // Keeps old inbound links alive; unknown extensioned paths still 404.
  if (!extOf(key)) {
    const fallback = await env.LEDATIC_KV.get("index.html");
    if (fallback) {
      return new Response(fallback, {
        headers: sec({ "content-type": MIME.html, "cache-control": "public, max-age=300, s-maxage=300" }),
      });
    }
  }

  return notFound();
}

// ─── Top-level dispatch ──────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.hostname.startsWith("reports.") || url.hostname.startsWith("reports-")) {
      if (url.pathname === "/api/update" && request.method === "POST") {
        return handleAPI(request, env);
      }
      return handleReports(request, env, url.pathname);
    }

    return handleSite(request, env, url);
  },
};
