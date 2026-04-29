export interface Spring {
  i: number;
  j: number;
  rest: number;
  broken: boolean;
}

export type ShapeName = "cube" | "sphere" | "tower";

export interface SimState {
  shape: ShapeName;
  N: number;
  pos: Float32Array;
  prev: Float32Array;
  facc: Float32Array;
  springs: Spring[];
  faces: Array<{ vertToParticle: number[]; triIdx: number[] }>;
  dropped: boolean;
}

export interface Config {
  stiffness: number;
  damping: number;
  breakRatio: number;
  substeps: number;
}