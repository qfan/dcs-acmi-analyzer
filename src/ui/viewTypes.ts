import type { MapData } from "../map/mapData.ts";

/** A request from the tables to show an event on the map. */
export interface MapFocus {
  time: number;
  uid: number;
  /** Increments on every request so the same kill can be shown twice. */
  seq: number;
}

/** What the shared map panel passes to the 2D and 3D views. Time and selection live in the panel. */
export interface ViewProps {
  data: MapData;
  t: number;
  trailS: number;
  labels: boolean;
  ground: boolean;
  selected: number | null;
  follow: boolean;
  onSelect: (uid: number | null) => void;
  /** The user moved the view by hand (stops "follow"). */
  onUserMove: () => void;
  /** Frame this object/time when it changes. */
  focus: MapFocus | null;
}

export function hasWebGL2(): boolean {
  try {
    const c = document.createElement("canvas");
    return c.getContext("webgl2") !== null;
  } catch {
    return false;
  }
}
