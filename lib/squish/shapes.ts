import type { BodyColor, ShapeName, SimState } from './types';

interface ShapeMeta {
  id?: number;
  color?: BodyColor;
  dropped?: boolean;
}

const defaultColor: BodyColor = [1, 0.843, 0];

// PERIDYNAMICS
// Connects all particles within a spatial horizon
function applyPeridynamicHorizon(pos: Float32Array, N: number, horizon: number) {
  const springs = [];
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const dx = pos[i * 3] - pos[j * 3];
      const dy = pos[i * 3 + 1] - pos[j * 3 + 1];
      const dz = pos[i * 3 + 2] - pos[j * 3 + 2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // If particles are within the horizon, form a peridynamic bond
      if (dist > 0 && dist <= horizon) {
        springs.push({ i, j, rest: dist, broken: false });
      }
    }
  }
  return springs;
}

function buildGrid(
  gx: number,
  gy: number,
  gz: number,
  s: number,
  y0: number,
  shape: ShapeName,
  meta: ShapeMeta
): SimState {
  const N = gx * gy * gz;
  const pidx = (x: number, y: number, z: number) => x * gy * gz + y * gz + z;

  const hx = (gx - 1) * s * 0.5;
  const hz = (gz - 1) * s * 0.5;

  const pos = new Float32Array(N * 3);
  for (let x = 0; x < gx; x++) {
    for (let y = 0; y < gy; y++) {
      for (let z = 0; z < gz; z++) {
        const i = pidx(x, y, z);
        pos[i * 3] = x * s - hx;
        pos[i * 3 + 1] = y0 + y * s;
        pos[i * 3 + 2] = z * s - hz;
      }
    }
  }

  // EXPLICIT STRUCTURAL SPRINGS
  // We intentionally allow duplicate i->j and j->i pairs here because 
  // the physics stiffness scalar is tuned for this exact topology!
  const springs = [];
  for (let x = 0; x < gx; x++) {
    for (let y = 0; y < gy; y++) {
      for (let z = 0; z < gz; z++) {
        // Nearest neighbors and diagonals (26-way)
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dz = -1; dz <= 1; dz++) {
              if (!dx && !dy && !dz) continue;
              
              const nx = x + dx;
              const ny = y + dy;
              const nz = z + dz;
              
              if (nx < 0 || nx >= gx || ny < 0 || ny >= gy || nz < 0 || nz >= gz) continue;
              
              springs.push({
                i: pidx(x, y, z),
                j: pidx(nx, ny, nz),
                rest: Math.hypot(dx, dy, dz) * s,
                broken: false
              });
            }
          }
        }
        
        // Bending springs (distance 2, positive axis only to match original tuning)
        for (const [dx, dy, dz] of [[2, 0, 0], [0, 2, 0], [0, 0, 2]] as [number, number, number][]) {
          const nx = x + dx;
          const ny = y + dy;
          const nz = z + dz;
          if (nx >= gx || ny >= gy || nz >= gz) continue;
          springs.push({
            i: pidx(x, y, z),
            j: pidx(nx, ny, nz),
            rest: Math.hypot(dx, dy, dz) * s,
            broken: false
          });
        }
      }
    }
  }

  const faceDefs: Array<[(u: number, v: number) => number, number, number]> = [
    [(u, v) => pidx(u, v, 0), gx, gy],
    [(u, v) => pidx(u, v, gz - 1), gx, gy],
    [(u, v) => pidx(0, u, v), gy, gz],
    [(u, v) => pidx(gx - 1, u, v), gy, gz],
    [(u, v) => pidx(u, 0, v), gx, gz],
    [(u, v) => pidx(u, gy - 1, v), gx, gz],
  ];

  const faces = faceDefs.map(([fn, nu, nv]) => {
    const vertToParticle: number[] = [];
    for (let v = 0; v < nv; v++) {
      for (let u = 0; u < nu; u++) {
        vertToParticle.push(fn(u, v));
      }
    }

    const triIdx: number[] = [];
    for (let v = 0; v < nv - 1; v++) {
      for (let u = 0; u < nu - 1; u++) {
        const a = v * nu + u;
        const b = v * nu + (u + 1);
        const c = (v + 1) * nu + u;
        const d = (v + 1) * nu + (u + 1);
        triIdx.push(a, b, d, a, d, c);
      }
    }
    return { vertToParticle, triIdx };
  });

  return {
    id: meta.id ?? 0,
    shape,
    color: meta.color ?? defaultColor,
    N,
    pos,
    prev: new Float32Array(pos),
    facc: new Float32Array(N * 3),
    springs,
    faces,
    dropped: meta.dropped ?? false,
  };
}

