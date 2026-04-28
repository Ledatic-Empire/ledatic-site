#version 300 es
precision highp float;

// Ledatic — kaleidoscope porthole, magenta-violet variant.
// Same geometry as porthole.frag (radial spokes, concentric arcs,
// infinity-mirror corridor of dark eyes), warm palette swap. Pairs
// with the green version the way the two photographic references
// did — same chamber, different lamp.

uniform vec2  u_res;
uniform float u_time;
uniform vec2  u_mouse;
out vec4 fragColor;

const float K_FOLD = 16.0;
const float CELLS  = 14.0;
const vec3  CORE   = vec3(0.96, 0.34, 0.84);
const vec3  RIM    = vec3(1.00, 0.62, 0.95);

float lattice(vec2 uv, float t) {
  float r = length(uv) + 1e-4;
  float a = atan(uv.y, uv.x);

  float depth = log(1.0 / r) + t * 0.16;

  float spokes = abs(sin(a * K_FOLD));
  spokes = pow(spokes, 14.0);

  float arcs = abs(sin(depth * CELLS));
  arcs = pow(arcs, 12.0);

  float fine = abs(sin(a * K_FOLD * 2.0)) * abs(sin(depth * CELLS * 2.0));
  fine = pow(fine, 6.0) * 0.40;

  return max(spokes, max(arcs, fine));
}

float eyes(vec2 uv) {
  float dark = 0.0;
  for (int i = -2; i <= 2; i++) {
    float fi = float(i);
    float ax = sign(fi) * (1.0 - exp2(-abs(fi) * 0.70)) * 0.42;
    float sz = 0.072 * exp2(-abs(fi) * 0.45);
    float r  = length(uv - vec2(ax, 0.0));
    dark = max(dark, 1.0 - smoothstep(sz * 0.80, sz, r));
  }
  float ctr = 1.0 - smoothstep(0.026, 0.046, length(uv));
  return max(dark, ctr);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res.xy) / u_res.y;
  uv -= u_mouse * 0.025;

  float r = length(uv);
  float t = u_time;

  float iris  = 1.0 - smoothstep(0.50, 0.55, r);
  float bezel = smoothstep(0.55, 0.62, r) * (1.0 - smoothstep(0.62, 0.70, r));

  float L = lattice(uv, t);
  float E = eyes(uv);

  vec3 col = mix(CORE, RIM, smoothstep(0.0, 1.0, r * 1.8)) * L;
  col *= 1.0 - E * 0.96;
  col += CORE * 0.06 * (1.0 - smoothstep(0.0, 0.50, r));
  col *= iris;
  col += CORE * 0.16 * bezel;

  // Slightly warmer surround than the green version.
  vec3 surround = vec3(0.018, 0.006, 0.024);
  col = mix(surround, col, iris + bezel * 0.6);

  float v = 1.0 - smoothstep(0.65, 1.10, length(uv));
  col *= 0.6 + 0.4 * v;

  float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (grain - 0.5) * 0.014;

  fragColor = vec4(col, 1.0);
}
