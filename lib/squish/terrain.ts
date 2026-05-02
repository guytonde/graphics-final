export const GROUND_BASE_Y = -2.8;
export const GROUND_FLAT_RADIUS = 5.4;
export const GROUND_BLEND_RADIUS = 6.2;
export const TERRAIN_EXTENT = 96;
export const TERRAIN_SEGMENTS = 180;

const NORMAL_SAMPLE_STEP = 0.35;

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(min: number, max: number, value: number) {
  const t = clamp01((value - min) / (max - min || 1));
  return t * t * (3 - 2 * t);
}

function fract(value: number) {
  return value - Math.floor(value);
}

function hash2(x: number, z: number) {
  return fract(Math.sin(x * 127.1 + z * 311.7) * 43758.5453123);
}

function valueNoise(x: number, z: number) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);

  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);

  const ab = a + (b - a) * ux;
  const cd = c + (d - c) * ux;
  return ab + (cd - ab) * uz;
}

function fbm(x: number, z: number) {
  let sum = 0;
  let amp = 0.55;
  let freq = 1;

  for (let octave = 0; octave < 5; octave++) {
    sum += valueNoise(x * freq, z * freq) * amp;
    freq *= 2.03;
    amp *= 0.5;
  }

  return sum;
}

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

export function getTerrainBlend(x: number, z: number) {
  return smoothstep(
    GROUND_FLAT_RADIUS,
    GROUND_FLAT_RADIUS + GROUND_BLEND_RADIUS,
    Math.hypot(x, z)
  );
}

export function getGroundHeight(x: number, z: number) {
  const blend = getTerrainBlend(x, z);

  const swells =
    Math.sin(x * 0.055 + 1.7) * 0.72 +
    Math.sin(z * 0.041 - 0.9) * 0.58 +
    Math.sin((x + z) * 0.028 - 1.4) * 0.35;

  const meadowNoise = (fbm(x * 0.09 + 7.3, z * 0.09 - 4.8) - 0.5) * 1.15;
  const ridgeNoise = Math.abs(fbm(x * 0.023 - 5.2, z * 0.023 + 6.1) - 0.5) * 1.1 - 0.28;
  const contour = swells * 0.42 + meadowNoise * 0.9 + ridgeNoise * 0.6;

  return GROUND_BASE_Y + contour * 0.6 * blend;
}

export function getGroundNormal(x: number, z: number): [number, number, number] {
  const left = getGroundHeight(x - NORMAL_SAMPLE_STEP, z);
  const right = getGroundHeight(x + NORMAL_SAMPLE_STEP, z);
  const back = getGroundHeight(x, z - NORMAL_SAMPLE_STEP);
  const front = getGroundHeight(x, z + NORMAL_SAMPLE_STEP);

  return normalize3(left - right, NORMAL_SAMPLE_STEP * 2, back - front);
}

export function buildTerrainMesh(
  extent = TERRAIN_EXTENT,
  segments = TERRAIN_SEGMENTS
) {
  const vertsPerSide = segments + 1;
  const vertexCount = vertsPerSide * vertsPerSide;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(segments * segments * 6);

  let vertexOffset = 0;
  for (let z = 0; z <= segments; z++) {
    const tz = z / segments;
    const worldZ = -extent + tz * extent * 2;

    for (let x = 0; x <= segments; x++) {
      const tx = x / segments;
      const worldX = -extent + tx * extent * 2;
      const worldY = getGroundHeight(worldX, worldZ);
      const [nx, ny, nz] = getGroundNormal(worldX, worldZ);

      positions[vertexOffset * 3] = worldX;
      positions[vertexOffset * 3 + 1] = worldY;
      positions[vertexOffset * 3 + 2] = worldZ;

      normals[vertexOffset * 3] = nx;
      normals[vertexOffset * 3 + 1] = ny;
      normals[vertexOffset * 3 + 2] = nz;
      vertexOffset++;
    }
  }

  let indexOffset = 0;
  for (let z = 0; z < segments; z++) {
    for (let x = 0; x < segments; x++) {
      const a = z * vertsPerSide + x;
      const b = a + 1;
      const c = a + vertsPerSide;
      const d = c + 1;

      indices[indexOffset++] = a;
      indices[indexOffset++] = c;
      indices[indexOffset++] = b;
      indices[indexOffset++] = b;
      indices[indexOffset++] = c;
      indices[indexOffset++] = d;
    }
  }

  return { positions, normals, indices };
}
