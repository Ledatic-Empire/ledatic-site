/* ============================================================
   Ledatic 2040 — pulse-clock.js (ES module, zero deps)

   §5.3 pulse-bus     ONE scheduler for every liveness fetch on a page.
                      Max one network request per ~2 s cadence tick,
                      If-None-Match / 304-friendly, paused while
                      document.hidden, 30 s interval under Save-Data.
                      Sentinels, clock, and feeds subscribe; nothing
                      polls on its own.

   §5.2 <pulse-clock> Confirmed-only clock. It NEVER extrapolates:
                      it shows the last received pulse, and when
                      confirmation ages past `data-fresh-pulses`
                      (default 5) cadences the numeral freezes, the
                      dot hollows, and the clock reads stale — the
                      clock obeys the liveness grammar (§4).

   §5.2 <time-pulse>  Pulse-first timestamps. Ages denominated in
                      pulses; wall-clock demoted to an italic
                      translation (§2).

   Loaded by site.js (injected <script type=module>) or directly by
   pages. Idempotent: the module graph dedupes by URL and the custom
   element definitions are guarded.
   ============================================================ */

export const CADENCE_MS = 2000;          // beacon publishes every ~2 s
const SAVE_DATA_MS = 30000;              // §3.5 — Save-Data is an equal citizen
const FETCH_TIMEOUT_MS = 3500;           // abort hung requests: silence ≠ success
const DEFAULT_ENDPOINT = '/entropy/pulse';
const THIN = ' ';                   // narrow no-break space — §2 digit grouping

const saveData =
  (typeof navigator !== 'undefined' && navigator.connection && navigator.connection.saveData === true) ||
  (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-data: reduce)').matches);

const prm = typeof matchMedia === 'function'
  ? matchMedia('(prefers-reduced-motion: reduce)')
  : { matches: false, addEventListener: null };

/* ── formatters (exported — site.js and page modules reuse them) ───────── */

export function fmtPulse(n) {
  const s = String(Math.trunc(Math.abs(Number(n) || 0)));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += THIN;
    out += s[i];
  }
  return out;
}

export function fmtDur(pulses) {
  const s = pulses * (CADENCE_MS / 1000);
  if (s < 90) return `≈ ${Math.round(s)} s`;
  if (s < 5400) return `≈ ${Math.round(s / 60)} min`;
  if (s < 172800) return `≈ ${(s / 3600).toFixed(1)} h`;
  return `≈ ${(s / 86400).toFixed(1)} d`;
}

