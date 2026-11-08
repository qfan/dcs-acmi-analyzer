import type { Confidence } from "../analysis/analyze.ts";

/**
 * Data model for multi-file ACMI missile & engagement analytics.
 *
 * Each parsed ACMI file produces a compact `FileAnalytics` summary containing all extracted
 * `MissileEngagement` records (with full 3D/local-plane initial conditions at weapon launch)
 * without retaining heavy time-series buffers in the main thread.
 */

export type AspectCategory =
  | "head-on"
  | "forward-quarter"
  | "beam"
  | "rear-quarter"
  | "tail-on"
  | "unknown";

export type AltitudeRelation =
  | "co-alt-high"
  | "co-alt-low"
  | "high-to-low"
  | "low-to-high"
  | "unknown";

export type WeaponClass =
  | "A2A-ARH"
  | "A2A-SARH"
  | "A2A-IR"
  | "A2A-Other"
  | "SAM"
  | "A2G"
  | "Gun";

export type EngagementDomain = "A2A" | "SAM" | "A2G" | "Intercept" | "Other";

export type EngagementOutcome = "kill" | "hit-damaged" | "intercept" | "miss" | "active";

export type TargetSource = "kill" | "hit" | "locked" | "inferred" | "none";

export interface PlatformSnapshot {
  uid: number;
  id: string;
  name: string;
  pilot: string;
  group: string;
  side: string;
  coalition: string;
  domain: "air" | "heli" | "ground" | "sea" | "weapon" | "other";
  /** Altitude MSL at weapon launch (m). */
  altM: number | null;
  /** True speed at weapon launch (m/s). */
  speedMs: number | null;
  /** Approx Mach number at launch altitude (using ISA atmosphere). */
  mach: number | null;
  /** Climb/descent rate at launch (m/s, positive = climbing). */
  vzMs: number | null;
  /** Heading at launch (degrees clockwise from true north, 0–360). */
  headingDeg: number | null;
  /** Pitch angle at launch (degrees, positive = nose up). */
  pitchDeg: number | null;
}

export interface InitialCondition {
  /** 3D slant distance between shooter and target at launch (m). */
  slantRangeM: number;
  /** Horizontal ground distance between shooter and target at launch (m). */
  horizontalRangeM: number;
  /** Target altitude minus shooter altitude at launch (m). Positive = target above shooter. */
  altDiffM: number;
  /** Mean altitude of shooter and target at launch (m). */
  meanAltM: number;
  /** Look elevation angle from shooter to target (degrees, positive = look-up, negative = look-down). */
  lookAngleDeg: number;
  /**
   * Target aspect angle at launch (degrees, 0° = pure tail-on/cold, 90° = beam, 180° = pure head-on/hot).
   * Measured between target's tail vector (-velocity) and the line of sight from target to shooter.
   */
  aspectDeg: number;
  /** Heading crossing angle between shooter and target flight paths (0° = same direction, 180° = opposite). */
  hcaDeg: number;
  /** Shooter antenna train angle / off-boresight angle to target at launch (0° = target dead ahead on nose). */
  shooterAtaDeg: number;
  /** Target antenna train angle to shooter at launch (0° = shooter dead ahead of target's nose). */
  targetAtaDeg: number;
  /** Clock position of target from shooter's cockpit (1–12). */
  clock: number;
  /** Range closure rate at launch (m/s, positive = closing). */
  closureMs: number;
  /** Pre-classified aspect bucket under default thresholds. */
  aspectCategory: AspectCategory;
  /** Pre-classified altitude relation under default thresholds. */
  altitudeRelation: AltitudeRelation;
}

