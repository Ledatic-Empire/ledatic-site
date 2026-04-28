// ot-cite.js — populate the live citation block on /ot.
//
// Polls /entropy/pulse and /entropy/frame/latest.attestation.json,
// fills the [data-sys=...] placeholders.  Refreshes every 5 s.

(() => {
  const set = (sel, value) => {
    document.querySelectorAll(`[data-sys="${sel}"]`).forEach(el => {
      el.textContent = value;
    });
  };
  async function fetchJson(url) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; }
  }
  async function tick() {
    const [pulse, frame] = await Promise.all([
      fetchJson("/entropy/pulse"),
      fetchJson("/entropy/frame/latest.attestation.json"),
    ]);
    if (pulse) set("pulse.id", pulse.pulse_id);
    if (frame) {
      const fr = frame.frame || {};
      const w = frame.witness || {};
      if (fr.header && fr.header.frame_id !== undefined) {
        set("frame.id", fr.header.frame_id);
      }
      if (fr.sha256) set("frame.sha", fr.sha256.slice(0, 16) + "…");
      if (w.pk_fp) set("witness.pkfp", w.pk_fp);
    }
    set("now", new Date().toISOString().slice(0, 19) + "Z");
  }
  tick();
  setInterval(tick, 5000);
})();
