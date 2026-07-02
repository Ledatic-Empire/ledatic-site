/* ============================================================
   Ledatic 2040 — shared runtime (classic script, zero deps)

   What lives here:
   - boot of the pulse module (_shared/pulse-clock.js — ES module:
     pulse-bus §5.3 + <pulse-clock>/<time-pulse> §5.2)
   - legacy live hooks ([data-live="entropy-pulse"], #pulse-feed)
     rewired to ride the shared bus: one scheduler, abort timeouts,
     monotonic guard, honest stale
   - attested MHD frame streamer (ETag/304, cadence-aligned,
     visibility-paused) + procedural fallback renderer (createScene)
   - field-shader delegation: canvas[data-field] boots through
     _shared/field.js (§5.5)
   - nav scrolled-state, scroll progress

   What died here (spec §9 cut list):
   - IntersectionObserver .reveal JS  → CSS scroll-driven timelines
   - count-up counters                → a counting-up stat is a tiny lie
   - card tilt + pointer shader input → visitor input must not perturb
     a thing we call pulse-anchored

   Progressive enhancement: with zero JS every page is still a good
   site; everything below only adds confirmed-data behavior on top.
   ============================================================ */

(() => {
  'use strict';

  // Captured synchronously — module/loader URLs resolve relative to this
  // script's own URL, so pages served at any route path keep working.
  const SCRIPT_URL =
    (document.currentScript && document.currentScript.src) || location.href;

  const CADENCE_MS = 2000;   // beacon cadence ~2 s (§5.3) — floor for any poll

  const saveData =
    (navigator.connection && navigator.connection.saveData === true) ||
    (window.matchMedia && matchMedia('(prefers-reduced-data: reduce)').matches);

  const prm = window.matchMedia
    ? matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };

  /* ── pulse module loader ─────────────────────────────────────────────
     One shared fetch loop per page (§5.3). The module sets
     window.LedaticPulse + window.pulseBus and dispatches
     'ledatic:pulsebus'. Resolves null if the module can't load —
     consumers then take one honest snapshot instead of polling. */
  let busPromise = null;
  function loadPulseBus() {
    if (busPromise) return busPromise;
    if (window.LedaticPulse) return (busPromise = Promise.resolve(window.LedaticPulse));
    busPromise = new Promise((resolve) => {
      let settled = false;
      const done = (api) => { if (!settled) { settled = true; resolve(api || null); } };
      window.addEventListener('ledatic:pulsebus', (e) => done(e.detail), { once: true });
      try {
        // Pages carry their own (?v=-stamped) pulse-clock module tag.
        // Importing the unstamped URL here keys a SECOND module instance
        // (ES module cache is URL-keyed) — a second PulseBus and, when the
        // race splits element vs inline-import subscribers across the two,
        // a second fetch loop. Wait for the tag's 'ledatic:pulsebus'
        // announce instead; import only when no tag exists.
        if (!document.querySelector('script[type="module"][src*="pulse-clock.js"]')) {
          import(new URL('pulse-clock.js', SCRIPT_URL).href)
            .then(() => done(window.LedaticPulse))
            .catch(() => {
              // dynamic-import rejection (very old engines): script-tag fallback
              const s = document.createElement('script');
              s.type = 'module';
              s.src = new URL('pulse-clock.js', SCRIPT_URL).href;
              s.onerror = () => done(null);
              document.head.appendChild(s);
            });
        }
      } catch (e) { done(null); }
      setTimeout(() => done(null), 8000);  // never wedge page boot on the bus
    });
    return busPromise;
  }

  /* ── fetch with abort timeout — silence ≠ success ──────────────────── */
  async function fetchJson(url, timeout = 4000) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeout);
      const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(t);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  /* ── legacy WebGL renderer — kept ONLY for u_time fragments
        (procedural mhd.frag fallback). Pulse-seeded field.frag goes
        through field.js instead (§5.5). No pointer uniform: visitor
        input doesn't perturb anything pulse-anchored (§0 rule 4). ── */
  const VS = `#version 300 es
  in vec2 a_pos;
  void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

  function compileShader(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('[ledatic] shader compile error:', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }

  function linkProgram(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error('[ledatic] program link error:', gl.getProgramInfoLog(p));
      return null;
    }
    return p;
  }

  function fitCanvas(gl, canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);  // §7 DPR cap
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  async function createScene({ canvas, shaderUrl, fragmentShader } = {}) {
    if (!canvas) canvas = document.getElementById('scene-canvas');
    if (!canvas) return;

    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: true,
      premultipliedAlpha: false,
    });
    if (!gl) return;

    let fsrc = fragmentShader;
    if (!fsrc && shaderUrl) {
      try {
        const res = await fetch(shaderUrl);
        if (!res.ok) throw new Error(`fetch ${shaderUrl}: ${res.status}`);
        fsrc = await res.text();
      } catch (e) {
        console.error('[ledatic] failed to load shader', e);
        return;
      }
    }
    if (!fsrc) return;

    const vs = compileShader(gl, gl.VERTEX_SHADER, VS);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsrc);
    if (!vs || !fs) return;
    const prog = linkProgram(gl, vs, fs);
    if (!prog) return;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW
    );

    const aPos  = gl.getAttribLocation(prog, 'a_pos');
    const uRes  = gl.getUniformLocation(prog, 'u_res');
    const uTime = gl.getUniformLocation(prog, 'u_time');

    const start = performance.now();
    let raf = 0;
    const draw = () => {
      fitCanvas(gl, canvas);
      gl.useProgram(prog);
      gl.enableVertexAttribArray(aPos);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, (performance.now() - start) / 1000.0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const frame = () => {
      raf = 0;
      if (document.hidden) return;          // halted, not idling (§7)
      draw();
      if (prm.matches) return;              // §3.4: one real frame, stop
      raf = requestAnimationFrame(frame);
    };
    const kick = () => {
      if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
    };
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && raf) { cancelAnimationFrame(raf); raf = 0; }
      else kick();
    });
    if (prm.addEventListener) prm.addEventListener('change', kick);
    window.addEventListener('resize', kick, { passive: true });
    kick();
  }

  /* ── nav + scroll chrome ─────────────────────────────────────────── */
  function initNav() {
    const nav = document.querySelector('nav.topnav');
    if (!nav) return;
    const onScroll = () => {
      if (window.scrollY > 24) nav.classList.add('scrolled');
      else nav.classList.remove('scrolled');
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  function initScrollProgress() {
    let bar = document.getElementById('scroll-progress');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'scroll-progress';
      document.body.appendChild(bar);
    }
    const update = () => {
      const doc = document.documentElement;
      const max = doc.scrollHeight - doc.clientHeight;
      const p = max > 0 ? Math.min(doc.scrollTop / max, 1) : 0;
      bar.style.transform = `scaleX(${p})`;
    };
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update, { passive: true });
    update();
  }

  /* ── live data — everything rides the pulse-bus (§5.3) ──────────────
     The bus owns the network honesty: abort timeouts, If-None-Match,
     monotonic pulse-id guard, visibility pause, Save-Data 30 s, and
     confirmed-only delivery. This file only renders what arrived. */

  function markStale(el, on, title) {
    if (!el) return;
    if (on) {
      el.style.filter = 'saturate(0.55)';     // §4 burn-in, inline (JS-set only)
      el.style.opacity = '0.65';
      if (title) el.title = title;
      el.setAttribute('data-stale', '1');
    } else {
      el.style.filter = '';
      el.style.opacity = '';
      el.removeAttribute('title');
      el.removeAttribute('data-stale');
    }
  }

  async function initLiveData() {
    const counter = document.querySelector('[data-live="entropy-pulse"]');
    const feed = document.getElementById('pulse-feed');
    const hasElements = document.querySelector('pulse-clock, time-pulse, canvas[data-field]');
    if (!counter && !feed && !hasElements) return;

    const api = await loadPulseBus();
    if (!api) {
      // No scheduler available: one honest snapshot each, no polling.
      if (counter || feed) {
        const p = await fetchJson('/entropy/pulse');
        if (p && typeof p.pulse_id === 'number' && counter) {
          counter.textContent = Number(p.pulse_id).toLocaleString();
        }
      }
      return;
    }
    const bus = api.bus;

    /* entropy pulse counter + feed — confirmed receipts only */
    if (counter || feed) {
      let clearedStub = false;
      if (feed) {
        feed.setAttribute('role', 'log');          // §4 feeds get role=log
        feed.setAttribute('aria-live', 'polite');
      }
      const renderRow = (data) => {
        if (!clearedStub) { feed.innerHTML = ''; clearedStub = true; }
        const ts = (data.timestamp_utc || '').slice(11, 19) || '--:--:--';
        const hex = data.value_hex || '';
        const shortHash = hex.length > 20 ? `${hex.slice(0, 14)}…${hex.slice(-6)}` : hex;
        const row = document.createElement('div');
        row.className = 'row';
        const tsEl = document.createElement('span'); tsEl.className = 'ts';   tsEl.textContent = ts;
        const hEl  = document.createElement('span'); hEl.className  = 'hash'; hEl.textContent  = shortHash;
        const nEl  = document.createElement('span'); nEl.className  = 'n';    nEl.textContent  = `#${api.fmtPulse(data.pulse_id)}`;
        row.appendChild(tsEl); row.appendChild(hEl); row.appendChild(nEl);
        feed.insertBefore(row, feed.firstChild);
        while (feed.children.length > 20) feed.removeChild(feed.lastChild);
      };
      bus.subscribe((p) => {
        // Bus ids are strictly monotonic — every delivery is a NEW pulse.
        if (counter) {
          counter.textContent = api.fmtPulse(p.pulse_id);
          markStale(counter, false);
        }
        if (feed) { renderRow(p); markStale(feed, false); }
      });
      bus.onStale(() => {
        // Numeral was never extrapolated, so it simply freezes; the dimming
        // says so out loud instead of letting a frozen number look live.
        markStale(counter, true, 'beacon stale — last confirmed pulse shown');
        markStale(feed, true, 'beacon stale — last confirmed pulses shown');
      });
    }

  }

  /* ── live MHD frame streamer ─────────────────────────────────────────
     Fetches the attested binary plasma state, extracts the density
     plane, uploads as an R8 texture, cross-dissolves between real
     signed keyframes. Cadence-aligned polling (never faster than the
     pulse, §7), ETag/If-None-Match, paused while hidden. Falls back
     to the procedural shader if the stream is unavailable — the page
     badge guard reads canvas[data-live-mounted] to label that state
     honestly. NOTE (Wave 2): /entropy + /plasma page agents own
     moving this onto bus.schedule() + the 10-min REPLAY demotion. */
  async function initLiveMHD() {
    const canvases = document.querySelectorAll('canvas[data-mhd-live]');
    for (const canvas of canvases) {
      const frameUrl  = canvas.getAttribute('data-mhd-live');
      const shaderUrl = canvas.getAttribute('data-mhd-shader') || '_shared/shaders/mhd_live.frag';
      const fallback  = canvas.getAttribute('data-mhd-fallback') || '_shared/shaders/mhd.frag';

      const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
      if (!gl) continue;

      let fsrc;
      try {
        fsrc = await (await fetch(shaderUrl)).text();
      } catch (e) { fsrc = null; }
      if (!fsrc) { createScene({ canvas, shaderUrl: fallback }); continue; }

      const vs = compileShader(gl, gl.VERTEX_SHADER, VS);
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsrc);
      if (!vs || !fs) { createScene({ canvas, shaderUrl: fallback }); continue; }
      const prog = linkProgram(gl, vs, fs);
      if (!prog) { createScene({ canvas, shaderUrl: fallback }); continue; }

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const aPos   = gl.getAttribLocation(prog, 'a_pos');
      const uRes   = gl.getUniformLocation(prog, 'u_res');
      const uTime  = gl.getUniformLocation(prog, 'u_time');
      const uFrame = gl.getUniformLocation(prog, 'u_frame');

      let hasFrame = false;
      let frameW = 64, frameH = 128;

      // The attested frame advances ~once per beacon pulse (~2 s), not per
      // animation tick. Hard-cutting between keyframes is the visible
      // "lurch", so we cross-dissolve: keep the frame fading FROM (prevU8)
      // and the newest attested frame (curU8), blended over FADE_MS. Every
      // keyframe shown is a real signed frame; the in-between is a display
      // dissolve, like a video fade — no fabricated physics. Under
      // prefers-reduced-motion: hard cut, latest keyframe as a still (§3.4).
      let curU8 = null;
      let prevU8 = null;
      let blendU8 = null;
      let fadeStart = 0;
      let settled = true;
      let lastStep = -1;
      let etag = null;
      const FADE_MS = 1600;

      // Binary frame header (48 bytes):
      //   u32 w, u32 h, u32 c, u32 step, then 8 × f32 metrics
      // Body: c planes of w × h float32 — ρ, vx, vy, p, Bx, By.
      const stepEl = document.querySelector('[data-live="mhd-step"]');
      const fetchFrame = async () => {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 5000);
          const headers = {};
          if (etag) headers['If-None-Match'] = etag;
          const res = await fetch(frameUrl, { cache: 'no-store', headers, signal: ctrl.signal });
          clearTimeout(timer);
          if (res.status === 304) return;       // same signed frame — nothing new
          if (!res.ok) return;
          etag = res.headers.get('etag');
          const buffer = await res.arrayBuffer();
          if (buffer.byteLength < 48) return;
          const view = new DataView(buffer);
          const w = view.getUint32(0, true);
          const h = view.getUint32(4, true);
          const c = view.getUint32(8, true);
          const step = view.getUint32(12, true);
          if (w <= 0 || h <= 0 || c <= 0) return;
          if (step === lastStep) return;        // same signed frame
          const nCells = w * h;
          if (buffer.byteLength < 48 + nCells * c * 4) return;
          // Density = first planar channel (canonical Orszag-Tang viz).
          const floats = new Float32Array(buffer, 48, nCells);
          let min = floats[0], max = floats[0];
          for (let i = 1; i < nCells; i++) {
            const v = floats[i];
            if (v < min) min = v;
            if (v > max) max = v;
          }
          const range = (max - min) || 1;
          const newU8 = new Uint8Array(nCells);
          for (let i = 0; i < nCells; i++) {
            newU8[i] = Math.round(((floats[i] - min) / range) * 255);
          }
          // Dissolve FROM whatever is on screen right now so a frame arriving
          // mid-fade doesn't pop. null on the very first frame → no fade.
          prevU8 = (blendU8 && blendU8.length === nCells) ? blendU8.slice() : null;
          curU8 = newU8;
          if (!blendU8 || blendU8.length !== nCells) blendU8 = new Uint8Array(nCells);
          frameW = w; frameH = h;
          fadeStart = performance.now();
          settled = false;
          lastStep = step;
          hasFrame = true;
          // Badge-honesty contract: page guards (entropy/plasma inline JS)
          // only claim live once REAL attested frames have streamed.
          canvas.setAttribute('data-live-mounted', '1');
          if (stepEl) stepEl.textContent = step.toLocaleString();
          kick();                               // new real data → render it
        } catch (e) { /* silent — fallback/staleness does the talking */ }
      };

      // Render loop — declared (hoisted) before the first fetchFrame so its
      // kick() lands; kick guards on hasFrame so it can never race the
      // procedural-fallback path below.
      const start = performance.now();
      let raf = 0;
      function draw() {
        fitCanvas(gl, canvas);
        // Cross-dissolve the on-screen density between the two most recent
        // attested frames, then upload the blend (128² R8 = 16 KB, trivial).
        // Stops uploading once the fade lands (settled) until the next frame.
        if (curU8 && !settled) {
          const fade = prm.matches ? 0 : FADE_MS;   // reduced motion: hard cut
          const mix = fade > 0 ? Math.min((performance.now() - fadeStart) / fade, 1) : 1;
          if (prevU8 && mix < 1) {
            for (let i = 0; i < blendU8.length; i++) {
              blendU8[i] = prevU8[i] + (curU8[i] - prevU8[i]) * mix;
            }
          } else {
            blendU8.set(curU8);
            settled = true;
          }
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, frameW, frameH, 0, gl.RED, gl.UNSIGNED_BYTE, blendU8);
        }
        gl.useProgram(prog);
        gl.enableVertexAttribArray(aPos);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        gl.uniform2f(uRes, canvas.width, canvas.height);
        gl.uniform1f(uTime, (performance.now() - start) / 1000.0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(uFrame, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      function tick() {
        raf = 0;
        if (document.hidden) return;          // halted on visibilitychange (§7)
        draw();
        if (prm.matches && settled) return;   // §3.4: still per keyframe
        raf = requestAnimationFrame(tick);
      }
      function kick() {
        if (!raf && !document.hidden && hasFrame) raf = requestAnimationFrame(tick);
      }

      await fetchFrame();
      if (!hasFrame) {
        // Beacon unreachable — show the procedural shader instead.
        createScene({ canvas, shaderUrl: fallback });
        continue;
      }
      // Self-pacing poll, cadence-aligned: the attested frame only changes
      // ~every 2 s, so polling faster than the pulse is pure waste (§7).
      // Save-Data gets the 30 s diet (§3.5). Awaits the prior fetch before
      // scheduling the next (no overlap), and never polls while hidden.
      const FRAME_GAP_MS = saveData ? 30000 : CADENCE_MS;
      const pumpFrame = async () => {
        if (!document.hidden) await fetchFrame();
        setTimeout(pumpFrame, FRAME_GAP_MS);
      };
      setTimeout(pumpFrame, FRAME_GAP_MS);

      document.addEventListener('visibilitychange', () => {
        if (document.hidden && raf) { cancelAnimationFrame(raf); raf = 0; }
        else kick();
      });
      window.addEventListener('resize', kick, { passive: true });
      kick();
    }
  }

  /* ── shaders ─────────────────────────────────────────────────────────
     The pulse-seeded field program (§5.5) takes u_pulse_id/u_pulse_phase
     and must boot through the field loader so it freezes honestly when
     the beacon goes quiet. Legacy u_time frags (procedural mhd fallback)
     keep the simple renderer. */
  function fieldModeFor(canvas) {
    const declared =
      (canvas && canvas.getAttribute('data-field')) ||
      document.body.getAttribute('data-field-mode');
    if (declared) return declared;
    const p = location.pathname;
    if (p.indexOf('entropy') !== -1) return 'entropy';
    if (p.indexOf('plasma') !== -1) return 'plasma';
    return 'home';
  }

  let fieldLoading = null;
  function ensureFieldLoader(cb) {
    if (window.LedaticField) { cb(window.LedaticField); return; }
    if (!fieldLoading) {
      fieldLoading = new Promise((resolve) => {
        // Field pages carry their own (deferred, ?v=-stamped) field.js tag
        // that executes after this script. Injecting a second copy here
        // double-booted every canvas — wait for the existing tag instead.
        const existing = document.querySelector('script[src*="field.js"]');
        if (existing) {
          existing.addEventListener('load', () => resolve(window.LedaticField || null));
          existing.addEventListener('error', () => resolve(null));
          return;
        }
        const s = document.createElement('script');
        s.src = new URL('field.js', SCRIPT_URL).href;
        s.onload = () => resolve(window.LedaticField || null);
        s.onerror = () => resolve(null);
        document.head.appendChild(s);
      });
    }
    fieldLoading.then((F) => { if (F) cb(F); });
  }

  function initShader() {
    // Declarative field canvases boot inside field.js itself; the bus is
    // loaded too so receipts reach the field (it never polls on its own).
    if (document.querySelector('canvas[data-field]')) {
      loadPulseBus();
      ensureFieldLoader(() => {});
    }
  }

  // Explore dropdown: click-toggle (touch/keyboard) atop the CSS hover, plus
  // auto-active — mark the primary link (or Explore) matching the current path.
  function initNavMore() {
    var here = location.pathname.replace(/\/index\.html$/, '/').replace(/\.html$/, '');
    if (here.length > 1) here = here.replace(/\/$/, '');
    document.querySelectorAll('.navlinks a[href]').forEach(function (a) {
      var p = a.getAttribute('href').replace(/\.html$/, '').replace(/\/$/, '');
      if (p && (p === here || (p !== '/' && here.indexOf(p) === 0))) a.classList.add('active');
    });
    var more = document.querySelector('.navmore');
    if (!more) return;
    var btn = more.querySelector('.navmore-btn');
    var inMenu = more.querySelector('.navmore-menu a.active, .navmore-menu a[href="' + here + '"]');
    if (inMenu && btn) btn.classList.add('active');
    if (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = more.classList.toggle('open');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      document.addEventListener('click', function () { more.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { more.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); } });
    }
  }

  function init() {
    initNav();
    initNavMore();
    initScrollProgress();
    initLiveData();
    initLiveMHD();
    initShader();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.Ledatic = { createScene };
})();
