import type { Config, SimState } from "./types";

const GRAVITY = 18;
export const FLOOR_Y = -2.8;
const DT = 1 / 60;
const PARTICLE_RADIUS = 0.18;
const COLLISION_RADIUS = PARTICLE_RADIUS * 2;
const COLLISION_RADIUS_SQ = COLLISION_RADIUS * COLLISION_RADIUS;
const CELL_SIZE = COLLISION_RADIUS;
const FLOOR_BOUNCE = 0.8;
const FLOOR_FRICTION = 0.85;
const INTER_BODY_RESTITUTION = 0.28;
const INTER_BODY_STICK = 0.15;

const neighborOffsets = [-1, 0, 1].flatMap((x) =>
  [-1, 0, 1].flatMap((y) => [-1, 0, 1].map((z) => [x, y, z] as const))
);

export interface Actions {
  drop: () => void;
  smash: () => void;
  melt: () => void;
  clear: () => void;
  toggleSprings: () => void;
  toggleWireframe: () => void;
}

export function makeActions(args: Actions): Actions {
  return args;
}

export function stepSim(bodies: SimState[], cfg: Config) {
  const activeBodies = bodies.filter((body) => body.dropped);
  if (!activeBodies.length) return;

  const sdt2 = (DT / cfg.substeps) ** 2;

  for (let sub = 0; sub < cfg.substeps; sub++) {
    for (const body of activeBodies) {
      body.facc.fill(0);
      for (let i = 0; i < body.N; i++) body.facc[i * 3 + 1] -= GRAVITY;
    }

    for (const body of activeBodies) {
      for (const sp of body.springs) {
        if (sp.broken) continue;

        const dx = body.pos[sp.j * 3] - body.pos[sp.i * 3];
        const dy = body.pos[sp.j * 3 + 1] - body.pos[sp.i * 3 + 1];
        const dz = body.pos[sp.j * 3 + 2] - body.pos[sp.i * 3 + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-8;
        const stretch = len - sp.rest;

        if (stretch / sp.rest > cfg.breakRatio) {
          sp.broken = true;
          continue;
        }

        const f = cfg.stiffness * stretch / len;
        body.facc[sp.i * 3] += f * dx;
        body.facc[sp.i * 3 + 1] += f * dy;
        body.facc[sp.i * 3 + 2] += f * dz;
        body.facc[sp.j * 3] -= f * dx;
        body.facc[sp.j * 3 + 1] -= f * dy;
        body.facc[sp.j * 3 + 2] -= f * dz;
      }
    }

    for (const body of activeBodies) {
      for (let i = 0; i < body.N; i++) {
        const px = body.pos[i * 3];
        const py = body.pos[i * 3 + 1];
        const pz = body.pos[i * 3 + 2];
        const ox = body.prev[i * 3];
        const oy = body.prev[i * 3 + 1];
        const oz = body.prev[i * 3 + 2];
        const vx = (px - ox) * cfg.damping;
        const vy = (py - oy) * cfg.damping;
        const vz = (pz - oz) * cfg.damping;

        const nx = px + vx + body.facc[i * 3] * sdt2;
        const ny = py + vy + body.facc[i * 3 + 1] * sdt2;
        const nz = pz + vz + body.facc[i * 3 + 2] * sdt2;

        body.prev[i * 3] = px;
        body.prev[i * 3 + 1] = py;
        body.prev[i * 3 + 2] = pz;
        body.pos[i * 3] = nx;
        body.pos[i * 3 + 1] = ny;
        body.pos[i * 3 + 2] = nz;

        clampFloor(body, i);
      }
    }

    if (activeBodies.length > 1) {
      resolveInterBodyCollisions(activeBodies);
    }
  }
}

function clampFloor(body: SimState, i: number) {
  const py = body.pos[i * 3 + 1];
  if (py >= FLOOR_Y + 0.05) return;

  const px = body.pos[i * 3];
  const pz = body.pos[i * 3 + 2];
  const ox = body.prev[i * 3];
  const oy = body.prev[i * 3 + 1];
  const oz = body.prev[i * 3 + 2];
  const vx = px - ox;
  const vy = py - oy;
  const vz = pz - oz;
  const ny = FLOOR_Y + 0.05;

  body.pos[i * 3 + 1] = ny;
  body.prev[i * 3 + 1] = ny + vy * FLOOR_BOUNCE;
  body.prev[i * 3] = px - vx * FLOOR_FRICTION;
  body.prev[i * 3 + 2] = pz - vz * FLOOR_FRICTION;
}

function resolveInterBodyCollisions(bodies: SimState[]) {
  const buckets = new Map<string, Array<{ bodyIndex: number; particleIndex: number }>>();

  for (let bodyIndex = 0; bodyIndex < bodies.length; bodyIndex++) {
    const body = bodies[bodyIndex];
    for (let particleIndex = 0; particleIndex < body.N; particleIndex++) {
      const base = particleIndex * 3;
      const cellX = Math.floor(body.pos[base] / CELL_SIZE);
      const cellY = Math.floor(body.pos[base + 1] / CELL_SIZE);
      const cellZ = Math.floor(body.pos[base + 2] / CELL_SIZE);
      const key = `${cellX},${cellY},${cellZ}`;
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.push({ bodyIndex, particleIndex });
      } else {
        buckets.set(key, [{ bodyIndex, particleIndex }]);
      }
    }
  }

  for (let bodyIndex = 0; bodyIndex < bodies.length; bodyIndex++) {
    const body = bodies[bodyIndex];

    for (let particleIndex = 0; particleIndex < body.N; particleIndex++) {
      const base = particleIndex * 3;
      const x = body.pos[base];
      const y = body.pos[base + 1];
      const z = body.pos[base + 2];
      const cellX = Math.floor(x / CELL_SIZE);
      const cellY = Math.floor(y / CELL_SIZE);
      const cellZ = Math.floor(z / CELL_SIZE);

      for (const [dx, dy, dz] of neighborOffsets) {
        const bucket = buckets.get(`${cellX + dx},${cellY + dy},${cellZ + dz}`);
        if (!bucket) continue;

        for (const ref of bucket) {
          if (ref.bodyIndex === bodyIndex) continue;
          if (ref.bodyIndex < bodyIndex) continue;

          separateParticles(body, particleIndex, bodies[ref.bodyIndex], ref.particleIndex);
        }
      }
    }
  }
}

