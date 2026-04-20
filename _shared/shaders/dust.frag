#version 300 es
precision highp float;

// Ledatic generic — slow drifting green dust over charcoal void.
// Low-intensity, good default for content-heavy pages.

uniform vec2  u_res;
uniform float u_time;
out vec4 fragColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

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

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res.xy) / u_res.y;

  // Two noise octaves drifting at different speeds.
  float n1 = noise(uv * 3.0 + vec2(u_time * 0.03, u_time * 0.02));
  float n2 = noise(uv * 8.0 - vec2(u_time * 0.05, u_time * 0.04));
  float dust = (n1 * 0.6 + n2 * 0.4);

  // Threshold — only bright peaks visible.
  dust = smoothstep(0.62, 0.88, dust);

  vec3 col = vec3(0.031, 0.036, 0.033);
  col += vec3(0.08, 0.72, 0.11) * dust * 0.35;

  col *= 1.0 - 0.38 * length(uv);
  col = col / (1.0 + col);
  col = pow(col, vec3(0.92));
  fragColor = vec4(col, 1.0);
}
