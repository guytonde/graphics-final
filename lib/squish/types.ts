export interface Spring {
  i: number;
  j: number;
  rest: number;
  broken: boolean;
}

export type ShapeName = "cube" | "sphere" | "tower";
export type BodyColor = [number, number, number];

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
