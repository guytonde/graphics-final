import { stepSim } from "./sim-core";
import type { Config, SimState } from "./types";

const BODY_VS = `#version 300 es
precision highp float;
in vec3 aPosition;
in vec3 aNormal;
uniform mat4 uModel, uView, uProj;
out vec3 vPos, vNorm;
void main() {
  vec4 w = uModel * vec4(aPosition, 1.0);
  gl_Position = uProj * uView * w;
  vPos = w.xyz;
  vNorm = mat3(uModel) * aNormal;
}`;

const BODY_FS = `#version 300 es
precision highp float;
in vec3 vPos, vNorm;
uniform vec3 uLightPos, uCamPos, uColor;
out vec4 fragColor;
void main() {
  vec3 N = normalize(vNorm);
  if (!gl_FrontFacing) N = -N;
  vec3 L = normalize(uLightPos - vPos);
  vec3 H = normalize(L + normalize(uCamPos - vPos));
  float d = max(dot(N, L), 0.0);
  float s = pow(max(dot(H, N), 0.0), 80.0);
  fragColor = vec4(uColor * (0.18 + d * 0.75) + vec3(1., .97, .85) * s * 0.6, 1.0);
}`;

const FLAT_VS = `#version 300 es
precision highp float;
in vec3 aPosition;
uniform mat4 uMVP;
out vec2 vUV;
void main() {
  gl_Position = uMVP * vec4(aPosition, 1.);
  vUV = aPosition.xz * .5;
}`;

