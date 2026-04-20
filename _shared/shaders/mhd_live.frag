#version 300 es
precision highp float;

// Ledatic /plasma — LIVE MHD frame sampler.
// Samples the R8 density texture uploaded from /entropy/frame/current
// and applies the canonical Ledatic green colormap.

uniform vec2      u_res;
uniform float     u_time;
uniform sampler2D u_frame;
out vec4 fragColor;

void main() {
  vec2 uv = gl_FragCoord.xy / u_res.xy;

  // Density channel (R8 texture, u_frame)
  float d = texture(u_frame, uv).r;

  // Gentle temporal smoothing hint via sin — still static between frames
  // but pushes a tiny shimmer so the viewport never looks frozen.
  d += 0.018 * sin(u_time * 0.7 + uv.y * 22.0 + uv.x * 17.0);
  d = clamp(d, 0.0, 1.0);

  // 4-stop green colormap
  vec3 c0 = vec3(0.018, 0.040, 0.022);
  vec3 c1 = vec3(0.030, 0.320, 0.045);
  vec3 c2 = vec3(0.180, 0.950, 0.240);
  vec3 c3 = vec3(0.720, 1.100, 0.780);
  vec3 col;
  if (d < 0.33)      col = mix(c0, c1, d / 0.33);
  else if (d < 0.66) col = mix(c1, c2, (d - 0.33) / 0.33);
  else               col = mix(c2, c3, (d - 0.66) / 0.34);

  col *= 1.0 - 0.26 * length(uv - 0.5);
  col = col / (1.0 + col);
  col = pow(col, vec3(0.92));
  fragColor = vec4(col, 1.0);
}
