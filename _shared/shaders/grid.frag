#version 300 es
precision highp float;

// Ledatic /rail — infinite CRT grid receding into a green horizon.
// Terminal-console floor with a slow forward drift.

uniform vec2  u_res;
uniform float u_time;
out vec4 fragColor;

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res.xy) / u_res.y;

  // Perspective project the screen y into a ground plane.
  // y < 0.0 is the floor. Above the horizon is void.
  float horizon = 0.1;
  vec3 col = vec3(0.031, 0.036, 0.033);

  if (uv.y < horizon) {
    float depth = 0.6 / (horizon - uv.y + 0.001);
    // x coordinate in world space, z is depth.
    float wx = uv.x * depth;
    float wz = depth + u_time * 0.6;

    // Grid lines.
    float gx = abs(fract(wx * 2.0) - 0.5);
    float gz = abs(fract(wz * 2.0) - 0.5);
    float line = min(gx, gz);
    float width = 0.02 + 0.002 * depth;
    float grid = smoothstep(width, 0.0, line);

    float fade = exp(-depth * 0.18);
    col += vec3(0.08, 0.95, 0.14) * grid * fade * 0.55;
  }

  // Horizon glow.
  float glow = exp(-abs(uv.y - horizon) * 18.0);
  col += vec3(0.05, 0.6, 0.08) * glow * 0.5;

  // Vignette + scanline.
  col *= 1.0 - 0.35 * length(uv);
  float scan = 0.95 + 0.05 * sin(gl_FragCoord.y * 1.5 + u_time * 3.0);
  col *= scan;

  col = col / (1.0 + col);
  col = pow(col, vec3(0.92));
  fragColor = vec4(col, 1.0);
}
