/* ============================================================
   Ledatic — field loader (_shared/field.js)

   Boots the consolidated field shader (_shared/shaders/field.frag,
   spec §5.5) on a canvas, in one of three modes:

     LedaticField.init(canvas, 'home' | 'entropy' | 'plasma')

   or declaratively:

     <canvas data-field="home" data-field-src="_shared/shaders/field.frag"></canvas>

   Contract (spec §5.5, §3.4–3.5, §4, §7):
   - The field is a pure function of (pulse_id, phase, mode). No pointer,
     no scroll, no free-running clock. Phase advances only after a real
     pulse receipt and clamps at 1 — when the beacon goes quiet the field
     freezes and the render loop stops. Motion is a truth channel.
   - Pulse receipts arrive from the shared scheduler (§5.3,
     window.LedaticPulse.bus — pulse-clock.js is an ES module, so it is
     late-bound via its 'ledatic:pulsebus' window event) or from a
     'ledatic:pulse' document event any page may dispatch. This module
     never fetches liveness data and never polls on its own.
   - Continuity: the confirmed pulse + receipt time persist in
     sessionStorage, so the next document resumes the same field at the
     same phase — one continuous machine across real page loads, no SPA.
   - Honest state reporting: the canvas carries data-state with a
     liveness-grammar word (unknown / live / replay / stale / paused) and
     a bubbling 'field:state' CustomEvent fires on every change for
     sentinels to consume. A stored pulse animating before in-document
     confirmation is REPLAY, never live. This module never emits 'fail' —
     red means a verification failed, and decoration cannot fail a proof.
   - prefers-reduced-motion: render exactly one real frame, then stop;
     the media query is listened for changes. Save-Data / reduced-data:
     no GL at all — the static .scene-fallback poster stays. Missing
     WebGL2, shader fetch failure, or context loss: same poster path,
     honest 'paused' state with a reason. Context restore rebuilds and
     resumes. devicePixelRatio is capped at 1.5; rendering halts while
     the document is hidden.
   ============================================================ */

