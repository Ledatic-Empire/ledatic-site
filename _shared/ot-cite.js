// ot-cite.js — populate the citation block on /ot.
//
// Polls /entropy/pulse and /entropy/frame/ot256/latest.attestation.json,
// fills the [data-sys=...] placeholders.  The pulse refreshes every 5 s
// while the tab is visible.  "accessed" only advances when the beacon
// actually answered — a dead endpoint must not look alive.  If the frame
// signer has stopped re-signing (attestation older than FRESH_S), the
// citation says "signing paused" instead of dressing an old frame up as
// current, and the frame poll backs off to once a minute.

(() => {
  const set = (sel, value) => {
    document.querySelectorAll(`[data-sys="${sel}"]`).forEach(el => {
      el.textContent = value;
    });
  };
  async function fetchJson(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  const FRESH_S = 600; // re-sign cadence is ~30 s when the signer is live
  let tickN = 0;
  let frameStale = false;
  let inFlight = false;
  let timer = null;

  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
      tickN++;
      // Once the frame attestation is known stale, recheck it once a
      // minute instead of every tick.
      const wantFrame = tickN === 1 || !frameStale || tickN % 12 === 1;
      const [pulse, frame] = await Promise.all([
        fetchJson("/entropy/pulse"),
        wantFrame
          ? fetchJson("/entropy/frame/ot256/latest.attestation.json")
          : Promise.resolve(null),
      ]);
      if (pulse) {
        set("pulse.id", pulse.pulse_id);
        // "accessed" moves only when the beacon answered.
        set("now", new Date().toISOString().slice(0, 19) + "Z");
      }
      if (frame) {
        const fr = frame.frame || {};
        const w = frame.witness || {};
        const age = w.witnessed_at
          ? Math.floor(Date.now() / 1000) - w.witnessed_at
          : null;
        frameStale = age === null || age > FRESH_S;
        if (fr.header && fr.header.frame_id !== undefined) {
          set("frame.id", frameStale
            ? `${fr.header.frame_id} (signing paused)`
            : String(fr.header.frame_id));
        }
        if (fr.sha256) set("frame.sha", fr.sha256.slice(0, 16) + "…");
        if (w.pk_fp) set("witness.pkfp", w.pk_fp);
      }
    } finally {
      inFlight = false;
    }
  }

  function schedule() {
    if (document.hidden) return;
    clearTimeout(timer);
    timer = setTimeout(async () => { await tick(); schedule(); }, 5000);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearTimeout(timer); return; }
    tick().then(schedule);
  });

  tick().then(schedule);
})();