/* thin-space grouping every 8 hex chars — §2 hash-reading law */
export function groupHex(hex, every = 8) {
  return String(hex || '').replace(new RegExp(`(.{${every}})(?=.)`, 'g'), `$1${THIN}`);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/* visually hidden via JS style props (no CSS file dependency, CSP-safe) */
function srOnly(e) {
  e.style.position = 'absolute';
  e.style.width = '1px';
  e.style.height = '1px';
  e.style.overflow = 'hidden';
  e.style.clipPath = 'inset(50%)';
  e.style.whiteSpace = 'nowrap';
  return e;
}

/* ── §5.3 the pulse-bus ────────────────────────────────────────────────── */

class PulseBus {
  constructor() {
    this.url = DEFAULT_ENDPOINT;
    this.freshPulses = 5;       // page may tighten via <pulse-clock data-fresh-pulses>
    this.latest = null;         // last CONFIRMED pulse payload — never synthesized
    this.receivedAt = 0;        // Date.now() at last confirmation
    this.stale = false;
    this._lastId = -Infinity;   // monotonic guard: ids must strictly increase
    this._etag = null;
    this._subs = new Set();
    this._staleSubs = new Set();
    this._jobs = [];
    this._timer = 0;
    this._busy = false;
    this._started = false;
  }

  get cadence() { return saveData ? SAVE_DATA_MS : CADENCE_MS; }

  /* fn(pulse) fires only on real receipt — confirmed-only, no extrapolation. */
  subscribe(fn) {
    this._subs.add(fn);
    if (this.latest && !this.stale) { try { fn(this.latest); } catch (e) { /* subscriber's problem */ } }
    this._start();
    return () => this._subs.delete(fn);
  }

  /* fn(agePulses) fires once each time confirmation ages past the budget. */
  onStale(fn) {
    this._staleSubs.add(fn);
    this._start();
    return () => this._staleSubs.delete(fn);
  }

  /* Register a side fetch (fleet status, frame planes). Jobs run inside
     cadence ticks — never faster than the pulse cadence (§7) — and a due
     job takes that tick's single request slot instead of the pulse fetch,
     so the page stays at max one network request per tick. */
  schedule(periodMs, run) {
    const job = { period: Math.max(periodMs || 0, CADENCE_MS), due: 0, run };
    this._jobs.push(job);
    this._start();
    return () => { this._jobs = this._jobs.filter((j) => j !== job); };
  }

  _start() {
    if (this._started) return;
    this._started = true;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearTimeout(this._timer);  // §5.3 hidden = paused
      else this._tick();                               // immediate refresh on return
    });
    this._tick();
  }

  _arm() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._tick(), this.cadence);
  }

  async _tick() {
    if (document.hidden) return;              // resumed by visibilitychange
    if (this._busy) { this._arm(); return; }  // never overlap requests
    this._busy = true;
    try {
      const job = this._dueJob();
      if (job) {
        job.due = Date.now() + job.period;
        await job.run();
      } else if (this._subs.size || this._staleSubs.size) {
        await this._fetchPulse();             // no consumers → no request
      }
    } catch (e) { /* a failed tick is just a missed confirmation */ }
    this._busy = false;
    this._checkStale();
    this._arm();
  }

  _dueJob() {
    const now = Date.now();
    let pick = null;
    for (const j of this._jobs) {
      if (j.due <= now && (!pick || j.due < pick.due)) pick = j;
    }
    return pick;
  }

  async _fetchPulse() {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const headers = {};
      if (this._etag) headers['If-None-Match'] = this._etag;
      const res = await fetch(this.url, { signal: ctrl.signal, cache: 'no-store', headers });
      if (res.status === 304 || !res.ok) return;  // 304 = no NEW pulse ≠ a confirmation
      this._etag = res.headers.get('etag');
      const p = await res.json();
      if (!p || typeof p.pulse_id !== 'number') return;
      if (p.pulse_id <= this._lastId) return;     // monotonic guard: a cache flap is not time
      this._lastId = p.pulse_id;
      this.latest = p;
      this.receivedAt = Date.now();
      this.stale = false;
      for (const fn of this._subs) { try { fn(p); } catch (e) { /* isolate subscribers */ } }
      // Document-level receipt event — consumers that booted before this
      // module (field.js loader, classic scripts) ride the same receipt.
      try {
        document.dispatchEvent(new CustomEvent('ledatic:pulse', { detail: p }));
      } catch (e) { /* best-effort broadcast */ }
    } catch (e) {
      /* timeout / network failure — no confirmation, staleness does the talking */
    } finally {
      clearTimeout(t);
    }
  }

  _checkStale() {
    if (this.stale || !this.receivedAt) return;
    // Freshness budget in real pulses. Under Save-Data the poll itself runs
    // every 30 s, so the budget stretches by one poll interval — the bus
    // claims stale only when the BEACON is stale, not when the data diet is.
    const budget = this.freshPulses * CADENCE_MS + (saveData ? SAVE_DATA_MS : 0);
    if (Date.now() - this.receivedAt > budget) {
      this.stale = true;
      const age = Math.round((Date.now() - this.receivedAt) / CADENCE_MS);
      for (const fn of this._staleSubs) { try { fn(age); } catch (e) { /* isolate */ } }
    }
  }
}

export const pulseBus = new PulseBus();

/* ── §5.2 <pulse-clock> — confirmed-only display ───────────────────────── */

