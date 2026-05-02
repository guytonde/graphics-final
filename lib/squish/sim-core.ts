import { PARTICLE_RADIUS, SURFACE_CONTACT_HALF_EXTENT, isFlatContactShape } from './contact';
import { getPoseBounds, getPoseCenter } from './orientation';
import type { Config, SimState } from './types';

const GRAVITY = 18;
export const FLOOR_Y = -2.8;
const DT = 1 / 60;
const COLLISION_RADIUS = PARTICLE_RADIUS * 2;
const COLLISION_RADIUS_SQ = COLLISION_RADIUS * COLLISION_RADIUS;
const CELL_SIZE = COLLISION_RADIUS * 2.1;
const FLOOR_BOUNCE = 0.8;
const FLOOR_FRICTION = 0.85;
const INTER_BODY_RESTITUTION = 0.1;
const INTER_BODY_FRICTION = 0.8;
const FLAT_BODY_CONTACT_PADDING = PARTICLE_RADIUS * 0.35;
const FLAT_BODY_PROXY_BAND = SURFACE_CONTACT_HALF_EXTENT * 4;
const FLAT_BODY_PROXY_TANGENT_PADDING = PARTICLE_RADIUS;
const FLAT_BODY_PROXY_MIN_SUPPORT_SPAN = PARTICLE_RADIUS * 1.25;
const MAX_ADAPTIVE_MOTION_SUBSTEPS = 6;
const MAX_TRAVEL_PER_MOTION_STEP = SURFACE_CONTACT_HALF_EXTENT * 0.5;

const NEIGHBOR_OFFSETS = [-1, 0, 1].flatMap(dx =>
  [-1, 0, 1].flatMap(dy =>
    [-1, 0, 1].map(dz => ({ dx, dy, dz }))
  )
);

type AxisIndex = 0 | 1 | 2;

interface AxisRange {
  min: number;
  max: number;
}

interface FlatBodyProxyContact {
  nx: number;
  ny: number;
  nz: number;
  overlap: number;
  tangentAxisA: AxisIndex;
  tangentAxisB: AxisIndex;
  tangentA: AxisRange;
  tangentB: AxisRange;
}

export interface Actions {
  drop: () => void;
  smash: () => void;
  autobuild: () => void;
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

  const motion_substeps = active_bodies.length > 1
    ? getAdaptiveMotionSubsteps(active_bodies, cfg.substeps)
    : 1;
  const total_substeps = cfg.substeps * motion_substeps;
  const sub_dt = DT / total_substeps;
  const sdt2 = sub_dt * sub_dt;

  // Preserve the existing damping feel while allowing extra micro-steps for fast impacts.
  const sub_damping = Math.pow(cfg.damping, 1 / motion_substeps);

