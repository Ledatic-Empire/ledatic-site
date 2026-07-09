// ─────────────────────────────────────────────────────────────────────────────
// DRAFT — x402 grant-redemption route for ledatic.org datasets (grant v2: hardened).
// Review before splicing into worker.js. NOT wired into the live Worker yet.
//
// Flow it completes:  agent pays /x402/<slug> (x402_deliver.rail) -> gets a signed,
// single-use, expiring download_url -> GET /dl/<slug>?grant=<hex>&iat=<s>&jti=<hex>
// -> this route verifies the gateway's Ed25519 signature over
// sha256("grant|<slug>|<ttl>|<iat>|<jti>"), enforces expiry + KV single-use, then
// streams the real .tar.gz from R2.
//
// SPLICE POINT — in the MAIN `fetch` dispatch (~worker.js:890+), add:
//     if (pathname.startsWith("/dl/")) return handleX402Download(request, env, pathname, url);
//   (The existing /dl/ inside handleReports() is a different, auth'd reports path.)
//
// WRANGLER — bind the dataset bucket + reuse the existing KV:
//     [[r2_buckets]] binding = "DATA_R2"  bucket_name = "ledatic-data"
//     (LEDATIC_KV is already bound — used here for single-use jti tracking.)
// ─────────────────────────────────────────────────────────────────────────────

// Pinned Ed25519 PUBLIC key of the x402 gateway (only it can mint grants, and only
// after verifying payment). Rotate = redeploy.
const X402_GW_PUBKEY_HEX = "676c703151b730ac90be34b0bfc419bdb8d7527e1e3c6488b051a94c7c0690ec";

// slug -> delivery info. Mirrors data/catalog.json.
const X402_PRODUCTS = {
  "rail-verified-pairs-v2": {
    r2key: "rail-verified-pairs-v2.tar.gz",
    filename: "rail-verified-pairs-v2.tar.gz",
    download_sha256: "cebed0a4072df5116812b024e7818aeb3eaa1a5334b7882c3c8e59dd7a967fff",
  },
  "attested-text-corpus-v2": {
    r2key: "attested-text-corpus-v2.tar.gz",
    filename: "attested-text-corpus-v2.tar.gz",
    download_sha256: null, // TODO: fill from the corpus tarball .sha256
  },
};

// Must match the ttl the gateway bakes into the signed preimage.
const X402_GRANT_TTL = 900;

function hexToBytes(h) {
  const a = new Uint8Array(h.length >> 1);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16);
  return a;
}

async function handleX402Download(request, env, pathname, url) {
  const json = (o, status) =>
    new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

  const slug = pathname.slice("/dl/".length).replace(/\/+$/, "");
  const prod = X402_PRODUCTS[slug];
  if (!prod) return json({ error: "unknown product", catalog: "/data/catalog.json" }, 404);

  const grant = url.searchParams.get("grant") || "";
  const iat = url.searchParams.get("iat") || "";
  const jti = url.searchParams.get("jti") || "";
  if (!/^[0-9a-f]{128}$/.test(grant) || !/^\d{1,15}$/.test(iat) || !/^[0-9a-f]{16,64}$/.test(jti)) {
    return json({ error: "malformed grant" }, 400);
  }

  // 1) EXPIRY — reject grants older than ttl.
  const now = Math.floor(Date.now() / 1000);
  if (now - parseInt(iat, 10) > X402_GRANT_TTL) return json({ error: "grant expired" }, 403);

  // 2) SIGNATURE — verify the gateway's Ed25519 over sha256("grant|slug|ttl|iat|jti").
  const preimage = new TextEncoder().encode(`grant|${slug}|${X402_GRANT_TTL}|${iat}|${jti}`);
  const msg = new Uint8Array(await crypto.subtle.digest("SHA-256", preimage));
  const key = await crypto.subtle.importKey("raw", hexToBytes(X402_GW_PUBKEY_HEX), { name: "Ed25519" }, false, ["verify"]);
  if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, hexToBytes(grant), msg))) {
    return json({ error: "invalid or forged grant" }, 403);
  }

  // 3) SINGLE-USE — reject replay; record jti in KV until it expires anyway.
  const kvKey = `x402:jti:${jti}`;
  if (env.LEDATIC_KV) {
    if (await env.LEDATIC_KV.get(kvKey)) return json({ error: "grant already redeemed" }, 409);
    await env.LEDATIC_KV.put(kvKey, "1", { expirationTtl: X402_GRANT_TTL + 60 });
  }

  // 4) DELIVER — stream the real tarball from R2.
  if (!env.DATA_R2) return json({ error: "delivery bucket not bound" }, 503);
  const obj = await env.DATA_R2.get(prod.r2key);
  if (!obj) return json({ error: "object missing" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${prod.filename}"`,
      "x-content-sha256": prod.download_sha256 || "",
      "cache-control": "private, no-store",
    },
  });
}

// ── STILL TO HARDEN BEFORE PRODUCTION ────────────────────────────────────────
// DONE here: single-use (jti+KV) + expiry (iat+ttl) + forged-grant rejection.
// TODO:
//  - SETTLEMENT: the gateway verifies payment AUTHORIZATION (a signed x402 intent),
//    not on-chain settlement. Gate grant issuance on an x402 facilitator confirming
//    the USDC transfer before minting (server side, in x402_deliver).
//  - RATE-LIMIT /dl per IP (reuse the KV rate-limit helper already in worker.js).
//  - PAYER-BINDING: include the payer pubkey in the preimage so a leaked URL isn't
//    usable by a third party (defence-in-depth beyond single-use).

export { handleX402Download, X402_GW_PUBKEY_HEX, X402_PRODUCTS };