function sphere(meta: ShapeMeta): SimState {
  const radius = 1.3;
  const y0 = 2.8;
  const shells = 2; // Concentric volume layers for soft body mass
  const subdivs = 3; // 162 surface vertices, 320 faces -> very smooth!

  // 1. Base Icosahedron vertices
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: [number,number,number][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];

  // Normalize each tuple to unit length
  verts = verts.map(([x, y, z]) => {
    const l = Math.sqrt(x*x + y*y + z*z);
    return [x/l, y/l, z/l];
  });

  // Normalize base vertices to length 1
  verts = verts.map((v) => {
    const l = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
    return [v[0]/l, v[1]/l, v[2]/l];
  });

  // Base Icosahedron faces
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]
  ];

  // 2. Subdivide faces into smaller triangles to make it smooth
  for (let s = 0; s < subdivs; s++) {
    const nextFaces: number[][] = [];
    const cache: Record<string, number> = {};

    const getMid = (i1: number, i2: number) => {
      const key = i1 < i2 ? `${i1}-${i2}` : `${i2}-${i1}`;
      if (key in cache) return cache[key];
      const p1 = verts[i1], p2 = verts[i2];
      const m = [(p1[0]+p2[0])/2, (p1[1]+p2[1])/2, (p1[2]+p2[2])/2];
      const l = Math.sqrt(m[0]*m[0] + m[1]*m[1] + m[2]*m[2]);
      verts.push([m[0]/l, m[1]/l, m[2]/l]);
      const idx = verts.length - 1;
      cache[key] = idx;
      return idx;
    };

    for (const f of faces) {
      const a = f[0], b = f[1], c = f[2];
      const ab = getMid(a, b), bc = getMid(b, c), ca = getMid(c, a);
      nextFaces.push(
        [a, ab, ca],
        [b, bc, ab],
        [c, ca, bc],
        [ab, bc, ca]
      );
    }
    faces = nextFaces;
  }

  // 3. Create volumetric particle positions
  const V = verts.length;
  const N = 1 + (shells * V); // 1 center point + surface shells

  const pos = new Float32Array(N * 3);
  pos[0] = 0; pos[1] = y0; pos[2] = 0; // Center particle

  // Distribute particles into concentric shells
  for (let s = 1; s <= shells; s++) {
    const r = radius * (s / shells);
    const offset = 1 + ((s - 1) * V);
    for (let i = 0; i < V; i++) {
      const pIdx = offset + i;
      pos[pIdx * 3]     = verts[i][0] * r;
      pos[pIdx * 3 + 1] = y0 + verts[i][1] * r;
      pos[pIdx * 3 + 2] = verts[i][2] * r;
    }
  }

  // 4. Hook up structural springs using Peridynamic Horizon
  // With a radius of 1.3 and 2 shells, a horizon of 0.85 thoroughly connects the volumetric cloud into a solid bouncy mass.
  const springs = applyPeridynamicHorizon(pos, N, 0.85);

  // 5. Generate render geometry (only the outermost shell needs faces!)
  const vertToParticle: number[] = [];
  const outOffset = 1 + ((shells - 1) * V);
  for (let i = 0; i < V; i++) {
    vertToParticle.push(outOffset + i);
  }

  const triIdx: number[] = [];
  for (const f of faces) {
    triIdx.push(f[0], f[1], f[2]);
  }

  return {
    id: meta.id ?? 0,
    shape: 'sphere',
    color: meta.color ?? defaultColor,
    N,
    pos,
    prev: new Float32Array(pos), // Perfectly synced
    facc: new Float32Array(N * 3),
    springs,
    faces: [{ vertToParticle, triIdx }],
    dropped: meta.dropped ?? false
  };
}

export function buildShape(shape: ShapeName, meta: ShapeMeta): SimState {
  if (shape === 'sphere') return sphere(meta);
  if (shape === 'tower') return buildGrid(3, 10, 3, 0.38, 0.5, 'tower', meta);
  return buildGrid(6, 6, 6, 0.38, 2.5, 'cube', meta);
}