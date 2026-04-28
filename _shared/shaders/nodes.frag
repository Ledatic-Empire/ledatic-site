#version 300 es
precision highp float;

// Ledatic — fleet nodes wall (alien revision).
// Six pulsing eyes set into a soft organic surface. Each eye drifts
// around its nominal position, watches something specific (the cursor,
// another eye, or nothing in particular), and pulses on incommensurate
// rhythms so the timing never settles. Two of them have vertical slit
// pupils. Faint tendrils connect specific pairs, modulating in and out.
// Rare flicks break the calm.

uniform vec2  u_res;
uniform float u_time;
uniform vec2  u_mouse;
out vec4 fragColor;

const vec3 CORE   = vec3(0.20, 0.96, 0.40);
const vec3 SHADOW = vec3(0.004, 0.012, 0.018);
const int  N_NODES = 6;

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

// Nominal position + base phase per node.
vec3 node_seed(int i) {
  if (i == 0) return vec3(-0.62,  0.30, 0.00);
  if (i == 1) return vec3( 0.05,  0.40, 1.30);
  if (i == 2) return vec3( 0.68,  0.26, 2.50);
  if (i == 3) return vec3(-0.40, -0.22, 0.70);
  if (i == 4) return vec3( 0.30, -0.30, 1.90);
  if (i == 5) return vec3( 0.75, -0.42, 0.45);
  return vec3(0.0);
}

// Watch target per node: -1 = cursor, -2 = drift independently, 0..5 = another node.
int watch_target(int i) {
  if (i == 0) return -1;
  if (i == 1) return  4;
  if (i == 2) return -2;
  if (i == 3) return -1;
  if (i == 4) return  2;
  if (i == 5) return -2;
  return -2;
}

// Drifted position at time t — low-frequency 2D noise around the nominal.
vec2 node_pos(int i, float t) {
  vec2 nominal = node_seed(i).xy;
  vec2 drift = vec2(
    noise(vec2(float(i) * 17.3,        t * 0.06)),
    noise(vec2(float(i) * 23.1 + 99.7, t * 0.07))
  );
  return nominal + (drift * 2.0 - 1.0) * 0.06;
}

// Pupil offset within the iris — toward whatever this eye is watching.
vec2 pupil_offset(int i, float t, vec2 cursor_uv) {
  int tgt = watch_target(i);
  vec2 me = node_pos(i, t);
  vec2 dir;
  if (tgt == -1) {
    dir = cursor_uv - me;
  } else if (tgt == -2) {
    dir = vec2(sin(t * 0.31 + float(i) * 1.7), cos(t * 0.27 + float(i) * 2.3));
  } else if (tgt == 0) { dir = node_pos(0, t) - me; }
  else if (tgt == 1) { dir = node_pos(1, t) - me; }
  else if (tgt == 2) { dir = node_pos(2, t) - me; }
  else if (tgt == 3) { dir = node_pos(3, t) - me; }
  else if (tgt == 4) { dir = node_pos(4, t) - me; }
  else               { dir = node_pos(5, t) - me; }
  if (length(dir) > 0.001) dir = normalize(dir);
  return dir * 0.020;
}

// Non-sinusoidal pulse: two sins at incommensurate freqs + noise envelope.
float pulse(int i, float t) {
  float p = node_seed(i).z;
  float a = 0.5 + 0.5 * sin(t * 0.43 + p);
  float b = 0.5 + 0.5 * sin(t * 0.71 + p * 1.7);
  float env = noise(vec2(float(i), t * 0.18));
  return mix(a, b, 0.5) * (0.55 + 0.45 * env);
}

float seg_dist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res.xy) / u_res.y;
  uv -= u_mouse * 0.018;
  float t = u_time;

  // Wavy organic backdrop — soft cave-wall feel.
  float wall = noise(uv * 1.7 + vec2(t * 0.04, t * 0.03));
  wall += 0.50 * noise(uv * 4.2 - vec2(t * 0.07, 0.0));
  wall = wall * 0.5 - 0.10;
  vec3 col = SHADOW + vec3(wall * 0.020, wall * 0.026, wall * 0.022);

  // Cursor in the same coord space the nodes live in (rough).
  vec2 cursor_uv = u_mouse * 0.6;

  // Tendrils between specific pairs. Each pulses on its own rhythm.
  for (int k = 0; k < 5; k++) {
    int a, b;
    if      (k == 0) { a = 0; b = 1; }
    else if (k == 1) { a = 1; b = 2; }
    else if (k == 2) { a = 1; b = 3; }
    else if (k == 3) { a = 3; b = 4; }
    else             { a = 4; b = 5; }

    vec2 pa = node_pos(a, t);
    vec2 pb = node_pos(b, t);
    float d = seg_dist(uv, pa, pb);
    float on = 0.5 + 0.5 * sin(t * (0.30 + float(k) * 0.07) + float(k));
    on = smoothstep(0.40, 0.90, on);
    col += CORE * 0.045 * exp(-d * 80.0) * on;
  }

  // Stamp each eye onto the wall.
  for (int i = 0; i < N_NODES; i++) {
    vec2 c = node_pos(i, t);
    vec2 p = uv - c;
    float r = length(p);

    float pls = pulse(i, t);
    float radius = 0.078 + 0.014 * pls;

    float halo = exp(-pow(r / (radius * 4.5), 2.0)) * (0.50 + 0.40 * pls);
    float disk = smoothstep(radius, radius * 0.70, r);
    col += CORE * halo * 0.18;
    col += CORE * disk * (0.65 + 0.30 * pls);

    // Pupil — offset toward whatever this eye watches.
    vec2 po = pupil_offset(i, t, cursor_uv);
    vec2 pp = p - po;
    float pr = (i == 2 || i == 5)
      ? length(vec2(pp.x * 3.0, pp.y))   // vertical slit
      : length(pp);                       // round pupil
    float pupil = smoothstep(radius * 0.34, radius * 0.18, pr);
    col *= 1.0 - pupil * 0.92;

    // Rare flick — every ~8 seconds, a single eye spikes brighter.
    float flick = step(0.985, hash(vec2(float(i), floor(t * 0.12))));
    col += CORE * disk * flick * 0.35;
  }

  // Vignette
  float v = 1.0 - smoothstep(0.65, 1.10, length(uv));
  col *= 0.55 + 0.45 * v;

  // Film grain
  float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (grain - 0.5) * 0.012;

  fragColor = vec4(col, 1.0);
}
