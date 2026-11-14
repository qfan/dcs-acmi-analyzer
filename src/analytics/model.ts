import type { Confidence } from "../analysis/analyze.ts";

/**
 * Data model for multi-file ACMI missile & engagement analytics.
 *
 * Each parsed ACMI file produces a compact `FileAnalytics` summary containing all extracted
 * `MissileEngagement` records (with full 3D/local-plane initial conditions at weapon launch)
 * without retaining heavy time-series buffers in the main thread.
 */

export type AspectCategory = "head-on" | "forward-quarter" | "beam" | "rear-quarter" | "tail-on" | "unknown";

export type AltitudeRelation = "co-alt-high" | "co-alt-low" | "high-to-low" | "low-to-high" | "unknown";

export type WeaponClass = "A2A-ARH" | "A2A-SARH" | "A2A-IR" | "A2A-Other" | "SAM" | "A2G" | "Gun";

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
  /** DCS patch of the recording (e.g. "2.9.15"), copied from the file for cohort splits. */
  dcsPatch: string | null;
  /** Real-world recording start (ISO), copied from the file for date cohorts. */
  recordedAt: string | null;
  /** Missile flyout facts measured from the raw track (null for guns / bombs / unknown targets). */
  flight: MissileFlight | null;
  /** Resampled shooter / target / missile paths for post-launch analyses (A2A & SAM missiles only). */
  track: ShotTrack | null;
  /**
   * Off-path ("UFO") samples of the shooter and target from a little before launch to a little after
   * the end of the shot. Any warp in this window corrupts launch geometry and miss distances.
   * Missing on data extracted before quality labels existed.
   */
  ufo?: { shooter: number; target: number };
}

/** Thresholds for recording quality labels (see quality.ts). */
export const QUALITY_RULES = {
  /** Path bend beyond this many g (plus slack) is not flyable: the sample is off-path. */
  maxG: 15,
  offPathSlackM: 30,
  /** Off-path samples closer than this belong to one episode (s). */
  episodeGapS: 3,
  /** An aircraft is a heavy UFO when it has at least this many off-path samples and ... */
  heavyMinSamples: 10,
  /** ... at least this many separate episodes, or this many seconds inside episodes. */
  heavyMinEpisodes: 3,
  heavyMinSeconds: 10,
  /** Server-wide lag: windows with ≥ N aircraft off-path that are ≥ share of aircraft alive. */
  massWindowS: 10,
  massMinAircraft: 3,
  massMinShare: 0.3,
  /** File is "mass UFO" with at least this many such windows. */
  massMinWindows: 3,
  /** Aircraft with fewer samples are not counted as tracked. */
  minTrackedSamples: 50,
  /** Shot window for engagement-level UFO counts (s before launch / after shot end). */
  shotWindowPreS: 10,
  shotWindowPostS: 5,
  /** Shots with at least this many off-path samples (shooter + target) count as UFO-affected. */
  shotUfoMinSamples: 1,
  /** Recordings shorter than this are "short" (s). */
  shortS: 5 * 60,
  /** Fewer BVR shots than this is "few BVR". */
  fewBvrShots: 3,
  /** Per-file list of troubled aircraft is cut to this many. */
  keepAircraft: 40,
} as const;

export type QualityFlag = "short" | "no-a2a" | "no-bvr" | "few-bvr" | "ufo-mass" | "ufo-some" | "scrambled";

export const QUALITY_FLAG_ORDER: QualityFlag[] = [
  "ufo-mass",
  "ufo-some",
  "scrambled",
  "short",
  "no-a2a",
  "no-bvr",
  "few-bvr",
];

export const QUALITY_FLAG_LABELS: Record<QualityFlag, string> = {
  "ufo-mass": "Mass UFO",
  "ufo-some": "UFO aircraft",
  scrambled: "Scrambled",
  short: "Short",
  "no-a2a": "No A2A",
  "no-bvr": "No BVR",
  "few-bvr": "Few BVR",
};

export const QUALITY_FLAG_HELP: Record<QualityFlag, string> = {
  "ufo-mass":
    "Many aircraft warp at the same moments: server-side lag. Positions throughout the file are unreliable.",
  "ufo-some": "One or more aircraft warp repeatedly: those players' connections. Others are clean.",
  scrambled: "Protected recording: some horizontal positions are scrambled and take no part in geometry.",
  short: `Shorter than ${QUALITY_RULES.shortS / 60} minutes.`,
  "no-a2a": "No air-to-air missile launches.",
  "no-bvr": "Air-to-air missiles, but none launched beyond 10 nm.",
  "few-bvr": `Fewer than ${QUALITY_RULES.fewBvrShots} BVR missile shots.`,
};

/** none: no off-path sample at all; minor: isolated warps; some: ≥1 heavy aircraft; mass: server-wide. */
export type UfoLevel = "none" | "minor" | "some" | "mass";

/** One aircraft (one life) that went off-path at least once. */
export interface MotionTrouble {
  uid: number;
  name: string;
  pilot: string;
  side: string;
  flightS: number;
  samples: number;
  offPathSamples: number;
  episodes: number;
  /** Seconds covered by off-path episodes. */
  ufoS: number;
  perMin: number;
  heavy: boolean;
}

