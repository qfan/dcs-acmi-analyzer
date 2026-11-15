/** Small 3-vector helpers. World axes: x = east, y = north, z = altitude (all metres). */
export interface V3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
export const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: V3, k: number): V3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
export const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
export const norm = (a: V3): V3 => {
  const l = len(a);
  return l > 1e-9 ? scale(a, 1 / l) : v3(0, 1, 0);
};
/** Component of a perpendicular to the unit vector u. */
export const perp = (a: V3, u: V3): V3 => sub(a, scale(u, dot(a, u)));
/** Angle between two vectors (rad). */
export function angleBetween(a: V3, b: V3): number {
  const la = len(a);
  const lb = len(b);
  if (la < 1e-9 || lb < 1e-9) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (la * lb))));
}

/** Unit vector for a compass heading (rad, clockwise from north) and flight-path angle (rad). */
export const headingVec = (hdg: number, gamma = 0): V3 => ({
  x: Math.sin(hdg) * Math.cos(gamma),
  y: Math.cos(hdg) * Math.cos(gamma),
  z: Math.sin(gamma),
});

/** Compass bearing (rad, 0..2π) from a to b on the horizontal plane. */
export function bearing(a: V3, b: V3): number {
  const h = Math.atan2(b.x - a.x, b.y - a.y);
  return h < 0 ? h + 2 * Math.PI : h;
}

/** Wraps an angle to (−π, π]. */
export function wrapPi(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

/** Wraps an angle to [0, 2π). */
export function wrap2Pi(a: number): number {
  const r = a % (2 * Math.PI);
  return r < 0 ? r + 2 * Math.PI : r;
}

/**
 * Closest approach between two points moving linearly over one step: a from a0 to a1, b from b0 to
 * b1. Returns the distance and the fraction of the step (0..1) at which it happens.
 */
export function segmentClosest(a0: V3, a1: V3, b0: V3, b1: V3): { d: number; f: number } {
  const r0 = sub(b0, a0);
  const r1 = sub(b1, a1);
  const dr = sub(r1, r0);
  const dd = dot(dr, dr);
  const f = dd > 1e-12 ? Math.max(0, Math.min(1, -dot(r0, dr) / dd)) : 1;
  return { d: len(add(r0, scale(dr, f))), f };
}
