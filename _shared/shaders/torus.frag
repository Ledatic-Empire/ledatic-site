#version 300 es
precision highp float;

// Ledatic home hero — tokamak plasma torus.
// Raymarched SDF donut whose surface is textured with helical
// magnetic flux ropes: bright bands that wrap toroidally and
// poloidally with a safety factor q ≈ 2.5, drifting in time.
// Same silhouette and camera as before; the surface story is
// now magnetohydrodynamics rather than abstract noise.

uniform vec2  u_res;
uniform float u_time;
uniform vec2  u_mouse;
out vec4 fragColor;

const float R_MAJOR = 0.85;     // big-ring radius
const float R_MINOR = 0.26;     // tube radius
const float Q       = 2.5;      // safety factor — toroidal turns per poloidal turn
const float N_ROPES = 5.0;      // number of major flux ropes
const float PI      = 3.14159265;

float sdTorus(vec3 p, vec2 t) {
  vec2 q = vec2(length(p.xz) - t.x, p.y);
  return length(q) - t.y;
}

float hash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3(i + vec3(0,0,0)), hash3(i + vec3(1,0,0)), f.x),
        mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x),
        mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res.xy) / u_res.y;

  float ct = u_time * 0.08;
  vec3 ro = vec3(3.1 * cos(ct), 0.9 + 0.15 * sin(ct * 0.7), 3.1 * sin(ct));
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
    float d = sdTorus(p, vec2(R_MAJOR, R_MINOR));
    glow += 0.0028 / (0.04 + abs(d));
    if (d < 0.001) {
      // Toroidal angle (around big ring).
      float phi = atan(p.z, p.x);
      // Poloidal angle (around tube cross-section).
      float r_xz = length(p.xz);
      vec2  q_pol = vec2(r_xz - R_MAJOR, p.y);
      float theta = atan(q_pol.y, q_pol.x);

      // Helical phase: lines of constant phase = magnetic flux surfaces.
      // Drifts slowly in time so the field rotates toroidally.
      float phase = theta - phi / Q + u_time * 0.30;

      // Primary flux ropes — N_ROPES bright helical bands wrapping the torus.
      float ropes = 0.5 + 0.5 * sin(phase * N_ROPES);
      ropes = pow(ropes, 4.0);

      // Secondary fine structure (higher harmonic, opposite drift direction).
      float fine = 0.5 + 0.5 * sin(phase * 12.0 - u_time * 0.45);
      fine = pow(fine, 9.0) * 0.35;

      // Instability perturbation — small irregular wobble in the field.
      float perturb = noise3(vec3(phi * 3.5, theta * 4.5, u_time * 0.20));
      perturb = (perturb - 0.5) * 0.30;

      // Equatorial midplane brightening (where field strength peaks).
      float midplane = exp(-pow(p.y * 4.0, 2.0)) * 0.18;

      float intensity = clamp(ropes + fine + perturb + midplane, 0.0, 1.2);

      vec3 deep = vec3(0.006, 0.055, 0.014);
      vec3 hot  = vec3(0.18,  1.10,  0.32);
      col = mix(deep, hot, intensity);
      hit = true;
      break;
    }
    if (td > 18.0) break;
    td += d * 0.88;
  }

  // Volumetric haze accumulated along the ray.
  col += vec3(0.03, 0.32, 0.05) * glow * 0.32;

  // Background floor when the ray misses entirely.
  if (!hit) col = max(col, vec3(0.031, 0.036, 0.033));

  // Vignette + tonemap + gamma.
  col *= 1.0 - 0.38 * length(uv);
  col  = col / (1.0 + col);
  col  = pow(col, vec3(0.92));

  fragColor = vec4(col, 1.0);
}
