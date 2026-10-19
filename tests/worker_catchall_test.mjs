// Catch-all serving policy, through the Worker's real fetch() with an
// in-memory KV. Run: node tests/worker_catchall_test.mjs (exit 1 on any miss).
//
// The fallthrough must serve pages and assets, and nothing that a route
// writes for itself: an anonymous POST /portcall/order lands in the KV key
// portcall_orders, and the fallthrough used to serve that key as text/html
// under a CSP that allows inline script. The Lakes pages sit behind their
// own gates, so their raw .html keys must not be reachable around them.
import worker from "../worker/worker.js";

function memKV(seed) {
  const m = new Map(Object.entries(seed));
  let writes = 0;
  return {
    async get(k, type) {
      if (!m.has(k)) return null;
      const v = m.get(k);
      const t = typeof type === "object" ? type.type : type;
      if (t === "json") return JSON.parse(v);
      if (t === "arrayBuffer") return new TextEncoder().encode(v).buffer;
      return v;
    },
    async put(k, v) { writes++; m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
    async list() { return { keys: [...m.keys()].map((name) => ({ name })), list_complete: true }; },
    get writes() { return writes; },
  };
}

const PAYLOAD = "<script>alert(document.domain)</script>";
const kv = memKV({
  "index.html": "<!doctype html><title>home</title>",
  "rail.html": "<!doctype html><title>rail</title>",
  "_shared/site.css": "body{}",
  "llms.txt": "# Ledatic",
  "greatlakes.html": "<!doctype html><title>lakes</title>",
  "vessel.html": "<!doctype html><title>vessel</title>",
  "portcall.html": "<!doctype html><title>portcall</title>",
  "portcall-app.html": "<!doctype html><title>app</title>",
  "portcall-app.manifest": "{\"name\":\"Port Call\"}",
  "tios/current": "abc1234",
  "attest/releases/v5.4.0/compile.rail": "let x = 1 < 2",
  "releases/v5.1.0/rail_native": "\x7fELF-ish",
  "entropy:frame:current": "stale frame from july",
});
// The beacon origin, as the Worker sees it through the tunnel.
let originUp = true;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  const url = typeof u === "string" ? u : u.url;
  if (url === "https://beacon.ledatic.org/frame/current") {
    if (!originUp) throw new Error("tunnel down");
    return new Response(new Uint8Array(393264).fill(7), { headers: { "content-type": "application/octet-stream" } });
  }
  return realFetch(u, init);
};
const env = { LEDATIC_KV: kv, GREATLAKES_PASS: "test-pass", API_BEARER: "b", BEACON_TOKEN: "t" };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const hit = (path, init = {}) => worker.fetch(new Request("https://ledatic.org" + path, init), env, ctx);

let fails = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  (" + detail + ")"}`);
  if (!ok) fails++;
}

// 1. The write the old code allowed (constant cookie, arbitrary strings) is
//    gone with the Lakes demo, retired 2026-10-19: it answers 410 and writes
//    nothing. The stored ring is seeded below as if an old write had landed.
const writesBefore = kv.writes;
const w = await hit("/portcall/order", {
  method: "POST",
  headers: { cookie: "pc_ok=1", "content-type": "application/json" },
  body: JSON.stringify({ order: PAYLOAD, receipt: { pulse_id: 1 } }),
});
check("portcall order refused: 410, no write", w.status === 410 && kv.writes === writesBefore, `status ${w.status}, ${kv.writes - writesBefore} writes`);
await kv.put("portcall_orders", JSON.stringify([{ order: PAYLOAD }]));

// 2. Worker state is never served by the fallthrough.
for (const p of ["/portcall_orders", "/tios/current"]) {
  const r = await hit(p);
  const body = await r.text();
  check(`${p} not served`, r.status === 404 && !body.includes(PAYLOAD) && !body.includes("abc1234"),
    `status ${r.status} ${r.headers.get("content-type")} ${body.slice(0, 40)}`);
}

// 3. The Lakes pages answer only through their gates.
for (const p of ["/greatlakes.html", "/vessel.html", "/vessel", "/portcall.html", "/portcall-app.html", "/portcall-app.manifest"]) {
  const r = await hit(p);
  const body = await r.text();
  check(`${p} not served around the gate`, r.status === 404 && !/<title>(lakes|vessel|portcall|app)</.test(body),
    `status ${r.status} ${body.slice(0, 40)}`);
}
for (const p of ["/greatlakes", "/greatlakes/data/fleet.json", "/portcall", "/portcall/app", "/portcall/fleet.json"]) {
  const r = await hit(p, { headers: { authorization: "Basic " + btoa("demo:test-pass"), cookie: "pc_ok=1" } });
  const body = await r.text();
  check(`${p} retired: 410, even with the old password and cookie`, r.status === 410 && !body.includes("<title>"), `status ${r.status}`);
}

// 4. Unknown extensions are text, never HTML.
const src = await hit("/attest/releases/v5.4.0/compile.rail");
check("unknown extension served as text/plain", src.status === 200 && /^text\/plain/.test(src.headers.get("content-type") || ""),
  `status ${src.status} ${src.headers.get("content-type")}`);

// 5. Pages and assets still serve.
for (const [p, ct] of [["/", "text/html"], ["/rail", "text/html"], ["/rail.html", "text/html"], ["/_shared/site.css", "text/css"], ["/llms.txt", "text/plain"]]) {
  const r = await hit(p);
  check(`${p} serves ${ct}`, r.status === 200 && (r.headers.get("content-type") || "").startsWith(ct), `status ${r.status} ${r.headers.get("content-type")}`);
}
const bin = await hit("/releases/v5.1.0/rail_native");
check("release binary still served by its own route", bin.status === 200, `status ${bin.status}`);
const miss = await hit("/no-such-page");
check("unknown page is a real 404", miss.status === 404, `status ${miss.status}`);

// 6. The plasma frame comes from the origin, and a stale copy is never served.
const fr = await hit("/entropy/frame/current");
const fb = new Uint8Array(await fr.arrayBuffer());
check("frame served from the origin", fr.status === 200 && fb.length === 393264 && fb[0] === 7, `status ${fr.status} len ${fb.length}`);
originUp = false;
const fd = await hit("/entropy/frame/current");
const fdBody = await fd.text();
check("origin down: 503, not the frozen KV frame", fd.status === 503 && !fdBody.includes("stale"), `status ${fd.status} ${fdBody.slice(0, 30)}`);
originUp = true;

// 7. Anonymous requests that fail auth write nothing.
const before = kv.writes;
const wit = await hit("/attest/witness", { method: "POST", body: "{}" });
check("/attest/witness without a key: 401", wit.status === 401, `status ${wit.status}`);
const pg = await hit("/api/playground/compile", { method: "POST", body: "x" });
check("dead playground compile: 503", pg.status === 503, `status ${pg.status}`);
check("rejected anonymous requests wrote no KV", kv.writes === before, `${kv.writes - before} writes`);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
