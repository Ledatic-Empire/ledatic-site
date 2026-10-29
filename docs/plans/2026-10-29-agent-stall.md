# The agent stall: one stall, our own goods, bought by machines

Plan, 2026-10-29. Written before any build. The owner chose this over a marketplace: one stall first,
the marketplace only if something that is not us ever buys from it.

## 0. The claim that matters

**Claim:** an agent (or a stranger it works for) will buy an attested artifact from a machine-readable
stall on ledatic.org with no human in the loop, and the fleet will fulfil, receipt and ring on its own.

**What changes for the owner if true:** the first income the fleet earns without him on a call. The
distribution half becomes a protocol the fleet publishes and keeps healthy, which is the only form of
"income autonomously" that is not a fantasy.

**How often the decision fires today:** unknown, and that is the first defect. Two checkout sessions
were opened on 2026-10-28 (the $199 pairs at 15:38, the $5 look-inside at 21:58, local; neither paid;
the owner confirmed neither was him). Nobody was told. The Cloudflare token cannot read analytics, so the
base rate of visits to /data is unmeasured. Step 1 and step 2 exist to make the rate visible before the
stall is judged.

## What exists (measured 2026-10-29, commands beside each)

| Fact | Evidence |
|---|---|
| /data, /data/catalog.json, two SKUs live | `curl -o /dev/null -w '%{http_code}'` on each: 200 |
| Stripe payment links per SKU; webhook `checkout.session.completed` to `/attest/stripe/webhook`; sale stored in KV; /thanks claims it | Stripe `webhook_endpoints` list; `worker/worker.js` lines 1240 to 1356 |
| Delivery is OFF: `DATA_DELIVERY_ONLINE = false` since 2026-07-25, R2 disabled ("enable R2 through the dashboard"); a paid data order is told "delivery by email within 24h" and nobody is rung | `worker/worker.js` line 694; CF `r2/buckets` returns code 10042 |
| Real sales ever: 0. KV `stripesales:log` holds 2 test entries (micro receipts, created_at 0); `stripesale:*` 0 keys; `dl:*` 0 tokens | KV API, prefix listings |
| Checkouts opened since 2026-09-05: 2, both 2026-10-28, both unpaid. Customers, charges, subscriptions: 0 | Stripe API `checkout/sessions?created[gte]` |
| x402 advertised in the catalog ("endpoint ... status: not serving yet"); `/x402/<slug>` returns 404; `worker/dl_route.draft.js` holds a reviewed grant-redemption route; the gateway it expects (`x402_deliver.rail`) was never written | `curl`, `find` across projects, .ledatic, .fleet, the SSD archive |
| payTo `0x0129b9e6...3301` is Empire's Base address. An address receives without a key; nothing in the estate can spend from it (no EVM signer found; the enclave signer is Solana) | `~/empire/CLAUDE.md` line 471; grep for secp256k1, web3, eth_account: none |
| Tarballs: pairs v2 805,232 B (sha256 `cebed0a4...`), corpus 2,449,467,895 B (sha256 `36a799c7...`), both only on the SSD behind the `~/.ledatic/data-products` symlink, which no launchd agent can read | `ls -la`, the `.sha256` sidecars; CLAUDE.md TCC rule |
| Mini internal disk: 86 GB free | `df -h /` |
| ledatic.org is on the Free plan; the Worker's own comment cites ToS 2.8 against streaming 2.3 GB through it. KV values cap at 25 MB, so the pairs tarball can live in KV | CF zones API: `Free Website` |
| The tunnel `signal-feed` is remotely managed, version 38: beacon, ssh, dyno.fieldcraft.page, app.fromwhere.app. Adding a host is an API edit | `cfd_tunnel/<id>/configurations` |
| llms.txt and robots.txt do not mention /data or the catalog. An agent reading the site's own guide cannot find the stall | `grep -i data llms.txt`: nothing |
| Worker already signs with a dedicated Ed25519 key (`SDK_WITNESS_KEY`, WebCrypto) for receipts | `worker/worker.js` lines 657 to 740 |
| llms.txt and sitemap.xml are modified in the working tree by a parallel session (crossvendor) | `git status --short` |

Agent payment rails outside the house, from a standard web search on 2026-10-29 (third-party sources,
to be verified against the official CDP docs before step 5): the public x402.org facilitator is reported
to settle only Base Sepolia; mainnet USDC goes through Coinbase's CDP facilitator at
`api.cdp.coinbase.com/platform/v2/x402`, and sources disagree on whether it needs a CDP API key.