export interface MissileEngagement {
  /** Unique engagement ID across loaded files (`${fileId}:${shotIndex}`). */
  id: string;
  fileId: string;
  fileName: string;
  missionTitle: string;
  /** Weapon object UID in the recording. */
  weaponUid: number;
  /** Raw weapon name in ACMI (e.g. "AIM_120C"). */
  weaponRawName: string;
  /** Normalized display name (e.g. "AIM-120C"). */
  weaponName: string;
  weaponClass: WeaponClass;
  isGun: boolean;
  rounds: number;
  domain: EngagementDomain;
  /** Launch time (seconds from recording start). */
  launchTime: number;
  /** End/impact time (seconds from recording start), or null if still flying. */
  endTime: number | null;
  /** Time of target destruction (for kills), or null. */
  killTime: number | null;
  /** Weapon time of flight (s) from launch to hit or disappearance. */
  flightTimeS: number | null;
  /** Closest-approach miss distance (m) for hits/kills, or closest approach to inferred target. */
  missDistanceM: number | null;
  /** Terminal F-pole range (distance between shooter and target at hit/impact, m). */
  fPoleRangeM: number | null;
  outcome: EngagementOutcome;
  isKill: boolean;
  isHit: boolean;
  friendlyFire: boolean;
  targetEjected: boolean;
  confidence: Confidence;
  firstSeenInFlight: boolean;
  shooter: PlatformSnapshot | null;
  target: PlatformSnapshot | null;
  targetSource: TargetSource;
  /** Launch-time relative geometry between shooter and target (null if shooter or target unknown). */
  initial: InitialCondition | null;
}

export interface FileAnalytics {
  fileId: string;
  fileName: string;
  fileSize: number;
  missionTitle: string;
  theater: string;
  referenceTime: string | null;
  durationS: number;
  aircraftCount: number;
  weaponsReleasedCount: number;
  scrambledObjects: number;
  protectedHeader: boolean;
  engagements: MissileEngagement[];
  parseMs: number;
}

export interface ClassificationThresholds {
  /** Max |targetAlt - shooterAlt| in metres to still count as Co-Altitude (default: 1000 m ≈ 3,280 ft). */
  coAltBandM: number;
  /** Altitude MSL in metres separating Co-Altitude High from Co-Altitude Low (default: 4572 m = 15,000 ft). */
  highAltFloorM: number;
}

export const DEFAULT_THRESHOLDS: ClassificationThresholds = {
  coAltBandM: 1000,
  highAltFloorM: 4572,
};

export const ASPECT_ORDER: AspectCategory[] = [
  "head-on",
  "forward-quarter",
  "beam",
  "rear-quarter",
  "tail-on",
];

export const ASPECT_LABELS: Record<AspectCategory, string> = {
  "head-on": "Head-on (150°–180°)",
  "forward-quarter": "Forward Qtr (120°–150°)",
  beam: "Beam / Notch (60°–120°)",
  "rear-quarter": "Rear Qtr (30°–60°)",
  "tail-on": "Tail-on / Cold (0°–30°)",
  unknown: "Unknown Aspect",
};

export const ASPECT_SHORT_LABELS: Record<AspectCategory, string> = {
  "head-on": "Head-on",
  "forward-quarter": "Fwd Qtr",
  beam: "Beam",
  "rear-quarter": "Rear Qtr",
  "tail-on": "Tail-on",
  unknown: "Unknown",
};

export const ALT_RELATION_ORDER: AltitudeRelation[] = [
  "co-alt-high",
  "co-alt-low",
  "high-to-low",
  "low-to-high",
];

export const ALT_RELATION_LABELS: Record<AltitudeRelation, string> = {
  "co-alt-high": "Co-Alt High",
  "co-alt-low": "Co-Alt Low",
  "high-to-low": "High → Low (Look-down)",
  "low-to-high": "Low → High (Look-up)",
  unknown: "Unknown Altitude",
};

export const ALT_RELATION_COLORS: Record<AltitudeRelation, string> = {
  "co-alt-high": "#3b82f6",
  "co-alt-low": "#10b981",
  "high-to-low": "#f59e0b",
  "low-to-high": "#ec4899",
  unknown: "#94a3b8",
};

export const WEAPON_CLASS_ORDER: WeaponClass[] = [
  "A2A-ARH",
  "A2A-SARH",
  "A2A-IR",
  "A2A-Other",
  "SAM",
  "A2G",
  "Gun",
];

export const WEAPON_CLASS_LABELS: Record<WeaponClass, string> = {
  "A2A-ARH": "Fox-3 (Active Radar)",
  "A2A-SARH": "Fox-1 (Semi-Active Radar)",
  "A2A-IR": "Fox-2 (Infrared)",
  "A2A-Other": "Other A2A Missile",
  SAM: "Surface-to-Air (SAM)",
  A2G: "Air-to-Ground (A2G)",
  Gun: "Gun Burst",
};
