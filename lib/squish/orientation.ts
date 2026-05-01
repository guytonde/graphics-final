import type { Orientation } from "./types";

const toRad = (deg: number) => deg * Math.PI / 180;

export function rotateOffset(
  x: number,
  y: number,
  z: number,
  orientation: Orientation
): [number, number, number] {
  const rx = toRad(orientation.x);
  const ry = toRad(orientation.y);
  const rz = toRad(orientation.z);

  const sx = Math.sin(rx);
  const cx = Math.cos(rx);
  const sy = Math.sin(ry);
  const cy = Math.cos(ry);
  const sz = Math.sin(rz);
  const cz = Math.cos(rz);

  let nx = x;
  let ny = y * cx - z * sx;
  let nz = y * sx + z * cx;

  const x2 = nx * cy + nz * sy;
  const z2 = -nx * sy + nz * cy;
  nx = x2;
  nz = z2;

  const x3 = nx * cz - ny * sz;
  const y3 = nx * sz + ny * cz;

  return [x3, y3, nz];
}

export function getPoseCenter(pos: Float32Array): [number, number, number] {
  let sx = 0;
  let sy = 0;
  let sz = 0;

  for (let i = 0; i < pos.length; i += 3) {
    sx += pos[i];
    sy += pos[i + 1];
    sz += pos[i + 2];
  }

  const n = pos.length / 3 || 1;
  return [sx / n, sy / n, sz / n];
}

export function getPoseRadius(
  pos: Float32Array,
  center: [number, number, number] = getPoseCenter(pos)
) {
  let radius = 0;

  for (let i = 0; i < pos.length; i += 3) {
    const dx = pos[i] - center[0];
    const dy = pos[i + 1] - center[1];
    const dz = pos[i + 2] - center[2];
    radius = Math.max(radius, Math.hypot(dx, dy, dz));
  }

  return radius;
}

export function getPoseBounds(pos: Float32Array) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i];
    const y = pos[i + 1];
    const z = pos[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  return { minX, minY, minZ, maxX, maxY, maxZ };
}

export function translatePose(
  pos: Float32Array,
  prev: Float32Array,
  dx: number,
  dy: number,
  dz: number
) {
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] += dx;
    pos[i + 1] += dy;
    pos[i + 2] += dz;
    prev[i] += dx;
    prev[i + 1] += dy;
    prev[i + 2] += dz;
  }
}

export function applyOrientationToPose(
  source: Float32Array,
  targetPos: Float32Array,
  targetPrev: Float32Array,
  orientation: Orientation
) {
  const [cx, cy, cz] = getPoseCenter(source);

  for (let i = 0; i < source.length; i += 3) {
    const [rx, ry, rz] = rotateOffset(
      source[i] - cx,
      source[i + 1] - cy,
      source[i + 2] - cz,
      orientation
    );

    targetPos[i] = cx + rx;
    targetPos[i + 1] = cy + ry;
    targetPos[i + 2] = cz + rz;

    targetPrev[i] = targetPos[i];
    targetPrev[i + 1] = targetPos[i + 1];
    targetPrev[i + 2] = targetPos[i + 2];
  }
}
