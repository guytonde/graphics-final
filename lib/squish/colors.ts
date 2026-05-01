import type { BodyColor } from "./types";

export function colorForId(id: number): BodyColor {
  const hue = (id * 137.508) % 360;
  return hslToRgb(hue / 360, 0.74, 0.58);
}

function hslToRgb(h: number, s: number, l: number): BodyColor {
  if (s === 0) return [l, l, l];

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return [
    hueToRgb(p, q, h + 1 / 3),
    hueToRgb(p, q, h),
    hueToRgb(p, q, h - 1 / 3),
  ];
}

function hueToRgb(p: number, q: number, t: number) {
  let n = t;
  if (n < 0) n += 1;
  if (n > 1) n -= 1;
  if (n < 1 / 6) return p + (q - p) * 6 * n;
  if (n < 1 / 2) return q;
  if (n < 2 / 3) return p + (q - p) * (2 / 3 - n) * 6;
  return p;
}
