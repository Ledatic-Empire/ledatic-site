#version 300 es
precision highp float;

// Ledatic — fleet horizon (revised).
// Six tapered monoliths receding into a green sandstorm. Vertical
// ribbing + horizontal floor-banding break the flat silhouettes;
// the hero monolith carries a column of lit apertures with a
// vertical beam climbing from its peak. Two-layer haze: fine grain
// + slow atmospheric drift. Slow horizontal pan with depth parallax.
// Dune-Villeneuve geometry through a Neuromancer LUT.

uniform vec2  u_res;
uniform float u_time;
uniform vec2  u_mouse;
out vec4 fragColor;

const vec3 CORE    = vec3(0.20, 0.96, 0.40);
const vec3 DUST    = vec3(0.45, 0.85, 0.55);
const vec3 SKY_HI  = vec3(0.004, 0.014, 0.009);
const vec3 SKY_LO  = vec3(0.022, 0.082, 0.040);
const vec3 SURFACE = vec3(0.002, 0.008, 0.005);
const vec3 DEEP    = vec3(0.001, 0.003, 0.002);
const float HORIZON = -0.08;
const float PI = 3.14159265;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p *= 2.05;
    a *= 0.50;
  }
  return v;
}

// vec3(x_center, height, depth_0_to_1).
vec3 slab(int i) {
  if (i == 0) return vec3(-1.10, 0.45, 0.88);
  if (i == 1) return vec3(-0.55, 0.62, 0.32);
  if (i == 2) return vec3(-0.06, 0.92, 0.06);   // hero — tallest, closest
  if (i == 3) return vec3( 0.34, 0.54, 0.58);
  if (i == 4) return vec3( 0.84, 0.38, 0.92);
  if (i == 5) return vec3( 1.25, 0.56, 0.45);
  return vec3(0.0);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res.xy) / u_res.y;
  float t = u_time;

  float pan = t * 0.012 + u_mouse.x * 0.020;

  // ── Sky ──
  float sky_t = clamp((uv.y - HORIZON) / 0.65, 0.0, 1.0);
  vec3 col = mix(SKY_LO, SKY_HI, smoothstep(0.0, 1.0, sky_t));

  // ── Haze: two layers ──
  // Fine grain — high frequency, drifts horizontally with the wind.
  float grain = fbm(vec2(uv.x * 11.0 - pan * 6.0, uv.y * 9.0 + t * 0.22));
  grain = smoothstep(0.42, 0.88, grain);
  col += DUST * 0.038 * grain * (1.0 - sky_t * 0.70);
  // Slow atmospheric drift — large soft masses.
  float drift = fbm(vec2(uv.x * 1.4 - pan * 1.0, uv.y * 1.0 + t * 0.04));
  drift = smoothstep(0.32, 0.80, drift);
  col += DUST * 0.022 * drift * (1.0 - sky_t * 0.85);

  // Faint horizontal wind banding low in the sky.
  float wind = 0.5 + 0.5 * sin(uv.y * 58.0 + t * 1.10 - pan * 8.0);
  col += vec3(0.004, 0.016, 0.009) * wind * (1.0 - sky_t);

  // ── Ground ──
  if (uv.y < HORIZON) {
    float gd = clamp((HORIZON - uv.y) / 0.65, 0.0, 1.0);
    col = mix(SURFACE, DEEP, smoothstep(0.0, 1.0, gd));
    float ripple = 0.5 + 0.5 * sin(uv.x * 14.0 - pan * 3.5 + uv.y * 36.0);
    col += vec3(0.003, 0.012, 0.006) * ripple * (1.0 - gd);
  }

  // ── Backlight halo behind hero ──
  vec3 hero = slab(2);
  float backlight = exp(-pow(length(uv - vec2(hero.x + pan * 0.3, HORIZON + 0.22)) * 2.0, 2.0));
  col += vec3(0.05, 0.22, 0.12) * backlight;

  // ── Render slabs back-to-front: 4, 0, 5, 3, 1, 2 ──
  const int ORDER[6] = int[](4, 0, 5, 3, 1, 2);
  for (int k = 0; k < 6; k++) {
    int idx = ORDER[k];
    vec3 s = slab(idx);
    float cx = s.x;
    float h  = s.y;
    float depth = s.z;

    vec2 puv = uv;
    puv.x += pan * (1.0 - depth * 0.70);

    float top_y = HORIZON + h * (1.0 - depth * 0.45);
    float base_w = 0.045 + 0.020 * (1.0 - depth);

    // Vertical position within slab (0 = base, 1 = top)
    float vy = (puv.y - HORIZON) / max(top_y - HORIZON, 1e-4);

    // Taper inward toward the top — trapezoid, not rectangle.
    float w = base_w * (1.0 - vy * 0.20);

    // Silhouette mask (soft edges so they don't alias).
    float in_y = smoothstep(HORIZON - 0.001, HORIZON + 0.001, puv.y)
               * (1.0 - smoothstep(top_y - 0.0015, top_y + 0.0015, puv.y));
    float in_x = 1.0 - smoothstep(w - 0.0015, w + 0.0015, abs(puv.x - cx));
    float silhouette = in_y * in_x;
    if (silhouette < 0.001) continue;

    // Local coordinates within the slab.
    float lx = (puv.x - cx) / max(w, 1e-4);     // -1..1 across width
    float ly = clamp(vy, 0.0, 1.0);             // 0..1 up height

    // Vertical ribbing — bright pin-stripes (backlit ridges).
    int n_ribs = (idx == 2) ? 11 : 7;
    float ribs = pow(abs(sin(lx * float(n_ribs) * PI)), 8.0);

    // Horizontal floor-banding — thin dim lines every ~10% of height.
    float bands = pow(abs(sin(ly * 10.0 * PI)), 32.0);

    // Slab body colour — subtle vertical gradient (darker at top).
    float body_grad = mix(0.30, 0.10, ly);
    vec3 body = mix(DEEP, col, depth * 0.55);
    body = mix(body, body * 0.6, body_grad * 0.4);

    // Apply ribbing as a faint backlit highlight.
    body += CORE * ribs * 0.05 * (1.0 - depth);
    // Floor bands as faint dark separators.
    body *= 1.0 - bands * 0.25;

    col = mix(col, body, silhouette);

    // Apertures.
    if (idx == 2) {
      // Hero: column of 5 apertures up the height.
      for (int win = 0; win < 5; win++) {
        float fy = 0.30 + float(win) * 0.13;   // 0.30 .. 0.82
        float ay = HORIZON + h * fy * (1.0 - depth * 0.45);
        float ah = 0.010;
        float aw = base_w * 0.28 * (1.0 - fy * 0.20);
        vec2 ad = vec2(abs(puv.x - cx) - aw, abs(puv.y - ay) - ah);
        float aedge = max(ad.x, ad.y);
        float ap = 1.0 - smoothstep(-0.0010, 0.0010, aedge);
        float pulse = 0.55 + 0.45 * sin(t * (0.50 + float(win) * 0.09) + float(win) * 1.7);
        col += CORE * ap * pulse * 1.2;
      }
    } else {
      // Other slabs: one aperture, ~55% up.
      float ay = HORIZON + h * 0.55 * (1.0 - depth * 0.45);
      float ah = 0.012;
      float aw = base_w * 0.30 * (1.0 - 0.55 * 0.20);
      vec2 ad = vec2(abs(puv.x - cx) - aw, abs(puv.y - ay) - ah * 0.5);
      float aedge = max(ad.x, ad.y);
      float ap = 1.0 - smoothstep(-0.0010, 0.0010, aedge);
      float pulse = 0.55 + 0.45 * sin(t * (0.45 + float(idx) * 0.07) + float(idx) * 1.3);
      col += CORE * ap * pulse * (1.5 - depth);
    }
  }

  // ── Vertical beam from the hero peak ──
  vec2 huv = uv;
  huv.x += pan * (1.0 - hero.z * 0.70);
  float beam_d = abs(huv.x - hero.x);
  float beam_top  = HORIZON + hero.y * 1.85;
  float beam_base = HORIZON + hero.y * 0.35 * (1.0 - hero.z * 0.45);
  if (huv.y > beam_base && huv.y < beam_top) {
    float falloff = 1.0 - (huv.y - beam_base) / (beam_top - beam_base);
    float core_beam = exp(-beam_d * 130.0) * pow(falloff, 1.4);
    float wide_beam = exp(-beam_d * 20.0)  * pow(falloff, 2.6) * 0.20;
    col += CORE * (core_beam * 0.65 + wide_beam);
  }

  // ── Drifting motes ──
  float motes = 0.0;
  for (int m = 0; m < 4; m++) {
    float fm = float(m);
    vec2 mp = vec2(
      uv.x * 38.0 + pan * (5.0 + fm * 1.4) + fm * 11.0,
      uv.y * 16.0 + sin(t * 0.22 + fm) * 0.6
    );
    motes += step(0.987, hash(floor(mp)));
  }
  col += DUST * 0.10 * motes;

  // Letterbox vignette.
  float vign = 1.0 - smoothstep(0.50, 1.20, length(uv * vec2(0.55, 1.05)));
  col *= 0.55 + 0.45 * vign;

  // Faintest CRT scanline.
  col *= 0.985 + 0.015 * sin(gl_FragCoord.y * 1.30);

  // Film grain
  float fg = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (fg - 0.5) * 0.011;

  fragColor = vec4(col, 1.0);
}
