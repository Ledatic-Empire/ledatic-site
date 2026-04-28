#version 300 es
precision highp float;

// Ledatic — kaleidoscope porthole, CRT-green palette.
// Radial spokes + concentric arcs folded through k-fold symmetry,
// peered down a corridor of mirrored dark eyes that recede toward
// a vanishing point at the center. Procedural recreation of an
// in-the-wild infinity-mirror installation, rendered at the same
// hue band as the rest of the site.

uniform vec2  u_res;
uniform float u_time;
uniform vec2  u_mouse;
out vec4 fragColor;

const float K_FOLD = 16.0;   // visible radial spokes
const float CELLS  = 14.0;   // concentric tunnel stations
const vec3  CORE   = vec3(0.20, 0.96, 0.40);
const vec3  RIM    = vec3(0.30, 1.00, 0.55);

// Inverse-radius depth coordinate gives evenly spaced
// "stations" along a receding tunnel — the kaleidoscope effect.
float lattice(vec2 uv, float t) {
  float r = length(uv) + 1e-4;
  float a = atan(uv.y, uv.x);

  float depth = log(1.0 / r) + t * 0.16;

  // k-fold radial spokes, sharpened into thin bright lines.
  float spokes = abs(sin(a * K_FOLD));
  spokes = pow(spokes, 14.0);

  // Concentric arcs along the tunnel depth.
  float arcs = abs(sin(depth * CELLS));
  arcs = pow(arcs, 12.0);

  // Cross-grid at half scale — finer cell structure.
  float fine = abs(sin(a * K_FOLD * 2.0)) * abs(sin(depth * CELLS * 2.0));
  fine = pow(fine, 6.0) * 0.40;

  return max(spokes, max(arcs, fine));
}

// Horizontal infinity-mirror corridor of dark spheres along y=0,
// exponentially shrinking toward the center vanishing point.
float eyes(vec2 uv) {
  float dark = 0.0;
  for (int i = -2; i <= 2; i++) {
    float fi = float(i);
    float ax = sign(fi) * (1.0 - exp2(-abs(fi) * 0.70)) * 0.42;
    float sz = 0.072 * exp2(-abs(fi) * 0.45);
    float r  = length(uv - vec2(ax, 0.0));
    dark = max(dark, 1.0 - smoothstep(sz * 0.80, sz, r));
  }
  // Central black marble — anchor of the chain.
  float ctr = 1.0 - smoothstep(0.026, 0.046, length(uv));
  return max(dark, ctr);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res.xy) / u_res.y;
  // Subtle cursor parallax — tracks but never dominates.
  uv -= u_mouse * 0.025;

  float r = length(uv);
  float t = u_time;

  float iris  = 1.0 - smoothstep(0.50, 0.55, r);
  float bezel = smoothstep(0.55, 0.62, r) * (1.0 - smoothstep(0.62, 0.70, r));

  float L = lattice(uv, t);
  float E = eyes(uv);

  // Lattice color shifts from CORE near center to RIM at the edge of the disk.
  vec3 col = mix(CORE, RIM, smoothstep(0.0, 1.0, r * 1.8)) * L;
  col *= 1.0 - E * 0.96;                                              // dark spheres
  col += CORE * 0.07 * (1.0 - smoothstep(0.0, 0.50, r));               // tunnel haze
  col *= iris;                                                         // mask to porthole
  col += CORE * 0.18 * bezel;                                          // bezel ring

  // Outer surround: cool deep tint fading to black.
  vec3 surround = vec3(0.004, 0.012, 0.018);
  col = mix(surround, col, iris + bezel * 0.6);

  float v = 1.0 - smoothstep(0.65, 1.10, length(uv));
  col *= 0.6 + 0.4 * v;

  // Faint grain to match the rest of the site.
  float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (grain - 0.5) * 0.014;

  fragColor = vec4(col, 1.0);
}