class PulseClock extends HTMLElement {
  connectedCallback() {
    if (this._wired) return;
    this._wired = true;

    if (this.dataset.endpoint) pulseBus.url = this.dataset.endpoint;
    const fresh = parseInt(this.dataset.freshPulses || '', 10);
    const freshPulses = Number.isFinite(fresh) && fresh > 0 ? fresh : 5;
    pulseBus.freshPulses = Math.min(pulseBus.freshPulses, freshPulses);
    // Same Save-Data stretch as the bus (see _checkStale).
    this._freshMs = freshPulses * CADENCE_MS + (saveData ? SAVE_DATA_MS : 0);

    // Light DOM so sitewide [data-state] tokens style it. Default state is
    // unknown — hollow, unlit, claiming nothing — until a check passes (§4).
    // Glyph channel contract (site.css §4 block): CSS owns the glyph via
    // [data-state]::before (◌/●/✗); JS owns word + pulse anchor as text.
    this.textContent = '';
    this._num = el('span', 'pc-num', '⌁ p#—');
    this._word = el('span', 'pc-word', '');  // reduced-motion: literal state word (§3.4)
    this._sr = srOnly(el('span', 'pc-sr', ''));
    this._sr.setAttribute('aria-live', 'polite');  // state transitions only, never per tick
    this.append(this._num, this._word, this._sr);
    this.dataset.state = 'unknown';
    this.setAttribute('role', 'button');
    this.setAttribute('aria-expanded', 'false');
    this.setAttribute('aria-label', 'pulse clock, checking');
    if (!this.hasAttribute('tabindex')) this.setAttribute('tabindex', '0');
    this._setWord('checking…');

    this._unsub = pulseBus.subscribe((p) => this._confirm(p));
    this._onVis = () => {
      if (document.hidden) clearTimeout(this._demote);          // hidden = paused
      else if (this.dataset.state === 'live') this._armDemote(); // re-arm on return
    };
    document.addEventListener('visibilitychange', this._onVis);
    if (prm.addEventListener) {
      this._onPrm = () => this._setWord(this._lastWord || '');
      prm.addEventListener('change', this._onPrm);
    }
    this.addEventListener('click', () => this._toggleTray());
    this.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._toggleTray(); }
    });
  }

  disconnectedCallback() {
    if (this._unsub) this._unsub();
    clearTimeout(this._demote);
    document.removeEventListener('visibilitychange', this._onVis);
    if (this._onEsc) document.removeEventListener('keydown', this._onEsc);
    if (prm.removeEventListener && this._onPrm) prm.removeEventListener('change', this._onPrm);
  }

  /* Under reduced motion the breathing dot becomes static and the literal
     state word appears beside it (§3.4). Word otherwise stays empty. */
  _setWord(word) {
    this._lastWord = word;
    this._word.textContent = prm.matches && word ? ` ${word}` : '';
  }

  _confirm(p) {                              // called only on real receipt
    this._last = p;
    this._num.textContent = `⌁ p#${fmtPulse(p.pulse_id)}`;
    if (this.dataset.state !== 'live') {
      this.dataset.state = 'live';           // CSS ::before switches ◌ → ●
      this._sr.textContent = 'beacon live';
      this.setAttribute('aria-label', 'pulse clock, live');
      this._setWord('live');
    }
    // One opacity breath per RECEIVED pulse — event-driven, never free-running
    // (§3). site.css owns the one-shot keyframes ([data-state="live"].breathe)
    // and disables them under prefers-reduced-motion; the reflow restarts it.
    this.classList.remove('breathe');
    void this.offsetWidth;
    this.classList.add('breathe');
    this._armDemote();
    if (this._trayOpen) this._renderTray();
  }

  _armDemote() {
    clearTimeout(this._demote);
    this._demote = setTimeout(() => {
      // No confirmation inside the freshness budget: the numeral freezes
      // (it was never extrapolated), the dot hollows (CSS ::before ● → ◌),
      // the clock goes stale.
      this.dataset.state = 'stale';
      this.classList.remove('breathe');
      this._sr.textContent = this._last
        ? `beacon stale, last confirmed pulse ${fmtPulse(this._last.pulse_id)}`
        : 'beacon stale';
      this.setAttribute('aria-label', 'pulse clock, stale');
      this._setWord('stale');
    }, this._freshMs);
  }

  /* ── click → mini-tray: hash, prev link, wall-clock italic, walk 50 ──── */

  _toggleTray() {
    if (!this._tray) {
      this._tray = el('div', 'pc-tray');
      this._tray.hidden = true;
      this._tray.setAttribute('role', 'log');
      this._onEsc = (e) => { if (e.key === 'Escape' && this._trayOpen) this._toggleTray(); };
      this.after(this._tray);
    }
    this._trayOpen = this._tray.hidden;
    this._tray.hidden = !this._trayOpen;
    this.setAttribute('aria-expanded', String(this._trayOpen));
    if (this._trayOpen) {
      // Anchor under the clock (tray is a sibling, so position at open time).
      const r = this.getBoundingClientRect();
      this._tray.style.position = 'fixed';
      this._tray.style.top = `${Math.round(r.bottom + 8)}px`;
      this._tray.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
      document.addEventListener('keydown', this._onEsc);
      this._renderTray();
    } else {
      document.removeEventListener('keydown', this._onEsc);
    }
  }

  _renderTray() {
    const p = this._last;
    const t = this._tray;
    t.textContent = '';
    if (!p) {
      t.append(el('div', 'pc-row', 'no confirmed pulse yet — checking…'));
      return;
    }
    t.append(el('div', 'pc-row', `pulse p#${fmtPulse(p.pulse_id)}`));
    t.append(el('div', 'pc-row', `hash  ${groupHex(p.value_hex)}`));
    t.append(el('div', 'pc-row',
      `prev  ${p.prev_value_hex ? groupHex(p.prev_value_hex) : '— not published'}`));
    const wallRow = el('div', 'pc-row');
    wallRow.append(el('i', 'tp-wall',
      `≈ ${String(p.timestamp_utc || '').replace('T', ' ').replace('Z', ' UTC')}`));
    t.append(wallRow);
    const btn = el('button', 'pc-walk', 'walk 50 ▸');
    btn.type = 'button';
    btn.addEventListener('click', (e) => { e.stopPropagation(); this._walk50(btn); });
    t.append(btn);
  }

  async _walk50(btn) {
    btn.disabled = true;
    btn.textContent = 'walking…';
    let out = this._tray.querySelector('.pc-walk-out');
    if (!out) { out = el('div', 'pc-walk-out'); btn.after(out); }
    let log = null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(`${pulseBus.url}/log`, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(t);
      if (res.ok) log = await res.json();
    } catch (e) { /* fall through to the honest empty state */ }
    if (!Array.isArray(log) || log.length < 2) {
      out.textContent = 'log unavailable — nothing checked, nothing claimed';
      btn.textContent = 'walk 50 ▸';
      btn.disabled = false;
      return;
    }
    // Linkage walk over the published log: each entry's prev_value_hex must
    // equal the previous entry's value_hex. This verifies the chain's LINKS
    // as published — it does not recompute the hashes (that lives on /verify),
    // and the copy below says exactly that. A broken link names its pulse.
    let ok = 0;
    let broken = null;
    for (let i = 1; i < log.length; i++) {
      if (log[i].prev_value_hex && log[i].prev_value_hex === log[i - 1].value_hex) ok++;
      else { broken = log[i].pulse_id; break; }
    }
    delete out.dataset.state;
    if (broken === null) {
      out.textContent =
        `✓ ${ok}/${log.length - 1} links intact · ` +
        `p#${fmtPulse(log[0].pulse_id)} → p#${fmtPulse(log[log.length - 1].pulse_id)} · ` +
        'linkage of the published log — hash recompute lives on /verify';
    } else {
      out.dataset.state = 'fail';
      out.textContent =
        `✗ link broken at p#${fmtPulse(broken)} — ${ok} verified before the break`;
    }
    btn.textContent = 'walk again ▸';
    btn.disabled = false;
  }
}

