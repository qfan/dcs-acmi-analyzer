import { type FitTarget, fitAt, type Selection } from "../map/fit.ts";
import type { MapData } from "../map/mapData.ts";
import type { FollowMode } from "./viewTypes.ts";

/**
 * Where the camera should be centred for a follow mode at time t, or null to leave it alone
 * (follow off, or the followed object doesn't exist at t). "pair" returns the midpoint and a radius
 * that keeps both in view; if only one of the pair exists, it follows that one.
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
  return f.basis === "selected" || f.basis === "pair" ? f : null;
}
