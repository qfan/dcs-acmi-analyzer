import { type MapData, type MapKind, sampleAt } from "./mapData.ts";

/**
 * What the "Fit" button (and the initial view) should frame at time t:
 *  1. the primary and secondary objects together, or whichever one exists at t;
 *  2. otherwise everything alive at t: aircraft and weapons first, ground/sea units only if nothing flies.
 *     Evaluated per side so a smaller opposing flight is never dropped as an outlier: passive support
 *     aircraft (AWACS, tankers, heavy transports) are left out when that side has combat aircraft/weapons,
 *     and large groups (>= 10 of a kind on one side) trim the farthest ~10% from their side median.
 *     Centred on the bounding-box midpoint of the kept objects and sized to enclose them all.
 *  3. otherwise the whole recording's action area.
 * Distances in metres on the map plane; `alt` is the typical altitude (for the 3D camera target).
 */

export interface FitTarget {
  x: number;
  y: number;
  alt: number;
  /** Radius around (x, y) that should be in view. */
  radius: number;
  basis: "selected" | "pair" | "alive" | "recording";
  /** Objects the fit was computed from. */
  count: number;
}

/** About 20 km across around a selected aircraft. */
export const SELECTED_RADIUS_M = 10_000;
const MIN_RADIUS_M = 5_000;
/**
 * With this many objects of the same kind on one side or more, the farthest ~10% from their
 * median are left out: large crowds trim strays without dropping small flights or opposing sides.
 */
const TRIM_FROM = 10;

const FLYING: ReadonlySet<MapKind> = new Set(["air", "heli", "weapon"]);
const AIRCRAFT: ReadonlySet<MapKind> = new Set(["air", "heli"]);
const SURFACE: ReadonlySet<MapKind> = new Set(["ground", "sea", "chute"]);

/** Passive support types (AWACS, tankers, heavy transports) omitted when a side also has fighters/weapons. */
const SUPPORT_AIRCRAFT =
  /^(?:E-?2[CD]|E-?3[A-Z]?|E-?7|A-?50\b|KJ-?2000|KC-?(?:10|46|130|135)|IL-?7[68]|C-?(?:5(?:\b|[A-Z])|17|47(?:\b|[A-Z])|130)|An-?(?:26|30)(?:\b|[A-Z])|Yak-?40\b)|\b(?:AWACS|Tanker|MRTT)\b/i;

export interface Selection {
  primary: number | null;
  secondary: number | null;
}

interface FitPoint {
  x: number;
  y: number;
  alt: number;
  side: string;
  kind: MapKind;
  name: string;
}

function isSupportAircraft(p: FitPoint): boolean {
  return p.kind === "air" && SUPPORT_AIRCRAFT.test(p.name);
}

function trimGroup(group: FitPoint[]): FitPoint[] {
  if (group.length < TRIM_FROM) return group;
  const mx = median(group.map((p) => p.x));
  const my = median(group.map((p) => p.y));
  const withDist = group.map((p) => ({ p, d: Math.hypot(p.x - mx, p.y - my) })).sort((a, b) => a.d - b.d);
  const cutoff = (withDist[Math.floor(0.9 * (withDist.length - 1))] as { p: FitPoint; d: number }).d;
  return withDist.filter((w) => w.d <= cutoff).map((w) => w.p);
}

export function fitAt(d: MapData, t: number, sel: Selection, includeSurface = true): FitTarget {
  const at = (uid: number | null) => {
    if (uid === null) return null;
    const tr = d.tracks.find((x) => x.uid === uid);
    const s = tr ? sampleAt(d, tr, t) : null;
    return s ? { x: s.x, y: s.y, alt: Number.isFinite(s.alt) ? s.alt : 0 } : null;
  };
  const p = at(sel.primary);
  const q = at(sel.secondary);
  // Both selected and present: the pair, centred between them.
  if (p && q) {
    const half = Math.hypot(p.x - q.x, p.y - q.y) / 2;
    return {
      x: (p.x + q.x) / 2,
      y: (p.y + q.y) / 2,
      alt: (p.alt + q.alt) / 2,
      radius: Math.max(half * 1.3, MIN_RADIUS_M),
      basis: "pair",
      count: 2,
    };
  }
  const one = p ?? q;
  if (one) return { ...one, radius: SELECTED_RADIUS_M, basis: "selected", count: 1 };

  const collect = (kinds: ReadonlySet<MapKind>) => {
    const pts: FitPoint[] = [];
    for (const tr of d.tracks) {
      if (!kinds.has(tr.kind) || t < tr.t0 || t > tr.t1) continue;
      const s = sampleAt(d, tr, t);
      if (s) {
        pts.push({
          x: s.x,
          y: s.y,
          alt: Number.isFinite(s.alt) ? s.alt : 0,
          side: tr.side.toLowerCase(),
          kind: tr.kind,
          name: tr.name,
        });
      }
    }
    return pts;
  };
  let pts = collect(FLYING);
  const flying = pts.length > 0;
  if (!flying && includeSurface) pts = collect(SURFACE);

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

  const bySide = new Map<string, FitPoint[]>();
  for (const pt of pts) {
    const group = bySide.get(pt.side);
    if (group) group.push(pt);
    else bySide.set(pt.side, [pt]);
  }
  const kept: FitPoint[] = [];
  for (const group of bySide.values()) {
    if (flying) {
      const combat = group.filter((pt) => !isSupportAircraft(pt));
      const active = combat.length > 0 ? combat : group;
      const air = active.filter((pt) => AIRCRAFT.has(pt.kind));
      const weapons = active.filter((pt) => !AIRCRAFT.has(pt.kind));
      kept.push(...trimGroup(air), ...trimGroup(weapons));
    } else {
      kept.push(...trimGroup(group));
    }
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const pt of kept) {
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }
  const x = (minX + maxX) / 2;
  const y = (minY + maxY) / 2;
  const alt = median(kept.map((pt) => pt.alt));
  let reach = 0;
  for (const pt of kept) {
    const dist = Math.hypot(pt.x - x, pt.y - y);
    if (dist > reach) reach = dist;
  }
  return { x, y, alt, radius: Math.max(reach * 1.15, MIN_RADIUS_M), basis: "alive", count: pts.length };
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}
