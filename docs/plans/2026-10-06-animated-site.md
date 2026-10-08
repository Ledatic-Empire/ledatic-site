# ledatic.org, the animated site

Plan, 2026-10-06. Follows the review and the cleanup of the same day (PR #37: one front door, three
Explore groups, four retired pages, the reduced-motion hero clock). Nothing here is built yet.

## 0. The rule that decides everything

The site already states its motion grammar in `_shared/tokens.css` and `_shared/site.css`: glow is
earned, elevation is glow, the dot breathes once per real pulse, replay is cyan, stale is burn-in, red
is never decorative, and "nothing glows that hasn't proven itself". So on this site **motion must mean
one of two things: the beacon is alive, or a proof is being checked.** Anything else is decoration, and
decoration is allowed only when it is labeled as such (the entropy page already does this: "the band
behind this text is a pulse-seeded rendering, decoration, not the beacon").

Two tracks, both inside that rule:

- **Track A, the pulse is the choreographer.** The real beacon receipt (every ~2 s, through
  `window.pulseBus` in `_shared/pulse-clock.js`) drives every piece of motion below the fold, the way it
  already drives the hero field. Stop the beacon and the whole page freezes, honestly, as the field does.
- **Track B, the verifier as theatre.** The proof tray's five real steps (FETCH, HASH, KEY, SIG, CHAIN,
  emitted by `runProof` in `_shared/proof-tray.js`) become the site's signature animation. It plays only
  on a real verification and shows the real verdict at each step.

Track C (a raymarched field on every page) is deferred. It has the highest ceiling and the highest GPU and
battery cost, and it strains "one shader you can read". Revisit after A and B ship, heroes only.

## 1. What moves today (inventory, measured 2026-10-06)

| Piece | Where | Driver | Honest? |
|---|---|---|---|
| Plasma field | home hero | pulse receipts, phase clamps at 1, freezes when quiet | yes |
| Pulse clock breath | nav and hero | one-shot class per receipt | yes |
| Reveals, 12 px fade-up | 36 elements on home | CSS `animation-timeline: view()`, visible without support or JS | yes |
| Chain spine draw, ◇ to ◆ fill | section boundaries | CSS `scroll(root)` timeline, pre-filled without support | yes |
| Scroll progress bar | top edge | CSS scroll timeline | yes |
| Fireflies | whole page | 12 motes, infinite CSS loops | decorative, off under reduced motion |
| Card hover | `.card`, `.hp-card` | hover transition | yes |
| Nav underline | primary links | hover, charge fast decay slow | yes |

Below the fold that is the whole list. The brochure feel comes from the fact that nothing there knows
the beacon exists.

## 2. Track A, section by section

Every A piece is a CSS one-shot keyframe toggled by one small sentinel (about 60 lines added to
`_shared/site.js`) that subscribes to `pulseBus` once, sets `data-pulse-tick` on `<html>` for 600 ms per
receipt, and clears it on `onStale`. No element gets its own loop; nothing is free-running.

- **A1, the spine carries the pulse.** `.chain-spine` is already the 1 px hairline down every section.
  Add `.chain-spine::after`: a short bright segment that travels top to bottom in 600 ms on each receipt
  (transform only). The section glyph `.chain-link` fills ◇ to ◆ as the pulse passes it, then relaxes to
  `--ph-700`. Without JS, and without timeline support, the spine is fully drawn and the glyphs are
  pre-filled, exactly as today.
- **A2, the stat tiles charge.** `.stat .value` takes `--e2` for 600 ms on each receipt and decays on the
  phosphor curve. The figures never change (they are deploy-time truth from `_shared/stats.json`); only the
  glow moves. Under reduced motion the tiles show their static end state.
- **A3, the cards keep time.** `.hp-card` and `.card` get the hardware-panel LED back (the top-left dot the
  README describes) and it breathes once per receipt, only while the card is in view (one
  `IntersectionObserver`, so off-screen cards cost nothing).
- **A4, the freeze.** On `onStale`, `<html>` gets `data-beacon="stale"`: the spine's traveling segment
  stops, glyphs hold, tiles lose their glow, the LEDs go ash, and the field freezes as it already does. The
  page visibly stops breathing. On the next real receipt it resumes. This is the piece that makes the
  rest honest.