function separateParticles(a: SimState, ai: number, b: SimState, bi: number) {
  const aBase = ai * 3;
  const bBase = bi * 3;
  const dx = b.pos[bBase] - a.pos[aBase];
  const dy = b.pos[bBase + 1] - a.pos[aBase + 1];
  const dz = b.pos[bBase + 2] - a.pos[aBase + 2];
  const distSq = dx * dx + dy * dy + dz * dz;

  if (distSq >= COLLISION_RADIUS_SQ) return;

  const dist = Math.sqrt(distSq) || 1e-8;
  const overlap = COLLISION_RADIUS - dist;
  if (overlap <= 0) return;

  const nx = dx / dist;
  const ny = dy / dist;
  const nz = dz / dist;
  const push = overlap * 0.5;

  a.pos[aBase] -= nx * push;
  a.pos[aBase + 1] -= ny * push;
  a.pos[aBase + 2] -= nz * push;
  b.pos[bBase] += nx * push;
  b.pos[bBase + 1] += ny * push;
  b.pos[bBase + 2] += nz * push;

  const avx = a.pos[aBase] - a.prev[aBase];
  const avy = a.pos[aBase + 1] - a.prev[aBase + 1];
  const avz = a.pos[aBase + 2] - a.prev[aBase + 2];
  const bvx = b.pos[bBase] - b.prev[bBase];
  const bvy = b.pos[bBase + 1] - b.prev[bBase + 1];
  const bvz = b.pos[bBase + 2] - b.prev[bBase + 2];
  const rel = (bvx - avx) * nx + (bvy - avy) * ny + (bvz - avz) * nz;

  a.prev[aBase] -= nx * push * INTER_BODY_STICK;
  a.prev[aBase + 1] -= ny * push * INTER_BODY_STICK;
  a.prev[aBase + 2] -= nz * push * INTER_BODY_STICK;
  b.prev[bBase] += nx * push * INTER_BODY_STICK;
  b.prev[bBase + 1] += ny * push * INTER_BODY_STICK;
  b.prev[bBase + 2] += nz * push * INTER_BODY_STICK;

  if (rel < 0) {
    const bounce = -(1 + INTER_BODY_RESTITUTION) * rel * 0.5;
    a.prev[aBase] += nx * bounce;
    a.prev[aBase + 1] += ny * bounce;
    a.prev[aBase + 2] += nz * bounce;
    b.prev[bBase] -= nx * bounce;
    b.prev[bBase + 1] -= ny * bounce;
    b.prev[bBase + 2] -= nz * bounce;
  }

  clampFloor(a, ai);
  clampFloor(b, bi);
}