  for (let sub = 0; sub < total_substeps; sub++) {
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

function getAdaptiveMotionSubsteps(bodies: SimState[], baseSubsteps: number) {
  let maxTravel = 0;

  for (const body of bodies) {
    for (let i = 0; i < body.N; i++) {
      const base = i * 3;
      const travel = Math.hypot(
        body.pos[base] - body.prev[base],
        body.pos[base + 1] - body.prev[base + 1],
        body.pos[base + 2] - body.prev[base + 2]
      );
      if (travel > maxTravel) {
        maxTravel = travel;
      }
    }
  }

  const perSubstepTravel = maxTravel / Math.max(1, baseSubsteps);
  return Math.max(
    1,
    Math.min(
      MAX_ADAPTIVE_MOTION_SUBSTEPS,
      Math.ceil(perSubstepTravel / MAX_TRAVEL_PER_MOTION_STEP)
    )
  );
}

export function resolveBodyContacts(bodies: SimState[]) {
  const active_bodies = bodies.filter((body) => body.dropped);
  if (active_bodies.length > 1) {
    resolveInterBodyCollisions(active_bodies);
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
  resolveFlatBodyProxyContacts(bodies);

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

function resolveFlatBodyProxyContacts(bodies: SimState[]) {
  for (let ai = 0; ai < bodies.length; ai++) {
    const a = bodies[ai];
    if (!isFlatContactShape(a.shape)) continue;

    for (let bi = ai + 1; bi < bodies.length; bi++) {
      const b = bodies[bi];
      if (!isFlatContactShape(b.shape)) continue;

      const contact = getFlatBodyProxyContact(a, b);
      if (!contact) continue;

      const { nx, ny, nz, overlap } = contact;
      const [w_a, w_b] = getBodyContactWeights(a, b, nx, ny, nz);

      applyLocalizedBodyProxyCorrection(
        a,
        -nx * overlap * w_a,
        -ny * overlap * w_a,
        -nz * overlap * w_a,
        contact,
        true
      );
      applyLocalizedBodyProxyCorrection(
        b,
        nx * overlap * w_b,
        ny * overlap * w_b,
        nz * overlap * w_b,
        contact,
        false
      );
    }
  }
}

function getFlatBodyProxyContact(a: SimState, b: SimState): FlatBodyProxyContact | null {
  const aBounds = getPoseBounds(a.pos);
  const bBounds = getPoseBounds(b.pos);

  const xOverlap = getAxisRangeOverlap(aBounds.minX, aBounds.maxX, bBounds.minX, bBounds.maxX);
  const yOverlap = getAxisRangeOverlap(aBounds.minY, aBounds.maxY, bBounds.minY, bBounds.maxY);
  const zOverlap = getAxisRangeOverlap(aBounds.minZ, aBounds.maxZ, bBounds.minZ, bBounds.maxZ);

  const paddedXOverlap = getAxisRangeOverlap(
    aBounds.minX - FLAT_BODY_CONTACT_PADDING,
    aBounds.maxX + FLAT_BODY_CONTACT_PADDING,
    bBounds.minX - FLAT_BODY_CONTACT_PADDING,
    bBounds.maxX + FLAT_BODY_CONTACT_PADDING
  );
  const paddedYOverlap = getAxisRangeOverlap(
    aBounds.minY - FLAT_BODY_CONTACT_PADDING,
    aBounds.maxY + FLAT_BODY_CONTACT_PADDING,
    bBounds.minY - FLAT_BODY_CONTACT_PADDING,
    bBounds.maxY + FLAT_BODY_CONTACT_PADDING
  );
  const paddedZOverlap = getAxisRangeOverlap(
    aBounds.minZ - FLAT_BODY_CONTACT_PADDING,
    aBounds.maxZ + FLAT_BODY_CONTACT_PADDING,
    bBounds.minZ - FLAT_BODY_CONTACT_PADDING,
    bBounds.maxZ + FLAT_BODY_CONTACT_PADDING
  );

  const px = paddedXOverlap.max - paddedXOverlap.min;
  const py = paddedYOverlap.max - paddedYOverlap.min;
  const pz = paddedZOverlap.max - paddedZOverlap.min;

  if (px <= 0 || py <= 0 || pz <= 0) return null;

  const [acx, acy, acz] = getPoseCenter(a.pos);
  const [bcx, bcy, bcz] = getPoseCenter(b.pos);
  const dx = bcx - acx;
  const dy = bcy - acy;
  const dz = bcz - acz;

  if (py <= px && py <= pz) {
    if (!hasUsableFlatBodySupport(xOverlap, zOverlap)) return null;
    return {
      nx: 0,
      ny: dy >= 0 ? 1 : -1,
      nz: 0,
      overlap: py,
      tangentAxisA: 0,
      tangentAxisB: 2,
      tangentA: xOverlap,
      tangentB: zOverlap,
    };
  }
  if (px <= pz) {
    if (!hasUsableFlatBodySupport(yOverlap, zOverlap)) return null;
    return {
      nx: dx >= 0 ? 1 : -1,
      ny: 0,
      nz: 0,
      overlap: px,
      tangentAxisA: 1,
      tangentAxisB: 2,
      tangentA: yOverlap,
      tangentB: zOverlap,
    };
  }
  if (!hasUsableFlatBodySupport(xOverlap, yOverlap)) return null;
  return {
    nx: 0,
    ny: 0,
    nz: dz >= 0 ? 1 : -1,
    overlap: pz,
    tangentAxisA: 0,
    tangentAxisB: 1,
    tangentA: xOverlap,
    tangentB: yOverlap,
  };
}

function getBodyContactWeights(
  a: SimState,
  b: SimState,
  nx: number,
  ny: number,
  nz: number
): [number, number] {
  if (Math.abs(ny) >= Math.abs(nx) && Math.abs(ny) >= Math.abs(nz)) {
    const [, y_a] = getPoseCenter(a.pos);
    const [, y_b] = getPoseCenter(b.pos);
    const w_b = y_b > y_a ? 0.85 : 0.15;
    return [1.0 - w_b, w_b];
  }

  return [0.5, 0.5];
}

function applyLocalizedBodyProxyCorrection(
  body: SimState,
  dx: number,
  dy: number,
  dz: number,
  contact: FlatBodyProxyContact,
  towardPositiveNormal: boolean
) {
  const { nx, ny, nz, tangentAxisA, tangentAxisB, tangentA, tangentB } = contact;
  let support = towardPositiveNormal ? -Infinity : Infinity;

  for (let i = 0; i < body.N; i++) {
    const base = i * 3;
    const projection =
      body.pos[base] * nx +
      body.pos[base + 1] * ny +
      body.pos[base + 2] * nz;

    if (towardPositiveNormal) {
      if (projection > support) support = projection;
    } else if (projection < support) {
      support = projection;
    }
  }

  if (!Number.isFinite(support)) return;

  for (let i = 0; i < body.N; i++) {
    const base = i * 3;
    const projection =
      body.pos[base] * nx +
      body.pos[base + 1] * ny +
      body.pos[base + 2] * nz;
    const depth = towardPositiveNormal ? support - projection : projection - support;
    if (depth >= FLAT_BODY_PROXY_BAND) continue;

    const faceWeight = 1 - depth / FLAT_BODY_PROXY_BAND;
    const tangentWeightA = getAxisRangeInfluence(body.pos[base + tangentAxisA], tangentA);
    const tangentWeightB = getAxisRangeInfluence(body.pos[base + tangentAxisB], tangentB);
    const weight = faceWeight * tangentWeightA * tangentWeightB;
    if (weight <= 0) continue;

    body.pos[base] += dx * weight;
    body.pos[base + 1] += dy * weight;
    body.pos[base + 2] += dz * weight;
    body.prev[base] += dx * weight;
    body.prev[base + 1] += dy * weight;
    body.prev[base + 2] += dz * weight;

    const vx = body.pos[base] - body.prev[base];
    const vy = body.pos[base + 1] - body.prev[base + 1];
    const vz = body.pos[base + 2] - body.prev[base + 2];
    const normal_vel = vx * nx + vy * ny + vz * nz;

    if (towardPositiveNormal ? normal_vel <= 0 : normal_vel >= 0) continue;

    body.prev[base] += nx * normal_vel * weight;
    body.prev[base + 1] += ny * normal_vel * weight;
    body.prev[base + 2] += nz * normal_vel * weight;
  }
}

function getAxisRangeOverlap(aMin: number, aMax: number, bMin: number, bMax: number): AxisRange {
  return {
    min: Math.max(aMin, bMin),
    max: Math.min(aMax, bMax),
  };
}

function hasUsableFlatBodySupport(a: AxisRange, b: AxisRange) {
  return (a.max - a.min) >= FLAT_BODY_PROXY_MIN_SUPPORT_SPAN
    && (b.max - b.min) >= FLAT_BODY_PROXY_MIN_SUPPORT_SPAN;
}

function getAxisRangeInfluence(value: number, range: AxisRange) {
  if (value < range.min - FLAT_BODY_PROXY_TANGENT_PADDING) return 0;
  if (value > range.max + FLAT_BODY_PROXY_TANGENT_PADDING) return 0;
  if (value < range.min) {
    return 1 - (range.min - value) / FLAT_BODY_PROXY_TANGENT_PADDING;
  }
  if (value > range.max) {
    return 1 - (value - range.max) / FLAT_BODY_PROXY_TANGENT_PADDING;
  }
  return 1;
}

function separateParticles(a: SimState, ai: number, b: SimState, bi: number) {
  const a_base = ai * 3;
  const b_base = bi * 3;
  const contact = resolveFlatSurfaceContact(a, ai, b, bi) ?? resolveSphereContact(a, ai, b, bi);
  if (!contact) return;

  const { nx, ny, nz, overlap } = contact;
  const [w_a, w_b] = getContactWeights(a, a_base, b, b_base, nx, ny, nz);

  a.pos[a_base] -= nx * overlap * w_a;
  a.pos[a_base + 1] -= ny * overlap * w_a;
  a.pos[a_base + 2] -= nz * overlap * w_a;
  b.pos[b_base] += nx * overlap * w_b;
  b.pos[b_base + 1] += ny * overlap * w_b;
  b.pos[b_base + 2] += nz * overlap * w_b;

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

function resolveFlatSurfaceContact(a: SimState, ai: number, b: SimState, bi: number) {
  if (!isFlatContactShape(a.shape) || !isFlatContactShape(b.shape)) return null;
  if (!a.surfaceParticleMask[ai] || !b.surfaceParticleMask[bi]) return null;

  const a_base = ai * 3;
  const b_base = bi * 3;
  const dx = b.pos[b_base] - a.pos[a_base];
  const dy = b.pos[b_base + 1] - a.pos[a_base + 1];
  const dz = b.pos[b_base + 2] - a.pos[a_base + 2];

  const size = SURFACE_CONTACT_HALF_EXTENT * 2;
  const px = size - Math.abs(dx);
  const py = size - Math.abs(dy);
  const pz = size - Math.abs(dz);

  if (px <= 0 || py <= 0 || pz <= 0) return null;

  if (py <= px && py <= pz) {
    return { nx: 0, ny: dy >= 0 ? 1 : -1, nz: 0, overlap: py };
  }
  if (px <= pz) {
    return { nx: dx >= 0 ? 1 : -1, ny: 0, nz: 0, overlap: px };
  }
  return { nx: 0, ny: 0, nz: dz >= 0 ? 1 : -1, overlap: pz };
}

function resolveSphereContact(a: SimState, ai: number, b: SimState, bi: number) {
  const a_base = ai * 3;
  const b_base = bi * 3;
  const dx = b.pos[b_base] - a.pos[a_base];
  const dy = b.pos[b_base + 1] - a.pos[a_base + 1];
  const dz = b.pos[b_base + 2] - a.pos[a_base + 2];
  const dist_sq = dx * dx + dy * dy + dz * dz;

  if (dist_sq >= COLLISION_RADIUS_SQ) return null;

  const dist = Math.sqrt(dist_sq) + 1e-8;
  const overlap = COLLISION_RADIUS - dist;
  if (overlap <= 0) return null;

  return {
    nx: dx / dist,
    ny: dy / dist,
    nz: dz / dist,
    overlap,
  };
}

function getContactWeights(
  a: SimState,
  a_base: number,
  b: SimState,
  b_base: number,
  nx: number,
  ny: number,
  nz: number
): [number, number] {
  if (Math.abs(ny) >= Math.abs(nx) && Math.abs(ny) >= Math.abs(nz)) {
    const y_a = a.pos[a_base + 1];
    const y_b = b.pos[b_base + 1];
    const w_b = y_b > y_a ? 0.85 : 0.15;
    return [1.0 - w_b, w_b];
  }

  return [0.5, 0.5];
}
