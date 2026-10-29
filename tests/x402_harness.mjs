// Local gate for the x402 route in worker/worker.js (agent stall step 5, 2026-10-29).
// Runs the real Worker module under node with a KV stub. The forged-payment case
// talks to the real public x402.org facilitator; the settle case stubs the
// facilitator (a real settle needs funded test USDC) and checks everything the
// Worker does after it: grant, receipt, signature, ledger, replay refusal.
//   node tests/x402_harness.mjs            exit 1 on any FAIL
import { readFileSync } from "node:fs";
import { createPublicKey, verify as edVerify, randomBytes } from "node:crypto";

const worker = (await import("../worker/worker.js")).default;

function kvStub() {
  const m = new Map();
  return {
    m,
    async get(k, type) {
      const v = m.get(k);
      if (v === undefined) return null;
      if (type === "arrayBuffer") return v instanceof ArrayBuffer ? v : new TextEncoder().encode(v).buffer;
      return v;
    },
    async put(k, v) { m.set(k, v); },
    async list() { return { keys: [...m.keys()].map((name) => ({ name })) }; },
  };
}
let seed;
try { seed = readFileSync(process.env.HOME + "/.ledatic/stall/grant_key.hex", "utf8").trim(); }
catch { seed = randomBytes(32).toString("hex"); }
const PAY_TO = "0x64b9ee0EC9bE1dcC7d39Afa37AA75CCACd32eFD7";
const SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SLUG = "rail-verified-pairs-v2";
const URL_ = `https://ledatic.org/x402/${SLUG}`;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

const results = [];
const check = (name, ok, detail = "") => { results.push([name, !!ok]); console.log((ok ? "ok   " : "FAIL ") + name + (ok || !detail ? "" : `: ${detail}`)); };

function env(mode, kv) { return { LEDATIC_KV: kv, X402_MODE: mode, X402_GRANT_KEY: seed, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "" }; }
const get = (e, url, headers = {}) => worker.fetch(new Request(url, { headers }), e);

function payload(requirements, over = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    x402Version: 2,
    resource: { url: URL_, description: "", mimeType: "application/json" },
    accepted: { ...requirements, ...(over.accepted || {}) },
    payload: {
      signature: "0x" + "11".repeat(65),
      authorization: {
        from: "0x000000000000000000000000000000000000dEaD", to: requirements.payTo, value: requirements.amount,
        validAfter: "0", validBefore: String(now + 300), nonce: over.nonce || ("0x" + randomBytes(32).toString("hex")),
      },
    },
  };
}

