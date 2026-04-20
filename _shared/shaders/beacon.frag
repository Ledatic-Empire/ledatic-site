#version 300 es
precision highp float;

// Ledatic /entropy — concentric plasma pulses from a central source.
// Tick-anchored: the beacon emits a bright ring every ~2 seconds,
// echoing the entropy pulse cadence.

uniform vec2  u_res;
uniform float u_time;
out vec4 fragColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(41.7, 79.3))) * 43758.5453); }

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res.xy) / u_res.y;

  float r = length(uv);
  float a = atan(uv.y, uv.x);

  // Pulse rings — emitted every 4s (display-only; actual beacon still 2s),
  // travel outward, fade with distance.
  float rings = 0.0;
  for (int i = 0; i < 6; i++) {
    float age = mod(u_time - float(i) * 0.66, 4.0);
    float radius = age * 0.375;
    float thickness = 0.02 + age * 0.0075;
    float intensity = smoothstep(thickness, 0.0, abs(r - radius));
    float fade = 1.0 - (age / 4.0);
    rings += intensity * fade * 0.65;
  }

  // Angular noise — static-like texture on each ring.
  float nstatic = hash(vec2(floor(a * 40.0), floor(u_time * 4.0)));
  rings *= 0.85 + 0.15 * nstatic;

  // Central core
  float core = exp(-r * r * 18.0) * (0.7 + 0.3 * sin(u_time * 3.0));

  vec3 green = vec3(0.14, 1.05, 0.18);
  vec3 bg    = vec3(0.031, 0.036, 0.033);

  vec3 col = bg + green * (rings * 0.8 + core * 1.4);

  // Vignette + gentle scanline
  col *= 1.0 - 0.42 * r;
  float scan = 0.94 + 0.06 * sin(gl_FragCoord.y * 2.0 + u_time * 2.0);
  col *= scan;

  // Dim overall — reads quieter behind content.
  col *= 0.55;

  col = col / (1.0 + col);
  col = pow(col, vec3(0.92));
  fragColor = vec4(col, 1.0);
}
