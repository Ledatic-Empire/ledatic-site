# x402 niches for Ledatic: research, 2026-11-15

> Status, 2026-11-15 21:15 UTC: research only, nothing built. Made by a 13-agent survey with skeptics; figures carry their sources and were not re-checked beyond the two items below.
> Known since the report was written: the 2026-11-06 reply to Coinstancy WAS sent (free listing accepted, paid tiers and joint post declined), and a second mail on 2026-11-15 approved the listing preview before the AMF fact was known. The AMF blacklist page was re-read directly the same day: title "coinstancy.com - Liste noire | AMF", dated 24/03/2026. The owner chose to withdraw; the withdrawal mail went out 2026-11-15 21:36 UTC (asks for removal of name, logo, descriptions and endpoints, and a confirming reply). No confirmation received yet.

## 1. The short answer

No candidate has evidence of a paying buyer, and the skeptics killed both build ideas they reviewed as paid products. The x402 market is short of buyers, not sellers: real agent buying is cents per call for live search, crypto data and actions, none of which Ledatic sells. The supported move is no build and no new price before the stall's decision date, 2026-11-28, while research continues on paper. The digest witness is the only build that survived at all, and only as a free research artifact with a narrower claim. One decision is due today: the Coinstancy listing launches 2026-11-16, and coinstancy.com is on the French regulator's blacklist.

## 2. The market as it is

Terms:
- **x402:** a server answers HTTP 402 "payment required" and the client pays per request in USDC.
- **Facilitator:** the service that verifies and settles that payment on chain.
- **Bazaar:** Coinbase's catalog of x402 sellers.
- **Wash:** self-payment that inflates the numbers.