## The plan

Order: 1, 2, 3, 4, 5, 7. Step 6 is built on first demand only. Steps 1 and 3 fit one session; 4 and 5
another. Every step ships with the check that would have caught its absence.

### 1. The wallet ring (Mini, no Worker change)
`~/.fleet/scripts/stall_watch.py`, launchd `com.ledatic.stall_watch` every 600 s, `/usr/bin/python3`,
stdlib only. Lists Stripe checkout sessions created since a cursor file (`~/.fleet/state/stall_cursor`).
Open and unpaid: `notify.py -s "stall: checkout opened <pack>"`, demoted, so it folds into the morning
mail. Complete: `notify.py -s "🔴 stall: SALE <pack> $<amount>"` with the buyer email and the line
"deliver within 24 h", which rings red and pushes to the phone. Also reads KV `stripesales:log` once a
day and diffs it against Stripe, so the Worker and Stripe cannot silently disagree.
- Proof: `--selftest` against a recorded Stripe payload; planted defect: a completed session with the
  ring line commented out must fail the selftest through the launchd path (a real tick with
  `NOTIFY_DRY=1` and a fixture cursor). Row in `services_manifest.md`, line in `estate_tree.py` MAP.
- Runtime: about 1 hour. Disk: none. Abort: the restricted key `rk_live` cannot list sessions (it can,
  measured today).

### 2. Analytics permission (the owner, 2 minutes)
In the Cloudflare dashboard, edit the API token the fleet uses (id `5ebcd443...d5b5`) and add
`Zone > Analytics > Read` for ledatic.org and aitwoz.com. Then one query gives 60 days of /data visits
with bot score and agent string, which is the base rate the whole plan is judged against. The query is
already written (it failed today with `authz` and nothing else).

### 3. Pairs delivered by the Worker, no human (Worker change, deploy_worker.sh)
Put `rail-verified-pairs-v2.tar.gz` (805 KB) in KV as `deliverable:pairs` (one `wrangler kv` put from a
Terminal session, since the file is on the SSD). Change `/data/download/<token>` to read KV for the pairs
pack and keep the "email within 24 h" text for the corpus. Flip `DATA_DELIVERY_ONLINE` to per-pack. The
/thanks page already shows the link.
- Proof: `POST /attest/data/grant {pack: pairs}` then `GET` the link; `shasum -a 256` of the body equals
  `cebed0a4...`; a second GET meters `used`; planted defect: wrong KV key must return the 503 text, not
  a 200 with an empty body. Binding-drift diff before deploy (the script's own rule).
- Runtime: about 1 hour. Cost: 805 KB of KV. Abort: the KV put fails on size or the download route's
  content-length cannot be set from KV (then serve with chunked encoding and re-measure).

### 4. The stall is findable (static deploy, deploy.sh)
After the parallel session's llms.txt change is committed: add a "Data for agents" section to llms.txt
naming `/data/catalog.json`, what each SKU is, the price, the two ways to pay, and that every delivery
carries an Ed25519 receipt verifiable with the published key. Fix the catalog so nothing in it is false:
the x402 block says "not serving" until step 5 lands, then says how. Add the two data pages to the
sitemap if absent.
- Proof: honesty gate green; `curl https://ledatic.org/llms.txt | grep catalog.json`.
- Runtime: 30 minutes. Abort: none.

### 5. Agents pay: x402 in the Worker (Worker change)
Preconditions, checked before any code: (a) the owner confirms he can spend from `0x0129b9e6...3301`, or
names the address that receives; (b) the CDP x402 facilitator's mainnet terms read from the official docs:
key, cost, KYB. If (b) needs a paid plan or a business verification he does not want, this step becomes
"Stripe only" and the catalog says so plainly.
Route `/x402/<slug>`: GET without payment returns 402 with the x402 payment-requirements JSON (USDC on
Base, amount from the catalog, payTo). GET with `X-PAYMENT` posts to the facilitator's `/verify` then
`/settle`; on success mints the grant from `dl_route.draft.js` (Ed25519 over
`grant|slug|ttl|iat|jti`, signed by a dedicated key, not `SDK_WITNESS_KEY`), stores the sale under
`x402sale:<jti>`, and returns the download URL plus a signed receipt (`sha256`, `pulse_id`, signature)
the agent can verify offline with the published key. Pairs download from KV (step 3); corpus returns
the 24 h text until step 6.
- Proof: a Base Sepolia end-to-end run with a test wallet first; then one mainnet purchase of the $5
  SKU from our own wallet, with the settle transaction hash in the handoff. Planted defects: a forged
  payment header must get 402, a replayed jti must get 409, a tampered receipt must fail the verifier.
- Runtime: one session. Cost: gas for one settle. Abort: facilitator returns anything but a settled
  transaction on Sepolia after two attempts; the route stays 404 and the catalog keeps "not serving".

### 6. The corpus origin (on first demand only)
Built the day step 1 rings a corpus sale, not before. Copy the 2.45 GB tarball to the internal disk
(`~/.ledatic/data-products-local/`, 86 GB free) so launchd can read it; a 40-line stdlib file server on
`127.0.0.1:8798` that serves only a grant-bearing GET; a `data.ledatic.org` ingress added to the tunnel
through the cfd_tunnel API (the tunnel is remotely managed); the Worker redirects corpus grants there.
- Abort: the Free zone's proxy throughput makes a 2.45 GB transfer fail twice in a row; then deliver
  the corpus by a signed link to an object store the owner pays for, his call.

### 7. The measurement that decides
Thirty days from the day step 4 lands, one table from the fleet's own logs: /data visits (humans vs bots,
from step 2), checkouts opened, checkouts completed, 402s served, settles, receipts issued, and for each
sale what it was and whether we had to touch it. Decision rule, written now so it cannot move later:
- One or more purchases by something that is not us: plan the marketplace (other stalls, the forum),
  on its own plan with the same discipline.