const FLOOR_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fc;
void main() {
  vec2 g = abs(fract(vUV) - .5);
  float line = 1. - smoothstep(0., .04, min(g.x, g.y));
  fc = vec4(vec3(.09 + line * .05), 1.);
}`;

const LINE_FS = `#version 300 es
precision highp float;
out vec4 fc;
void main() {
  fc = vec4(.53, .35, .1, .45);
}`;

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

  m[0] = x[0];  m[1] = y[0];  m[2] = z[0];
  m[4] = x[1];  m[5] = y[1];  m[6] = z[1];
  m[8] = x[2];  m[9] = y[2];  m[10] = z[2];
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
    const i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2];
    const ax = pos[i0 * 3], ay = pos[i0 * 3 + 1], az = pos[i0 * 3 + 2];
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
  const flatProg = mkProg(gl, FLAT_VS, FLOOR_FS);
  const lineProg = mkProg(gl, FLAT_VS, LINE_FS);

  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(.027, .027, .054, 1);

  const h = 12;
  const floorVerts = new Float32Array([
    -h, -2.8,  h,
     h, -2.8,  h,
     h, -2.8, -h,
    -h, -2.8,  h,
     h, -2.8, -h,
    -h, -2.8, -h,
  ]);

  const floorVAO = gl.createVertexArray()!;
  gl.bindVertexArray(floorVAO);
  const floorBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, floorBuf);
  gl.bufferData(gl.ARRAY_BUFFER, floorVerts, gl.STATIC_DRAW);
  const floorPos = gl.getAttribLocation(flatProg, "aPosition");
  gl.enableVertexAttribArray(floorPos);
  gl.vertexAttribPointer(floorPos, 3, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  let sim: SimState;
  let faceMeshes: FaceMesh[] = [];
  let faceData: Array<{ v2p: number[]; idx: Uint32Array; pos: Float32Array; nrm: Float32Array }> = [];
  let wireframe = false;
  let showSprings = false;
  let springVAO: WebGLVertexArrayObject | null = null;
  let springBuf: WebGLBuffer | null = null;

  let theta = .35, phi = .30, dist = 11;
  const target = [0, .5, 0];
  let dragging = false, lx = 0, ly = 0;

  const getEye = () => {
    const cr = dist * Math.cos(phi);
    return [target[0] + cr * Math.sin(theta), target[1] + dist * Math.sin(phi), target[2] + cr * Math.cos(theta)] as [number, number, number];
  };

  const onDown = (e: MouseEvent) => { dragging = true; lx = e.clientX; ly = e.clientY; };
  const onUp = () => { dragging = false; };
  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    theta -= (e.clientX - lx) * .007;
    phi = Math.max(-1.4, Math.min(1.4, phi - (e.clientY - ly) * .007));
    lx = e.clientX;
    ly = e.clientY;
  };
  const onWheel = (e: WheelEvent) => { dist = Math.max(3, Math.min(22, dist + e.deltaY * .01)); };

  canvas.addEventListener("mousedown", onDown);
  canvas.addEventListener("mouseup", onUp);
  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("wheel", onWheel, { passive: true });

  function rebuildFaces() {
    for (const f of faceMeshes) {
      gl.deleteBuffer(f.posBuf);
      gl.deleteBuffer(f.normBuf);
      gl.deleteBuffer(f.idxBuf);
      gl.deleteVertexArray(f.vao);
    }
    faceMeshes = [];
    faceData = [];

    for (const { vertToParticle, triIdx } of sim.faces) {
      const idx = new Uint32Array(triIdx);
      faceMeshes.push(mkFaceMesh(gl, bodyProg, vertToParticle.length, idx));
      faceData.push({
        v2p: vertToParticle,
        idx,
        pos: new Float32Array(vertToParticle.length * 3),
        nrm: new Float32Array(vertToParticle.length * 3),
      });
    }
  }

  function syncFaces() {
    for (let fi = 0; fi < faceData.length; fi++) {
      const fd = faceData[fi];
      const fm = faceMeshes[fi];

      for (let vi = 0; vi < fd.v2p.length; vi++) {
        const pi = fd.v2p[vi];
        fd.pos[vi * 3] = sim.pos[pi * 3];
        fd.pos[vi * 3 + 1] = sim.pos[pi * 3 + 1];
        fd.pos[vi * 3 + 2] = sim.pos[pi * 3 + 2];
      }

      recomputeNormals(fd.pos, fd.idx, fd.nrm);

      gl.bindBuffer(gl.ARRAY_BUFFER, fm.posBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, fd.pos);
      gl.bindBuffer(gl.ARRAY_BUFFER, fm.normBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, fd.nrm);
    }
  }

  function syncSpringLines() {
    const alive = sim.springs.filter((s) => !s.broken);
    const v = new Float32Array(alive.length * 6);

    alive.forEach(({ i, j }, k) => {
      v[k * 6] = sim.pos[i * 3];
      v[k * 6 + 1] = sim.pos[i * 3 + 1];
      v[k * 6 + 2] = sim.pos[i * 3 + 2];
      v[k * 6 + 3] = sim.pos[j * 3];
      v[k * 6 + 4] = sim.pos[j * 3 + 1];
      v[k * 6 + 5] = sim.pos[j * 3 + 2];
    });

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
    return alive.length * 2;
  }

  function draw() {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const eye = getEye();
    const proj = mat4Persp(Math.PI / 4, canvas.width / canvas.height, .1, 80);
    const view = mat4LookAt(eye, target, [0, 1, 0]);
    const mvp = mat4Mul(proj, view);
    const id = mat4Id();

    gl.useProgram(flatProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(flatProg, "uMVP"), false, mvp);
    gl.bindVertexArray(floorVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.useProgram(bodyProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(bodyProg, "uModel"), false, id);
    gl.uniformMatrix4fv(gl.getUniformLocation(bodyProg, "uView"), false, view);
    gl.uniformMatrix4fv(gl.getUniformLocation(bodyProg, "uProj"), false, proj);
    gl.uniform3fv(gl.getUniformLocation(bodyProg, "uLightPos"), [8, 15, 8]);
    gl.uniform3fv(gl.getUniformLocation(bodyProg, "uCamPos"), eye);
    gl.uniform3fv(gl.getUniformLocation(bodyProg, "uColor"), wireframe ? [.8, .6, .1] : [1, .843, 0]);

    gl.disable(gl.CULL_FACE);
    for (const m of faceMeshes) {
      gl.bindVertexArray(m.vao);
      gl.drawElements(wireframe ? gl.LINES : gl.TRIANGLES, m.cnt, gl.UNSIGNED_INT, 0);
    }
    gl.enable(gl.CULL_FACE);

    if (showSprings) {
      const cnt = syncSpringLines();
      gl.useProgram(lineProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(lineProg, "uMVP"), false, mvp);
      gl.bindVertexArray(springVAO);
      gl.drawArrays(gl.LINES, 0, cnt);
    }
  }

  return {
    load(nextSim: SimState) {
      sim = nextSim;
      rebuildFaces();
      syncFaces();
      draw();
    },
    update(cfg: Config) {
      stepSim(sim, cfg);
      syncFaces();
      draw();
    },
    toggleSprings() {
      showSprings = !showSprings;
    },
    toggleWireframe() {
      wireframe = !wireframe;
    },
    resize() {
      // Multiply CSS size by pixel ratio for high-res Retina displays
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(canvas.clientWidth * dpr);
      canvas.height = Math.floor(canvas.clientHeight * dpr);
      draw();
    },
    dispose() {
      canvas.removeEventListener("mousedown", onDown);
      canvas.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("wheel", onWheel);
    },
  };
}