| What | Figure | Source and status |
|---|---|---|
| Raw cumulative volume | $52.7M, 198.9M settlements | TRM Labs, 2026-09-09 |
| Same, after screening | $25.62M; agent volume about $5,000 to $11,000 a month | TRM Labs (https://www.trmlabs.com/trm-tech-blog/whos-actually-paying-measuring-ai-agent-payments-onchain) |
| Base only, 280 days | $44.1M raw; $187,861 reaches a nameable service | https://arxiv.org/abs/2607.12575 |
| Last 7 days | $494.1k, 21 active facilitators | https://x402-list.com/facilitators (page flags its totals as incomplete) |
| Coinbase "165M+ transactions, $50M+" | raw | self-reported, search snippet only |
| Median payment on Base | $0.0061 | https://www.turnkey.com/blog/agents-buying-coinbases-x402-bazaar-discovery-layer |
| Buyers paying only one seller | 92% of 5,445 wallets | https://whatagentsbuy.com/ |
| Endpoints with one payer | 73% | https://apify.com/yadroo/x402-endpoints (one directory, dated 2026-09-13) |

- **What agents buy** (top 100 Bazaar listings by calls, Turnkey): web search 42.0%, crypto data 23.4%, enrichment 11.3%. Verification, attestation, datasets and randomness do not appear.
- **Where the dollars are:** cards and credits. Laso Finance shows $229.2k in 30 days, 98.6% from one buyer. Broad information sellers earn little: Exa $191, Nansen $133 (x402-list).
- **What one new seller saw:** modelmarket.dev logged 40,400 unpaid 402s and 26 paid calls from 7 wallets, about $0.083, over 5 to 24 October. None of the wallets "looks like use". This is self-reported (https://dev.to/alexar76/three-x402-sellers-compared-notes-the-routes-answer-nobody-comes-back-to-buy-5897). An earlier draft credited these numbers to three sellers; the skeptics corrected that.
- **Price gap:** Ledatic's 199 USDC item is four to five orders of magnitude above the median payment. The 1 USDC look-inside is about 160 times it.

## 3. What Ledatic already has

- **The stall.** It is live on Base mainnet. In its first eight days it served 3,558 402s and 4 settles, all house tests. The wallet holds exactly 4.0 USDC today (checked on chain). Ledatic is not on x402-list (0 of 1,326).
- **The decision rule** (`docs/plans/2026-10-29-agent-stall.md`, step 7), due 2026-11-28:
  - One or more outside purchases: plan the marketplace.
  - Zero: "the stall stays up as it is, nothing more is built for agents", and "No second attempt without new evidence."
- **The witness signer.** `POST /attest/witness` has been live but dormant since 2026-05-29. It was priced as prepaid packs ($80, $500, $2,000). No key minted to an outsider was found.
- **The beacon.** A signed pulse every 2 seconds, free to read. Its independence is graded D+ because every key and witness is Ledatic's.
- **Rail.** Version 5.6.0, 264/264 tests measured today. The public compile route answers 503 since 2026-10-06.
- **The first ceiling.** Cloudflare's free key-value store (KV) allows 1,000 writes a day and about 624 are already committed. Each paid call writes three times, which leaves roughly 100 to 125 paid calls a day (arithmetic from the code and memory notes, not measured).

## 4. The candidates

Prices are suggestions from the research; you name any number.

| Name | Exact claim | Buyer | Price | Must be built | Verdict after the skeptics |
|---|---|---|---|---|---|
| 1. Hold until 11-28 | No new claim. A purchase returns a signed receipt naming a beacon pulse. | None new | 199 and 1 USDC, unchanged | Nothing | **Survives with changes.** A zero tests only "this corpus at 199 USDC, plus a look-inside whose sample is public". The rule stops building, not research. |
| 2. Digest witness | Ledatic's key signed digest D at server time T | None found | 0.01 to 0.05 USDC | x402 front, POST input, fewer KV writes, a public log | **Dies as a paid service; survives as a free research artifact** |
| 3. Signed offer check | Ledatic saw this 402 offer at this URL and time | Buying agents, monitors | 0.01 to 0.02 | Fetch-and-sign route, abuse guard | **Dies on both lenses** |
| 4. Corpus by the slice | These records match the published corpus hash | None found | 0.01 to 0.05 | Slices, query path, license decision | Not reviewed. 13 dataset listings found, all under $15 a month. |
| 5. Anchor for others' receipts | Ledatic signed this batch root at time T | Other sellers | 0.05 per batch | Candidate 2 first | Not reviewed. The proposal already names a free anchor. |
| 6. Rail compile oracle | This source produced this output hash at commit C | Rail writers; none outside found | 0.01 to 0.02 | Sandbox for untrusted code on the Mini | Not reviewed. No demand evidence. |
| 7. Paid beacon draws | Value derived from a single-operator pulse | None found | 0.0025 | Priced route | Not recommended. drand (a multi-party public beacon) is free. |

**Why candidate 2 died as a product:**
- The eight comparable notaries on x402-list earn $0.05 to $17 a month, and the best is concentrated in three wallets or fewer.
- The "two-sided bracket" does not exist today. No log or later pulse records the receipt, so the upper bound is only Ledatic's own clock.
- The server accepts any pulse the caller supplies, so "fresh pulse" is unchecked.
- A free drand round plus OpenTimestamps gives both bounds with stronger anchors.
- The same service has had no outside buyer under prepaid pricing since May.
- It carries a forever-stable format promise for an upside the research put at 1 to 5 USDC a day.

**Why candidate 3 died:**
- The buyer must fetch the 402 anyway, and reading it is free.
- x402station sells a richer check for $0.001.
- The same single-witness design already exists and calls itself "dormant".
- A seller can identify Ledatic's Worker and serve it a different offer.
- A fetch-any-URL route risks Cloudflare's proxy terms on the account that carries the beacon and Fieldcraft's tunnel.
- The route would settle before fetching, so a failed fetch takes a cent and delivers nothing.

A narrower relative of candidate 3 was proposed: a signed log of offer changes for a fixed list of sellers. It has no demand evidence either.

## 5. One-week experiments for the top two

Both are paper only, 11-15 to 11-22, because the rule allows reading and measuring but not building.

**Hold**
1. Decide Coinstancy today (section 6).
2. Write into the plan, before 11-28, what a zero covers, and whether cents-priced repeat calls count as a "second attempt".
3. Write how a `?ref=coinstancy` sale is labelled in the table.
4. Default to no self-purchase to keep the Bazaar listing. It lapses about 2026-11-28 20:19 UTC.
5. Check daily that `stall_watch` is loaded and the route answers 402.
6. Write one paragraph on refunds, tax and payer screening.

Kill condition: an outside settle before 11-28 ends the hold, and the rule then says plan the marketplace. If you do not amend the rule after a zero, the research wing stays read-and-measure only.

**Digest witness**
1. Read the docs of satledger, AOTrust and ForgeMesh to settle whether any offers a "made after" bound. This is currently unverified.
2. Record the daily x402-list volume and buyer counts of the eight notaries.
3. Write the narrowed claim and the six required changes as a spec. The six are a server-chosen pulse, a real upper bound or none claimed, one KV write per call, a separate key with a rotation procedure, a terms line, and a daily cap.

Kill condition: by 11-22 no notary shows sustained volume from more than a handful of wallets, and no outside party has asked for this unprompted. That condition is already met today. Unless the week changes it, the witness stays a free receipt feature and no x402 front is built.

## 6. Coinstancy

**Verified** (two independent checks today):
- coinstancy.com is on the French regulator's (AMF) blacklist, crypto-assets category, dated 24/03/2026 (https://www.amf-france.org/fr/espace-epargnants/proteger-son-epargne/listes-noires-et-mises-en-garde/crypto-actifs/coinstancycom).
- Its own legal notice says it holds no MiCA authorization, the EU crypto licence.
- The company is real: Blue Shadow Webdev SAS, Tahiti, by its own PDFs. Its core business is custodial stablecoin yield.
- The stall plan's "no web footprint" note is wrong.
- Its terms publish no fee on the free plan.

**Not verified:**
- Whether the 2026-11-06 reply draft was sent.
- The catalog's existence, seller terms and placement prices.
- The reason for the AMF listing.
- The IOSCO entry and the forum report of a 7% loss, both known from search snippets only.
- The registry entry itself.
- Whether the outreach mails came from the real company.

**Risk:** legal exposure is low; reputational exposure is real for a company that sells "check-me". If the listing proceeds, the conditions are no logo, no "partner" wording, removal on request, text exactly as supplied and no paid tier. If the reply was already sent, undoing it means a withdrawal mail, which is your call.

## 7. What could not be found

- Any buyer who chose a seller because it signs receipts or attests.
- Any outside purchase of a dataset near 199 USDC.
- Any request from an agent or builder for a lower time bound.
- Evidence of outside Rail users.
- A per-client share of x402 payments.
- Readable x402scan or Artemis dashboards.
- The "demand note" on disk, which the skeptics looked for, so the ten-sellers-per-buyer figure is unverified.
- Three figures the skeptics could not confirm:
  - The dOrg "confidence" quote.
  - The "29% dead" endpoint figure.
  - The stale-price figure. The source one skeptic read says 57 of 153 listings vanished, including all 20 that advertised $0.01.
- The phrase "no production cases". It was not at the URL the candidates cited, and the GitHub thread was not re-read.
- Proof that categories are empty. "Absent" means not found in the pages read; only 50 of 199 Verification rows were read.