export interface FileQuality {
  flags: QualityFlag[];
  ufoLevel: UfoLevel;
  /** Aircraft with enough samples to judge. */
  trackedAircraft: number;
  heavyAircraft: number;
  offPathSamples: number;
  /** Time windows where many aircraft were off-path together (server lag). */
  massWindows: number;
  massPeakShare: number;
  /** A2A missile shots whose shooter or target went off-path around the shot. */
  ufoShots: number;
  /** Aircraft with off-path samples, worst first. */
  aircraft: MotionTrouble[];
}

/**
 * Bump whenever extraction output changes meaning or shape: cached results with an older
 * version are ignored and the file is re-parsed.
 */
export const EXTRACTOR_VERSION = 3;

/** Launch range above which a shot counts as BVR (10 nm). */
export const BVR_RANGE_M = 10 * 1852;

/** Per-recording metadata used for cohorts (DCS patch, date), de-duplication and session filters. */
export interface RecordingMeta {
  /** Full DCS build from `DataSource`, e.g. "2.9.15.9599". */
  dcsVersion: string | null;
  /** Major.minor.patch, e.g. "2.9.15": the usual cohort key for "what changed in this update". */
  dcsPatch: string | null;
  /** Recorder, e.g. "DCS2ACMI 1.9.4.200". */
  recorder: string | null;
  /** Real-world recording start (ISO 8601) from `RecordingTime`. */
  recordedAt: string | null;
  author: string | null;
  /** Identifies the same session recorded twice (copies): recording time + title + rounded duration. */
  sessionKey: string;
  /** Air-to-air missile launches (no guns). */
  a2aMissileShots: number;
  /** Air-to-air missile launches with launch range > `BVR_RANGE_M`: the "is this a BVR session" score. */
  bvrShots: number;
}

/** Missile flyout facts measured on the raw (not resampled) track. Speeds are true airspeed estimates. */
export interface MissileFlight {
  /** Launch to disappearance (s). */
  tofS: number;
  maxSpeedMs: number;
  maxMach: number;
  /** Time after launch of peak speed ≈ motor burnout (s). */
  maxSpeedAtS: number;
  /** Highest altitude reached (m MSL) and gain over launch altitude (m): loft indicator. */
  apexAltM: number;
  apexGainM: number;
  /** Ground-track + vertical distance flown (m). */
  distanceFlownM: number;
  /** Speed / Mach at the last sample before disappearing (m/s). */
  endSpeedMs: number;
  endMach: number;
  /** Closest approach to the target (m), when (s after launch), missile speed and |v_missile − v_target| there. */
  cpaM: number | null;
  cpaAtS: number | null;
  cpaMissileSpeedMs: number | null;
  cpaRelSpeedMs: number | null;
}

/**
 * Shooter, target and missile resampled every `dt` seconds from launch. Positions are local
 * East/North metres from the shooter's launch position plus altitude MSL, interleaved per sample as
 * `TRACK_CHANNELS`. Unknown values are NaN (e.g. missile gone, target dead).
 */
export interface ShotTrack {
  dt: number;
  n: number;
  data: Float32Array;
  /** Seconds after launch at which the target / shooter released chaff and flares. */
  targetChaffS: number[];
  targetFlareS: number[];
  shooterChaffS: number[];
  shooterFlareS: number[];
}

export const TRACK_CHANNELS = ["mE", "mN", "mAlt", "mSpeed", "tE", "tN", "tAlt", "sE", "sN", "sAlt"] as const;
export const TRACK_STRIDE = TRACK_CHANNELS.length;
export const TRACK_DT_S = 0.5;
/** Tracks are cut this long after launch at most. */
export const TRACK_MAX_S = 180;

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
  meta: RecordingMeta;
  /** Quality labels. Missing on data extracted before they existed (old bundles). */
  quality?: FileQuality;
  extractorVersion: number;
}

export interface ClassificationThresholds {
  /** Max |targetAlt - shooterAlt| in metres to still count as Co-Altitude (default: 1000 m ≈ 3,280 ft). */
  coAltBandM: number;
  /** Altitude MSL in metres separating Co-Altitude High from Co-Altitude Low (default: 9144 m = 30,000 ft; Ultra-High = 12192 m = 40,000 ft). */
  highAltFloorM: number;
}

export const DEFAULT_THRESHOLDS: ClassificationThresholds = {
  coAltBandM: 1000,
  highAltFloorM: 9144,
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

/** Weapon classes representing air-to-air missiles (excluding guns, SAMs, and A2G ordnance). */
export const A2A_MISSILE_CLASSES: readonly WeaponClass[] = ["A2A-ARH", "A2A-SARH", "A2A-IR", "A2A-Other"];

export const WEAPON_CLASS_LABELS: Record<WeaponClass, string> = {
  "A2A-ARH": "Fox-3 (Active Radar)",
  "A2A-SARH": "Fox-1 (Semi-Active Radar)",
  "A2A-IR": "Fox-2 (Infrared)",
  "A2A-Other": "Other A2A Missile",
  SAM: "Surface-to-Air (SAM)",
  A2G: "Air-to-Ground (A2G)",
  Gun: "Gun Burst",
};
