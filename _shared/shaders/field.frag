#version 300 es
precision highp float;

/* Ledatic field — the one shader (spec §5.5).
   One WebGL2 program, three modes; the nine page-specific .frag files it
   replaces are deleted. The MHD viewport shaders (mhd_live / mhd) are NOT
   part of this program: they render attested frame data, which the seeded
   field must never impersonate (§0 rule 3).

     u_mode 0 — home     domain-warped stream plasma behind the / hero.
                         Each receipt fires a shockwave ring + reheat and
                         re-seeds the grain; between receipts the flow
                         advances only with phase, so a quiet beacon is a
                         frozen field. Still decoration — never labeled
                         as the beacon plasma itself (§0 rule 3).
     u_mode 1 — entropy  hash-rain band for the /entropy hero. Decoration
                         only — never labeled as the beacon. The real
                         chain renders from real pulse data elsewhere.
     u_mode 2 — plasma   flux ring for the /plasma hero. Decoration only —
                         the physics viewport renders signed frames.

   Determinism (§0 rule 4): the image is a pure function of
   (u_pulse_id, u_pulse_phase, u_mode, u_res). No wall-clock, no pointer,
   no scroll. Two visitors at the same pulse and phase see the same field.

   u_pulse_id    confirmed beacon pulse id, pre-wrapped mod 2^20 by the
                 loader so the upload stays exact in float32. Wrapped
                 again here (mod 2048) before entering the flow domain so
                 hash inputs stay in their precision sweet spot; the
                 once-per-2048-pulses reseed is an honest discontinuity.
   u_pulse_phase 0→1 across the ~2 s cadence. The loader advances it only
                 after a real pulse receipt and clamps it at 1 when the
                 beacon goes quiet — when pulses stop arriving, the field
                 freezes. Motion is a truth channel (§3).
*/

uniform vec2  u_res;
uniform float u_pulse_id;
uniform float u_pulse_phase;
uniform int   u_mode;
out vec4 fragColor;

const vec3 BASE   = vec3(0.003, 0.010, 0.006);
const vec3 STREAM = vec3(0.10, 0.78, 0.25);
const vec3 SHOCK  = vec3(0.45, 1.15, 0.60);

/* Sinless hash (Hoskins) — stays well-conditioned for the coordinate
   ranges a wrapped pulse-time can reach, where fract(sin(big)) decays. */
float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i),               hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)),  hash(i + vec2(1, 1)), f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.05; a *= 0.5; }
  return v;
}

/* mode 0 — home. Domain-warped stream plasma (q warps p, r warps q): the
   flow reads as a magnetized fluid, striations as field lines. The core
   sits right of the copy column. Everything is still a pure function of
   (pulse_id, phase): the warp advances with pulse-time, the shockwave
   ring and reheat ride the receipt (phase near 0), and both are gone by
   phase 1 — a quiet beacon leaves a frozen, calm field. */
vec3 modeHome(vec2 uv, float t, float phase, float bloom) {
  vec2 c = uv - vec2(0.33, -0.02);          /* plasma core, right of copy */
  float d = length(c);

  /* receipt shockwave: a refraction ring expanding from the core across
     the ~2 s cadence. No receipt → bloom 0 → no ring, no displacement. */
  float ring = smoothstep(0.045, 0.0, abs(d - phase * 1.5)) * bloom;
  vec2 suv = uv + normalize(c + 1e-4) * ring * 0.05;

  vec2 p = suv * 2.2 + vec2(t * 0.026, t * 0.014);

  /* q warps p, r warps q — computed once, shared by all three channels */
  vec2 q = vec2(fbm(p),
                fbm(p + vec2(5.2, 1.3)));
  vec2 r = vec2(fbm(p + 2.6 * q + vec2(1.7, 9.2) + t * 0.020),
                fbm(p + 2.6 * q + vec2(8.3, 2.8) - t * 0.016));
  vec2 fp = p + 3.2 * r;

  /* chromatic aberration on the final lookup only — widens on receipt */
  float ca = 0.006 + 0.030 * bloom + 0.004 * d;
  float f  = fbm(fp);
  float fr = fbm(fp + vec2(ca, 0.0));
  float fb = fbm(fp - vec2(ca, 0.0));

  /* field-line striations riding the warped domain, advected by phase */
  float lines = pow(abs(sin((f * 9.0 + r.x * 5.0 + t * 0.11) * 3.14159)), 12.0);

  /* green ramp: charcoal → deep green → phosphor → hot mint core,
     per-channel from the offset lookups so the aberration reads */
  vec3 deep = vec3(0.015, 0.16, 0.055), hot = vec3(0.72, 1.0, 0.80);
  vec3 col;
  col.r = mix(mix(BASE.r, deep.r, smoothstep(0.18, 0.56, fr)),
              mix(STREAM.r, hot.r, smoothstep(0.78, 1.0, fr)), smoothstep(0.46, 0.80, fr));
  col.g = mix(mix(BASE.g, deep.g, smoothstep(0.18, 0.56, f)),
              mix(STREAM.g, hot.g, smoothstep(0.78, 1.0, f)),  smoothstep(0.46, 0.80, f));
  col.b = mix(mix(BASE.b, deep.b, smoothstep(0.18, 0.56, fb)),
              mix(STREAM.b, hot.b, smoothstep(0.78, 1.0, fb)), smoothstep(0.46, 0.80, fb));
  col *= f * f * 1.9 + 0.14;

  col += SHOCK * lines * smoothstep(0.35, 0.75, f) * 0.45;   /* field lines */
  col += hot * ring * 0.9;                                    /* the ring   */
  col += SHOCK * bloom * 0.30 * exp(-d * 2.6);                /* reheat     */

  /* keep the copy column readable: ease the field off to the left */
  col *= 0.35 + 0.65 * smoothstep(-0.85, 0.05, uv.x);
  return col;
}