/* ── §5.2 <time-pulse> — pulse-first timestamps ────────────────────────────
   <time-pulse data-pulse="1191882" data-iso="2026-05-12T18:00:00Z"></time-pulse>
     → @ p#1 191 882  ·  italic wall-clock translation, title on hover.
   <time-pulse data-pulse="1191882" data-mode="age"></time-pulse>
     → +4 312 pulses · ≈ 2.4 h   (counts up — the one live element a stale
       panel keeps, §4). Renders nothing until the bus has a confirmed pulse:
       authored fallback content stays until we can honestly compute.       */

class TimePulse extends HTMLElement {
  connectedCallback() {
    if (this._wired) return;
    this._wired = true;
    this._anchor = parseInt(this.dataset.pulse || '', 10);
    this._iso = this.dataset.iso || '';
    this._mode = this.dataset.mode || 'anchor';
    if (!Number.isFinite(this._anchor)) return;  // assert nothing; fallback text stays
    if (this._mode === 'age') {
      this._unsub = pulseBus.subscribe(() => this._render());
      // Display-only arithmetic between confirmations — no network involved.
      // Skips ticks while hidden (§5.3 pause discipline, applied to timers).
      this._timer = setInterval(() => { if (!document.hidden) this._render(); }, CADENCE_MS);
    } else {
      this._render();
    }
  }

