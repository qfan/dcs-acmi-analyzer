import { Euler, Quaternion, Vector3 } from "three";
import { type MapData, type MapKind, type MapTrack, pilotAt, sampleAt } from "../map/mapData.ts";

/**
 * Pure per-frame scene building for the 3D view (no WebGL here, so it is unit-tested).
 *
 * World axes (three.js is Y-up): X = east, Y = altitude MSL, Z = south (−north). All in metres,
 * on the flat plane of the map projection — like DCS itself, which uses a flat world per map.
 */

const DEG = Math.PI / 180;

export function toWorld(x: number, y: number, alt: number, out = new Vector3()): Vector3 {
  return out.set(x, Number.isFinite(alt) ? alt : 0, -y);
}

const euler = new Euler();
/**
 * Rotation for a symbol modelled nose along −Z (north), right wing along +X, up along +Y.
 * Heading: clockwise from north. Pitch: nose up positive. Roll: right wing down positive.
 */
export function attitude(
  hdgDeg: number,
  pitchDeg: number,
  rollDeg: number,
  out = new Quaternion(),
): Quaternion {
  euler.set(pitchDeg * DEG, -hdgDeg * DEG, -rollDeg * DEG, "YXZ");
  return out.setFromEuler(euler);
}

export interface FrameObject {
  uid: number;
  kind: MapKind;
  side: string;
  pos: Vector3;
  rot: Quaternion;
  /** Distance above the ground plane (for drop lines). */
  alt: number;
  label: string;
  pilot: string;
  name: string;
  /** Ground speed, m/s. */
  speed: number;
}

export interface FrameOptions {
  trailS: number;
  ground: boolean;
  /** Selected objects (primary, secondary): drawn with their whole trail. */
  selected: readonly number[];
}

export interface Frame {
  objects: FrameObject[];
  /** Line segments (pairs of xyz) and their RGB colours, for trails. */
  trail: { positions: Float32Array; colors: Float32Array; count: number };
  /** Vertical lines from aircraft to the ground plane. */
  drops: { positions: Float32Array; colors: Float32Array; count: number };
}

export type ColorFn = (side: string) => [number, number, number];

export function buildFrame(d: MapData, t: number, o: FrameOptions, color: ColorFn): Frame {
  const objects: FrameObject[] = [];
  const trailP: number[] = [];
  const trailC: number[] = [];
  const dropP: number[] = [];
  const dropC: number[] = [];
  const v = new Vector3();
  const prev = new Vector3();
  for (const tr of d.tracks) {
    if (t < tr.t0 || t > tr.t1) continue;
    if (!o.ground && (tr.kind === "ground" || tr.kind === "sea")) continue;
    const s = sampleAt(d, tr, t);
    if (!s) continue;
    const alt = Number.isFinite(s.alt) ? s.alt : 0;
    const pos = toWorld(s.x, s.y, alt);
    const pilot = pilotAt(tr, t);
    objects.push({
      uid: tr.uid,
      kind: tr.kind,
      side: tr.side,
      pos,
      rot: attitude(s.hdg, s.pitch, s.roll),
      alt,
      label: `${pilot ? `${pilot} ` : ""}${tr.name}`,
      pilot,
      name: tr.name,
      speed: Math.hypot(s.speed, s.vz),
    });
    const rgb = color(tr.side);
    const flying = tr.kind === "air" || tr.kind === "heli" || tr.kind === "weapon";
    if (flying && (tr.kind !== "weapon" || alt > 0)) {
      if (tr.kind !== "weapon") {
        dropP.push(pos.x, pos.y, pos.z, pos.x, 0, pos.z);
        dropC.push(...rgb, ...rgb);
      }
      const seconds = o.selected.includes(tr.uid) ? t - tr.t0 : o.trailS;
      if (seconds > 0) appendTrail(d, tr, t, seconds, pos, rgb, trailP, trailC, v, prev);
    }
  }
  return {
    objects,
    trail: {
      positions: Float32Array.from(trailP),
      colors: Float32Array.from(trailC),
      count: trailP.length / 3,
    },
    drops: { positions: Float32Array.from(dropP), colors: Float32Array.from(dropC), count: dropP.length / 3 },
  };
}

function appendTrail(
  d: MapData,
  tr: MapTrack,
  t: number,
  seconds: number,
  head: Vector3,
  rgb: [number, number, number],
  outP: number[],
  outC: number[],
  v: Vector3,
  prev: Vector3,
) {
  const from = t - seconds;
  // First sample at or after `from` (binary search).
  let lo = 0;
  let hi = tr.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((d.times[tr.start + mid] as number) < from) lo = mid + 1;
    else hi = mid;
  }
  let have = false;
  for (let i = lo; i < tr.count; i++) {
    const k = tr.start + i;
    if ((d.times[k] as number) > t) break;
    toWorld(d.x[k] as number, d.y[k] as number, d.alt[k] as number, v);
    if (have) {
      outP.push(prev.x, prev.y, prev.z, v.x, v.y, v.z);
      outC.push(...rgb, ...rgb);
    }
    prev.copy(v);
    have = true;
  }
  if (have) {
    outP.push(prev.x, prev.y, prev.z, head.x, head.y, head.z);
    outC.push(...rgb, ...rgb);
  }
}

/** Grid spacings in distance units (km or nm), finest first. */
export const GRID_STEPS = [1, 10, 50] as const;

/**
 * Which grids to show for a camera this far (metres) from what it looks at, and how strongly.
 * Close: 1-unit lines with 10-unit lines over them. Medium: 10 units only. Far: 50 units only.
 * `unitM` is metres per unit: 1000 for km, 1852 for nautical miles. Cells are returned in metres.
 */
export function gridLevels(cameraDistanceM: number, unitM = 1000): { cell: number; opacity: number }[] {
  const [fine, mid, coarse] = GRID_STEPS.map((s) => s * unitM) as [number, number, number];
  if (cameraDistanceM < 40 * unitM)
    return [
      { cell: fine, opacity: 0.1 },
      { cell: mid, opacity: 0.24 },
    ];
  if (cameraDistanceM < 300 * unitM) return [{ cell: mid, opacity: 0.22 }];
  return [{ cell: coarse, opacity: 0.22 }];
}

/** Centre for a grid near `at`, snapped so its lines fall on whole multiples of the cell size. */
export function snapGridCentre(at: number, cell: number): number {
  return Math.round(at / cell) * cell;
}

/** Fog distances that fade the ground and grid out towards the horizon. */
export function fogRange(cameraDistanceM: number): { near: number; far: number } {
  const d = Math.max(cameraDistanceM, 2_000);
  return { near: d * 1.5, far: d * 7 };
}

/** Camera placement that frames a horizontal box (metres) from the south-east, looking down ~35°. */
export function framingCamera(
  b: { minX: number; minY: number; maxX: number; maxY: number },
  altitude: number,
  fovDeg: number,
): { target: Vector3; position: Vector3 } {
  const target = toWorld((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, altitude);
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY, 2000);
  const dist = (span / 2 / Math.tan((fovDeg * DEG) / 2)) * 1.1;
  const elev = 35 * DEG;
  const azim = 200 * DEG; // from slightly west of south, looking north-east-ish
  const position = new Vector3(
    target.x + dist * Math.cos(elev) * Math.sin(azim),
    target.y + dist * Math.sin(elev),
    target.z - dist * Math.cos(elev) * Math.cos(azim),
  );
  return { target, position };
}