- Zero: the stall stays up as it is, nothing more is built for agents, and this document records that
  the claim was measured and did not hold. No second attempt without new evidence.

## As run, 2026-10-29 (same day; the owner: "lets make a new address ... other than that lets do it")

| Step | State | Proof as run |
|---|---|---|
| 1 wallet ring | live, `com.ledatic.stall_watch` | `--selftest` 9/9; plants: sale branch off 3/6 exit 1, open branch off 5/6 exit 1, x402 mainnet branch off 8/9 exit 1; first real tick deferred the two open checkouts of 10-28; a fake Stripe sale against the real KV ledger rang red |
| 2 analytics permission | **open, the owner** | the token still lacks Zone Analytics Read |
| 3 pairs from KV | live | `deliverable:pairs` in KV hashes `cebed0a4...`; admin grant then GET: 200, 805,232 bytes, same sha256; HEAD 200; meter counts; corpus grant 409; plant (wrong KV key): the 503 text, restore `cmp` identical, 200 again |
| 4 findable | live | llms.txt "Data for agents" (live grep: 1), sitemap lists four /data URLs (live grep: 4), catalog rewritten; the em-dash ratchet blocked every deploy until three in crossvendor.html went |
| 5 x402 | live on Base Sepolia; mainnet dormant | `node tests/x402_harness.mjs` 16/16 (a forged signature refused by the real x402.org facilitator: `invalid_exact_evm_signature`; settle stubbed; receipt verifies with node's Ed25519 against /x402/key; tamper fails; replay 409); plants: nonce guard off 15/16 exit 1, payTo check off 15/16 exit 1; live: /x402/key serves `abe6541e...`, GET answers 402 with PAYMENT-REQUIRED (eip155:84532, 199000000, our address), the forged header through the real Worker answers 402 `invalid_exact_evm_signature`, corpus 503, unknown 404 |
| 6 corpus origin | not built | waits for the first corpus sale |
| 7 the measurement | clock starts when step 4 landed: 2026-10-29 | table due 2026-11-28 |

New address: `0x64b9ee0EC9bE1dcC7d39Afa37AA75CCACd32eFD7`, made with `~/.ledatic/stall/keccak_addr.py` (stdlib
Keccak checked against the empty-string vector and the key-1 address vector); key in
`~/.ledatic/stall/base_wallet.json`, mode 600, on the Mini only. Receipt signing key `grant_key.hex` beside
it (public `abe6541e...`, served at /x402/key). Test payer for Sepolia: `sepolia_payer.json`
(`0x628aB52b4701071EDe5F2C859B5c8586489fB3F8`, test coins only).

**Mainnet, later the same afternoon.** The owner made the CDP account and pasted the key (`cdp_key_id` a
UUID, `cdp_key_secret` 64 base64 bytes, both mode 600). A JWT signed with it got 200 from CDP's
`/supported` (Base mainnet: v1 exact, v2 exact, upto, batch-settlement). Mode flipped to mainnet, Worker
deployed: the live 402 names `eip155:8453`, Base USDC and our address. The official Python client
(`~/.ledatic/stall/venv`, x402 2.26.0, `buy.py`) was run against both endpoints with unfunded payers: on
Sepolia the x402.org facilitator answered `invalid_exact_evm_insufficient_balance`; on mainnet CDP answered
HTTP 400 with `invalid_payload` / "execution reverted" (the same thing, said by a simulation), which the
Worker first reported as a 503 and now passes through as a 402 (site 4a38aad). So the whole path, client,
Worker, JWT, facilitator, is exercised up to the point where money exists.

**Settled, 17:07 UTC.** The owner asked for a cheaper SKU and funded the payer with 28 USDC. "Look inside"
(`/x402/rail-verified-pairs-v2-look-inside`, 1 USDC, the public sample delivered through the paid path with
the same receipt) went live (site 4a5b67d). The first funded purchase still failed with CDP's
`invalid_payload` / "execution reverted": the 402 advertised the EIP-712 domain `USDC` v2, but Base mainnet
USDC's contract says `USD Coin` v2 (Sepolia's says `USDC`), so the client's signature recovered to the wrong
signer. Fixed by reading `name()` and `version()` from both chains into the Worker (c2e9345); the harness now
checks the advertised domain against the contract on both chains (8c). Then:

