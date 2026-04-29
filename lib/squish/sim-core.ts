import type { Config, ShapeName, SimState } from "./types";

const GRAVITY = 18;
const FLOOR_Y = -2.8;
const DT = 1 / 60;

export interface Actions {
  reset: (shape: ShapeName) => void;
  drop: () => void;
  smash: () => void;
  melt: () => void;
  toggleSprings: () => void;
  toggleWireframe: () => void;
}

export function stepSim(sim: SimState, cfg: Config) {
  if (!sim.dropped) return;

  const sdt2 = (DT / cfg.substeps) ** 2;

  for (let sub = 0; sub < cfg.substeps; sub++) {
    sim.facc.fill(0);

    for (let i = 0; i < sim.N; i++) sim.facc[i * 3 + 1] -= GRAVITY;

    for (const sp of sim.springs) {
      if (sp.broken) continue;

      const dx = sim.pos[sp.j * 3] - sim.pos[sp.i * 3];
      const dy = sim.pos[sp.j * 3 + 1] - sim.pos[sp.i * 3 + 1];
      const dz = sim.pos[sp.j * 3 + 2] - sim.pos[sp.i * 3 + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-8;
      const stretch = len - sp.rest;

      if (stretch / sp.rest > cfg.breakRatio) {
        sp.broken = true;
        continue;
      }

      const f = cfg.stiffness * stretch / len;
      sim.facc[sp.i * 3] += f * dx;
      sim.facc[sp.i * 3 + 1] += f * dy;
      sim.facc[sp.i * 3 + 2] += f * dz;
      sim.facc[sp.j * 3] -= f * dx;
      sim.facc[sp.j * 3 + 1] -= f * dy;
      sim.facc[sp.j * 3 + 2] -= f * dz;
    }

    for (let i = 0; i < sim.N; i++) {
      const px = sim.pos[i * 3], py = sim.pos[i * 3 + 1], pz = sim.pos[i * 3 + 2];
      const ox = sim.prev[i * 3], oy = sim.prev[i * 3 + 1], oz = sim.prev[i * 3 + 2];
      const vx = (px - ox) * cfg.damping;
      const vy = (py - oy) * cfg.damping;
      const vz = (pz - oz) * cfg.damping;

      let nx = px + vx + sim.facc[i * 3] * sdt2;
      let ny = py + vy + sim.facc[i * 3 + 1] * sdt2;
      let nz = pz + vz + sim.facc[i * 3 + 2] * sdt2;

      sim.prev[i * 3] = px;
      sim.prev[i * 3 + 1] = py;
      sim.prev[i * 3 + 2] = pz;

      // if (ny < FLOOR_Y + 0.05) {
      //   ny = FLOOR_Y + 0.05;
      //   sim.prev[i * 3 + 1] = ny + vy * 0.25;
      //   sim.prev[i * 3] = nx - (nx - px) * 0.35;
      //   sim.prev[i * 3 + 2] = nz - (nz - pz) * 0.35;
      // }
      if (ny < FLOOR_Y + 0.05) {
        ny = FLOOR_Y + 0.05;
        // BOUNCE: 80% restitution (vy * 0.8 forces it to bounce back up)
        sim.prev[i * 3 + 1] = ny + vy * 0.8;
        // FRICTION: retain 85% of horizontal sliding velocity
        sim.prev[i * 3] = nx - vx * 0.85;
        sim.prev[i * 3 + 2] = nz - vz * 0.85;
      }

      sim.pos[i * 3] = nx;
      sim.pos[i * 3 + 1] = ny;
      sim.pos[i * 3 + 2] = nz;
    }
  }
}

export function makeActions(args: {
  getSim: () => SimState;
  setStatus: (status: string) => void;
  reload: (shape: ShapeName) => void;
  toggleSprings: () => void;
  toggleWireframe: () => void;
}): Actions {
  return {
    reset: (shape) => args.reload(shape),
    drop: () => {
      args.getSim().dropped = true;
      args.setStatus("SIMULATING");
    },
    smash: () => {
      const sim = args.getSim();
      sim.dropped = true;
      for (let i = 0; i < sim.N; i++) {
        const str = Math.max(0, 1.4 - Math.hypot(sim.pos[i * 3], sim.pos[i * 3 + 2]) * 0.8);
        const j = (Math.random() - 0.5) * 0.12;
        sim.prev[i * 3 + 1] = sim.pos[i * 3 + 1] + str * 1.8;
        sim.prev[i * 3] -= j;
        sim.prev[i * 3 + 2] -= j;
      }
      args.setStatus("SMASHED");
    },
    melt: () => {
      const sim = args.getSim();
      sim.springs.forEach((s) => (s.broken = true));
      args.setStatus("MELTED");
    },
    toggleSprings: args.toggleSprings,
    toggleWireframe: args.toggleWireframe,
  };
}