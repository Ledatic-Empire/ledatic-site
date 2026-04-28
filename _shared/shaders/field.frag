#version 300 es
precision highp float;

// Ledatic home hero — 2D field plot.
// A scalar stream function ψ rendered as contour streamlines, with
// sharp shock fronts where the high-frequency component peaks. The
// physics lives in a narrow horizontal band; the rest of the frame
// stays dark and quiet, with the field whispering through. Restraint
// composition. Same physics class the plasma page renders live.

uniform vec2  u_res;
uniform float u_time;
uniform vec2  u_mouse;
out vec4 fragColor;

const vec3 BASE   = vec3(0.003, 0.010, 0.006);
const vec3 STREAM = vec3(0.10, 0.78, 0.25);
const vec3 SHOCK  = vec3(0.45, 1.15, 0.60);

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i + vec2(0,0)), hash(i + vec2(1,0)), f.x),
    mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
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

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res.xy) / u_res.y;
  float t = u_time;

  // Field-space coords — slow horizontal drift + tiny cursor parallax.
  vec2 p = uv * 2.6 + vec2(t * 0.015, t * 0.008) + u_mouse * 0.06;

  // Stream function: two-scale fbm.
  float psi = fbm(p) + 0.42 * fbm(p * 3.4 + vec2(t * 0.012, 0));

  // Streamlines — thin curves where ψ crosses integer levels.
  float lvl = psi * 7.0;
  float streams = 1.0 - smoothstep(0.0, 0.055, abs(fract(lvl) - 0.5));
  streams = pow(streams, 2.5);

  // Shock fronts — sharp peaks of a higher-octave field, weighted to
  // appear only where the main stream function is also strong.
  float shock_field = fbm(p * 6.5 - vec2(t * 0.020, t * 0.005));
  float shocks = smoothstep(0.70, 0.86, shock_field);
  shocks *= smoothstep(0.30, 0.66, psi);

  // Restraint: structure is bright only inside a narrow horizontal band.
  // Edges of the frame fade hard to dark.
  float band_y = 1.0 - smoothstep(0.30, 0.55, abs(uv.y + 0.04));
  float band_x = 1.0 - smoothstep(0.85, 1.20, abs(uv.x));
  float band = band_y * band_x;

  // Compose.
  vec3 col = BASE;
  col += STREAM * streams * band * 0.55;
  col += SHOCK  * shocks  * band * 0.95;

  // Whisper outside the band — same streamlines, near-invisible. Implies
  // the field is everywhere; we're just looking at a slice of it.
  float whisper = (1.0 - smoothstep(0.55, 0.95, abs(uv.y))) * (1.0 - band_y);
  col += STREAM * streams * whisper * 0.05;

  // Outer vignette to deep black at the corners.
  float vign = 1.0 - smoothstep(0.45, 1.15, length(uv * vec2(0.65, 1.0)));
  col *= 0.40 + 0.60 * vign;

  // Faint film grain.
  float g = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (g - 0.5) * 0.010;

  fragColor = vec4(col, 1.0);
}
