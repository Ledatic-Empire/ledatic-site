// TIOS match recording and downloads, through the Worker's real fetch() with
// an in-memory KV. Run: node tests/worker_tios_test.mjs (exit 1 on any miss).
//
// Until 2026-10-19 every match the game posted threw on the retired R2 bucket
// (a Cloudflare 500), cost one KV write, and recorded nothing, so /tios/war
// froze at 11 exams on 2026-07-17; the desktop downloads read R2 and 404'd.
import worker from "../worker/worker.js";

const m = new Map();
let writes = 0;
const kv = {
  async get(k, type) {
    if (!m.has(k)) return null;
    const v = m.get(k);
    const t = typeof type === "object" ? type.type : type;
    return t === "json" ? JSON.parse(v) : v;
  },
  async put(k, v) { writes++; m.set(k, String(v)); },
  async delete(k) { m.delete(k); },
  async list() { return { keys: [], list_complete: true }; },
};
const env = { LEDATIC_KV: kv, API_BEARER: "b" };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const rec = (over = {}) => ({ doctrine: "SWARMLORD", proctor_win: false, duration_s: 612, map: "THRESHOLD", src: "web", ...over });
async function post(ip, body) {
  try {
    return await worker.fetch(new Request("https://ledatic.org/api/tios/match", {
      method: "POST", body: JSON.stringify(body), headers: { "cf-connecting-ip": ip } }), env, ctx);
  } catch (e) { return { status: `threw: ${e.message}` }; }
}

let fails = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  (" + detail + ")"}`);
  if (!ok) fails++;
}

let w0 = writes;
let r = await post("198.51.100.1", rec());
check("a match is recorded with one KV write", r.status === 204 && writes - w0 === 1, `status ${r.status}, ${writes - w0} writes`);

w0 = writes;
r = await post("198.51.100.2", rec({ doctrine: "<img src=x onerror=a()>" }));
check("markup as a doctrine is refused, nothing written", r.status === 400 && writes === w0, `status ${r.status}, ${writes - w0} writes`);

await post("198.51.100.3", rec());
await post("198.51.100.3", rec());
w0 = writes;
r = await post("198.51.100.3", rec());
check("third post from one IP in a minute: 429, no write", r.status === 429 && writes === w0, `status ${r.status}`);

const st = {};
for (let i = 0; i < 40; i++) { const x = await post("192.0.2." + i, rec({ proctor_win: i % 3 === 0 })); st[x.status] = (st[x.status] || 0) + 1; }
const agg = JSON.parse(m.get("tios/war_agg") || "{}");
check("the day's cap holds at 25 recorded matches", agg.day_n === 25 && agg.total === 25, `day_n ${agg.day_n}, total ${agg.total}, ${JSON.stringify(st)}`);

const war = await (await worker.fetch(new Request("https://ledatic.org/api/tios/war"), env, ctx)).json().catch(() => ({}));
check("/api/tios/war shows the count and hides the records", war.total === 25 && !("recent" in war) && !("day_n" in war), JSON.stringify(war).slice(0, 80));

for (const f of ["tios_macos.zip", "tios_windows.zip", "tios_linux.zip"]) {
  let d;
  try { d = await worker.fetch(new Request("https://ledatic.org/tios/dist/" + f), env, ctx); } catch (e) { d = { status: "threw", headers: new Headers() }; }
  const loc = d.headers.get("location") || "";
  check(`/tios/dist/${f} redirects to the release`, d.status === 302 && loc.startsWith("https://github.com/Ledatic-Empire/tios-releases/releases/download/") && loc.endsWith(f), `status ${d.status} ${loc}`);
}
const evil = await worker.fetch(new Request("https://ledatic.org/tios/dist/../worker.js"), env, ctx).catch(() => ({ status: "threw" }));
check("any other dist path is not redirected", evil.status !== 302, `status ${evil.status}`);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