- **A5, the heading entrance.** The hero title already narrows its variable width on load
  (`hero-wdth`). Section `h2`s get the same 112 to 87.5 `wdth` move on their view timeline, 12 px travel
  kept. Pure CSS.

Pages: home gets A1 to A5. Rail, verify, entropy, replay, changelog, system and the archive get A1 and A4
(they all carry `.chain-spine` sections already) and A2 where they have stat tiles. Manifesto gets A1 only;
it is a reading page.

## 3. Track B, the verifier as theatre

- **B1, the hero's second act.** The page already proves itself on load (`#prove-page`, the tray). Add a
  compact strip under the hero clock that plays the five steps as they really happen, from the `emit`
  stream of `runProof`: FETCH counts the manifest bytes up; HASH rolls sixteen hex digits into place left
  to right as the digest settles; KEY locks the pinned fingerprint; SIG draws a chain link closed; CHAIN
  drops the anchor onto the pulse number, which blooms `--e3` once (`data-verified`, JS-set, already in
  the grammar). About 2.4 s end to end at the real step timing, never faster than the proof. A failed step
  shows the real red at that step and the rest skip, exactly as the tray does. Without JS the strip is
  absent and the tray's static text stands, as today.
- **B2, cards verify themselves.** `.hp-card` and the four scale cards carry a small chip,
  "verified @ p#…", that plays a 600 ms HASH to SIG micro-sequence from the deploy manifest result the page
  already holds (no new fetch) the first time the card enters view. The chip wears the state hue only
  after the real result; before it, it is ◌ and dim.
- **B3, the verify page.** The loader and the three triad buttons get the same strip as B1, driven by
  the same step events. The sabotaged sample in the triad goes red at SIG in front of the visitor (its
  sabotage is one flipped signature character, so the bytes hash clean and the signature collapses);
  that is the best thirty seconds on the site and it should look like it.
- **B4, replay and changelog.** Ledger rows draw their chain links on the view timeline (CSS only), in
  replay cyan, never green: recorded data animating is replay by the grammar.

## 4. The gate: every piece proves itself before it ships

A new `tools/motion_gate.py` (Playwright, run by `deploy.sh` beside the honesty gate) renders home,
rail, verify and entropy at 1440 and 390, four ways each: JS on, JS off, reduce-motion on, reduce-data on.
It fails the deploy on any of:

1. A `.reveal` in view with opacity under 1 after settling (the zero-JS, zero-support render must be
   complete).
2. Any element whose computed `animation-iteration-count` is `infinite` outside the labeled decorative
   layer (`.fireflies`). One-shot or scroll-driven only.
3. Under reduce-motion: any running animation, the hero clock number on more than one line, or any
   `transform` not at its end state.
4. Under reduce-data: any request beyond today's list (no new fetch for motion).
5. `data-state="live"`, `data-verified`, or `--e3` present in authored HTML (the honesty gate's R3,
   repeated here from the rendered side: only the bus or a proof may set them).
6. With the live bus: two receipts observed within 6 s and `data-pulse-tick` toggled twice; then a
   simulated `onStale` and every A piece at its stale state.
7. Any console error.

Performance budget, measured in the same run with 4x CPU throttling: no long task over 50 ms on a receipt,
compositor-only properties for everything except the hex roll (text), and the shared CSS plus JS grows by
at most 12 KB over today's total. No new font, no new shader for A or B.

## 5. Order of work

