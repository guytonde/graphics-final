import type { Config, SimState } from './types';

const GRAVITY = 18;
export const FLOOR_Y = -2.8;
const DT = 1 / 60;
const PARTICLE_RADIUS = 0.18;
const COLLISION_RADIUS = PARTICLE_RADIUS * 2;
const COLLISION_RADIUS_SQ = COLLISION_RADIUS * COLLISION_RADIUS;
const CELL_SIZE = COLLISION_RADIUS * 2.1;
const FLOOR_BOUNCE = 0.8;
const FLOOR_FRICTION = 0.85;
const INTER_BODY_RESTITUTION = 0.1;
const INTER_BODY_FRICTION = 0.8;

const NEIGHBOR_OFFSETS = [-1, 0, 1].flatMap(dx =>
  [-1, 0, 1].flatMap(dy =>
    [-1, 0, 1].map(dz => ({ dx, dy, dz }))
  )
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

const HASH_SIZE = 16381;
let hash_head = new Int32Array(HASH_SIZE);
let hash_next = new Int32Array(10000);
let map_body = new Int32Array(10000);
let map_part = new Int32Array(10000);

function getHash(cx: number, cy: number, cz: number) {
  let h = (cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791);
  if (h < 0) h = ~h;
  return h % HASH_SIZE;
}

export function stepSim(bodies: SimState[], cfg: Config) {
  const active_bodies = bodies.filter(body => body.dropped);
  if (!active_bodies.length) return;

  const sub_dt = DT / cfg.substeps;
  const sdt2 = sub_dt * sub_dt;

  // FIX: Restored original per-substep damping.
  // The "mathematically correct" scale made it too weak, 
  // causing the shapes to explode and fracture instantly.
  const sub_damping = cfg.damping; 

  for (let sub = 0; sub < cfg.substeps; sub++) {
    for (const body of active_bodies) {
      body.facc.fill(0);
      for (let i = 0; i < body.N; i++) {
        body.facc[i * 3 + 1] = -GRAVITY;
      }
    }

    for (const body of active_bodies) {
      for (const sp of body.springs) {
        if (sp.broken) continue;

        const i3 = sp.i * 3;
        const j3 = sp.j * 3;
        const dx = body.pos[j3] - body.pos[i3];
        const dy = body.pos[j3 + 1] - body.pos[i3 + 1];
        const dz = body.pos[j3 + 2] - body.pos[i3 + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-8;
        const stretch = len - sp.rest;

        if (stretch > sp.rest * cfg.breakRatio) {
          sp.broken = true;
          continue;
        }

        const f = (cfg.stiffness * stretch) / len;
        body.facc[i3] += f * dx;
        body.facc[i3 + 1] += f * dy;
        body.facc[i3 + 2] += f * dz;
        body.facc[j3] -= f * dx;
        body.facc[j3 + 1] -= f * dy;
        body.facc[j3 + 2] -= f * dz;
      }
    }

    for (const body of active_bodies) {
      for (let i = 0; i < body.N; i++) {
        const base = i * 3;
        const px = body.pos[base];
        const py = body.pos[base + 1];
        const pz = body.pos[base + 2];
        const ox = body.prev[base];
        const oy = body.prev[base + 1];
        const oz = body.prev[base + 2];

        const vx = (px - ox) * sub_damping;
        const vy = (py - oy) * sub_damping;
        const vz = (pz - oz) * sub_damping;

        body.prev[base] = px;
        body.prev[base + 1] = py;
        body.prev[base + 2] = pz;

        body.pos[base] = px + vx + body.facc[base] * sdt2;
        body.pos[base + 1] = py + vy + body.facc[base + 1] * sdt2;
        body.pos[base + 2] = pz + vz + body.facc[base + 2] * sdt2;

        clampFloor(body, i);
      }
    }

    if (active_bodies.length > 1) {
      resolveInterBodyCollisions(active_bodies);
    }
  }
}

function clampFloor(body: SimState, i: number) {
  const base = i * 3;
  const py = body.pos[base + 1];
  const floor_ny = FLOOR_Y + PARTICLE_RADIUS;
  if (py > floor_ny) return;

  const px = body.pos[base];
  const pz = body.pos[base + 2];
  const ox = body.prev[base];
  const oy = body.prev[base + 1];
  const oz = body.prev[base + 2];

  const vx = px - ox;
  const vy = py - oy;
  const vz = pz - oz;

  body.pos[base + 1] = floor_ny;
  body.prev[base + 1] = floor_ny + vy * FLOOR_BOUNCE;
  body.prev[base] = body.pos[base] - vx * FLOOR_FRICTION;
  body.prev[base + 2] = body.pos[base + 2] - vz * FLOOR_FRICTION;
}

function resolveInterBodyCollisions(bodies: SimState[]) {
  let total_particles = 0;
  for (const body of bodies) total_particles += body.N;

  if (hash_next.length < total_particles) {
    const size = total_particles * 2;
    hash_next = new Int32Array(size);
    map_body = new Int32Array(size);
    map_part = new Int32Array(size);
  }

  hash_head.fill(-1);

  let entry = 0;
  for (let body_index = 0; body_index < bodies.length; body_index++) {
    const body = bodies[body_index];
    for (let particle_index = 0; particle_index < body.N; particle_index++) {
      const base = particle_index * 3;
      const cell_x = Math.floor(body.pos[base] / CELL_SIZE);
      const cell_y = Math.floor(body.pos[base + 1] / CELL_SIZE);
      const cell_z = Math.floor(body.pos[base + 2] / CELL_SIZE);
      const hash = getHash(cell_x, cell_y, cell_z);

      hash_next[entry] = hash_head[hash];
      hash_head[hash] = entry;
      map_body[entry] = body_index;
      map_part[entry] = particle_index;
      entry++;
    }
  }

  for (let body_index = 0; body_index < bodies.length; body_index++) {
    const body = bodies[body_index];
    for (let particle_index = 0; particle_index < body.N; particle_index++) {
      const base = particle_index * 3;
      const cell_x = Math.floor(body.pos[base] / CELL_SIZE);
      const cell_y = Math.floor(body.pos[base + 1] / CELL_SIZE);
      const cell_z = Math.floor(body.pos[base + 2] / CELL_SIZE);

      for (const { dx, dy, dz } of NEIGHBOR_OFFSETS) {
        const query_x = cell_x + dx;
        const query_y = cell_y + dy;
        const query_z = cell_z + dz;
        const hash = getHash(query_x, query_y, query_z);

        let curr = hash_head[hash];
        while (curr !== -1) {
          const other_body_index = map_body[curr];
          if (other_body_index > body_index) {
            const other_part_index = map_part[curr];
            const other = bodies[other_body_index];
            const other_base = other_part_index * 3;
            const other_cell_x = Math.floor(other.pos[other_base] / CELL_SIZE);
            const other_cell_y = Math.floor(other.pos[other_base + 1] / CELL_SIZE);
            const other_cell_z = Math.floor(other.pos[other_base + 2] / CELL_SIZE);

            if (other_cell_x === query_x && other_cell_y === query_y && other_cell_z === query_z) {
              separateParticles(body, particle_index, other, other_part_index);
            }
          }
          curr = hash_next[curr];
        }
      }
    }
  }
}

function separateParticles(a: SimState, ai: number, b: SimState, bi: number) {
  const a_base = ai * 3;
  const b_base = bi * 3;
  const dx = b.pos[b_base] - a.pos[a_base];
  const dy = b.pos[b_base + 1] - a.pos[a_base + 1];
  const dz = b.pos[b_base + 2] - a.pos[a_base + 2];
  const dist_sq = dx * dx + dy * dy + dz * dz;

  if (dist_sq >= COLLISION_RADIUS_SQ) return;

  const dist = Math.sqrt(dist_sq) + 1e-8;
  const overlap = COLLISION_RADIUS - dist;
  if (overlap <= 0) return;

  const nx = dx / dist;
  const ny = dy / dist;
  const nz = dz / dist;

  const y_a = a.pos[a_base + 1];
  const y_b = b.pos[b_base + 1];
  const w_b = y_b > y_a ? 0.85 : 0.15;
  const w_a = 1.0 - w_b;

  const push = overlap * 0.5;
  a.pos[a_base] -= nx * push * w_a;
  a.pos[a_base + 1] -= ny * push * w_a;
  a.pos[a_base + 2] -= nz * push * w_a;
  b.pos[b_base] += nx * push * w_b;
  b.pos[b_base + 1] += ny * push * w_b;
  b.pos[b_base + 2] += nz * push * w_b;

  const avx = a.pos[a_base] - a.prev[a_base];
  const avy = a.pos[a_base + 1] - a.prev[a_base + 1];
  const avz = a.pos[a_base + 2] - a.prev[a_base + 2];
  const bvx = b.pos[b_base] - b.prev[b_base];
  const bvy = b.pos[b_base + 1] - b.prev[b_base + 1];
  const bvz = b.pos[b_base + 2] - b.prev[b_base + 2];

  const rel_vx = bvx - avx;
  const rel_vy = bvy - avy;
  const rel_vz = bvz - avz;
  const normal_vel = rel_vx * nx + rel_vy * ny + rel_vz * nz;

  if (normal_vel < 0) {
    const tan_vx = rel_vx - normal_vel * nx;
    const tan_vy = rel_vy - normal_vel * ny;
    const tan_vz = rel_vz - normal_vel * nz;

    const dvx = nx * normal_vel * (1 + INTER_BODY_RESTITUTION) + tan_vx * INTER_BODY_FRICTION;
    const dvy = ny * normal_vel * (1 + INTER_BODY_RESTITUTION) + tan_vy * INTER_BODY_FRICTION;
    const dvz = nz * normal_vel * (1 + INTER_BODY_RESTITUTION) + tan_vz * INTER_BODY_FRICTION;

    a.prev[a_base] = a.pos[a_base] - (avx + dvx * w_a);
    a.prev[a_base + 1] = a.pos[a_base + 1] - (avy + dvy * w_a);
    a.prev[a_base + 2] = a.pos[a_base + 2] - (avz + dvz * w_a);

    b.prev[b_base] = b.pos[b_base] - (bvx - dvx * w_b);
    b.prev[b_base + 1] = b.pos[b_base + 1] - (bvy - dvy * w_b);
    b.prev[b_base + 2] = b.pos[b_base + 2] - (bvz - dvz * w_b);
  } else {
    a.prev[a_base] = a.pos[a_base] - avx;
    a.prev[a_base + 1] = a.pos[a_base + 1] - avy;
    a.prev[a_base + 2] = a.pos[a_base + 2] - avz;
    b.prev[b_base] = b.pos[b_base] - bvx;
    b.prev[b_base + 1] = b.pos[b_base + 1] - bvy;
    b.prev[b_base + 2] = b.pos[b_base + 2] - bvz;
  }
}