| Purchase | Transaction on Base | Receipt |
|---|---|---|
| look inside, 1 USDC | `0x6008e815cbe4e683bf50d50e2aa7f45384ce0310b8aab01c67848c4f57eaf5d0`, block 53,252,151, Transfer payer to payTo 1.0 USDC | signature verifies offline against /x402/key; `beacon_pulse` null (the Worker fetched its own zone, which Workers cannot) |
| look inside, 1 USDC, after the fix (3724242) | `0xd6b7f7ce0cf72a5e5e63cd05d9b2d83d9a85d40f7c892b8ab3058017928dbf5a` | verifies; `beacon_pulse` 9518363 |

Balances after: payTo 2.0 USDC, payer 26.0 USDC (the owner's standing budget for the stall's own tests). The
wallet ring rang red by mail and push for the first sale (`notify.log` 17:08:39Z); a kickstart a minute after
the sale had read an empty ledger, KV being eventually consistent, and the next tick caught it.

## Step 2 landed, 17:31 UTC: the base rate

The owner granted the fleet token **Account** Analytics Read (not zone-level; the account-scoped GraphQL
dataset filtered by host serves the same purpose). The Free plan exposes no `botScore` and no ASN, so
human vs bot is judged by user agent, and the adaptive dataset is sampled (counts are estimates in tens).

30 days to 2026-10-29, eyeball requests to ledatic.org, by surface (estimate; browser UA / bot UA):

| Surface | browser | bot | who the bots are |
|---|---|---|---|
| /llms.txt | 120 | 150 | |
| /data and /data.html | 230 | 240 | ExaSearchBot, Barkrowler, curl |
| /data/catalog.json | 100 | 70 | |
| the two dataset pages | 150 | 130 | AteveSearchSourceUrlDiscovery, curl |
| sample, sha256 sidecar, ledger sig | 70 | 300 | Elevenlabs crawler, curl |
| /x402/rail-verified-pairs-v2 | 20 | 0 | our own tests today |
| /data/.env, /database.sql and kin | 0 | 300 | GrokBot, KimiBot, curl: scanners, not buyers |

ledatic.org html pageviews per day, 10-19 to 10-29: 2460, 2264, 1104, 3163, 2033, 395, 768, 920, 1170,
616, 431. On 10-28 the data pages saw browser visitors from DE, ID, PY, GB, ZA, US and CL and the crawlers
Exa and Barkrowler; the sampling is too coarse to pin the two checkout opens (19:38 and 01:58 UTC) to a row.
So the base rate the 30-day table will be judged against is on the order of a few browser visits to /data
per day, the same again from crawlers, and AI search crawlers (Exa, Grok, Kimi) already reading the catalog
and llms.txt. The measurement script is `tools/stall_traffic.py` (added with this section).

## Dross
- The `aitwoz-cloud` tunnel (down) and the aitwoz webhook endpoint still enabled in Stripe: harmless,
  removed in a later deletion pass, not here.
- `rail-verified-pairs-v1.tar.gz` on the SSD: not sold, not touched.
- The receipts packs (micro, starter, growth, scale) keep working as they are; the wallet ring covers
  them too since it watches every checkout.

## What this plan does not claim
That agents want attested datasets. That is the thing step 7 measures. The hours come out of Fieldcraft
and Fromwhere, by the owner's decision on 2026-10-29.