// 1. off
{
  const r = await get(env("off", kvStub()), URL_);
  const j = await r.json();
  check("mode off answers 503 with the card link", r.status === 503 && /buy\.stripe\.com/.test(j.buy_url || ""));
}
// 2. unknown
{
  const r = await get(env("sepolia", kvStub()), "https://ledatic.org/x402/nothing-here");
  check("unknown product answers 404", r.status === 404);
}
// 3. 402 shape
let requirements;
{
  const r = await get(env("sepolia", kvStub()), URL_);
  const hdr = r.headers.get("payment-required");
  const req = hdr ? unb64(hdr) : null;
  requirements = req && req.accepts && req.accepts[0];
  const body = await r.json();
  check("no payment answers 402 with a PAYMENT-REQUIRED header", r.status === 402 && !!req);
  check("requirements name Base Sepolia USDC, 199 USDC, our address, EIP-712 USDC v2",
    requirements && requirements.scheme === "exact" && requirements.network === "eip155:84532"
    && requirements.amount === "199000000" && requirements.asset === SEPOLIA_USDC && requirements.payTo === PAY_TO
    && requirements.extra && requirements.extra.name === "USDC" && requirements.extra.version === "2"
    && body.x402Version === 2 && body.resource && body.resource.url === URL_, JSON.stringify(requirements));
}
// 4. v1 refused
{
  const r = await get(env("sepolia", kvStub()), URL_, { "x-payment": b64({ x402Version: 1, scheme: "exact", network: "base-sepolia", payload: {} }) });
  const j = await r.json();
  check("a v1 X-PAYMENT payload is refused with a v2 hint", r.status === 402 && /v2/.test(j.error || ""));
}
// 5. payTo mismatch
{
  const p = payload(requirements, { accepted: { payTo: "0x000000000000000000000000000000000000beef" } });
  const r = await get(env("sepolia", kvStub()), URL_, { "payment-signature": b64(p) });
  const j = await r.json();
  check("a payment aimed at another address is refused before any facilitator call", r.status === 402 && /do not match/.test(j.error || ""));
}
// 6. forged signature, real facilitator
{
  const p = payload(requirements);
  const r = await get(env("sepolia", kvStub()), URL_, { "payment-signature": b64(p) });
  const j = await r.json();
  check("a forged signature is refused by the real x402.org facilitator", r.status === 402 && /payment not valid/.test(j.error || ""),
    `status ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
}
// 7. settle path with a stubbed facilitator, then 8. replay
{
  const kv = kvStub();
  const e = env("sepolia", kv);
  const realFetch = globalThis.fetch;
  const TX = "0x" + randomBytes(32).toString("hex");
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://x402.org/facilitator/verify")) return new Response(JSON.stringify({ isValid: true, payer: "0x000000000000000000000000000000000000dEaD" }), { headers: { "content-type": "application/json" } });
    if (u.startsWith("https://x402.org/facilitator/settle")) return new Response(JSON.stringify({ success: true, transaction: TX, network: "eip155:84532", payer: "0x000000000000000000000000000000000000dEaD" }), { headers: { "content-type": "application/json" } });
    return realFetch(url, init);
  };
  const nonce = "0x" + randomBytes(32).toString("hex");
  const p = payload(requirements, { nonce });
  let r, j;
  try {
    r = await get(e, URL_, { "payment-signature": b64(p) });
    j = await r.json();
  } finally { globalThis.fetch = realFetch; }
  check("a verified and settled payment answers 200 with a receipt", r.status === 200 && j.receipt && j.receipt.transaction === TX, `status ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  check("testnet delivers the free sample, never the paid file", j.receipt && /sample200\.jsonl$/.test(j.receipt.download_url || "") && !kv.m.has("dl:" + (j.receipt.download_url || "").split("/").pop()));
  const pr = r.headers.get("payment-response") ? unb64(r.headers.get("payment-response")) : null;
  check("PAYMENT-RESPONSE header carries the settlement", pr && pr.success === true && pr.transaction === TX);
  // signature check with node's own Ed25519 against the key the route publishes
  const kr = await get(e, "https://ledatic.org/x402/key");
  const kj = await kr.json();
  const canonical = JSON.stringify(j.receipt, Object.keys(j.receipt).sort());
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update(canonical).digest("hex");
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(kj.public_key_hex, "hex")]);
  const pub = createPublicKey({ key: spki, format: "der", type: "spki" });
  const sigOk = edVerify(null, Buffer.from(digest, "utf8"), pub, Buffer.from(j.signature, "hex"));
  check("the receipt's Ed25519 signature verifies against /x402/key and re-derives canonical_sha256", sigOk && digest === j.canonical_sha256);
  const tampered = { ...j.receipt, amount: "1" };
  const tdigest = createHash("sha256").update(JSON.stringify(tampered, Object.keys(tampered).sort())).digest("hex");
  check("a tampered receipt does not verify", !edVerify(null, Buffer.from(tdigest, "utf8"), pub, Buffer.from(j.signature, "hex")));
  check("the sale and the ledger are written to KV", kv.m.has(`x402sale:${TX}`) && JSON.parse(kv.m.get("x402sales:log")).some((x) => x.transaction === TX));
  const r2 = await get(e, URL_, { "payment-signature": b64(payload(requirements, { nonce })) });
  check("the same authorization nonce again answers 409 without asking the facilitator", r2.status === 409);
}
// 9. mainnet without CDP credentials
{
  const p = payload({ ...requirements, network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" });
  const r = await get(env("mainnet", kvStub()), URL_, { "payment-signature": b64(p) });
  const j = await r.json();
  check("mainnet without a CDP key answers 503 'settlement not configured'", r.status === 503 && /not configured/.test(j.error || ""), JSON.stringify(j).slice(0, 160));
}
// 10. key route
{
  const r = await get(env("sepolia", kvStub()), "https://ledatic.org/x402/key");
  const j = await r.json();
  check("/x402/key publishes a 32-byte Ed25519 public key", r.status === 200 && /^[0-9a-f]{64}$/.test(j.public_key_hex || ""));
}
const okCount = results.filter(([, ok]) => ok).length;
console.log(`x402 harness: ${okCount}/${results.length}`);
process.exit(okCount === results.length ? 0 : 1);