  disconnectedCallback() {
    if (this._unsub) this._unsub();
    clearInterval(this._timer);
  }

  _render() {
    if (this._mode === 'age') {
      if (!pulseBus.latest) return;  // confirmed-only: no clock, no age claim
      // Confirmed pulse difference, plus elapsed-since-receipt denominated in
      // cadence units — so the age keeps counting up even when the beacon has
      // gone stale (the page itself is awake; the anchor is what froze).
      const drift = Math.max(0, Math.floor((Date.now() - pulseBus.receivedAt) / CADENCE_MS));
      const age = (pulseBus.latest.pulse_id - this._anchor) + drift;
      if (age < 0) return;
      this.textContent = `+${fmtPulse(age)} pulses`;
      this.append(el('i', 'tp-wall', ` · ${fmtDur(age)}`));
      this.setAttribute('aria-label', `${age} pulses ago, ${fmtDur(age).replace('≈', 'about')}`);
    } else {
      const wall = this._iso ? new Date(this._iso) : null;
      const hasWall = wall && !isNaN(wall.getTime());
      this.textContent = `@ p#${fmtPulse(this._anchor)}`;
      if (hasWall) {
        this.append(el('i', 'tp-wall', ` · ${wall.toISOString().slice(0, 10)}`));
        this.title = wall.toUTCString();
      }
      this.setAttribute('aria-label',
        `pulse ${this._anchor}` + (hasWall ? `, ${wall.toUTCString()}` : ''));
    }
  }
}

if (!customElements.get('pulse-clock')) customElements.define('pulse-clock', PulseClock);
if (!customElements.get('time-pulse')) customElements.define('time-pulse', TimePulse);

/* Tray + translation-voice styles via a constructable stylesheet — CSP-safe
   (no inline <style>), token-driven, and droppable the day site.css adopts
   these classes. Unsupported browsers get a functional unstyled tray. */
try {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    pulse-clock { cursor: pointer; user-select: none; }
    .pc-tray {
      z-index: 80;
      max-width: min(92vw, 52ch);
      padding: var(--sp-4, 1rem);
      background: var(--ink-3, #16201a);
      box-shadow: var(--e1, inset 0 0 0 1px rgba(120,160,130,0.35));
      border-radius: var(--r-0, 0);
      font-size: var(--t-data, 0.8125rem);
      line-height: 1.8;
      color: var(--tx-lo, #a7b5ab);
      text-align: left;
    }
    .pc-tray .pc-row { margin: 0 0 0.25em; overflow-wrap: anywhere; }
    .pc-tray .pc-walk {
      margin-top: 0.5em;
      padding: 0.2em 0.8em;
      font: inherit;
      color: inherit;
      background: transparent;
      border: 1px solid var(--line, rgba(120,160,130,0.35));
      border-radius: var(--r-1, 2px);
      cursor: pointer;
    }
    .pc-tray .pc-walk-out { margin-top: 0.5em; overflow-wrap: anywhere; }
    .tp-wall { font-style: italic; color: var(--tx-dim, #79857d); }
  `);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
} catch (e) { /* constructable stylesheets unsupported — tray works unstyled */ }

/* Handshake for classic-script consumers (site.js) and the field loader
   (field.js reads window.pulseBus). */
window.pulseBus = window.pulseBus || pulseBus;
window.LedaticPulse = window.LedaticPulse || { bus: pulseBus, CADENCE_MS, fmtPulse, fmtDur, groupHex };
window.dispatchEvent(new CustomEvent('ledatic:pulsebus', { detail: window.LedaticPulse }));
