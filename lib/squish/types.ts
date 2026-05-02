export interface Spring {
  i: number;
  j: number;
  rest: number;
  broken: boolean;
}

export type ShapeName = "prism" | "sphere" | "tower";
export type BodyColor = [number, number, number];

export interface PrismDimensions {
  width: number;
  height: number;
  depth: number;
}

export const DEFAULT_PRISM_DIMENSIONS: PrismDimensions = {
  width: 6,
  height: 6,
  depth: 6,
};

export interface SimState {
  id: number;
  shape: ShapeName;
  color: BodyColor;
  N: number;
  pos: Float32Array;
  prev: Float32Array;
  facc: Float32Array;
  springs: Spring[];
  faces: Array<{ vertToParticle: number[]; triIdx: number[] }>;
  surfaceParticleMask: Uint8Array;
  dropped: boolean;
}

export interface Config {
  stiffness: number;
  damping: number;
  breakRatio: number;
  substeps: number;
}

export interface Orientation {
  x: number;
  y: number;
  z: number;
}
