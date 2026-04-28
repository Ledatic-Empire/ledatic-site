// system-live.js — wires /system to live data.
//
// Each panel is fed by one or more JSON GETs.  All reads are best-effort:
// failures leave the panel in its "stale" state with the loaded values
// untouched.  Cards labelled "live" only when the relevant fetch returns
// fresh data within the polling window.

(() => {
  const $ = (sel) => document.querySelectorAll(`[data-sys="${sel}"]`);
  const set = (sel, value) => $(sel).forEach(el => { el.textContent = value; });
  const setHTML = (sel, html) => $(sel).forEach(el => { el.innerHTML = html; });
  const mark = (panelId, cls) => {
    const el = document.getElementById(panelId);
    if (!el) return;
    el.classList.remove("live", "stale");
    el.classList.add(cls);
  };

  async function fetchJson(url) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; }
  }

  function ageString(unix_ts) {
    const now = Math.floor(Date.now() / 1000);
    const dt = now - unix_ts;
    if (dt < 0)   return "future?";
    if (dt < 4)   return `${dt}s — fresh`;
    if (dt < 60)  return `${dt}s`;
    if (dt < 3600)return `${Math.floor(dt/60)}m ${dt%60}s`;
    if (dt < 86400)return `${Math.floor(dt/3600)}h ${Math.floor((dt%3600)/60)}m`;
    return `${Math.floor(dt/86400)}d`;
  }

  async function tickPulse() {
    const d = await fetchJson("/entropy/pulse");
    if (!d) { mark("panel-pulse", "stale"); return; }
    set("pulse.id", d.pulse_id);
    set("pulse.hex", d.value_hex);
    set("pulse.ts", d.timestamp_utc || "");
    set("pulse.age", d.unix_timestamp ? ageString(d.unix_timestamp) : "?");
    mark("panel-pulse", "live");
  }

  async function tickWitness() {
    const d = await fetchJson("/witness/fleet0/latest");
    if (!d) { mark("panel-witness", "stale"); return; }
    set("witness.pulse", d.pulse_id);
    set("witness.chain", String(d.chain_verified));
    set("witness.pkfp", d.pk_fp || "");
    set("witness.ts", d.witnessed_at ? ageString(d.witnessed_at) : "");
    mark("panel-witness", d.chain_verified === true ? "live" : "stale");
  }

  async function loadAttested(kind, panelId) {
    // /<kind>/latest → tells us which short SHA is current.  Then pull
    // the per-SHA result.json + attestation.json for the actual numbers.
    const ptr = await fetchJson(`/${kind}/latest/index.json`);
    if (!ptr || !ptr.short) { mark(panelId, "stale"); return null; }
    const result = await fetchJson(`/${kind}/${ptr.short}/result.json`);
    if (!result) { mark(panelId, "stale"); return null; }
    return { ptr, result };
  }

  async function tickBuild() {
    const got = await loadAttested("builds", "panel-build");
    if (!got) return;
    const r = got.result;
    set("build.short", r.short || "");
    set("build.pass", `${r.pass}/${r.total}`);
    set("build.status", r.status || "");
    set("build.pulses", `${r.pulse_start} → ${r.pulse_end}`);
    set("build.logsha", (r.log_sha256 || "").slice(0, 32) + "…");
    setHTML("build.links",
      `<a href="/builds/${r.short}/result.json">result.json</a>` +
      ` <span class="sep">·</span> ` +
      `<a href="/builds/${r.short}/result.json.attestation.json">attestation</a>` +
      ` <span class="sep">·</span> ` +
      `<a href="/attest/verify.sh">verify.sh</a>`);
    mark("panel-build", r.status === "ok" ? "live" : "stale");
  }

  async function tickSelfhost() {
    const got = await loadAttested("selfhost", "panel-selfhost");
    if (!got) return;
    const r = got.result;
    set("self.short", r.short || "");
    set("self.fp", String(r.fixed_point));
    set("self.seed", String(r.seed_match));
    set("self.seedsha", (r.seed_sha256 || "").slice(0, 32) + "…");
    set("self.pulses", `${r.pulse_start} → ${r.pulse_end}`);
    setHTML("self.links",
      `<a href="/selfhost/${r.short}/result.json">result.json</a>` +
      ` <span class="sep">·</span> ` +
      `<a href="/selfhost/${r.short}/result.json.attestation.json">attestation</a>` +
      ` <span class="sep">·</span> ` +
      `<a href="/attest/verify.sh">verify.sh</a>`);
    mark("panel-selfhost", r.fixed_point && r.seed_match ? "live" : "stale");
  }

  async function tickFleet() {
    const d = await fetchJson("/fleet/status.json");
    if (!d) { mark("panel-fleet", "stale"); return; }
    set("fleet.pulse", d.pulse_id);
    const up = (d.nodes || []).filter(n => n.alive).length;
    const total = (d.nodes || []).length;
    const breakdown = (d.nodes || [])
      .map(n => `${n.name}${n.alive ? ":✓" : ":×"}`).join(" ");
    set("fleet.nodes", `${up}/${total}  —  ${breakdown}`);
    set("fleet.age", d.asof_unix ? ageString(d.asof_unix) : "?");
    set("fleet.pkfp", (d.witness && d.witness.pk_fp) || "(unsigned)");
    const fresh = d.asof_unix && (Math.floor(Date.now()/1000) - d.asof_unix) < 180;
    const allUp = up === total && total > 0;
    mark("panel-fleet", fresh && allUp ? "live" : "stale");
  }

  async function refreshAll() {
    await Promise.all([tickPulse(), tickWitness(), tickFleet(), tickBuild(), tickSelfhost()]);
  }

  refreshAll();
  // Pulse + witness change every ~2s; build/selfhost change daily.  Poll
  // pulse/witness on a 2.5s clock; let the others ride along (cheap, all
  // 200-byte JSONs).
  setInterval(refreshAll, 2500);
})();
