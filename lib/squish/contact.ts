import type { ShapeName, SimState } from "./types";

export const PARTICLE_RADIUS = 0.18;
export const SURFACE_CONTACT_HALF_EXTENT = 0.19;

export interface BodyPairDiagnostics {
  bodyAId: number;
  bodyBId: number;
  maxShellBoxPenetration: number;
  maxContactBoxPenetration: number;
  maxSpherePenetration: number;
}

export interface SceneDiagnostics {
  maxBodySpeed: number;
  maxShellBoxPenetration: number;
  maxContactBoxPenetration: number;
  maxSpherePenetration: number;
  pairs: BodyPairDiagnostics[];
}

export function buildSurfaceParticleMask(
  N: number,
  faces: Array<{ vertToParticle: number[] }>
) {
  const mask = new Uint8Array(N);
  for (const face of faces) {
    for (const particleIndex of face.vertToParticle) {
      mask[particleIndex] = 1;
    }
  }
  return mask;
}

export function isFlatContactShape(shape: ShapeName) {
  return shape === "prism" || shape === "jenga";
}

export function createSceneDiagnostics(bodies: SimState[]): SceneDiagnostics {
  let maxBodySpeed = 0;

  for (const body of bodies) {
    maxBodySpeed = Math.max(maxBodySpeed, getBodyMaxSpeed(body));
  }

  const pairs: BodyPairDiagnostics[] = [];
  let maxShellBoxPenetration = 0;
  let maxContactBoxPenetration = 0;
  let maxSpherePenetration = 0;

  for (let ai = 0; ai < bodies.length; ai++) {
    for (let bi = ai + 1; bi < bodies.length; bi++) {
      const pair = diagnoseBodyPair(bodies[ai], bodies[bi]);
      pairs.push(pair);
      maxShellBoxPenetration = Math.max(maxShellBoxPenetration, pair.maxShellBoxPenetration);
      maxContactBoxPenetration = Math.max(maxContactBoxPenetration, pair.maxContactBoxPenetration);
      maxSpherePenetration = Math.max(maxSpherePenetration, pair.maxSpherePenetration);
    }
  }

  return {
    maxBodySpeed,
    maxShellBoxPenetration,
    maxContactBoxPenetration,
    maxSpherePenetration,
    pairs,
  };
}

function diagnoseBodyPair(a: SimState, b: SimState): BodyPairDiagnostics {
  let maxShellBoxPenetration = 0;
  let maxContactBoxPenetration = 0;
  let maxSpherePenetration = 0;

  const flatPair = isFlatContactShape(a.shape) && isFlatContactShape(b.shape);

  for (let ai = 0; ai < a.N; ai++) {
    if (flatPair && !a.surfaceParticleMask[ai]) continue;

    const aBase = ai * 3;
    const ax = a.pos[aBase];
    const ay = a.pos[aBase + 1];
    const az = a.pos[aBase + 2];

    for (let bi = 0; bi < b.N; bi++) {
      if (flatPair && !b.surfaceParticleMask[bi]) continue;

      const bBase = bi * 3;
      const dx = b.pos[bBase] - ax;
      const dy = b.pos[bBase + 1] - ay;
      const dz = b.pos[bBase + 2] - az;

      const spherePenetration = getSpherePenetration(dx, dy, dz, PARTICLE_RADIUS * 2);
      if (spherePenetration > maxSpherePenetration) {
        maxSpherePenetration = spherePenetration;
      }

      if (!flatPair) continue;

      const shellBoxPenetration = getBoxPenetration(dx, dy, dz, PARTICLE_RADIUS);
      if (shellBoxPenetration > maxShellBoxPenetration) {
        maxShellBoxPenetration = shellBoxPenetration;
      }

      const contactBoxPenetration = getBoxPenetration(dx, dy, dz, SURFACE_CONTACT_HALF_EXTENT);
      if (contactBoxPenetration > maxContactBoxPenetration) {
        maxContactBoxPenetration = contactBoxPenetration;
      }
    }
  }

  return {
    bodyAId: a.id,
    bodyBId: b.id,
    maxShellBoxPenetration,
    maxContactBoxPenetration,
    maxSpherePenetration,
  };
}

function getBodyMaxSpeed(body: SimState) {
  let maxSpeed = 0;

  for (let i = 0; i < body.N; i++) {
    const base = i * 3;
    const vx = body.pos[base] - body.prev[base];
    const vy = body.pos[base + 1] - body.prev[base + 1];
    const vz = body.pos[base + 2] - body.prev[base + 2];
    maxSpeed = Math.max(maxSpeed, Math.hypot(vx, vy, vz));
  }

  return maxSpeed;
}

function getSpherePenetration(dx: number, dy: number, dz: number, diameter: number) {
  return Math.max(0, diameter - Math.hypot(dx, dy, dz));
}

function getBoxPenetration(dx: number, dy: number, dz: number, halfExtent: number) {
  const size = halfExtent * 2;
  const px = size - Math.abs(dx);
  const py = size - Math.abs(dy);
  const pz = size - Math.abs(dz);

  if (px <= 0 || py <= 0 || pz <= 0) return 0;
  return Math.min(px, py, pz);
}
