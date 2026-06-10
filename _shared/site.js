/* ============================================================
   Ledatic 2030 — shared runtime
   - createScene({ shaderUrl | fragmentShader })   WebGL2 fullscreen shader
   - initReveals()                                  scroll-triggered fade-ups
   - initNav()                                      nav scrolled-state
   ============================================================ */

(() => {
  'use strict';

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
    const uMouse = gl.getUniformLocation(prog, 'u_mouse');

    const state = { mx: 0, my: 0 };
    window.addEventListener('mousemove', (e) => {
      state.mx = (e.clientX / window.innerWidth)  * 2 - 1;
      state.my = (e.clientY / window.innerHeight) * 2 - 1;
    }, { passive: true });

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.floor(canvas.clientWidth  * dpr);
      const h = Math.floor(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    };

    let paused = false;
    document.addEventListener('visibilitychange', () => { paused = document.hidden; });

    const start = performance.now();
    const frame = () => {
      if (!paused) {
        resize();
        gl.useProgram(prog);
        gl.enableVertexAttribArray(aPos);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        gl.uniform2f(uRes, canvas.width, canvas.height);
        gl.uniform1f(uTime, (performance.now() - start) / 1000.0);
        if (uMouse) gl.uniform2f(uMouse, state.mx, state.my);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  function initReveals() {
    const els = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) {
      els.forEach((e) => e.classList.add('in'));
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            obs.unobserve(e.target);
          }
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -5% 0px' }
    );
    els.forEach((e) => obs.observe(e));
  }

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

  function initCardTilt() {
    if (window.matchMedia('(pointer: coarse)').matches) return;
    const cards = document.querySelectorAll('.card, .node-card');
    cards.forEach((card) => {
      card.addEventListener('mousemove', (e) => {
        const r = card.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width  - 0.5;
        const y = (e.clientY - r.top)  / r.height - 0.5;
        card.style.transform =
          `perspective(900px) rotateX(${-y * 5.5}deg) rotateY(${x * 6.5}deg) translateY(-2px)`;
      });
      card.addEventListener('mouseleave', () => {
        card.style.transform = '';
      });
    });
  }

  function animateCounter(el) {
    const final = el.textContent.trim();
    if (!/^\d+(\.\d+)?$/.test(final)) return;
    const target = parseFloat(final);
    const decimals = (final.split('.')[1] || '').length;
    const duration = 1200;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const val = target * eased;
      el.textContent = decimals > 0 ? val.toFixed(decimals) : Math.floor(val).toString();
      if (t < 1) requestAnimationFrame(step);
      else el.textContent = final;
    };
    requestAnimationFrame(step);
  }

  function initCounters() {
    if (!('IntersectionObserver' in window)) return;
    const values = document.querySelectorAll('.stat .value');
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            animateCounter(e.target);
            obs.unobserve(e.target);
          }
        }
      },
      { threshold: 0.55 }
    );
    values.forEach((el) => obs.observe(el));
  }

  async function fetchJson(url, timeout = 4000) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeout);
      const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(t);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function pollEntropyPulse() {
    const counter = document.querySelector('[data-live="entropy-pulse"]');
    const feed = document.getElementById('pulse-feed');
    const fmt = (n) => Number(n).toLocaleString();
    let lastId = null;
    let clearedStub = false;

    const renderRow = (data) => {
      if (!feed) return;
      if (!clearedStub) { feed.innerHTML = ''; clearedStub = true; }
      const ts = (data.timestamp_utc || '').slice(11, 19) || '--:--:--';
      const hex = data.value_hex || '';
      const shortHash = hex.length > 20 ? `${hex.slice(0, 14)}…${hex.slice(-6)}` : hex;
      const row = document.createElement('div');
      row.className = 'row';
      const tsEl = document.createElement('span'); tsEl.className = 'ts';   tsEl.textContent = ts;
      const hEl  = document.createElement('span'); hEl.className  = 'hash'; hEl.textContent  = shortHash;
      const nEl  = document.createElement('span'); nEl.className  = 'n';    nEl.textContent  = `#${fmt(data.pulse_id)}`;
      row.appendChild(tsEl); row.appendChild(hEl); row.appendChild(nEl);
      feed.insertBefore(row, feed.firstChild);
      while (feed.children.length > 20) feed.removeChild(feed.lastChild);
    };

    const tick = async () => {
      const data = await fetchJson('/entropy/pulse');
      if (!data || typeof data.pulse_id !== 'number') return;
      if (counter) counter.textContent = fmt(data.pulse_id);
      if (data.pulse_id !== lastId) {
        lastId = data.pulse_id;
        renderRow(data);
      }
    };

    await tick();
    // Beacon emits every ~2s; poll slightly slower to avoid tight loops.
    setInterval(tick, 2100);
  }

  async function pollFleetStatus() {
    const el = document.querySelector('[data-live="fleet-status"]');
    if (!el) return;
    const tick = async () => {
      const data = await fetchJson('/fleet/status.json');
      if (!data || !Array.isArray(data.nodes) || data.nodes.length === 0) return;
      const up = data.nodes.filter(n => n.alive).length;
      const total = data.nodes.length;
      const state = up === total ? 'ONLINE' : 'DEGRADED';
      el.innerHTML = `${up}/${total} <span class="dim">//</span> ${state}`;
    };
    await tick();
    setInterval(tick, 15000);
  }

  function initLiveData() {
    pollEntropyPulse();
    pollFleetStatus();
  }

  function initShader() {
    // Hero background shader — body-level attribute (one per page).
    const bodyShader = document.body.getAttribute('data-shader');
    if (bodyShader) createScene({ shaderUrl: bodyShader });

    // Embedded viewport shaders — any canvas with its own data-shader.
    // Skip canvases that are bound to a live-frame streamer (handled separately).
    document.querySelectorAll('canvas[data-shader]:not([data-mhd-live])').forEach((canvas) => {
      const url = canvas.getAttribute('data-shader');
      if (url) createScene({ canvas, shaderUrl: url });
    });
  }

  // Live MHD frame streamer — fetches binary plasma state from the beacon
  // feed, extracts the density channel, uploads as an R8 texture, and runs
  // the mhd_live fragment shader. Falls back to the procedural mhd shader
  // if the stream is unavailable.
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
      } catch (_) { fsrc = null; }
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

      // The attested frame at /entropy/frame/current advances ~once per beacon
      // pulse (~2 s), not per animation tick. Hard-cutting between those
      // keyframes is the visible "lurch". Instead we cross-dissolve: keep the
      // frame we're fading FROM (prevU8) and the newest attested frame (curU8),
      // and the render loop blends them over FADE_MS. Every keyframe shown is a
      // real signed frame; the in-between is a display dissolve, like a video
      // fade — no fabricated physics.
      let curU8 = null;     // newest attested frame (min-max normalized density)
      let prevU8 = null;    // frame we're dissolving from
      let blendU8 = null;   // what's actually on screen this tick
      let fadeStart = 0;
      let settled = true;   // true once the current frame is fully shown
      let lastStep = -1;
      const FADE_MS = 1600;

      // Binary frame header (48 bytes):
      //   u32 w, u32 h, u32 c, u32 step, then 8 × f32 metrics
      // Body: c planes of w × h float32 — ρ, vx, vy, p, Bx, By.
      const stepEl = document.querySelector('[data-live="mhd-step"]');
      const fetchFrame = async () => {
        try {
          const res = await fetch(frameUrl, { cache: 'no-store' });
          if (!res.ok) return;
          const buffer = await res.arrayBuffer();
          if (buffer.byteLength < 48) return;
          const view = new DataView(buffer);
          const w = view.getUint32(0, true);
          const h = view.getUint32(4, true);
          const c = view.getUint32(8, true);
          const step = view.getUint32(12, true);
          if (w <= 0 || h <= 0 || c <= 0) return;
          if (step === lastStep) return;   // same signed frame — nothing new to show
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
          if (stepEl) stepEl.textContent = step.toLocaleString();
        } catch (_) { /* silent fallback */ }
      };

      await fetchFrame();
      if (!hasFrame) {
        // Beacon unreachable — show the procedural shader instead.
        createScene({ canvas, shaderUrl: fallback });
        continue;
      }
      // Self-pacing poll: each frame is ~0.5 MB and can take >250 ms, so a
      // fixed setInterval stacked overlapping fetches and saturated the
      // connection pool. Await the prior fetch before scheduling the next,
      // and don't poll while the tab is hidden.
      // The attested frame only changes ~every 2 s, so a 250 ms poll refetched
      // the same object ~8× per real update — wasteful, and a likely
      // Cloudflare rate-limit trigger (the cause of the original "won't load").
      // ~1 s still catches each new frame promptly at a quarter of the request
      // volume; the cross-dissolve in the render loop is what smooths motion.
      const FRAME_GAP_MS = 1000;
      const pumpFrame = async () => {
        if (!document.hidden) await fetchFrame();
        setTimeout(pumpFrame, FRAME_GAP_MS);
      };
      setTimeout(pumpFrame, FRAME_GAP_MS);

      const resize = () => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.floor(canvas.clientWidth  * dpr);
        const h = Math.floor(canvas.clientHeight * dpr);
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
          gl.viewport(0, 0, w, h);
        }
      };

      let paused = false;
      document.addEventListener('visibilitychange', () => { paused = document.hidden; });

      const start = performance.now();
      const tick = () => {
        if (!paused) {
          resize();
          // Cross-dissolve the on-screen density between the two most recent
          // attested frames, then upload the blend (128² R8 = 16 KB, trivial).
          // Stops uploading once the fade lands (settled) until the next frame.
          if (curU8 && !settled) {
            const mix = Math.min((performance.now() - fadeStart) / FADE_MS, 1);
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
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  }

  // ─── Live RAIL version (footer trust strip) ──────────────────────────────
  // Pulls the most recent release from /feed.xml and fills any
  // [data-live="rail-version"] element. Falls back silently to the
  // server-rendered fallback text if the feed is unreachable.
  // Version only — the feed carries no current test count, so we don't
  // decorate this live element with one.
  async function initLiveVersion() {
    const els = document.querySelectorAll('[data-live="rail-version"]');
    if (!els.length) return;
    try {
      const res = await fetch('/feed.xml', { cache: 'no-store' });
      if (!res.ok) return;
      const xml = new DOMParser().parseFromString(await res.text(), 'application/xml');
      const title = xml.querySelector('entry > title')?.textContent || '';
      const m = title.match(/v(\d+\.\d+\.\d+)/);
      if (!m) return;
      els.forEach(el => { el.textContent = `RAIL v${m[1]}`; });
    } catch {}
  }

  function init() {
    initNav();
    initReveals();
    initScrollProgress();
    initCardTilt();
    initCounters();
    initLiveData();
    initLiveMHD();
    initShader();
    initLiveVersion();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.Ledatic = { createScene };
})();
