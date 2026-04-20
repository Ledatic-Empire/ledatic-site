#version 300 es
precision highp float;

// Ledatic /plasma viewport — Orszag-Tang-aesthetic 2D MHD turbulence.
// Procedural: four counter-rotating vortex seeds + domain-warped FBM
// noise on top. Not the real solver output, but reads as plasma
// turbulence evolving under the same initial conditions.

uniform vec2  u_res;
uniform float u_time;
out vec4 fragColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res.xy;

  // Orszag-Tang large-scale vortex seed. Two superposed sine sheets
  // that counter-rotate over the full domain.
  float tau = u_time * 0.035;
  float base =
      sin(uv.x * 6.2831 + tau * 1.2) * cos(uv.y * 6.2831 - tau * 0.8) * 0.5
    + cos(uv.x * 3.1415 - tau)       * sin(uv.y * 3.1415 + tau * 1.1) * 0.5;

  // Turbulent overlay — domain-warped FBM. Small vortex cascades.
  vec2 warp = vec2(
    fbm(uv * 3.0 + vec2(0.0, u_time * 0.07)),
    fbm(uv * 3.0 + vec2(5.2, 1.3 - u_time * 0.07))
  );
  float turb = fbm(uv * 5.2 + warp * 1.8 + u_time * 0.035);

  float d = clamp(base * 0.45 + turb * 0.55, 0.0, 1.0);

  // Green colormap in 4 stops.
  vec3 c0 = vec3(0.018, 0.040, 0.022);
  vec3 c1 = vec3(0.030, 0.320, 0.045);
  vec3 c2 = vec3(0.180, 0.950, 0.240);
  vec3 c3 = vec3(0.720, 1.100, 0.780);

  vec3 col;
  if (d < 0.33)      col = mix(c0, c1, d / 0.33);
  else if (d < 0.66) col = mix(c1, c2, (d - 0.33) / 0.33);
  else               col = mix(c2, c3, (d - 0.66) / 0.34);

  // Very soft vignette to let overlay readouts breathe.
  col *= 1.0 - 0.28 * length(uv - 0.5);

  col = col / (1.0 + col);
  col = pow(col, vec3(0.92));
  fragColor = vec4(col, 1.0);
}
