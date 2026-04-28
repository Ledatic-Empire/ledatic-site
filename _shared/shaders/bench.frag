#version 300 es
precision highp float;

// Ledatic — bench wall.
// A 4×2 grid of CRT cells, each running a different procedural
// pattern: noise stations, ring lattice, Worley cells, stripes,
// hex packing, vortex. Bezel borders, CRT curvature, scanlines.
// Inspired by a wall of analog monitors classifying signals;
// tuned for the changelog "ship log" reading.

uniform vec2  u_res;
uniform float u_time;
out vec4 fragColor;

const vec3 CORE   = vec3(0.20, 0.96, 0.40);
const vec3 BEZEL  = vec3(0.03, 0.06, 0.04);
const vec3 SHADOW = vec3(0.004, 0.012, 0.018);

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// Worley / Voronoi cell distance.
float worley(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float md = 8.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 g = vec2(float(dx), float(dy));
      vec2 o = vec2(hash(i + g), hash(i + g + 31.7));
      vec2 d = g + o - f;
      md = min(md, dot(d, d));
    }
  }
  return sqrt(md);
}

// Hex packing: distance to nearest hex center.
float hex(vec2 p) {
  p *= mat2(1.0, 0.0, 0.5, 0.866);
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d = 1e9;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 g = vec2(float(dx), float(dy));
      d = min(d, length(f - g - 0.5));
    }
  }
  return d;
}

float stripes(vec2 p, float t) {
  return 0.5 + 0.5 * sin(p.y * 8.0 + sin(p.x * 5.0 + t * 0.3) * 1.6);
}

float static_(vec2 p, float t) {
  return hash(floor(p * 80.0) + floor(t * 30.0));
}

float vortex(vec2 p, float t) {
  float r = length(p);
  float a = atan(p.y, p.x);
  return 0.5 + 0.5 * sin(a * 5.0 + r * 8.0 - t * 0.6);
}

float rings(vec2 p, float t) {
  return 0.5 + 0.5 * sin(length(p) * 16.0 - t * 0.5);
}

// Cell index → pattern intensity.
float cell_pattern(int idx, vec2 p, float t) {
  if (idx == 0) return static_(p, t);                  // noise
  if (idx == 1) return rings(p, t);                    // ring lattice
  if (idx == 2) return 1.0 - worley(p * 5.0 + t*0.05); // voronoi (inverted)
  if (idx == 3) return stripes(p * 1.4, t);            // stripes
  if (idx == 4) return 1.0 - hex(p * 6.0);             // hex packing
  if (idx == 5) return static_(p * 1.2, t * 0.7);      // static
  if (idx == 6) return vortex(p, t);                   // vortex
  return rings(p * 0.8, t * 1.3);                      // rings (alt)
}

// Subtle CRT pin-cushion curvature within a cell.
vec2 crt_curve(vec2 p) {
  return p + p * 0.08 * dot(p, p);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res.xy) / u_res.y;
  float t = u_time;

  // 4 cols × 2 rows. Slightly wider than tall.
  const vec2 grid = vec2(4.0, 2.0);
  const vec2 cell = vec2(0.32, 0.30);
  vec2 origin = -0.5 * grid * cell;

  vec2 q = uv - origin;
  vec2 idx = floor(q / cell);

  if (idx.x < 0.0 || idx.x >= grid.x || idx.y < 0.0 || idx.y >= grid.y) {
    // Outside the bench: dark surround with faint grain.
    float g = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    fragColor = vec4(SHADOW + (g - 0.5) * 0.010, 1.0);
    return;
  }

  // Local cell coords in [-1, 1]
  vec2 lp = ((q - idx * cell) / cell) * 2.0 - 1.0;

  int cellIdx = int(idx.y) * int(grid.x) + int(idx.x);

  // CRT screen mask + bezel.
  vec2 sp = crt_curve(lp * 1.05);
  float screen = step(max(abs(sp.x), abs(sp.y)), 0.92);
  float bezel_mask =
    step(max(abs(lp.x), abs(lp.y)), 0.98) *
    (1.0 - step(max(abs(sp.x), abs(sp.y)), 0.92));

  float pat = cell_pattern(cellIdx, sp * 1.5, t);

  // Subtle CRT scanline modulation.
  float scan = 0.50 + 0.50 * sin(gl_FragCoord.y * 1.50);
  pat *= 0.82 + 0.18 * scan;

  // Slight per-cell brightness drift, like uneven phosphors.
  float drift = 0.85 + 0.15 * sin(t * 0.30 + float(cellIdx) * 1.7);

  vec3 col = CORE * pat * screen * drift;
  col += BEZEL * bezel_mask;
  // Outside the screen + bezel = surround
  col = mix(SHADOW, col, screen + bezel_mask);

  // Vignette beyond the bench.
  float v = 1.0 - smoothstep(0.95, 1.40, length(uv));
  col *= 0.55 + 0.45 * v;

  // Film grain
  float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (grain - 0.5) * 0.012;

  fragColor = vec4(col, 1.0);
}