(() => {
  'use strict';

  // Double-load guard: a second copy of this script (e.g. injected by a
  // loader that raced the page's own tag) must not re-boot every canvas.
  if (window.LedaticField) return;

  const FRAG_DEFAULT  = '_shared/shaders/field.frag';
  const CADENCE_MS    = 2000;     // beacon cadence ~2 s
  const FRESH_PULSES  = 5;        // LIVE → STALE after 5 quiet pulses (§4)
  const DPR_CAP       = 1.5;      // §7
  const PULSE_WRAP    = 1048576;  // 2^20 — uploaded id stays exact in f32
  const SS_KEY        = 'ledatic:field';
  const MODES         = { home: 0, entropy: 1, plasma: 2 };

  const VS = '#version 300 es\nin vec2 a_pos;void main(){gl_Position=vec4(a_pos,0.,1.);}';

  const mqMotion = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const mqData   = window.matchMedia ? matchMedia('(prefers-reduced-data: reduce)') : null;

  const reducedMotion = () => !!(mqMotion && mqMotion.matches);
  const reducedData = () => {
    if (mqData && mqData.matches) return true;
    const c = navigator.connection;
    return !!(c && c.saveData);
  };

  function emit(canvas, state, extra) {
    canvas.dataset.state = state;
    try {
      canvas.dispatchEvent(new CustomEvent('field:state', {
        bubbles: true,
        detail: Object.assign({ state }, extra || {}),
      }));
    } catch (_) { /* events are best-effort; rendering never depends on them */ }
  }

  /* Poster fallback: hide the canvas so the static .scene-fallback
     sibling shows through. The poster asserts nothing — 'paused'.
     Inline display:none as well: the stylesheet gives scene canvases
     display:block, which would defeat the hidden attribute alone. */
  function poster(canvas, reason) {
    canvas.hidden = true;
    canvas.style.display = 'none';
    emit(canvas, 'paused', { reason });
    return null;
  }

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('[ledatic field] shader compile:', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }

  function readStored() {
    try {
      const raw = sessionStorage.getItem(SS_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (typeof v.id !== 'number' || typeof v.t0 !== 'number') return null;
      return v;
    } catch (_) { return null; }
  }

  function writeStored(id, t0) {
    try { sessionStorage.setItem(SS_KEY, JSON.stringify({ id, t0 })); } catch (_) {}
  }

  async function init(canvas, mode, opts) {
    if (!canvas) return null;
    opts = opts || {};
    const modeInt = typeof mode === 'number' ? mode : (MODES[mode] || 0);

    emit(canvas, 'unknown', { mode });

    if (reducedData()) return poster(canvas, 'reduced-data'); // §3.5: no shader

    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: true,
      premultipliedAlpha: false,
      powerPreference: 'low-power',
    });
    if (!gl) return poster(canvas, 'no-webgl2');

    const src = opts.src || canvas.getAttribute('data-field-src') || FRAG_DEFAULT;
    let fsrc;
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error('fetch ' + res.status);
      fsrc = await res.text();
    } catch (e) {
      console.error('[ledatic field] shader fetch failed:', e);
      return poster(canvas, 'shader-unavailable');
    }

    // ── GL objects (rebuilt on context restore) ──────────────────────
    let prog, buf, loc;
    function build() {
      const vs = compile(gl, gl.VERTEX_SHADER, VS);
      const fs = compile(gl, gl.FRAGMENT_SHADER, fsrc);
      if (!vs || !fs) return false;
      prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error('[ledatic field] link:', gl.getProgramInfoLog(prog));
        return false;
      }
      buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      loc = {
        pos:   gl.getAttribLocation(prog, 'a_pos'),
        res:   gl.getUniformLocation(prog, 'u_res'),
        id:    gl.getUniformLocation(prog, 'u_pulse_id'),
        phase: gl.getUniformLocation(prog, 'u_pulse_phase'),
        mode:  gl.getUniformLocation(prog, 'u_mode'),
      };
      return true;
    }
    if (!build()) return poster(canvas, 'shader-unavailable');

    // ── Pulse state ──────────────────────────────────────────────────
    // grammar = the field's honest liveness word; 'paused' overlays it
    // during context loss and is restored from here afterward.
    const st = { id: 0, t0: 0, seeded: false, grammar: 'unknown' };
    let raf = 0, demoteTimer = 0, lost = false, destroyed = false;

    const phase = () =>
      st.seeded ? Math.min(Math.max((Date.now() - st.t0) / CADENCE_MS, 0), 1) : 1;

    function setGrammar(state, extra) {
      st.grammar = state;
      emit(canvas, state, Object.assign({ pulse_id: st.id, mode }, extra || {}));
    }

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    }

    function render() {
      if (lost || destroyed) return;
      resize();
      gl.useProgram(prog);
      gl.enableVertexAttribArray(loc.pos);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.vertexAttribPointer(loc.pos, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(loc.res, canvas.width, canvas.height);
      gl.uniform1f(loc.id, st.id % PULSE_WRAP);
      gl.uniform1f(loc.phase, phase());
      gl.uniform1i(loc.mode, modeInt);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /* The loop runs only while there is honest motion to show: document
       visible, motion allowed, phase still advancing. Frozen fields cost
       zero GPU until the next receipt kicks them. */
    function frame() {
      raf = 0;
      if (destroyed || lost || document.hidden) return;
      render();
      if (reducedMotion()) return;          // §3.4: one real frame, stop
      if (phase() >= 1) return;             // beacon quiet → field frozen
      raf = requestAnimationFrame(frame);
    }
    function kick() {
      if (!raf && !destroyed && !lost && !document.hidden) {
        raf = requestAnimationFrame(frame);
      }
    }
    function stop() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    }

    function armDemote(ms) {
      clearTimeout(demoteTimer);
      demoteTimer = setTimeout(() => {
        if (destroyed) return;
        setGrammar('stale');                // numeral freezes, field frozen
        kick();                             // one frame to settle the still
      }, ms);
    }

    /* Real receipt — the only thing that advances the field. `at` is the
       bus's Date.now() at confirmation: bus-delivered pulses may match the
       sessionStorage id and still upgrade REPLAY → live, because this
       document's own fetch loop confirmed them. The event-path (no `at`)
       can never upgrade a recorded pulse. */
    function confirm(p, at) {
      if (destroyed) return;
      const id = typeof p === 'number' ? p
               : p && typeof p.pulse_id === 'number' ? p.pulse_id
               : p && typeof p.id === 'number' ? p.id
               : NaN;
      if (!Number.isFinite(id) || id < st.id) return;  // never rewind
      if (id === st.id && !(at && st.grammar !== 'live')) return; // same pulse ≠ fresh
      st.id = id;
      st.t0 = at || Date.now();
      st.seeded = true;
      writeStored(id, st.t0);               // §5.5 continuity across nav
      setGrammar('live');
      armDemote(Math.max(0, st.t0 + FRESH_PULSES * CADENCE_MS - Date.now()));
      kick();
    }

    // Continuity restore: a receipt recorded earlier this session. It is
    // recorded data until this document confirms one — REPLAY, not live.
    const stored = readStored();
    if (stored) {
      st.id = stored.id;
      st.t0 = stored.t0;
      st.seeded = true;
      const age = Date.now() - stored.t0;
      if (age < FRESH_PULSES * CADENCE_MS) {
        setGrammar('replay');
        armDemote(FRESH_PULSES * CADENCE_MS - age);
      } else {
        setGrammar('stale');
      }
    }

    // ── Pulse sources ────────────────────────────────────────────────
    // Primary: the shared scheduler (§5.3) at window.LedaticPulse.bus.
    // pulse-clock.js is an ES module, so it may execute after this
    // classic script — its 'ledatic:pulsebus' window event late-binds.
    // Fallback: a 'ledatic:pulse' document event any page may dispatch.
    let unsub = null;
    function bindBus(api) {
      const bus = api && api.bus;
      if (unsub || !bus || typeof bus.subscribe !== 'function') return;
      // bus delivery is a confirmation made by this document's own fetch
      // loop — pass its receipt time so a resumed phase stays honest.
      unsub = bus.subscribe((p) => confirm(p, bus.receivedAt || Date.now()));
    }
    bindBus(window.LedaticPulse);
    const onBus = (e) => bindBus(e.detail || window.LedaticPulse);
    window.addEventListener('ledatic:pulsebus', onBus);
    const onPulse = (e) => confirm(e.detail);
    document.addEventListener('ledatic:pulse', onPulse);

    // ── Lifecycle ────────────────────────────────────────────────────
    const onVis = () => { document.hidden ? stop() : kick(); };
    document.addEventListener('visibilitychange', onVis);

    const onResize = () => kick();          // redraw even when frozen
    window.addEventListener('resize', onResize, { passive: true });

    const onMotionChange = () => { stop(); kick(); }; // re-evaluate mode
    if (mqMotion && mqMotion.addEventListener) {
      mqMotion.addEventListener('change', onMotionChange);
    }

    const onLost = (e) => {
      e.preventDefault();
      lost = true;
      stop();
      emit(canvas, 'paused', { reason: 'context-lost', pulse_id: st.id, mode });
    };
    const onRestored = () => {
      if (destroyed) return;
      lost = false;
      if (build()) {
        setGrammar(st.grammar);             // restore the honest state word
        kick();
      } else {
        poster(canvas, 'shader-unavailable');
      }
    };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);

    kick(); // first frame — real even when frozen or reduced-motion

    return {
      canvas,
      mode,
      confirm,
      destroy() {
        destroyed = true;
        stop();
        clearTimeout(demoteTimer);
        if (unsub) { try { unsub(); } catch (_) {} }
        window.removeEventListener('ledatic:pulsebus', onBus);
        document.removeEventListener('ledatic:pulse', onPulse);
        document.removeEventListener('visibilitychange', onVis);
        window.removeEventListener('resize', onResize);
        if (mqMotion && mqMotion.removeEventListener) {
          mqMotion.removeEventListener('change', onMotionChange);
        }
        canvas.removeEventListener('webglcontextlost', onLost);
        canvas.removeEventListener('webglcontextrestored', onRestored);
      },
    };
  }

  function boot() {
    document.querySelectorAll('canvas[data-field]').forEach((c) => {
      if (c.dataset.fieldBooted) return; // declarative boot is once-only
      c.dataset.fieldBooted = '1';
      init(c, c.getAttribute('data-field') || 'home');
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.LedaticField = { init, MODES, CADENCE_MS, FRESH_PULSES };
})();
