import type { ContainerInfo } from "./container.ts";
import type { NumberData, TextData, TransformData } from "./tracks.ts";

export interface AcmiObject {
  /** Unique index within the recording (an ID reused after removal gets a new object). */
  uid: number;
  /** Hexadecimal object ID as written in the file (lowercase, no leading zeros). */
  id: string;
  /** 0 for the first object with this ID, 1 if the ID was reused after removal, and so on. */
  life: number;
  /**
   * For a reused ID: uid of the previous object with this ID, and seconds between its removal and this
   * object's first line. DCS2ACMI often removes an aircraft and re-adds it a few hundredths of a second
   * later at the same spot with the same name and pilot. That is a recorder glitch, not a kill, so
   * analysis should treat short gaps as a continuation.
   */
  previousUid: number | null;
  reappearGap: number | null;
  /** Time of the first line mentioning this object. */
  createdAt: number;
  /** Time of the `-id` removal line, or null if still present when the recording ended. */
  removedAt: number | null;
  /** Time of an explicit `Event=Destroyed`, if the recorder wrote one. */
  destroyedAt: number | null;
  /** Most recent value of the common text properties (empty string when never set). */
  name: string;
  type: string;
  tags: string[];
  pilot: string;
  group: string;
  coalition: string;
  color: string;
  country: string;
  callSign: string;
  /** Parent object ID (e.g. the launcher of a missile), when the recorder writes it. */
  parent: string;
  /** Which T= forms (3, 5, 6, 9 components) this object used. */
  tForms: number[];
  transform: TransformData | null;
  text: Record<string, TextData>;
  numbers: Record<string, NumberData>;
  firstLine: number;
}

export interface AcmiEvent {
  time: number;
  /** Message, Bookmark, Debug, LeftArea, Destroyed, TakenOff, Landed, Timeout, or anything else. */
  type: string;
  objectIds: string[];
  /** `Key:Value` parameters (used by Timeout). */
  params: Record<string, string>;
  text: string;
  raw: string;
  lineNo: number;
}

export interface GlobalChange {
  time: number;
  key: string;
  value: string;
}

export type WarningKind =
  | "header"
  | "bad-frame"
  | "bad-line"
  | "bad-id"
  | "remove-unknown"
  | "id-reused"
  | "t-components"
  | "bad-number"
  | "reference-changed"
  | "truncated"
  | "incomplete-zip";

export interface ParseWarning {
  kind: WarningKind;
  lineNo: number;
  message: string;
}

export interface ParseStats {
  logicalLines: number;
  frames: number;
  /** Frames whose time was lower than the previous frame. */
  framesBackwards: number;
  objectLines: number;
  removals: number;
  /** Count of T= updates by number of components. */
  tComponentCounts: Record<number, number>;
  /** Objects that used more than one T= form. */
  objectsMixingTForms: number;
  idReuses: number;
  /** Reused IDs bucketed by gap since removal: "<0.1s", "<1s", "<10s", ">=10s". */
  idReuseGaps: Record<string, number>;
  /** Reused IDs whose new object has the same Name and Pilot as the previous one. */
  idReusesSameIdentity: number;
  /** Property keys that were neither in the known text nor known numeric list. */
  unknownProps: Record<string, number>;
  textBytes: number;
  rawBytes: number;
}

export interface Recording {
  container: ContainerInfo;
  fileType: string | null;
  fileVersion: string | null;
  /** Global (object 0) properties, latest value. AuthenticationKey is summarised, not stored. */
  globals: Record<string, string>;
  globalChanges: GlobalChange[];
  refLon: number;
  refLat: number;
  /** ISO time string from ReferenceTime, or null. Frame times are seconds relative to it. */
  referenceTime: string | null;
  timeStart: number;
  timeEnd: number;
  objects: AcmiObject[];
  events: AcmiEvent[];
  truncated: boolean;
  warnings: ParseWarning[];
  warningCounts: Partial<Record<WarningKind, number>>;
  stats: ParseStats;
}

/** Properties the spec defines as text. Everything else is parsed as a number when possible. */
export const TEXT_PROPS = new Set([
  "Name",
  "Type",
  "AdditionalType",
  "Parent",
  "Next",
  "ShortName",
  "LongName",
  "FullName",
  "CallSign",
  "Pilot",
  "Registration",
  "Squawk",
  "ICAO24",
  "Group",
  "Country",
  "Coalition",
  "Color",
  "Shape",
  "Label",
  "Debug",
  "FocusedTarget",
  "LockedTarget",
  "LockedTarget2",
  "LockedTarget3",
  "LockedTarget4",
  "LockedTarget5",
  "LockedTarget6",
  "LockedTarget7",
  "LockedTarget8",
  "LockedTarget9",
]);

/** Numeric properties from the spec, plus ones observed in real files (AOAUnits). */
export const KNOWN_NUMERIC = new Set([
  "Slot",
  "Importance",
  "Disabled",
  "Visible",
  "Health",
  "Length",
  "Width",
  "Height",
  "Radius",
  "IAS",
  "CAS",
  "TAS",
  "Mach",
  "AOA",
  "AOS",
  "AGL",
  "HDG",
  "HDM",
  "Throttle",
  "Throttle2",
  "EngineRPM",
  "EngineRPM2",
  "NR",
  "NR2",
  "RotorRPM",
  "RotorRPM2",
  "Afterburner",
  "AirBrakes",
  "Flaps",
  "LandingGear",
  "LandingGearHandle",
  "Tailhook",
  "Parachute",
  "DragChute",
  "RadarMode",
  "RadarAzimuth",
  "RadarElevation",
  "RadarRoll",
  "RadarRange",
  "RadarHorizontalBeamwidth",
  "RadarVerticalBeamwidth",
  "LockedTargetMode",
  "LockedTargetAzimuth",
  "LockedTargetElevation",
  "LockedTargetRange",
  "EngagementMode",
  "EngagementMode2",
  "EngagementRange",
  "EngagementRange2",
  "VerticalEngagementRange",
  "VerticalEngagementRange2",
  "RollControlInput",
  "PitchControlInput",
  "YawControlInput",
  "RollControlPosition",
  "PitchControlPosition",
  "YawControlPosition",
  "RollTrimTab",
  "PitchTrimTab",
  "YawTrimTab",
  "AileronLeft",
  "AileronRight",
  "Elevator",
  "Rudder",
  "LocalizerLateralDeviation",
  "GlideslopeVerticalDeviation",
  "LocalizerAngularDeviation",
  "GlideslopeAngularDeviation",
  "PilotHeadRoll",
  "PilotHeadPitch",
  "PilotHeadYaw",
  "PilotEyeGazePitch",
  "PilotEyeGazeYaw",
  "VerticalGForce",
  "LongitudinalGForce",
  "LateralGForce",
  "TriggerPressed",
  "ENL",
  "HeartRate",
  "SpO2",
  "WindDirection",
  "WindPitch",
  "WindSpeed",
  "AltimeterSetting",
  "QNH",
  "OnGround",
  "AOAUnits",
]);
for (let i = 1; i <= 9; i++) {
  const s = i === 1 ? "" : String(i);
  KNOWN_NUMERIC.add(`FuelWeight${s}`);
  KNOWN_NUMERIC.add(`FuelVolume${s}`);
  if (i <= 8) {
    KNOWN_NUMERIC.add(`FuelFlowWeight${s}`);
    KNOWN_NUMERIC.add(`FuelFlowVolume${s}`);
  }
}

export function hasTag(o: AcmiObject, tag: string): boolean {
  return o.tags.includes(tag);
}