/* mode 1 — entropy. Sparse columns of cells raining downward, each cell
   a hash of (column, row) — pulse-time scrolls the rows. */
vec3 modeEntropy(vec2 uv, float t, float bloom) {
  float cx    = floor((uv.x + 2.0) * 48.0);
  float h0    = hash(vec2(cx, 7.31));
  float speed = 0.4 + h0 * 1.3;
  float y     = uv.y * 14.0 + t * 0.8 * speed + h0 * 53.0;
  float row   = mod(floor(y), 256.0);

  float cell = hash(vec2(cx, row));
  float on   = step(0.76, cell) * step(0.35, hash(vec2(cx, 1.7)));
  float glow = on * (0.18 + 0.82 * pow(hash(vec2(cx, row + 101.0)), 2.0))
             * (0.55 + 0.45 * fract(y));

  float band = (1.0 - smoothstep(0.34, 0.60, abs(uv.y)))
             * (1.0 - smoothstep(0.95, 1.30, abs(uv.x)));

  vec3 col = STREAM * glow * band * (0.50 + 0.28 * bloom);
  col += SHOCK * glow * band * step(0.97, cell) * 0.35; /* rare hot cells */
  return col;
}

/* mode 2 — plasma. Differentially-rotated flux streamlines concentrated
   in a ring, dim core glow. Angular seam avoided via cos/sin embedding. */
vec3 modePlasma(vec2 uv, float t, float bloom) {
  float r  = length(uv);
  float an = atan(uv.y, uv.x) + t * 0.05 + r * 2.4;
  vec2  q  = vec2(cos(an), sin(an)) * (1.0 + r * 2.2);

  float psi   = fbm(q * 1.7 + vec2(t * 0.020, 0.0));
  float lines = pow(1.0 - smoothstep(0.0, 0.06, abs(fract(psi * 6.0) - 0.5)), 2.2);
  float ring  = exp(-pow((r - 0.40) * 5.5, 2.0));
  float core  = exp(-r * r * 18.0);

  return STREAM * lines * ring * (0.80 + 0.25 * bloom)
       + SHOCK  * ring  * 0.10
       + STREAM * core  * 0.22;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res.xy) / u_res.y;

  float phase = clamp(u_pulse_phase, 0.0, 1.0);
  /* pulse-time: continuous across a receipt (id+1 at phase 0 follows id
     at phase 1), frozen when phase clamps. Wrapped for hash precision. */
  float t = mod(u_pulse_id, 2048.0) + phase;
  /* receipt bloom: bright the instant a pulse lands, decayed by phase 1.
     If no pulse arrives, there is nothing to bloom — honest by shape. */
  float bloom = exp(-4.0 * phase);

  vec3 col = BASE;
  if      (u_mode == 1) col += modeEntropy(uv, t, bloom);
  else if (u_mode == 2) col += modePlasma(uv, t, bloom);
  else                  col += modeHome(uv, t, phase, bloom);

  float vign = 1.0 - smoothstep(0.45, 1.15, length(uv * vec2(0.65, 1.0)));
  col *= 0.40 + 0.60 * vign;

  /* grain — deterministic, re-seeded per pulse, static in between */
  float g = hash(gl_FragCoord.xy + vec2(mod(u_pulse_id, 64.0)));
  col += (g - 0.5) * 0.010;

  fragColor = vec4(col, 1.0);
}
