import { getPoseCenter, getPoseRadius, rotateOffset } from "./orientation";
import { stepSim } from "./sim-core";
import type { Config, Orientation, SimState } from "./types";

// const BODY_VS = `#version 300 es
// precision highp float;
// in vec3 aPosition;
// in vec3 aNormal;
// uniform mat4 uModel, uView, uProj;
// out vec3 vPos, vNorm;
// void main() {
//   vec4 w = uModel * vec4(aPosition, 1.0);
//   gl_Position = uProj * uView * w;
//   vPos = w.xyz;
//   vNorm = mat3(uModel) * aNormal;
// }`;

// const BODY_VS = `#version 300 es
// precision highp float;
// in vec3 aPosition;
// in vec3 aNormal;
// uniform mat4 uModel, uView, uProj;

// // We pass in the center of the shape to scale from it properly
// uniform vec3 uCenter;

// out vec3 vPos, vNorm;
// void main() {
//     vec3 expandedPos = aPosition + aNormal * 0.18;

//     vec4 w = uModel * vec4(expandedPos, 1.0);
//     gl_Position = uProj * uView * w;
//     vPos = w.xyz;
//     vNorm = mat3(uModel) * aNormal;
// }
// `;

const PARTICLE_RADIUS = 0.18;


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
uniform vec3 uColor;
out vec4 fc;
void main() {
  fc = vec4(uColor, 1.0);
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
  const bodyColorLoc = gl.getUniformLocation(bodyProg, "uColor");
  const lineColorLoc = gl.getUniformLocation(lineProg, "uColor");
  const lineMvpLoc = gl.getUniformLocation(lineProg, "uMVP");

  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0.027, 0.027, 0.054, 1);

  const h = 12;
  const floorVerts = new Float32Array([
    -h, -2.8, h,
    h, -2.8, h,
    h, -2.8, -h,
    -h, -2.8, h,
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

  let bodies: SimState[] = [];
  let renderBodies: RenderBody[] = [];
  let wireframe = false;
  let showSprings = false;
  let springVAO: WebGLVertexArrayObject | null = null;
  let springBuf: WebGLBuffer | null = null;
  let axisVAO: WebGLVertexArrayObject | null = null;
  let axisBuf: WebGLBuffer | null = null;
  let previewOrientation: Orientation = { x: 0, y: 0, z: 0 };

  let theta = 0.35;
  let phi = 0.3;
  let dist = 11;
  const target = [0, 0.5, 0];
  let dragging = false;
  let lx = 0;
  let ly = 0;

  const getEye = () => {
    const cr = dist * Math.cos(phi);
    return [
      target[0] + cr * Math.sin(theta),
      target[1] + dist * Math.sin(phi),
      target[2] + cr * Math.cos(theta),
    ] as [number, number, number];
  };

  const onDown = (e: MouseEvent) => {
    dragging = true;
    lx = e.clientX;
    ly = e.clientY;
  };
  const onUp = () => {
    dragging = false;
  };
  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    theta -= (e.clientX - lx) * 0.007;
    phi = Math.max(-1.4, Math.min(1.4, phi - (e.clientY - ly) * 0.007));
    lx = e.clientX;
    ly = e.clientY;
  };
  const onWheel = (e: WheelEvent) => {
    dist = Math.max(3, Math.min(22, dist + e.deltaY * 0.01));
  };

  canvas.addEventListener("mousedown", onDown);
  canvas.addEventListener("mouseup", onUp);
  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("wheel", onWheel, { passive: true });

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

      // Body centroid — used to orient face normals outward
      let bcx = 0, bcy = 0, bcz = 0;
      for (let i = 0; i < body.N; i++) {
        bcx += body.pos[i * 3];
        bcy += body.pos[i * 3 + 1];
        bcz += body.pos[i * 3 + 2];
      }
      bcx /= body.N; bcy /= body.N; bcz /= body.N;

      // Multi-face = flat shape (prism/tower). Single-face = curved shape (sphere).
      const isMultiFace = rb.faceData.length > 1;

      // Step 1 — copy particle positions and compute per-vertex normals for each face
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

      // Step 2 — accumulate one expansion vector per particle from all faces it belongs to
      // KEY: using the same accumulated vector in all face VBOs later means no seams
      const expansion = new Float32Array(body.N * 3);

      for (let fi = 0; fi < rb.faceData.length; fi++) {
        const fd = rb.faceData[fi];

        if (isMultiFace) {
          // Flat face: average all vertex normals → one uniform outward normal for this face.
          // Every particle in this face gets the SAME contribution, keeping the face flat.
          let nx = 0, ny = 0, nz = 0;
          for (let vi = 0; vi < fd.v2p.length; vi++) {
            nx += fd.nrm[vi * 3];
            ny += fd.nrm[vi * 3 + 1];
            nz += fd.nrm[vi * 3 + 2];
          }
          const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          nx /= l; ny /= l; nz /= l;

          // Face centroid to check outward direction
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

          // Accumulate this face's outward normal into every particle it owns
          for (const pi of fd.v2p) {
            expansion[pi * 3]     += nx * PARTICLE_RADIUS;
            expansion[pi * 3 + 1] += ny * PARTICLE_RADIUS;
            expansion[pi * 3 + 2] += nz * PARTICLE_RADIUS;
          }
        } else {
          // Curved face (sphere): use each vertex's own normal for radial expansion
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

      // Step 3 — write expanded positions into all face VBOs using the per-particle value
      // Same expansion[pi] used in every face that contains pi → identical world position → no seam
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

    const eye = getEye();
    const proj = mat4Persp(Math.PI / 4, canvas.width / canvas.height, 0.1, 80);
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

    gl.disable(gl.CULL_FACE);
    for (const rb of renderBodies) {
      gl.uniform3fv(bodyColorLoc, rb.body.color);
      
      const [cx, cy, cz] = getPoseCenter(rb.body.pos);
      // gl.uniform3f(gl.getUniformLocation(bodyProg, "uCenter"), cx, cy, cz);

      for (const mesh of rb.meshes) {
        gl.bindVertexArray(mesh.vao);
        gl.drawElements(wireframe ? gl.LINES : gl.TRIANGLES, mesh.cnt, gl.UNSIGNED_INT, 0);
      }
    }
    gl.enable(gl.CULL_FACE);

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
      gl.useProgram(lineProg);
      gl.uniformMatrix4fv(lineMvpLoc, false, mvp);
      gl.uniform3fv(lineColorLoc, [0.53, 0.35, 0.1]);
      gl.bindVertexArray(springVAO);
      gl.drawArrays(gl.LINES, 0, cnt);
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
      syncFaces();
      draw();
    },
    setPreviewOrientation(orientation: Orientation) {
      previewOrientation = { ...orientation };
    },
    toggleSprings() {
      showSprings = !showSprings;
    },
    toggleWireframe() {
      wireframe = !wireframe;
    },
    resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(canvas.clientWidth * dpr);
      canvas.height = Math.floor(canvas.clientHeight * dpr);
      draw();
    },
    dispose() {
      disposeBodyMeshes();
      canvas.removeEventListener("mousedown", onDown);
      canvas.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("wheel", onWheel);
      gl.deleteBuffer(floorBuf);
      gl.deleteVertexArray(floorVAO);
      if (springBuf) gl.deleteBuffer(springBuf);
      if (springVAO) gl.deleteVertexArray(springVAO);
      if (axisBuf) gl.deleteBuffer(axisBuf);
      if (axisVAO) gl.deleteVertexArray(axisVAO);
    },
  };
}
