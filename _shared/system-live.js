// system-live.js — wires /system to live data.
//
// Each panel is fed by one or more JSON GETs.  All reads are best-effort:
// a failed read flips the panel to "stale" and says so in its age line —
// frozen numbers are never left posing as current.  Cards are labelled
// "live" only when the relevant fetch returns fresh data within the
// polling window.  Polling pauses while the tab is hidden and backs off
// when the beacon stops advancing.

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

  const STALE_MSG = "stale — no response";

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

  // Monotonic pulse guard: a slow, overlapping response must never
  // overwrite a newer pulse with an older one.
  let lastPulseId = -1;
  let pulseUnchanged = 0;
  let pulseDown = false;

  async function tickPulse() {
    const d = await fetchJson("/entropy/pulse");
    if (!d) {
      pulseDown = true;
      mark("panel-pulse", "stale");
      set("pulse.age", STALE_MSG);
      return;
    }
    pulseDown = false;
    if (typeof d.pulse_id === "number") {
      if (d.pulse_id < lastPulseId) return; // late out-of-order response
      pulseUnchanged = d.pulse_id === lastPulseId ? pulseUnchanged + 1 : 0;
      lastPulseId = d.pulse_id;
    }
    set("pulse.id", d.pulse_id);
    set("pulse.hex", d.value_hex);
    set("pulse.ts", d.timestamp_utc || "");
    set("pulse.age", d.unix_timestamp ? ageString(d.unix_timestamp) : "?");
    // A beacon that has stopped advancing is not live, even if it answers.
    mark("panel-pulse", pulseUnchanged < 4 ? "live" : "stale");
  }

  async function tickWitness() {
    const d = await fetchJson("/witness/fleet0/latest");
    if (!d) {
      mark("panel-witness", "stale");
      set("witness.ts", STALE_MSG);
      return;
    }
    set("witness.pulse", d.pulse_id);
    set("witness.chain",
        d.chain_verified === true  ? "true"
      : d.chain_verified === false ? "false"
      : "unverified");
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
    if (!d) {
      mark("panel-fleet", "stale");
      set("fleet.age", STALE_MSG);
      return;
    }
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

  // Cadence split: pulse + witness change every ~2s and poll fast.  The
  // fleet snapshot updates about once a minute; build/selfhost artifacts
  // change daily (and the server caches them for 5 minutes anyway), so
  // hammering them on the fast clock buys nothing.
  const FAST_MS  = 2500;
  const SLOW_MS  = 10000;   // backoff while the beacon is stalled/unreachable
  const FLEET_MS = 30000;
  const DAILY_MS = 300000;

  let inFlight = false;
  let timer = null;
  let lastFleet = 0;
  let lastDaily = 0;

  async function refresh(force) {
    if (inFlight) return;
    inFlight = true;
    try {
      const now = Date.now();
      const jobs = [tickPulse(), tickWitness()];
      if (force || now - lastFleet >= FLEET_MS) { lastFleet = now; jobs.push(tickFleet()); }
      if (force || now - lastDaily >= DAILY_MS) { lastDaily = now; jobs.push(tickBuild(), tickSelfhost()); }
      await Promise.all(jobs);
    } finally {
      inFlight = false;
    }
  }

  function schedule() {
    if (document.hidden) return;
    clearTimeout(timer);
    const delay = (pulseDown || pulseUnchanged >= 4) ? SLOW_MS : FAST_MS;
    timer = setTimeout(async () => { await refresh(false); schedule(); }, delay);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearTimeout(timer); return; }
    refresh(true).then(schedule);
  });

  refresh(true).then(schedule);
})();
