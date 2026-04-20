#version 300 es
precision highp float;

// Ledatic home hero — raymarched SDF plasma torus.
// Green emissive core, volumetric haze, slow orbital camera.

uniform vec2  u_res;
uniform float u_time;
uniform vec2  u_mouse;
out vec4 fragColor;

float sdTorus(vec3 p, vec2 t) {
  vec2 q = vec2(length(p.xz) - t.x, p.y);
  return length(q) - t.y;
}

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float noise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
        mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
        mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res.xy) / u_res.y;

  float ct = u_time * 0.08;
  vec3 ro = vec3(3.1 * cos(ct), 0.9 + 0.15 * sin(ct * 0.7), 3.1 * sin(ct));
  // Subtle parallax from cursor — tracks but never dominates.
  ro += vec3(u_mouse.x * 0.35, -u_mouse.y * 0.25, 0.0);
  vec3 ta = vec3(0.0);
  vec3 ww = normalize(ta - ro);
  vec3 uu = normalize(cross(vec3(0.0, 1.0, 0.0), ww));
  vec3 vv = cross(ww, uu);
  vec3 rd = normalize(uv.x * uu + uv.y * vv + 1.5 * ww);

  float td = 0.0;
  vec3 col = vec3(0.0);
  float glow = 0.0;
  bool hit = false;

  for (int i = 0; i < 96; i++) {
    vec3 p = ro + rd * td;
    float d = sdTorus(p, vec2(0.85, 0.26));
    glow += 0.0028 / (0.04 + abs(d));
    if (d < 0.001) {
      float ang = atan(p.z, p.x);
      float flow  = noise(vec3(ang * 3.0 + u_time * 0.45, p.y * 2.5, u_time * 0.22));
      float flow2 = noise(vec3(ang * 7.0 - u_time * 0.8,  p.y * 5.0 + u_time * 0.9, 0.0));
      float intensity = clamp(flow * 0.7 + flow2 * 0.55, 0.0, 1.0);
      vec3 deep = vec3(0.01, 0.10, 0.02);
      vec3 hot  = vec3(0.14, 1.05, 0.18);
      col = mix(deep, hot, intensity);
      hit = true;
      break;
    }
    if (td > 18.0) break;
    td += d * 0.88;
  }

  col += vec3(0.03, 0.32, 0.05) * glow * 0.32;
  if (!hit) col = max(col, vec3(0.031, 0.036, 0.033));

  col *= 1.0 - 0.38 * length(uv);
  col  = col / (1.0 + col);
  col  = pow(col, vec3(0.92));

  fragColor = vec4(col, 1.0);
}
