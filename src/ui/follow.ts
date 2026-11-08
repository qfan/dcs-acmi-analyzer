import { type FitTarget, fitAt, type Selection } from "../map/fit.ts";
import { type MapData, sampleAt } from "../map/mapData.ts";
import type { FollowMode } from "./viewTypes.ts";

/** Smallest radius the pair follow keeps in view, so a tight formation isn't framed edge to edge. */
const PAIR_MIN_RADIUS_M = 300;

/**
 * Where the camera should be centred for a follow mode at time t, or null to leave it alone
 * (follow off, or the followed object doesn't exist at t). "pair" returns the midpoint and the
 * smallest radius that keeps both in view (3D separation, with a margin); the views only zoom out
 * to that, never in, so the user's own zoom is kept. If only one of the pair exists, it follows that one.
 */
export function followTarget(d: MapData, t: number, mode: FollowMode, sel: Selection): FitTarget | null {
  if (mode === "off") return null;
  const which: Selection =
    mode === "primary"
      ? { primary: sel.primary, secondary: null }
      : mode === "secondary"
        ? { primary: null, secondary: sel.secondary }
        : sel;
  if (which.primary === null && which.secondary === null) return null;
  const f = fitAt(d, t, which, false);
  if (f.basis === "selected") return f;
  if (f.basis !== "pair") return null;
  const at = (uid: number | null) => {
    const tr = d.tracks.find((x) => x.uid === uid);
    return tr ? sampleAt(d, tr, t) : null;
  };
  const a = at(which.primary);
  const b = at(which.secondary);
  if (!a || !b) return f;
  const alt = (v: number) => (Number.isFinite(v) ? v : 0);
  const half = Math.hypot(a.x - b.x, a.y - b.y, alt(a.alt) - alt(b.alt)) / 2;
  return { ...f, radius: Math.max(half * 1.2, PAIR_MIN_RADIUS_M) };
}
