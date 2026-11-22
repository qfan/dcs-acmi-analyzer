/** Camera transform and rotation helpers for the BVR Trainer top-down canvas. */
import type { View } from "../../map/render.ts";
import type { Side } from "../sim/aircraft.ts";
import { DEG } from "../sim/atmosphere.ts";
import { wrap2Pi, wrapPi } from "../sim/vec.ts";

/** Top-down camera: `rot` is the world compass heading (rad, clockwise from north) pointing up. */
export interface GameView extends View {
  rot: number;
}

const MIN_SCALE = 2e-4;
const MAX_SCALE = 0.2;
const CARDINAL_SNAP_RAD = 3 * DEG;

/** Blue starts north-up (0); red starts south-up (π) so own jets face up from the bottom. */
export function initialMapRotation(side: Side): number {
  return side === "red" ? Math.PI : 0;
}

/** Projects a world position (x east, y north, in metres) to CSS canvas pixels. */
export function toScreen(v: GameView, x: number, y: number): [number, number] {
  const c = Math.cos(v.rot);
  const s = Math.sin(v.rot);
  const dx = x - v.cx;
  const dy = y - v.cy;
  return [v.w / 2 + (dx * c - dy * s) * v.scale, v.h / 2 - (dx * s + dy * c) * v.scale];
}

/** Unprojects CSS canvas pixels back to world coordinates (metres). */
export function toWorld(v: GameView, sx: number, sy: number): [number, number] {
  const c = Math.cos(v.rot);
  const s = Math.sin(v.rot);
  const rx = (sx - v.w / 2) / v.scale;
  const ry = -(sy - v.h / 2) / v.scale;
  return [v.cx + rx * c + ry * s, v.cy - rx * s + ry * c];
}

/** Pans the view so projected world points shift by (+dxPx, +dyPx) on screen. */
export function panView(v: GameView, dxPx: number, dyPx: number): void {
  const c = Math.cos(v.rot);
  const s = Math.sin(v.rot);
  v.cx += (-dxPx * c + dyPx * s) / v.scale;
  v.cy += (dxPx * s + dyPx * c) / v.scale;
}

/** Scales the view by `factor`; when `keepAnchor` is true, keeps the world point under (sx, sy) fixed. */
export function zoomViewAt(v: GameView, sx: number, sy: number, factor: number, keepAnchor: boolean): void {
  const [wx, wy] = toWorld(v, sx, sy);
  v.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * factor));
  if (!keepAnchor) return;
  const [wx2, wy2] = toWorld(v, sx, sy);
  v.cx += wx - wx2;
  v.cy += wy - wy2;
}

/** Converts a world compass heading (rad, 0 = north) to a screen-clockwise angle (0 = screen up). */
export function screenHeading(worldHdg: number, rot: number): number {
  return worldHdg - rot;
}

/** Steps `rot` by `deltaDeg` degrees and normalizes into [0, 2π), snapping near-integer degrees. */
export function stepRotation(rot: number, deltaDeg: number): number {
  const deg = (((rot / DEG + deltaDeg) % 360) + 360) % 360;
  const nearest = Math.round(deg);
  const rounded = Math.abs(deg - nearest) < 1e-4 ? nearest % 360 : deg;
  return rounded * DEG;
}

/** Normalizes `rot` and snaps either to 15° increments (`fineSnap15`) or within ±3° of cardinals. */
export function snapRotation(rot: number, fineSnap15: boolean): number {
  const norm = wrap2Pi(rot);
  if (fineSnap15) {
    const snappedDeg = (Math.round(norm / DEG / 15) * 15) % 360;
    return snappedDeg * DEG;
  }
  for (let k = 0; k < 4; k++) {
    const cardinal = (k * Math.PI) / 2;
    if (Math.abs(wrapPi(norm - cardinal)) <= CARDINAL_SNAP_RAD) return cardinal;
  }
  return norm;
}

/** Flips between north-up (0) and south-up (π); any off-north angle resets to north-up (0). */
export function toggleNorthFlip(rot: number): number {
  return Math.abs(wrapPi(rot)) < 0.01 ? Math.PI : 0;
}

/** Integer compass heading (0..359°) currently pointing to the top of the screen. */
export function upHeadingDeg(rot: number): number {
  return Math.round((((rot / DEG) % 360) + 360) % 360) % 360;
}
