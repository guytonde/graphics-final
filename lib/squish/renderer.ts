import { PARTICLE_RADIUS, SURFACE_CONTACT_HALF_EXTENT, isFlatContactShape } from "./contact";
import { getPoseCenter, getPoseRadius, rotateOffset } from "./orientation";
import { resolveBodyContacts, stepSim } from "./sim-core";
import { buildTerrainMesh, getGroundHeight, GROUND_BASE_Y, GROUND_FLAT_RADIUS } from "./terrain";
import type { Config, Orientation, SimState } from "./types";

const BODY_VS = `#version 300 es
precision highp float;
in vec3 aPosition;
in vec3 aNormal;
uniform mat4 uModel, uView, uProj;
out vec3 vPos, vNorm;
void main() {
  vec4 w = uModel * vec4(aPosition, 1.0);
  gl_Position = uProj * uView * w;
  vPos  = w.xyz;
  vNorm = mat3(uModel) * aNormal;
}`;

const BODY_FS = `#version 300 es
precision highp float;
in vec3 vPos, vNorm;
uniform vec3 uLightDir, uLightColor, uAmbientColor, uFogColor, uCamPos, uColor;
uniform float uAlpha;
out vec4 fragColor;
void main() {
  vec3 N = normalize(vNorm);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(uCamPos - vPos);
  vec3 L = normalize(uLightDir);
  vec3 H = normalize(L + V);
  float diffuse = max(dot(N, L), 0.0);
  float rim = pow(max(1.0 - dot(N, V), 0.0), 2.4);
  float spec = pow(max(dot(H, N), 0.0), 72.0);
  float skyFill = 0.5 + 0.5 * N.y;

  vec3 color = uColor * (uAmbientColor * (0.85 + skyFill * 0.35) + uLightColor * diffuse * 0.88);
  color += uLightColor * spec * 0.34;
  color += vec3(0.32, 0.5, 0.74) * rim * 0.08;

  float fog = smoothstep(18.0, 58.0, distance(vPos, uCamPos));
  color = mix(color, uFogColor, fog);
  fragColor = vec4(color, uAlpha);
}`;

const TERRAIN_VS = `#version 300 es
precision highp float;
in vec3 aPosition;
in vec3 aNormal;
uniform mat4 uView, uProj;
out vec3 vWorldPos, vWorldNorm;
void main() {
  vWorldPos = aPosition;
  vWorldNorm = aNormal;
  gl_Position = uProj * uView * vec4(aPosition, 1.0);
}`;

const TERRAIN_FS = `#version 300 es
precision highp float;
in vec3 vWorldPos, vWorldNorm;
uniform vec3 uLightDir, uLightColor, uAmbientColor, uFogColor, uCamPos;
uniform float uTime;
out vec4 fc;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise21(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);

  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));

  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    value += noise21(p) * amp;
    p = p * 2.03 + vec2(17.1, -9.4);
    amp *= 0.5;
  }
  return value;
}

void main() {
  vec3 N = normalize(vWorldNorm);
  vec3 L = normalize(uLightDir);
  vec2 worldUV = vWorldPos.xz;
  float clearing = 1.0 - smoothstep(${GROUND_FLAT_RADIUS.toFixed(2)}, ${(GROUND_FLAT_RADIUS + 4.0).toFixed(2)}, length(worldUV));

  vec2 macroUV = worldUV * 0.055;
  vec2 tuftUV = mat2(0.84, -0.56, 0.56, 0.84) * (worldUV * 0.68);
  vec2 cloverUV = mat2(0.92, 0.39, -0.39, 0.92) * (worldUV * 0.24);

  float broad = fbm(macroUV);
  float patches = fbm(macroUV * 2.6 + vec2(8.0, 3.0));
  float tuftMask = smoothstep(0.32, 0.8, fbm(tuftUV * 0.95 + vec2(2.0, 11.0)));
  float tuftBands = 0.5 + 0.5 * sin(tuftUV.x * 15.0 + fbm(tuftUV * 0.42) * 5.5);
  float tuftFine = 0.5 + 0.5 * sin(tuftUV.x * 33.0 + tuftUV.y * 6.0);
  float blades = mix(0.88, 1.14, tuftBands * 0.68 + tuftFine * 0.32) * mix(0.84, 1.0, tuftMask);
  float clover = smoothstep(0.56, 0.84, fbm(cloverUV + vec2(5.0, -7.0)));
  float soil = smoothstep(0.63, 0.92, fbm(macroUV * 1.9 - vec2(4.0, 6.0)));
  float blooms = smoothstep(0.7, 0.95, fbm(cloverUV * 3.8 + vec2(-3.0, 12.0)));
  float cloudShadow = 0.88 + 0.12 * fbm(worldUV * 0.028 + vec2(uTime * 0.018, -uTime * 0.011));

  vec3 deepGrass = vec3(0.08, 0.33, 0.12);
  vec3 midGrass = vec3(0.18, 0.49, 0.18);
  vec3 brightGrass = vec3(0.38, 0.68, 0.22);
  vec3 limeGrass = vec3(0.54, 0.74, 0.28);
  vec3 dryGrass = vec3(0.44, 0.41, 0.18);
  vec3 soilColor = vec3(0.3, 0.2, 0.1);

  float lushMix = smoothstep(0.22, 0.82, broad * 0.65 + patches * 0.35);
  vec3 color = mix(deepGrass, brightGrass, lushMix);
  color = mix(color, midGrass, smoothstep(0.28, 0.8, patches));
  color = mix(color, limeGrass, clover * 0.28);
  color = mix(color, dryGrass, soil * 0.22 + (1.0 - N.y) * 0.2);
  color = mix(color, soilColor, soil * 0.14);
  color *= blades;
  color *= cloudShadow;
  color = mix(color, color * 1.08 + vec3(0.02, 0.03, 0.01), clearing * 0.16);
  color += vec3(0.08, 0.06, 0.03) * blooms * clover * 0.045;

  float diffuse = max(dot(N, L), 0.0);
  float back = max(dot(N, -L), 0.0);
  color *= uAmbientColor * (0.95 + N.y * 0.35) + uLightColor * diffuse * 0.8;
  color += color * back * 0.06;

  float fog = smoothstep(26.0, 84.0, distance(vWorldPos, uCamPos));
  color = mix(color, uFogColor, fog);
  fc = vec4(color, 1.);
}`;

const LINE_VS = `#version 300 es
precision highp float;
in vec3 aPosition;
uniform mat4 uMVP;
void main() {
  gl_Position = uMVP * vec4(aPosition, 1.);
}`;

