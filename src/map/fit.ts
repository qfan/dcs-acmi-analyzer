import { type MapData, type MapKind, sampleAt } from "./mapData.ts";

/**
 * What the "Fit" button (and the initial view) should frame at time t:
 *  1. the selected object, if it exists at t;
 *  2. otherwise everything alive at t: aircraft and weapons first, ground/sea units only if nothing flies.
 *     Centred on the median position and sized to cover ~90% of objects, so one far-off aircraft
 *     (an AWACS orbit, a tanker track) neither drags the centre nor zooms everything to specks;
 *  3. otherwise the whole recording's action area.
 * Distances in metres on the map plane; `alt` is the typical altitude (for the 3D camera target).
 */

export interface FitTarget {
  x: number;
  y: number;
  alt: number;
  /** Radius around (x, y) that should be in view. */
  radius: number;
  basis: "selected" | "alive" | "recording";
  /** Objects the fit was computed from. */
  count: number;
}

/** About 20 km across around a selected aircraft. */
export const SELECTED_RADIUS_M = 10_000;
const MIN_RADIUS_M = 5_000;
/**
 * With this many objects or more, the farthest ~10% (at least the single farthest) are left out of
 * the radius: e.g. two fighters plus an AWACS 100 km away frames the fighters.
 */
const TRIM_FROM = 3;

const FLYING: ReadonlySet<MapKind> = new Set(["air", "heli", "weapon"]);
const SURFACE: ReadonlySet<MapKind> = new Set(["ground", "sea", "chute"]);

export function fitAt(d: MapData, t: number, selected: number | null, includeSurface = true): FitTarget {
  if (selected !== null) {
    const tr = d.tracks.find((x) => x.uid === selected);
    const s = tr ? sampleAt(d, tr, t) : null;
    if (s)
      return {
        x: s.x,
        y: s.y,
        alt: Number.isFinite(s.alt) ? s.alt : 0,
        radius: SELECTED_RADIUS_M,
        basis: "selected",
        count: 1,
      };
  }

  const collect = (kinds: ReadonlySet<MapKind>) => {
    const pts: { x: number; y: number; alt: number }[] = [];
    for (const tr of d.tracks) {
      if (!kinds.has(tr.kind) || t < tr.t0 || t > tr.t1) continue;
      const s = sampleAt(d, tr, t);
      if (s) pts.push({ x: s.x, y: s.y, alt: Number.isFinite(s.alt) ? s.alt : 0 });
    }
    return pts;
  };
  let pts = collect(FLYING);
  if (pts.length === 0 && includeSurface) pts = collect(SURFACE);

  if (pts.length === 0) {
    const f = d.focus;
    return {
      x: (f.minX + f.maxX) / 2,
      y: (f.minY + f.maxY) / 2,
      alt: 0,
      radius: Math.max(f.maxX - f.minX, f.maxY - f.minY, 2 * MIN_RADIUS_M) / 2,
      basis: "recording",
      count: 0,
    };
  }

  const x = median(pts.map((p) => p.x));
  const y = median(pts.map((p) => p.y));
  const alt = median(pts.map((p) => p.alt));
  const dists = pts.map((p) => Math.hypot(p.x - x, p.y - y)).sort((a, b) => a - b);
  const reach =
    dists.length >= TRIM_FROM
      ? (dists[Math.floor(0.9 * (dists.length - 1))] as number)
      : (dists[dists.length - 1] as number);
  return { x, y, alt, radius: Math.max(reach * 1.15, MIN_RADIUS_M), basis: "alive", count: pts.length };
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}