| Wave | What | Done when |
|---|---|---|
| W0 | The motion gate, run against today's site; baseline screenshots at both widths | **Done 2026-10-06:** `tools/motion_gate.py` (77 checks, all green on the live site), `tools/motion_gate.sh` (quick cut in `deploy.sh` as gate 2c), baseline `tools/motion_baseline.json` (176,348 bytes shared; home carries a 60 ms receipt task at 4x CPU from the hero field, recorded), shots in `docs/plans/shots/2026-10-06-w0/` |
| W1 | Track A on home (A1 to A5), the sentinel, the freeze | **Built and live 2026-10-06** (PR #41, deploy manifest #92): sentinel in `site.js`, per-section spine with the traveling pulse, glyph flash, tile charge, card LEDs, the freeze, h2 width move; gate 20/20 local, full live run in `docs/plans/shots/2026-10-06-w1/`; +7.2 KB. **Open:** the stranger test (Reilly's, twenty seconds, one person who has not seen it). |
| W2 | B1, the hero's second act | **Built and live 2026-10-07** (PR #43, deploy manifest #94): the tray fires `ledatic:proofstep` and `ledatic:proofdone`; a `[data-proof-act]` strip under the hero clock resolves from them at the proof's pace; HASH rolls and settles onto the real digest; ok blooms the clock. Gate R10 (truthful resolution) and R11 (a sabotaged manifest goes red at HASH, the rest skip, no bloom) added; full live run 86/86 in `docs/plans/shots/2026-10-07-w2/`; payload +10.8 KB of 12. **Open:** the stranger test. |
| W3 | B2 and B3 (cards, verify page) | **Built 2026-10-07:** six card chips on home play hash, sig, verified from the held result when they enter view; four strips on the verify page (the loader and the triad) fed by the same events, the triad buttons now control their authored trays. Gate R12 (press all three: /01 and /02 green, /03 red at SIG with CHAIN skipped) and R13 (every chip verified) added; local run 55/55; **live 2026-10-07** (PR #46, deploy manifest #95), full live run 93/93 in `docs/plans/shots/2026-10-07-w3/`; payload +12.2 KB of 12.3 (budget 12 KB = 12,288 B). **Open:** the stranger test. |
| W4 | A1, A2, A4 on the other pages; B4 on replay and changelog | **Built and live 2026-10-07** (PR #48, deploy manifest #96): section spines on rail, oracle, data and receipts (the sentinel, tile charge and card LEDs were already shared, so verify, entropy, life, provenance, plasma and fleet had them since W1); ledger marks on changelog and replay fill replay cyan; replay's deploy rows are a spined ledger that reveals row by row. Full live gate on all nine plan pages: 188 passed, 0 failed, shots in `docs/plans/shots/2026-10-07-w4/`. Payload +12,005 B of 12,288. |
| W5 | Decide Track C for heroes only, or close it | **Recommendation (2026-10-07), decision Reilly's:** close Track C for now. W1 to W4 give every page a living spine and a proof that plays; a raymarched field per page would add GPU and battery cost on phones and strain "one shader you can read" for a gain the stranger test has not yet asked for. Revisit only if the stranger test on W1 to W4 says the inner pages still read as still. **Done 2026-10-08:** the tray, chip and clock blooms moved onto a pseudo-element whose opacity animates (the box-shadow never repaints); the tray's bloom trigger now flushes the charge before the timed release, so the bloom reaches full and decays over 1.6 s (it had been reversing at about a fifth). Long tasks in the 1.8 s after HASH at 4x CPU: 22 before, 5 to 8 after. Track C stays closed unless the stranger test reopens it. |

Each wave is one PR, deployed through `deploy.sh` (signed manifest, byte-diff), with a before and after
screenshot pair at 1440 and 390 committed beside this plan.

**The stranger test, per wave:** one person who has not seen the site is shown the page for twenty
seconds and asked what the motion means. If the answer is "it's alive" or "it's checking something", the
wave passes. If the answer is "it looks cool", the wave fails and is cut back until the meaning reads.

## 6. What we will not do

- No free-running loops anywhere outside the labeled fireflies.
- No parallax on copy, no scroll hijacking, no loading screen, no autoplay video.
- No animation library, no framework, no build step. The stack statement stands.
- No motion that could be read as a verdict (red, green, a glow) unless a check set it.
- No faster than the truth: B1 plays at the proof's real timing, never a canned 1.5 s.

## 7. Open before W1

- The LED corner chrome: the README describes it; the 2040 rebuild dropped it. Confirm it comes back for
  A3 or A3 uses the card border instead.
- Hex roll in B1: traced at 4x CPU on 2026-10-07, the roll is not the cost (21 long tasks with it removed
  against 22 with it). The pre-existing 1.6 s `--e3` box-shadow bloom on the tray is the paint-heavy piece
  (14 against 22 with it removed). W5 candidate: move the grammar's bloom onto a pseudo-element whose
  opacity animates, as A2 does for the tiles. Long-task count during the proof rose, the worst stayed at
  61 ms against the 70 ms budget.
- The em-dash pass across public copy is a separate, copy-only PR and is not part of this plan.