const SKY_VS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(
    gl_VertexID == 1 ? 3.0 : -1.0,
    gl_VertexID == 2 ? 3.0 : -1.0
  );
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const SKY_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec3 uCamForward, uCamRight, uCamUp, uSunDir;
uniform float uAspect, uTanHalfFov, uTime, uSpaceMix;
out vec4 fc;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise21(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);

  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));

  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    sum += noise21(p) * amp;
    p = p * 2.03 + vec2(17.1, -9.4);
    amp *= 0.5;
  }
  return sum;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 ray = normalize(
    uCamForward +
    uCamRight * ndc.x * uAspect * uTanHalfFov +
    uCamUp * ndc.y * uTanHalfFov
  );

  float dayMix = smoothstep(-0.16, 0.18, uSunDir.y);
  float horizonMix = smoothstep(-0.2, 0.42, ray.y);

  vec3 nightHorizon = vec3(0.03, 0.06, 0.12);
  vec3 nightZenith = vec3(0.0, 0.015, 0.05);
  vec3 dayHorizon = vec3(0.84, 0.9, 0.96);
  vec3 dayZenith = vec3(0.19, 0.53, 0.9);

  vec3 sky = mix(mix(nightHorizon, nightZenith, horizonMix), mix(dayHorizon, dayZenith, horizonMix), dayMix);

  float sunAlignment = max(dot(ray, uSunDir), 0.0);
  float sunGlow = pow(sunAlignment, 7.0);
  float sunDisk = smoothstep(0.99955, 1.0, sunAlignment);
  float moonAlignment = max(dot(ray, -uSunDir), 0.0);
  float moonGlow = pow(moonAlignment, 10.0);
  float moonDisk = smoothstep(0.99972, 1.0, moonAlignment);

  float sunsetBand = (1.0 - dayMix) * smoothstep(-0.25, 0.08, uSunDir.y) + dayMix * (1.0 - smoothstep(0.02, 0.24, uSunDir.y));
  sky += vec3(1.0, 0.47, 0.22) * sunGlow * sunsetBand * 0.55;
  sky += vec3(1.0, 0.93, 0.72) * sunDisk * mix(0.35, 1.15, dayMix);
  sky += vec3(0.7, 0.8, 1.0) * moonGlow * (1.0 - dayMix) * 0.22;
  sky += vec3(0.95, 0.98, 1.0) * moonDisk * (1.0 - dayMix) * 0.65;

  vec2 cloudUV = ray.xz / max(ray.y + 0.32, 0.12);
  float cloudField = fbm(cloudUV * 1.25 + vec2(uTime * 0.012, -uTime * 0.006));
  float cloudDetail = fbm(cloudUV * 2.6 - vec2(uTime * 0.02, uTime * 0.009));
  float clouds = smoothstep(0.56, 0.8, cloudField * 0.7 + cloudDetail * 0.3);
  vec3 cloudTint = mix(vec3(0.15, 0.18, 0.24), vec3(1.0, 0.96, 0.9), dayMix);
  sky = mix(sky, mix(cloudTint * 0.7, cloudTint, sunGlow * 0.45 + horizonMix * 0.2), clouds * mix(0.08, 0.24, dayMix));

  vec2 starUV = ray.xz / max(abs(ray.y) + 0.18, 0.18) * 180.0;
  float stars = smoothstep(0.988, 1.0, noise21(floor(starUV) * 0.37));
  stars *= (1.0 - dayMix) * smoothstep(0.0, 0.45, ray.y);
  sky += vec3(0.72, 0.82, 1.0) * stars * 0.8;

  vec3 spaceSky = mix(vec3(0.006, 0.008, 0.02), vec3(0.02, 0.035, 0.08), smoothstep(-0.4, 0.75, ray.y));
  vec3 galaxyAxis = normalize(vec3(-0.32, 0.9, 0.22));
  float galaxyBand = exp(-pow(dot(ray, galaxyAxis), 2.0) * 26.0);
  vec2 galaxyUV = mat2(0.86, -0.52, 0.52, 0.86) * (ray.xz * 8.5 + ray.yy * vec2(4.0, -3.2));
  float nebulaA = fbm(galaxyUV * 0.7 + vec2(uTime * 0.002, -uTime * 0.0015));
  float nebulaB = fbm(galaxyUV * 1.5 - vec2(8.0, 3.0));
  float dust = fbm(galaxyUV * 2.6 + vec2(-5.0, 11.0));
  float deepField = smoothstep(0.9925, 1.0, noise21(floor((ray.xz / max(abs(ray.y) + 0.18, 0.12)) * 320.0) * 0.29));
  float brightField = smoothstep(0.9962, 1.0, noise21(floor((ray.xy / max(abs(ray.z) + 0.2, 0.12)) * 820.0 + 13.0) * 0.17));
  float aurora = smoothstep(0.65, 0.98, fbm(galaxyUV * 0.45 - vec2(2.0, 9.0))) * smoothstep(0.05, 0.78, ray.y);

  spaceSky += vec3(0.55, 0.3, 0.8) * smoothstep(0.45, 0.92, nebulaA) * galaxyBand * 0.8;
  spaceSky += vec3(0.12, 0.55, 0.95) * smoothstep(0.52, 0.95, nebulaB) * galaxyBand * 0.48;
  spaceSky += vec3(0.95, 0.92, 0.82) * galaxyBand * smoothstep(0.22, 0.82, dust) * 0.22;
  spaceSky += vec3(0.8, 0.88, 1.0) * deepField * (0.55 + galaxyBand * 0.7) * 1.2;
  spaceSky += vec3(1.0, 0.96, 0.9) * brightField * (0.4 + galaxyBand * 0.55) * 0.9;
  spaceSky += vec3(0.09, 0.22, 0.44) * aurora * 0.2;

  sky = mix(sky, spaceSky, clamp(uSpaceMix, 0.0, 1.0));

  fc = vec4(sky, 1.0);
}`;

const LINE_FS = `#version 300 es
precision highp float;
uniform vec3 uColor;
out vec4 fc;
void main() {
  fc = vec4(uColor, 1.0);
}`;

const CAMERA_FOV = Math.PI / 4;
const WORLD_UP: [number, number, number] = [0, 1, 0];
const MAX_GRAB_STEP = SURFACE_CONTACT_HALF_EXTENT * 0.5;
const MIN_GRAB_RADIUS = PARTICLE_RADIUS * 3.25;
const MAX_GRAB_RADIUS = PARTICLE_RADIUS * 6;
const GRAB_RADIUS_SCALE = 0.32;
const BODY_ALPHA = 0.84;
const DAY_NIGHT_CYCLE_SPEED = 0.07;
const JENGA_VERTICAL_SPACING = 0.38;
const JENGA_VERTICAL_PARTICLES = 3;
const JENGA_BLOCK_HEIGHT = JENGA_VERTICAL_SPACING * (JENGA_VERTICAL_PARTICLES - 1);
const JENGA_LAYER_STEP = JENGA_BLOCK_HEIGHT + PARTICLE_RADIUS * 2;
const SPACE_SKY_START_LAYER = 16;
const SPACE_SKY_FULL_LAYER = 18;
const SPACE_SKY_START_HEIGHT = GROUND_BASE_Y + PARTICLE_RADIUS + (SPACE_SKY_START_LAYER - 1) * JENGA_LAYER_STEP + JENGA_BLOCK_HEIGHT;
const SPACE_SKY_FULL_HEIGHT = GROUND_BASE_Y + PARTICLE_RADIUS + (SPACE_SKY_FULL_LAYER - 1) * JENGA_LAYER_STEP + JENGA_BLOCK_HEIGHT;
const DEFAULT_STATIC_SUN_DIR = (() => {
  const raw: [number, number, number] = [0.42, 0.9, 0.2];
  const length = Math.hypot(raw[0], raw[1], raw[2]) || 1;
  return [raw[0] / length, raw[1] / length, raw[2] / length] as [number, number, number];
})();
const FIRST_PERSON_HALF_EXTENT = 1;
const FIRST_PERSON_EYE_OFFSET = 0.36;
const FIRST_PERSON_MOUSE_SENSITIVITY = 0.0022;
const FIRST_PERSON_PITCH_LIMIT = 1.3;
const FIRST_PERSON_MOVE_ACCEL = 26;
const FIRST_PERSON_AIR_ACCEL = 10;
const FIRST_PERSON_MOVE_SPEED = 6.4;
const FIRST_PERSON_JUMP_SPEED = 7.2;
const FIRST_PERSON_SUBSTEPS = 4;
const FIRST_PERSON_IMPACT_PUSH = 0.2;
const FIRST_PERSON_PARTICLE_SHIFT = 0.38;
const FIRST_PERSON_POSITION_CORRECTION = 0.78;
const FIRST_PERSON_SPAWN_CLEARANCE = 6.5;
const FIRST_PERSON_SUPPORT_SAMPLE = FIRST_PERSON_HALF_EXTENT * 0.8;
const FIRST_PERSON_IDLE_BOB = 0.02;

const cross3 = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const len3 = (v: number[]) => Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
const norm3 = (v: number[]) => {
  const l = len3(v) || 1;
  return v.map((x) => x / l);
};

const mat4Id = () => {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
};

function mat4Persp(fov: number, asp: number, n: number, f: number) {
  const t = 1 / Math.tan(fov * 0.5);
  const nf = 1 / (n - f);
  const m = new Float32Array(16);
  m[0] = t / asp;
  m[5] = t;
  m[10] = (f + n) * nf;
  m[11] = -1;
  m[14] = 2 * f * n * nf;
  return m;
}

function mat4LookAt(eye: number[], ctr: number[], up: number[]) {
  const z = norm3([eye[0] - ctr[0], eye[1] - ctr[1], eye[2] - ctr[2]]);
  const x = norm3(cross3(up, z));
  const y = cross3(z, x);
  const m = new Float32Array(16);

  m[0] = x[0];
  m[1] = y[0];
  m[2] = z[0];
  m[4] = x[1];
  m[5] = y[1];
  m[6] = z[1];
  m[8] = x[2];
  m[9] = y[2];
  m[10] = z[2];
  m[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]);
  m[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]);
  m[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]);
  m[15] = 1;

  return m;
}

function mat4Mul(a: Float32Array, b: Float32Array) {
  const m = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      m[c * 4 + r] = s;
    }
  }
  return m;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function approach(current: number, target: number, maxDelta: number) {
  if (current < target) return Math.min(target, current + maxDelta);
  if (current > target) return Math.max(target, current - maxDelta);
  return target;
}

function smoothstep(min: number, max: number, value: number) {
  const t = clamp01((value - min) / (max - min || 1));
  return t * t * (3 - 2 * t);
}

function mixVec3(a: number[], b: number[], t: number) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ] as [number, number, number];
}

function getSceneLighting(time: number, focus: [number, number, number], dayNightCycleEnabled: boolean) {
  const sunDir = dayNightCycleEnabled
    ? norm3([
        Math.cos(time * DAY_NIGHT_CYCLE_SPEED) * 0.82,
        Math.sin(time * DAY_NIGHT_CYCLE_SPEED) * 0.96 + 0.12,
        Math.sin(time * DAY_NIGHT_CYCLE_SPEED * 0.61) * 0.45,
      ]) as [number, number, number]
    : DEFAULT_STATIC_SUN_DIR;

  const dayMix = smoothstep(-0.16, 0.18, sunDir[1]);
  const moonDir = [-sunDir[0], -sunDir[1], -sunDir[2]] as [number, number, number];
  const lightDir = norm3([
    moonDir[0] * (1 - dayMix) + sunDir[0] * dayMix,
    moonDir[1] * (1 - dayMix) + sunDir[1] * dayMix,
    moonDir[2] * (1 - dayMix) + sunDir[2] * dayMix,
  ]) as [number, number, number];

  return {
    sunDir,
    dayMix,
    lightDir,
    lightColor: mixVec3([0.38, 0.47, 0.72], [1.0, 0.94, 0.82], dayMix),
    ambientColor: mixVec3([0.07, 0.1, 0.16], [0.22, 0.28, 0.33], dayMix),
    fogColor: mixVec3([0.04, 0.07, 0.12], [0.76, 0.87, 0.95], dayMix),
    lightPos: [
      focus[0] + lightDir[0] * 36,
      focus[1] + lightDir[1] * 36,
      focus[2] + lightDir[2] * 36,
    ] as [number, number, number],
  };
}

function mkProg(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const mk = (t: number, src: string) => {
    const s = gl.createShader(t)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)!);
    return s;
  };

  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)!);
  return p;
}

function recomputeNormals(pos: Float32Array, idx: Uint32Array, out: Float32Array) {
  out.fill(0);
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t];
    const i1 = idx[t + 1];
    const i2 = idx[t + 2];
    const ax = pos[i0 * 3];
    const ay = pos[i0 * 3 + 1];
    const az = pos[i0 * 3 + 2];
    const e1 = [pos[i1 * 3] - ax, pos[i1 * 3 + 1] - ay, pos[i1 * 3 + 2] - az];
    const e2 = [pos[i2 * 3] - ax, pos[i2 * 3 + 1] - ay, pos[i2 * 3 + 2] - az];
    const n = cross3(e1, e2);
    for (const i of [i0, i1, i2]) {
      out[i * 3] += n[0];
      out[i * 3 + 1] += n[1];
      out[i * 3 + 2] += n[2];
    }
  }

  for (let i = 0; i < out.length / 3; i++) {
    const l = Math.sqrt(out[i * 3] ** 2 + out[i * 3 + 1] ** 2 + out[i * 3 + 2] ** 2) || 1;
    out[i * 3] /= l;
    out[i * 3 + 1] /= l;
    out[i * 3 + 2] /= l;
  }
}

interface FaceMesh {
  vao: WebGLVertexArrayObject;
  posBuf: WebGLBuffer;
  normBuf: WebGLBuffer;
  idxBuf: WebGLBuffer;
  cnt: number;
}

interface RenderBody {
  body: SimState;
  meshes: FaceMesh[];
  faceData: Array<{ v2p: number[]; idx: Uint32Array; pos: Float32Array; nrm: Float32Array }>;
}

type PointerMode = "orbit" | "pan" | "grab" | null;

interface GrabInfluence {
  particle: number;
  offset: [number, number, number];
}

interface GrabState {
  body: SimState;
  influences: GrabInfluence[];
  planeOrigin: [number, number, number];
  planeNormal: [number, number, number];
  targetPoint: [number, number, number];
}

interface OrbitState {
  theta: number;
  phi: number;
  dist: number;
  target: [number, number, number];
}

interface FirstPersonState {
  active: boolean;
  suspended: boolean;
  grounded: boolean;
  position: [number, number, number];
  velocity: [number, number, number];
  yaw: number;
  pitch: number;
}

interface ViewState {
  eye: [number, number, number];
  forward: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
  focus: [number, number, number];
}

function mkFaceMesh(
  gl: WebGL2RenderingContext,
  prog: WebGLProgram,
  nv: number,
  idx: Uint32Array
): FaceMesh {
  const vao = gl.createVertexArray()!;
  const posBuf = gl.createBuffer()!;
  const normBuf = gl.createBuffer()!;
  const idxBuf = gl.createBuffer()!;

  gl.bindVertexArray(vao);

  const aPos = gl.getAttribLocation(prog, "aPosition");
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, nv * 3 * 4, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);

  const aNrm = gl.getAttribLocation(prog, "aNormal");
  gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
  gl.bufferData(gl.ARRAY_BUFFER, nv * 3 * 4, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(aNrm);
  gl.vertexAttribPointer(aNrm, 3, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  gl.bindVertexArray(null);

  return { vao, posBuf, normBuf, idxBuf, cnt: idx.length };
}

export function createRenderer(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext("webgl2")!;
  const bodyProg = mkProg(gl, BODY_VS, BODY_FS);
  const terrainProg = mkProg(gl, TERRAIN_VS, TERRAIN_FS);
  const skyProg = mkProg(gl, SKY_VS, SKY_FS);
  const lineProg = mkProg(gl, LINE_VS, LINE_FS);
  const bodyColorLoc = gl.getUniformLocation(bodyProg, "uColor");
  const bodyAlphaLoc = gl.getUniformLocation(bodyProg, "uAlpha");
  const lineColorLoc = gl.getUniformLocation(lineProg, "uColor");
  const lineMvpLoc = gl.getUniformLocation(lineProg, "uMVP");

  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0.01, 0.015, 0.03, 1);

  const terrain = buildTerrainMesh();
  const terrainVAO = gl.createVertexArray()!;
  gl.bindVertexArray(terrainVAO);
  const terrainPosBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, terrainPosBuf);
  gl.bufferData(gl.ARRAY_BUFFER, terrain.positions, gl.STATIC_DRAW);
  const terrainPosLoc = gl.getAttribLocation(terrainProg, "aPosition");
  gl.enableVertexAttribArray(terrainPosLoc);
  gl.vertexAttribPointer(terrainPosLoc, 3, gl.FLOAT, false, 0, 0);

  const terrainNormBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, terrainNormBuf);
  gl.bufferData(gl.ARRAY_BUFFER, terrain.normals, gl.STATIC_DRAW);
  const terrainNormLoc = gl.getAttribLocation(terrainProg, "aNormal");
  gl.enableVertexAttribArray(terrainNormLoc);
  gl.vertexAttribPointer(terrainNormLoc, 3, gl.FLOAT, false, 0, 0);

  const terrainIdxBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, terrainIdxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, terrain.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);

  const skyVAO = gl.createVertexArray()!;

  let bodies: SimState[] = [];
  let renderBodies: RenderBody[] = [];
  let wireframe = false;
  let showSprings = false;
  let dayNightCycleEnabled = true;
  let springVAO: WebGLVertexArrayObject | null = null;
  let springBuf: WebGLBuffer | null = null;
  let axisVAO: WebGLVertexArrayObject | null = null;
  let axisBuf: WebGLBuffer | null = null;
  let previewOrientation: Orientation = { x: 0, y: 0, z: 0 };
  let savedOrbitState: OrbitState | null = null;
  let firstPerson: FirstPersonState | null = null;

  let theta = 0.35;
  let phi = 0.3;
  let dist = 11;
  const target = [0, 0.5, 0];
  let activePointerId: number | null = null;
  let pointerMode: PointerMode = null;
  let grabState: GrabState | null = null;
  let lx = 0;
  let ly = 0;
  const pressedKeys = new Set<string>();
  let jumpQueued = false;

  const getOrbitEye = () => {
    const cr = dist * Math.cos(phi);
    return [
      target[0] + cr * Math.sin(theta),
      target[1] + dist * Math.sin(phi),
      target[2] + cr * Math.cos(theta),
    ] as [number, number, number];
  };

  const getOrbitCameraBasis = () => {
    const eye = getOrbitEye();
    const forward = norm3([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
    const right = norm3(cross3(forward, WORLD_UP));
    const up = norm3(cross3(right, forward));
    return { eye, forward, right, up };
  };

  const getFirstPersonForward = (state: FirstPersonState) => (
    norm3([
      Math.sin(state.yaw) * Math.cos(state.pitch),
      Math.sin(state.pitch),
      Math.cos(state.yaw) * Math.cos(state.pitch),
    ]) as [number, number, number]
  );

  const getViewState = (): ViewState => {
    if (!firstPerson?.active) {
      const { eye, forward, right, up } = getOrbitCameraBasis();
      return {
        eye,
        forward: forward as [number, number, number],
        right: right as [number, number, number],
        up: up as [number, number, number],
        focus: [...target] as [number, number, number],
      };
    }

    const forward = getFirstPersonForward(firstPerson);
    const right = norm3(cross3(forward, WORLD_UP)) as [number, number, number];
    const up = norm3(cross3(right, forward)) as [number, number, number];
    const bob = firstPerson.grounded && !firstPerson.suspended
      ? Math.sin(performance.now() * 0.01) * FIRST_PERSON_IDLE_BOB * clamp01(Math.hypot(firstPerson.velocity[0], firstPerson.velocity[2]) / FIRST_PERSON_MOVE_SPEED)
      : 0;
    const eye: [number, number, number] = [
      firstPerson.position[0],
      firstPerson.position[1] + FIRST_PERSON_EYE_OFFSET + bob,
      firstPerson.position[2],
    ];

    return {
      eye,
      forward,
      right,
      up,
      focus: [
        eye[0] + forward[0],
        eye[1] + forward[1],
        eye[2] + forward[2],
      ],
    };
  };

  const getMouseRay = (clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = ((clientY - rect.top) / rect.height) * -2 + 1;
    const aspect = rect.width / rect.height;
    const t = Math.tan(CAMERA_FOV * 0.5);
    const { eye, forward, right, up } = getViewState();
    const dir = norm3([
      forward[0] + right[0] * nx * aspect * t + up[0] * ny * t,
      forward[1] + right[1] * nx * aspect * t + up[1] * ny * t,
      forward[2] + right[2] * nx * aspect * t + up[2] * ny * t,
    ]);

    return { origin: eye, dir };
  };

  const intersectRayPlane = (
    origin: [number, number, number],
    dir: number[],
    planeOrigin: [number, number, number],
    planeNormal: [number, number, number]
  ) => {
    const denom = dir[0] * planeNormal[0] + dir[1] * planeNormal[1] + dir[2] * planeNormal[2];
    if (Math.abs(denom) < 1e-6) return null;

    const ox = planeOrigin[0] - origin[0];
    const oy = planeOrigin[1] - origin[1];
    const oz = planeOrigin[2] - origin[2];
    const t = (ox * planeNormal[0] + oy * planeNormal[1] + oz * planeNormal[2]) / denom;
    if (t < 0) return null;

    return [
      origin[0] + dir[0] * t,
      origin[1] + dir[1] * t,
      origin[2] + dir[2] * t,
    ] as [number, number, number];
  };

  const rayTri = (
    origin: [number, number, number],
    dir: number[],
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number
  ) => {
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;
    const px = dir[1] * acz - dir[2] * acy;
    const py = dir[2] * acx - dir[0] * acz;
    const pz = dir[0] * acy - dir[1] * acx;
    const det = abx * px + aby * py + abz * pz;
    if (Math.abs(det) < 1e-7) return null;

    const invDet = 1 / det;
    const tx = origin[0] - ax;
    const ty = origin[1] - ay;
    const tz = origin[2] - az;
    const u = (tx * px + ty * py + tz * pz) * invDet;
    if (u < 0 || u > 1) return null;

    const qx = ty * abz - tz * aby;
    const qy = tz * abx - tx * abz;
    const qz = tx * aby - ty * abx;
    const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * invDet;
    if (v < 0 || u + v > 1) return null;

    const t = (acx * qx + acy * qy + acz * qz) * invDet;
    if (t < 0) return null;

    return t;
  };

  const pickDroppedBody = (clientX: number, clientY: number) => {
    const { origin, dir } = getMouseRay(clientX, clientY);
    let best: {
      body: SimState;
      faceIndex: number;
      hitPoint: [number, number, number];
    } | null = null;
    let bestT = Infinity;

    for (const rb of renderBodies) {
      if (!rb.body.dropped) continue;

      for (let faceIndex = 0; faceIndex < rb.faceData.length; faceIndex++) {
        const fd = rb.faceData[faceIndex];
        for (let i = 0; i < fd.idx.length; i += 3) {
          const ia = fd.idx[i] * 3;
          const ib = fd.idx[i + 1] * 3;
          const ic = fd.idx[i + 2] * 3;
          const t = rayTri(
            origin,
            dir,
            fd.pos[ia], fd.pos[ia + 1], fd.pos[ia + 2],
            fd.pos[ib], fd.pos[ib + 1], fd.pos[ib + 2],
            fd.pos[ic], fd.pos[ic + 1], fd.pos[ic + 2]
          );
          if (t === null || t >= bestT) continue;

          bestT = t;
          best = {
            body: rb.body,
            faceIndex,
            hitPoint: [
              origin[0] + dir[0] * t,
              origin[1] + dir[1] * t,
              origin[2] + dir[2] * t,
            ],
          };
        }
      }
    }

    if (!best) return null;

    let anchorParticle = 0;
    let bestDistSq = Infinity;
    for (let i = 0; i < best.body.N; i++) {
      if (!best.body.surfaceParticleMask[i]) continue;
      const base = i * 3;
      const dx = best.body.pos[base] - best.hitPoint[0];
      const dy = best.body.pos[base + 1] - best.hitPoint[1];
      const dz = best.body.pos[base + 2] - best.hitPoint[2];
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        anchorParticle = i;
      }
    }

    const influences: GrabInfluence[] = [];

    if (isFlatContactShape(best.body.shape)) {
      const clickedFace = best.body.faces[best.faceIndex];
      for (const particle of clickedFace.vertToParticle) {
        const base = particle * 3;
        influences.push({
          particle,
          offset: [
            best.hitPoint[0] - best.body.pos[base],
            best.hitPoint[1] - best.body.pos[base + 1],
            best.hitPoint[2] - best.body.pos[base + 2],
          ],
        });
      }
    } else if (best.body.shape === "sphere") {
      for (let i = 0; i < best.body.N; i++) {
        const base = i * 3;
        influences.push({
          particle: i,
          offset: [
            best.hitPoint[0] - best.body.pos[base],
            best.hitPoint[1] - best.body.pos[base + 1],
            best.hitPoint[2] - best.body.pos[base + 2],
          ],
        });
      }
    } else {
      const grabRadius = Math.max(
        MIN_GRAB_RADIUS,
        Math.min(MAX_GRAB_RADIUS, getPoseRadius(best.body.pos) * GRAB_RADIUS_SCALE)
      );
      const grabRadiusSq = grabRadius * grabRadius;

      for (let i = 0; i < best.body.N; i++) {
        const base = i * 3;
        const dx = best.body.pos[base] - best.hitPoint[0];
        const dy = best.body.pos[base + 1] - best.hitPoint[1];
        const dz = best.body.pos[base + 2] - best.hitPoint[2];
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq > grabRadiusSq) continue;

        influences.push({
          particle: i,
          offset: [
            best.hitPoint[0] - best.body.pos[base],
            best.hitPoint[1] - best.body.pos[base + 1],
            best.hitPoint[2] - best.body.pos[base + 2],
          ],
        });
      }
    }

    if (!influences.length) {
      const anchorBase = anchorParticle * 3;
      influences.push({
        particle: anchorParticle,
        offset: [
          best.hitPoint[0] - best.body.pos[anchorBase],
          best.hitPoint[1] - best.body.pos[anchorBase + 1],
          best.hitPoint[2] - best.body.pos[anchorBase + 2],
        ],
      });
    }

    return {
      body: best.body,
      hitPoint: best.hitPoint,
      influences,
      planeNormal: [...getViewState().forward] as [number, number, number],
    };
  };

  const getCurrentGrabPoint = (state: GrabState): [number, number, number] => {
    let x = 0;
    let y = 0;
    let z = 0;

    for (const influence of state.influences) {
      const base = influence.particle * 3;
      x += state.body.pos[base] + influence.offset[0];
      y += state.body.pos[base + 1] + influence.offset[1];
      z += state.body.pos[base + 2] + influence.offset[2];
    }

    const count = state.influences.length || 1;
    return [x / count, y / count, z / count];
  };

  const translateGrabRegion = (
    body: SimState,
    influences: GrabInfluence[],
    dx: number,
    dy: number,
    dz: number
  ) => {
    for (const influence of influences) {
      const base = influence.particle * 3;
      body.pos[base] += dx;
      body.pos[base + 1] += dy;
      body.pos[base + 2] += dz;
      body.prev[base] += dx;
      body.prev[base + 1] += dy;
      body.prev[base + 2] += dz;
    }
  };

  const alignGrabRegionToTarget = (state: GrabState, point: [number, number, number]) => {
    const currentPoint = getCurrentGrabPoint(state);
    translateGrabRegion(
      state.body,
      state.influences,
      point[0] - currentPoint[0],
      point[1] - currentPoint[1],
      point[2] - currentPoint[2]
    );
  };

  const applyGrabConstraint = () => {
    if (!grabState) return;

    const currentPoint = getCurrentGrabPoint(grabState);
    const dx = grabState.targetPoint[0] - currentPoint[0];
    const dy = grabState.targetPoint[1] - currentPoint[1];
    const dz = grabState.targetPoint[2] - currentPoint[2];

    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6 && Math.abs(dz) < 1e-6) {
      alignGrabRegionToTarget(grabState, grabState.targetPoint);
      return;
    }

    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) / MAX_GRAB_STEP));
    const stepDx = dx / steps;
    const stepDy = dy / steps;
    const stepDz = dz / steps;

    const stepPoint: [number, number, number] = [...currentPoint];
    for (let step = 0; step < steps; step++) {
      stepPoint[0] += stepDx;
      stepPoint[1] += stepDy;
      stepPoint[2] += stepDz;
      alignGrabRegionToTarget(grabState, stepPoint);
      resolveBodyContacts(bodies);
      alignGrabRegionToTarget(grabState, stepPoint);
    }
  };

  const getFirstPersonState = () => (
    firstPerson
      ? {
          active: true,
          suspended: firstPerson.suspended,
          grounded: firstPerson.grounded,
          mouseCaptured: document.pointerLockElement === canvas,
        }
      : {
          active: false,
          suspended: false,
          grounded: false,
          mouseCaptured: false,
        }
  );

  const releasePointerCaptureIfNeeded = () => {
    if (activePointerId !== null && canvas.hasPointerCapture(activePointerId)) {
      canvas.releasePointerCapture(activePointerId);
    }
    activePointerId = null;
    pointerMode = null;
    grabState = null;
  };

  const getSceneFocusPoint = (): [number, number, number] => {
    const droppedBodies = bodies.filter((body) => body.dropped);
    if (!droppedBodies.length) {
      return [target[0], target[1], target[2]];
    }

    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    let maxY = -Infinity;
    for (const body of droppedBodies) {
      const center = getPoseCenter(body.pos);
      sumX += center[0];
      sumY += center[1];
      sumZ += center[2];
      for (let i = 0; i < body.N; i++) {
        maxY = Math.max(maxY, body.pos[i * 3 + 1]);
      }
    }

    const inv = 1 / droppedBodies.length;
    return [sumX * inv, maxY, sumZ * inv];
  };

  const getFirstPersonSupportY = (x: number, z: number) => {
    let height = getGroundHeight(x, z);
    for (const [ox, oz] of [
      [FIRST_PERSON_SUPPORT_SAMPLE, FIRST_PERSON_SUPPORT_SAMPLE],
      [FIRST_PERSON_SUPPORT_SAMPLE, -FIRST_PERSON_SUPPORT_SAMPLE],
      [-FIRST_PERSON_SUPPORT_SAMPLE, FIRST_PERSON_SUPPORT_SAMPLE],
      [-FIRST_PERSON_SUPPORT_SAMPLE, -FIRST_PERSON_SUPPORT_SAMPLE],
    ] as Array<[number, number]>) {
      height = Math.max(height, getGroundHeight(x + ox, z + oz));
    }
    return height + FIRST_PERSON_HALF_EXTENT;
  };

  const getFirstPersonSpawnState = () => {
    const [focusX, focusY, focusZ] = getSceneFocusPoint();
    const groundY = getFirstPersonSupportY(focusX, focusZ);
    const position: [number, number, number] = [
      focusX,
      Math.max(groundY + FIRST_PERSON_SPAWN_CLEARANCE, focusY + FIRST_PERSON_SPAWN_CLEARANCE),
      focusZ,
    ];
    const lookDir = norm3([
      focusX - position[0],
      Math.max(-2.2, focusY - position[1]),
      focusZ - position[2] - 0.001,
    ]);
    return {
      position,
      yaw: Math.atan2(lookDir[0], lookDir[2]),
      pitch: Math.asin(clamp(lookDir[1], -1, 1)),
    };
  };

  const requestPointerLock = () => {
    if (document.pointerLockElement === canvas) return true;

    try {
      const request = canvas.requestPointerLock.bind(canvas) as () => Promise<void> | void;
      const result = request();
      if (result && typeof (result as Promise<void>).catch === "function") {
        void (result as Promise<void>).catch((error) => {
          console.warn("Pointer lock request was rejected.", error);
        });
      }
      return true;
    } catch (error) {
      console.warn("Pointer lock could not be acquired.", error);
      return false;
    }
  };

  const toggleMouseCapture = () => {
    if (!firstPerson?.active) return false;
    if (document.pointerLockElement === canvas) {
      document.exitPointerLock();
      return true;
    }
    return requestPointerLock();
  };

  const enterFirstPerson = () => {
    if (firstPerson?.active) return false;

    savedOrbitState = {
      theta,
      phi,
      dist,
      target: [...target] as [number, number, number],
    };
    const spawn = getFirstPersonSpawnState();
    firstPerson = {
      active: true,
      suspended: true,
      grounded: false,
      position: spawn.position,
      velocity: [0, 0, 0],
      yaw: spawn.yaw,
      pitch: spawn.pitch,
    };
    pressedKeys.clear();
    jumpQueued = false;
    releasePointerCaptureIfNeeded();
    canvas.style.cursor = "crosshair";
    draw();
    return true;
  };

  const exitFirstPerson = () => {
    if (!firstPerson?.active) return false;

    firstPerson = null;
    pressedKeys.clear();
    jumpQueued = false;
    releasePointerCaptureIfNeeded();
    if (savedOrbitState) {
      theta = savedOrbitState.theta;
      phi = savedOrbitState.phi;
      dist = savedOrbitState.dist;
      target[0] = savedOrbitState.target[0];
      target[1] = savedOrbitState.target[1];
      target[2] = savedOrbitState.target[2];
      savedOrbitState = null;
    }
    if (document.pointerLockElement === canvas) {
      document.exitPointerLock();
    }
    canvas.style.cursor = "grab";
    draw();
    return true;
  };

  const releaseFirstPerson = () => {
    if (!firstPerson?.active || !firstPerson.suspended) return false;
    firstPerson.suspended = false;
    firstPerson.grounded = false;
    firstPerson.velocity = [0, 0, 0];
    return true;
  };

  const getCubeParticleContact = (
    center: [number, number, number],
    px: number,
    py: number,
    pz: number,
    radius: number
  ) => {
    const cx = clamp(px, center[0] - FIRST_PERSON_HALF_EXTENT, center[0] + FIRST_PERSON_HALF_EXTENT);
    const cy = clamp(py, center[1] - FIRST_PERSON_HALF_EXTENT, center[1] + FIRST_PERSON_HALF_EXTENT);
    const cz = clamp(pz, center[2] - FIRST_PERSON_HALF_EXTENT, center[2] + FIRST_PERSON_HALF_EXTENT);
    let dx = px - cx;
    let dy = py - cy;
    let dz = pz - cz;
    let distSq = dx * dx + dy * dy + dz * dz;

    if (distSq > 1e-8) {
      const dist = Math.sqrt(distSq);
      if (dist >= radius) return null;
      return {
        normal: [dx / dist, dy / dist, dz / dist] as [number, number, number],
        penetration: radius - dist,
      };
    }

    const relX = px - center[0];
    const relY = py - center[1];
    const relZ = pz - center[2];
    const gapX = FIRST_PERSON_HALF_EXTENT - Math.abs(relX);
    const gapY = FIRST_PERSON_HALF_EXTENT - Math.abs(relY);
    const gapZ = FIRST_PERSON_HALF_EXTENT - Math.abs(relZ);

    if (gapX <= gapY && gapX <= gapZ) {
      dx = relX >= 0 ? 1 : -1;
      return { normal: [dx, 0, 0] as [number, number, number], penetration: radius + gapX };
    }
    if (gapY <= gapZ) {
      dy = relY >= 0 ? 1 : -1;
      return { normal: [0, dy, 0] as [number, number, number], penetration: radius + gapY };
    }

    dz = relZ >= 0 ? 1 : -1;
    return { normal: [0, 0, dz] as [number, number, number], penetration: radius + gapZ };
  };

  const resolveFirstPersonTerrain = (state: FirstPersonState) => {
    const supportY = getFirstPersonSupportY(state.position[0], state.position[2]);
    if (state.position[1] >= supportY) return false;
    state.position[1] = supportY;
    if (state.velocity[1] < 0) state.velocity[1] = 0;
    return true;
  };

  const resolveFirstPersonBodies = (state: FirstPersonState) => {
    let grounded = false;
    let touchedBody = false;

    for (let pass = 0; pass < 3; pass++) {
      let resolvedPass = false;

      for (const body of bodies) {
        if (!body.dropped) continue;

        for (let i = 0; i < body.N; i++) {
          if (!body.surfaceParticleMask[i]) continue;

          const base = i * 3;
          const px = body.pos[base];
          const py = body.pos[base + 1];
          const pz = body.pos[base + 2];
          if (
            Math.abs(px - state.position[0]) > FIRST_PERSON_HALF_EXTENT + PARTICLE_RADIUS ||
            Math.abs(py - state.position[1]) > FIRST_PERSON_HALF_EXTENT + PARTICLE_RADIUS ||
            Math.abs(pz - state.position[2]) > FIRST_PERSON_HALF_EXTENT + PARTICLE_RADIUS
          ) {
            continue;
          }

          const contact = getCubeParticleContact(state.position, px, py, pz, PARTICLE_RADIUS);
          if (!contact || contact.penetration <= 1e-4) continue;

          const [nx, ny, nz] = contact.normal;
          const playerShift = Math.min(FIRST_PERSON_POSITION_CORRECTION, contact.penetration * 0.72);
          const particleShift = Math.min(FIRST_PERSON_PARTICLE_SHIFT, contact.penetration * 0.42);
          const particleVx = body.pos[base] - body.prev[base];
          const particleVy = body.pos[base + 1] - body.prev[base + 1];
          const particleVz = body.pos[base + 2] - body.prev[base + 2];
          const relativeSpeed = Math.max(
            0,
            (state.velocity[0] - particleVx) * nx +
            (state.velocity[1] - particleVy) * ny +
            (state.velocity[2] - particleVz) * nz
          );
          const impact = Math.min(FIRST_PERSON_IMPACT_PUSH, contact.penetration * 0.16 + relativeSpeed * 0.02);

          state.position[0] -= nx * playerShift;
          state.position[1] -= ny * playerShift;
          state.position[2] -= nz * playerShift;

          body.pos[base] += nx * particleShift;
          body.pos[base + 1] += ny * particleShift;
          body.pos[base + 2] += nz * particleShift;
          body.prev[base] += nx * (particleShift - impact);
          body.prev[base + 1] += ny * (particleShift - impact);
          body.prev[base + 2] += nz * (particleShift - impact);

          const speedInto = state.velocity[0] * nx + state.velocity[1] * ny + state.velocity[2] * nz;
          if (speedInto > 0) {
            state.velocity[0] -= nx * speedInto;
            state.velocity[1] -= ny * speedInto;
            state.velocity[2] -= nz * speedInto;
          }

          grounded = grounded || ny < -0.45;
          touchedBody = true;
          resolvedPass = true;
        }
      }

      if (!resolvedPass) break;
    }

    if (touchedBody) {
      resolveBodyContacts(bodies);
    }

    return { grounded, touchedBody };
  };

  const updateFirstPerson = () => {
    if (!firstPerson?.active) return;
    if (firstPerson.suspended) {
      firstPerson.grounded = false;
      firstPerson.velocity = [0, 0, 0];
      return;
    }

    const wishForward = (pressedKeys.has("KeyW") ? 1 : 0) - (pressedKeys.has("KeyS") ? 1 : 0);
    const wishRight = (pressedKeys.has("KeyD") ? 1 : 0) - (pressedKeys.has("KeyA") ? 1 : 0);
    const planarLength = Math.hypot(wishForward, wishRight) || 1;
    const moveForward = wishForward / planarLength;
    const moveRight = wishRight / planarLength;
    const flatForward: [number, number, number] = [Math.sin(firstPerson.yaw), 0, Math.cos(firstPerson.yaw)];
    const flatRight: [number, number, number] = [flatForward[2], 0, -flatForward[0]];
    const targetVX = (flatForward[0] * moveForward + flatRight[0] * moveRight) * FIRST_PERSON_MOVE_SPEED;
    const targetVZ = (flatForward[2] * moveForward + flatRight[2] * moveRight) * FIRST_PERSON_MOVE_SPEED;
    const accel = firstPerson.grounded ? FIRST_PERSON_MOVE_ACCEL : FIRST_PERSON_AIR_ACCEL;
    const accelStep = accel * (1 / 60);

    firstPerson.velocity[0] = approach(firstPerson.velocity[0], targetVX, accelStep);
    firstPerson.velocity[2] = approach(firstPerson.velocity[2], targetVZ, accelStep);

    if (!wishForward && !wishRight && firstPerson.grounded) {
      firstPerson.velocity[0] *= 0.78;
      firstPerson.velocity[2] *= 0.78;
    } else if (!firstPerson.grounded) {
      firstPerson.velocity[0] *= 0.996;
      firstPerson.velocity[2] *= 0.996;
    }

    if (jumpQueued && firstPerson.grounded) {
      firstPerson.velocity[1] = FIRST_PERSON_JUMP_SPEED;
      firstPerson.grounded = false;
    }
    jumpQueued = false;

    firstPerson.velocity[1] -= 18 * (1 / 60);

    let grounded = false;
    const subDt = (1 / 60) / FIRST_PERSON_SUBSTEPS;
    for (let step = 0; step < FIRST_PERSON_SUBSTEPS; step++) {
      firstPerson.position[0] += firstPerson.velocity[0] * subDt;
      firstPerson.position[1] += firstPerson.velocity[1] * subDt;
      firstPerson.position[2] += firstPerson.velocity[2] * subDt;

      grounded = resolveFirstPersonTerrain(firstPerson) || grounded;
      const bodyResult = resolveFirstPersonBodies(firstPerson);
      grounded = grounded || bodyResult.grounded;
      grounded = resolveFirstPersonTerrain(firstPerson) || grounded;
    }

    firstPerson.grounded = grounded;
  };

  const panCamera = (dx: number, dy: number) => {
    const rect = canvas.getBoundingClientRect();
    const { right, up } = getOrbitCameraBasis();
    const worldHeight = 2 * Math.tan(CAMERA_FOV * 0.5) * dist;
    const worldWidth = worldHeight * (rect.width / rect.height);
    const sx = -(dx / rect.width) * worldWidth;
    const sy = (dy / rect.height) * worldHeight;

    target[0] += right[0] * sx + up[0] * sy;
    target[1] += right[1] * sx + up[1] * sy;
    target[2] += right[2] * sx + up[2] * sy;
  };

  const beginGrab = (e: PointerEvent) => {
    if (firstPerson?.active) return false;
    const pick = pickDroppedBody(e.clientX, e.clientY);
    if (!pick) return false;

    pointerMode = "grab";
    grabState = {
      body: pick.body,
      influences: pick.influences,
      planeOrigin: pick.hitPoint,
      planeNormal: pick.planeNormal,
      targetPoint: pick.hitPoint,
    };
    canvas.style.cursor = "grabbing";
    return true;
  };

  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    if (firstPerson?.active) {
      requestPointerLock();
      return;
    }

    activePointerId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    lx = e.clientX;
    ly = e.clientY;

    if (e.button === 2 || e.button === 1 || (e.button === 0 && e.shiftKey)) {
      pointerMode = "pan";
      canvas.style.cursor = "grabbing";
      return;
    }

    if (e.button === 0 && beginGrab(e)) {
      return;
    }

    pointerMode = "orbit";
    canvas.style.cursor = "grabbing";
  };
  const onPointerUp = (e: PointerEvent) => {
    if (firstPerson?.active) return;
    if (activePointerId !== e.pointerId) return;
    grabState = null;
    pointerMode = null;
    activePointerId = null;
    canvas.style.cursor = "grab";
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    if (firstPerson?.active) return;
    if (activePointerId !== e.pointerId || !pointerMode) return;
    const dx = e.clientX - lx;
    const dy = e.clientY - ly;

    if (pointerMode === "orbit") {
      theta -= dx * 0.007;
      phi = Math.max(-1.4, Math.min(1.4, phi - dy * 0.007));
    } else if (pointerMode === "pan") {
      panCamera(dx, dy);
    } else if (pointerMode === "grab" && grabState) {
      const ray = getMouseRay(e.clientX, e.clientY);
      const hit = intersectRayPlane(ray.origin, ray.dir, grabState.planeOrigin, grabState.planeNormal);
      if (hit) {
        grabState.targetPoint = hit;
      }
    }

    lx = e.clientX;
    ly = e.clientY;
  };
  const onWheel = (e: WheelEvent) => {
    if (firstPerson?.active) return;
    dist = Math.max(3, Math.min(22, dist + e.deltaY * 0.01));
  };
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
  };
  const onDocumentMouseMove = (e: MouseEvent) => {
    if (!firstPerson?.active || document.pointerLockElement !== canvas) return;
    firstPerson.yaw -= e.movementX * FIRST_PERSON_MOUSE_SENSITIVITY;
    firstPerson.pitch = clamp(
      firstPerson.pitch - e.movementY * FIRST_PERSON_MOUSE_SENSITIVITY,
      -FIRST_PERSON_PITCH_LIMIT,
      FIRST_PERSON_PITCH_LIMIT
    );
  };
  const onPointerLockChange = () => {
    if (!firstPerson?.active) {
      canvas.style.cursor = "grab";
      return;
    }
    canvas.style.cursor = document.pointerLockElement === canvas ? "none" : "crosshair";
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!firstPerson?.active) return;
    if (e.code === "KeyT" && !e.repeat) {
      e.preventDefault();
      toggleMouseCapture();
      return;
    }
    if (["KeyW", "KeyA", "KeyS", "KeyD", "Space"].includes(e.code)) {
      e.preventDefault();
      pressedKeys.add(e.code);
    }
    if (e.code === "Space" && !e.repeat) {
      jumpQueued = true;
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    pressedKeys.delete(e.code);
  };

  canvas.style.cursor = "grab";
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("wheel", onWheel, { passive: true });
  canvas.addEventListener("contextmenu", onContextMenu);
  document.addEventListener("mousemove", onDocumentMouseMove);
  document.addEventListener("pointerlockchange", onPointerLockChange);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  function disposeBodyMeshes() {
    for (const rb of renderBodies) {
      for (const mesh of rb.meshes) {
        gl.deleteBuffer(mesh.posBuf);
        gl.deleteBuffer(mesh.normBuf);
        gl.deleteBuffer(mesh.idxBuf);
        gl.deleteVertexArray(mesh.vao);
      }
    }
    renderBodies = [];
  }

  function rebuildBodies() {
    disposeBodyMeshes();

    renderBodies = bodies.map((body) => {
      const meshes: FaceMesh[] = [];
      const faceData: RenderBody["faceData"] = [];

      for (const { vertToParticle, triIdx } of body.faces) {
        const idx = new Uint32Array(triIdx);
        meshes.push(mkFaceMesh(gl, bodyProg, vertToParticle.length, idx));
        faceData.push({
          v2p: vertToParticle,
          idx,
          pos: new Float32Array(vertToParticle.length * 3),
          nrm: new Float32Array(vertToParticle.length * 3),
        });
      }

      return { body, meshes, faceData };
    });
  }

  function syncFaces() {
    for (const rb of renderBodies) {
      const { body } = rb;

      let bcx = 0, bcy = 0, bcz = 0;
      for (let i = 0; i < body.N; i++) {
        bcx += body.pos[i * 3];
        bcy += body.pos[i * 3 + 1];
        bcz += body.pos[i * 3 + 2];
      }
      bcx /= body.N; bcy /= body.N; bcz /= body.N;

      const isMultiFace = rb.faceData.length > 1;

      for (let fi = 0; fi < rb.faceData.length; fi++) {
        const fd = rb.faceData[fi];
        for (let vi = 0; vi < fd.v2p.length; vi++) {
          const pi = fd.v2p[vi];
          fd.pos[vi * 3]     = body.pos[pi * 3];
          fd.pos[vi * 3 + 1] = body.pos[pi * 3 + 1];
          fd.pos[vi * 3 + 2] = body.pos[pi * 3 + 2];
        }
        recomputeNormals(fd.pos, fd.idx, fd.nrm);
      }

      const expansion = new Float32Array(body.N * 3);

      for (let fi = 0; fi < rb.faceData.length; fi++) {
        const fd = rb.faceData[fi];

        if (isMultiFace) {
          let nx = 0, ny = 0, nz = 0;
          for (let vi = 0; vi < fd.v2p.length; vi++) {
            nx += fd.nrm[vi * 3];
            ny += fd.nrm[vi * 3 + 1];
            nz += fd.nrm[vi * 3 + 2];
          }
          const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          nx /= l; ny /= l; nz /= l;

          let fcx = 0, fcy = 0, fcz = 0;
          for (let vi = 0; vi < fd.v2p.length; vi++) {
            fcx += fd.pos[vi * 3];
            fcy += fd.pos[vi * 3 + 1];
            fcz += fd.pos[vi * 3 + 2];
          }
          fcx /= fd.v2p.length; fcy /= fd.v2p.length; fcz /= fd.v2p.length;
          if (nx * (fcx - bcx) + ny * (fcy - bcy) + nz * (fcz - bcz) < 0) {
            nx = -nx; ny = -ny; nz = -nz;
          }

          for (const pi of fd.v2p) {
            expansion[pi * 3]     += nx * PARTICLE_RADIUS;
            expansion[pi * 3 + 1] += ny * PARTICLE_RADIUS;
            expansion[pi * 3 + 2] += nz * PARTICLE_RADIUS;
          }
        } else {
          for (let vi = 0; vi < fd.v2p.length; vi++) {
            const pi = fd.v2p[vi];
            let nx = fd.nrm[vi * 3], ny = fd.nrm[vi * 3 + 1], nz = fd.nrm[vi * 3 + 2];
            const px = fd.pos[vi * 3] - bcx;
            const py = fd.pos[vi * 3 + 1] - bcy;
            const pz = fd.pos[vi * 3 + 2] - bcz;
            if (nx * px + ny * py + nz * pz < 0) { nx = -nx; ny = -ny; nz = -nz; }
            expansion[pi * 3]     += nx * PARTICLE_RADIUS;
            expansion[pi * 3 + 1] += ny * PARTICLE_RADIUS;
            expansion[pi * 3 + 2] += nz * PARTICLE_RADIUS;
          }
        }
      }

      for (let fi = 0; fi < rb.faceData.length; fi++) {
        const fd = rb.faceData[fi];
        const mesh = rb.meshes[fi];

        for (let vi = 0; vi < fd.v2p.length; vi++) {
          const pi = fd.v2p[vi];
          fd.pos[vi * 3]     = body.pos[pi * 3]     + expansion[pi * 3];
          fd.pos[vi * 3 + 1] = body.pos[pi * 3 + 1] + expansion[pi * 3 + 1];
          fd.pos[vi * 3 + 2] = body.pos[pi * 3 + 2] + expansion[pi * 3 + 2];
        }

        recomputeNormals(fd.pos, fd.idx, fd.nrm);
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.posBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, fd.pos);
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.normBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, fd.nrm);
      }
    }
  }

  function syncSpringLines() {
    let aliveCount = 0;
    for (const body of bodies) aliveCount += body.springs.filter((spring) => !spring.broken).length;

    const v = new Float32Array(aliveCount * 6);
    let off = 0;

    for (const body of bodies) {
      for (const { i, j, broken } of body.springs) {
        if (broken) continue;
        v[off++] = body.pos[i * 3];
        v[off++] = body.pos[i * 3 + 1];
        v[off++] = body.pos[i * 3 + 2];
        v[off++] = body.pos[j * 3];
        v[off++] = body.pos[j * 3 + 1];
        v[off++] = body.pos[j * 3 + 2];
      }
    }

    if (!springVAO) {
      springVAO = gl.createVertexArray()!;
      springBuf = gl.createBuffer()!;
      gl.bindVertexArray(springVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, springBuf);
      const ap = gl.getAttribLocation(lineProg, "aPosition");
      gl.enableVertexAttribArray(ap);
      gl.vertexAttribPointer(ap, 3, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, springBuf!);
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.DYNAMIC_DRAW);
    return aliveCount * 2;
  }

  function syncPreviewAxes(preview: SimState) {
    const center = getPoseCenter(preview.pos);
    const axisLength = Math.max(1.25, getPoseRadius(preview.pos, center) * 1.2);
    const [xx, xy, xz] = rotateOffset(axisLength, 0, 0, previewOrientation);
    const [yx, yy, yz] = rotateOffset(0, axisLength, 0, previewOrientation);
    const [zx, zy, zz] = rotateOffset(0, 0, axisLength, previewOrientation);
    const v = new Float32Array([
      center[0], center[1], center[2], center[0] + xx, center[1] + xy, center[2] + xz,
      center[0], center[1], center[2], center[0] + yx, center[1] + yy, center[2] + yz,
      center[0], center[1], center[2], center[0] + zx, center[1] + zy, center[2] + zz,
    ]);

    if (!axisVAO) {
      axisVAO = gl.createVertexArray()!;
      axisBuf = gl.createBuffer()!;
      gl.bindVertexArray(axisVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, axisBuf);
      const ap = gl.getAttribLocation(lineProg, "aPosition");
      gl.enableVertexAttribArray(ap);
      gl.vertexAttribPointer(ap, 3, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, axisBuf!);
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.DYNAMIC_DRAW);
  }

  function draw() {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const { eye, forward, right, up, focus } = getViewState();
    const proj = mat4Persp(CAMERA_FOV, canvas.width / canvas.height, 0.1, 80);
    const view = mat4LookAt(eye, focus, up);
    const mvp = mat4Mul(proj, view);
    const id = mat4Id();
    const time = performance.now() * 0.001;
    const spaceMix = smoothstep(SPACE_SKY_START_HEIGHT, SPACE_SKY_FULL_HEIGHT, eye[1]);
    const lighting = getSceneLighting(
      time,
      firstPerson?.active ? firstPerson.position : target as [number, number, number],
      dayNightCycleEnabled
    );

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.useProgram(skyProg);
    gl.uniform3fv(gl.getUniformLocation(skyProg, "uCamForward"), forward);
    gl.uniform3fv(gl.getUniformLocation(skyProg, "uCamRight"), right);
    gl.uniform3fv(gl.getUniformLocation(skyProg, "uCamUp"), up);
    gl.uniform3fv(gl.getUniformLocation(skyProg, "uSunDir"), lighting.sunDir);
    gl.uniform1f(gl.getUniformLocation(skyProg, "uAspect"), canvas.width / canvas.height);
    gl.uniform1f(gl.getUniformLocation(skyProg, "uTanHalfFov"), Math.tan(CAMERA_FOV * 0.5));
    gl.uniform1f(gl.getUniformLocation(skyProg, "uTime"), time);
    gl.uniform1f(gl.getUniformLocation(skyProg, "uSpaceMix"), spaceMix);
    gl.bindVertexArray(skyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);

    gl.useProgram(terrainProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(terrainProg, "uView"), false, view);
    gl.uniformMatrix4fv(gl.getUniformLocation(terrainProg, "uProj"), false, proj);
    gl.uniform3fv(gl.getUniformLocation(terrainProg, "uLightDir"), lighting.lightDir);
    gl.uniform3fv(gl.getUniformLocation(terrainProg, "uLightColor"), lighting.lightColor);
    gl.uniform3fv(gl.getUniformLocation(terrainProg, "uAmbientColor"), lighting.ambientColor);
    gl.uniform3fv(gl.getUniformLocation(terrainProg, "uFogColor"), lighting.fogColor);
    gl.uniform3fv(gl.getUniformLocation(terrainProg, "uCamPos"), eye);
    gl.uniform1f(gl.getUniformLocation(terrainProg, "uTime"), time);
    gl.bindVertexArray(terrainVAO);
    gl.drawElements(gl.TRIANGLES, terrain.indices.length, gl.UNSIGNED_INT, 0);

    gl.useProgram(bodyProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(bodyProg, "uModel"), false, id);
    gl.uniformMatrix4fv(gl.getUniformLocation(bodyProg, "uView"), false, view);
    gl.uniformMatrix4fv(gl.getUniformLocation(bodyProg, "uProj"), false, proj);
    gl.uniform3fv(gl.getUniformLocation(bodyProg, "uLightDir"), lighting.lightDir);
    gl.uniform3fv(gl.getUniformLocation(bodyProg, "uLightColor"), lighting.lightColor);
    gl.uniform3fv(gl.getUniformLocation(bodyProg, "uAmbientColor"), lighting.ambientColor);
    gl.uniform3fv(gl.getUniformLocation(bodyProg, "uFogColor"), lighting.fogColor);
    gl.uniform3fv(gl.getUniformLocation(bodyProg, "uCamPos"), eye);
    const xrayBodies = showSprings && !wireframe;
    gl.uniform1f(bodyAlphaLoc, xrayBodies ? 0.28 : BODY_ALPHA);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(!xrayBodies);

    gl.disable(gl.CULL_FACE);
    for (const rb of renderBodies) {
      gl.uniform3fv(bodyColorLoc, rb.body.color);

      for (const mesh of rb.meshes) {
        gl.bindVertexArray(mesh.vao);
        gl.drawElements(wireframe ? gl.LINES : gl.TRIANGLES, mesh.cnt, gl.UNSIGNED_INT, 0);
      }
    }
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    const preview = bodies.find((body) => !body.dropped);
    if (preview) {
      syncPreviewAxes(preview);
      gl.useProgram(lineProg);
      gl.uniformMatrix4fv(lineMvpLoc, false, mvp);
      gl.bindVertexArray(axisVAO);
      gl.uniform3fv(lineColorLoc, [1.0, 0.35, 0.35]);
      gl.drawArrays(gl.LINES, 0, 2);
      gl.uniform3fv(lineColorLoc, [0.4, 1.0, 0.5]);
      gl.drawArrays(gl.LINES, 2, 2);
      gl.uniform3fv(lineColorLoc, [0.45, 0.7, 1.0]);
      gl.drawArrays(gl.LINES, 4, 2);
    }

    if (showSprings) {
      const cnt = syncSpringLines();
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(lineProg);
      gl.uniformMatrix4fv(lineMvpLoc, false, mvp);
      gl.uniform3fv(lineColorLoc, [0.53, 0.35, 0.1]);
      gl.bindVertexArray(springVAO);
      gl.drawArrays(gl.LINES, 0, cnt);
      gl.enable(gl.DEPTH_TEST);
    }
  }

  return {
    load(nextBodies: SimState[]) {
      bodies = nextBodies;
      rebuildBodies();
      syncFaces();
      draw();
    },
    update(cfg: Config) {
      stepSim(bodies, cfg);
      updateFirstPerson();
      applyGrabConstraint();
      syncFaces();
      draw();
    },
    setPreviewOrientation(orientation: Orientation) {
      previewOrientation = { ...orientation };
    },
    enterFirstPerson,
    exitFirstPerson,
    releaseFirstPerson,
    toggleMouseCapture,
    getFirstPersonState,
    isFirstPersonActive() {
      return Boolean(firstPerson?.active);
    },
    isFirstPersonSuspended() {
      return Boolean(firstPerson?.active && firstPerson.suspended);
    },
    toggleSprings() {
      showSprings = !showSprings;
    },
    toggleWireframe() {
      wireframe = !wireframe;
    },
    toggleDayNightCycle() {
      dayNightCycleEnabled = !dayNightCycleEnabled;
      draw();
    },
    resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(canvas.clientWidth * dpr);
      canvas.height = Math.floor(canvas.clientHeight * dpr);
      draw();
    },
    getCameraState() {
      return {
        theta,
        phi,
        dist,
        target: [...target] as [number, number, number],
      };
    },
    dispose() {
      exitFirstPerson();
      disposeBodyMeshes();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("mousemove", onDocumentMouseMove);
      document.removeEventListener("pointerlockchange", onPointerLockChange);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      gl.deleteBuffer(terrainPosBuf);
      gl.deleteBuffer(terrainNormBuf);
      gl.deleteBuffer(terrainIdxBuf);
      gl.deleteVertexArray(terrainVAO);
      gl.deleteVertexArray(skyVAO);
      if (springBuf) gl.deleteBuffer(springBuf);
      if (springVAO) gl.deleteVertexArray(springVAO);
      if (axisBuf) gl.deleteBuffer(axisBuf);
      if (axisVAO) gl.deleteVertexArray(axisVAO);
    },
  };
}
