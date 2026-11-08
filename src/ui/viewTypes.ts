import type { MapData } from "../map/mapData.ts";
import type { Settings } from "../settings/schema.ts";

/** A request from the tables to show an event on the map. */
export interface MapFocus {
  time: number;
  /** Object to frame. */
  uid: number;
  /** Selection to apply (e.g. killer as primary, victim as secondary). */
  primary: number | null;
  secondary: number | null;
  /** Increments on every request so the same kill can be shown twice. */
  seq: number;
}

export type PickRole = "primary" | "secondary";
export type FollowMode = "off" | "primary" | "secondary" | "pair";

/** What the shared map panel passes to the 2D and 3D views. Time and selection live in the panel. */
export interface ViewProps {
  data: MapData;
  t: number;
  trailS: number;
  labels: boolean;
  ground: boolean;
  primary: number | null;
  secondary: number | null;
  follow: FollowMode;
  /**
   * A click on the map. `uid` is the object under the pointer (or null), `role` what the click asks
   * for: Ctrl+left = primary, Ctrl+right = secondary, a plain click = primary (or secondary when
   * "pick secondary" is armed). `explicit` is true for Ctrl clicks.
   */
  onPick: (uid: number | null, role: PickRole, explicit: boolean) => void;
  /** The user moved the view by hand (stops following). */
  onUserMove: () => void;
  /** Frame this object/time when it changes. */
  focus: MapFocus | null;
  /** Units and label fields. */
  settings: Settings;
}

export function hasWebGL2(): boolean {
  try {
    const c = document.createElement("canvas");
    return c.getContext("webgl2") !== null;
  } catch {
    return false;
  }
}
