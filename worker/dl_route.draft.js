// ─────────────────────────────────────────────────────────────────────────────
// DRAFT — x402 grant-redemption route for ledatic.org datasets.
// Review before splicing into worker.js. NOT wired into the live Worker yet.
//
// Flow it completes:  agent pays /x402/<slug> (x402_deliver.rail) -> gets a signed
// download_url -> GET /dl/<slug>?grant=<hex> -> this route verifies the gateway's
// Ed25519 grant signature and streams the real .tar.gz from R2.
//
// SPLICE POINT — in the MAIN `fetch` dispatch (near the other pathname routes,
// ~worker.js:890+), add:
//     if (pathname.startsWith("/dl/")) return handleX402Download(request, env, pathname, url);
//   (The existing /dl/ inside handleReports() is a DIFFERENT, auth'd reports path
//    on the reports subdomain — this one is the public dataset lane on ledatic.org.)
//
// WRANGLER — bind the dataset bucket (holds the tarballs referenced in catalog.json):
//     [[r2_buckets]]  binding = "DATA_R2"  bucket_name = "ledatic-data"
// ─────────────────────────────────────────────────────────────────────────────

// Pinned Ed25519 PUBLIC key of the x402 gateway (only it can mint grants, and only
// after it has verified payment). Derived from the gateway seed; rotate = redeploy.
const X402_GW_PUBKEY_HEX = "676c703151b730ac90be34b0bfc419bdb8d7527e1e3c6488b051a94c7c0690ec";

// slug -> delivery info. Mirrors data/catalog.json (download_sha256 is what the
// buyer independently checks the received file against).
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

// Must match the ttl the gateway bakes into the signed preimage "grant|<slug>|<ttl>".
const X402_GRANT_TTL = "900";

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
  if (!/^[0-9a-f]{128}$/.test(grant)) return json({ error: "malformed grant" }, 400);

  // Verify the gateway's Ed25519 signature over sha256("grant|<slug>|<ttl>").
  // (x402_deliver.rail signs exactly this 32-byte digest as the Ed25519 message.)
  const preimage = new TextEncoder().encode(`grant|${slug}|${X402_GRANT_TTL}`);
  const msg = new Uint8Array(await crypto.subtle.digest("SHA-256", preimage));
  const key = await crypto.subtle.importKey("raw", hexToBytes(X402_GW_PUBKEY_HEX), { name: "Ed25519" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, hexToBytes(grant), msg);
  if (!ok) return json({ error: "invalid or forged grant" }, 403);

  // Stream the real tarball from R2.
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

// ── HARDEN BEFORE PRODUCTION ─────────────────────────────────────────────────
// 1. SINGLE-USE / EXPIRY: the grant currently signs a STATIC preimage, so it is a
//    bearer token reusable forever by anyone who sees the URL. Fix: have the gateway
//    include issued-at (iat) + a random jti in BOTH the grant JSON and the signed
//    preimage ("grant|slug|ttl|iat|jti"); here reject if (now - iat) > ttl and record
//    the redeemed jti in KV (reject on replay).
// 2. SETTLEMENT: the gateway currently verifies payment AUTHORIZATION (a signed x402
//    intent), not on-chain settlement. Gate grant issuance on an x402 facilitator
//    confirming the USDC transfer landed before minting the grant.
// 3. RATE-LIMIT /dl per IP (reuse the KV rate-limit helper already in worker.js).
// 4. Optionally bind the grant to the payer (include payer pubkey in the preimage)
//    so a leaked URL isn't usable by a third party.

export { handleX402Download, X402_GW_PUBKEY_HEX, X402_PRODUCTS };
