/**
 * Every tunable number of the game, in one place. These are "good enough" estimates in the
 * neighbourhood of what the analyzer measures for the F/A-18C and AIM-120C in DCS. They are meant to
 * be edited: in source here, or by the player in the in-game parameter editor (saved per browser).
 * If a DCS update changes the missile a lot, re-run the analyzer on fresh recordings and update the
 * defaults below.
 */

export interface AircraftParams {
  name: string;
  /** Combat weight (kg). */
  massKg: number;
  wingAreaM2: number;
  /** Flight-control / structural g limit ("max performance" turns). */
  gLimit: number;
  /** g used for "normal" turns. */
  normalG: number;
  /** Mach breakpoints for the clMax and cd0 tables. */
  tableMach: number[];
  /** Maximum usable lift coefficient per Mach breakpoint (lift-limited g = clMax·q·S / W). */
  clMax: number[];
  /** Zero-lift drag coefficient per Mach breakpoint (includes stores). */
  cd0: number[];
  /** Induced drag factor: CDi = k · CL². */
  inducedK: number;
  /** Sea-level static thrust, both engines (kN). */
  idleThrustKn: number;
  milThrustKn: number;
  abThrustKn: number;
  /** Thrust grows by this fraction per Mach (ram effect). */
  thrustMachGain: number;
  /** Thrust scales with (ρ/ρ0) to this power. */
  thrustDensityExp: number;
  rollRateDegS: number;
  /** The jet never slows below this (no stall model). */
  minSpeedKt: number;
  /** AIM-120s carried. */
  missiles: number;
}

export interface MissileParams {
  name: string;
  /** Rocket motor: boost phase length (s) and thrust acceleration (m/s²). */
  boostTimeS: number;
  boostAccel: number;
  /** Optional sustain phase after the boost. */
  sustainTimeS: number;
  sustainAccel: number;
  /** Drag table: a_drag = cd(M) · ρ · v² · dragScale. cd in 1/m at these Mach numbers. */
  dragMach: number[];
  dragCd: number[];
  /** Overall drag multiplier: the quickest knob for "the missile is too hot / too lazy". */
  dragScale: number;
  /** Induced drag: a = ci · L² / (ρ v²), L = lateral acceleration. Turning costs energy. */
  inducedCi: number;
  /** Lift limit: L ≤ liftK · ρ · v², and never above maxG. */
  liftK: number;
  maxG: number;
  /** Proportional navigation constant in the terminal phase. */
  navConstant: number;
  /** Midcourse steering: straight at the target estimate, or at a predicted intercept point. */
  midcourse: "pursuit" | "lead";
  /** Missile goes active when its own estimate of range to target is this close (nm). */
  pitbullRangeNm: number;
  /** Seeker: detection range (nm), search cone half-angle around the expected target (deg), gimbal limit (deg). */
  seekerRangeNm: number;
  seekerSearchDeg: number;
  seekerGimbalDeg: number;
  /** Proximity fuze radius (m) and chance that a fuzed hit kills. */
  fuzeRadiusM: number;
  pk: number;
  /**
   * The missile flies on until this long after launch, or until its true airspeed drops below
   * minSpeedKt (true, not indicated, so thin air at altitude does not end it early).
   */
  maxTofS: number;
  minSpeedKt: number;
  /**
   * Launch-zone readouts (Rmax / Rne) count a shot only if it arrives at least this fast: a
   * "likely lethal" range, shorter than how far the missile can fly at all.
   */
  lethalMach: number;
  /** Loft: apex gain over launch altitude (ft) vs launch range (nm). */
  loft: boolean;
  loftRangeNm: number[];
  loftGainFt: number[];
  loftClimbDeg: number;
  /** Loft ends (dive starts) once the target estimate is this far below the horizon (deg). */
  loftDiveDeg: number;
}

export interface RadarParams {
  /** Radar scan limit either side of the nose (deg), for both detecting and locking. */
  gimbalDeg: number;
  /**
   * Detection range against a fighter (nm): inside it (and the gimbal) the radar sees the target,
   * which shows it to you under fog of war and shows the scan on the target's RWR.
   */
  detectRangeNm: number;
  /**
   * TWS lock range (nm), the only lock in this game: needed to fire and for a missile's datalink.
   * Kept long so lofted long-range shots are possible.
   */
  rangeNm: number;
}

export interface CountermeasureParams {
  /** Chaff bundles and flares per jet. Releasing them does not affect missiles or radars yet. */
  chaff: number;
  flares: number;
}

export interface GameParams {
  aircraft: AircraftParams;
  missile: MissileParams;
  radar: RadarParams;
  countermeasures: CountermeasureParams;
}

export const DEFAULT_AIRCRAFT: AircraftParams = {
  name: "F/A-18C",
  massKg: 16000,
  wingAreaM2: 37.16,
  gLimit: 7.5,
  normalG: 4,
  tableMach: [0, 0.5, 0.7, 0.9, 1.1, 1.5, 2.0],
  clMax: [2.0, 2.0, 1.6, 1.2, 1.0, 0.8, 0.7],
  cd0: [0.024, 0.024, 0.025, 0.03, 0.05, 0.052, 0.05],
  inducedK: 0.18,
  idleThrustKn: 8,
  milThrustKn: 98,
  abThrustKn: 158,
  thrustMachGain: 0.2,
  thrustDensityExp: 0.9,
  rollRateDegS: 180,
  minSpeedKt: 130,
  missiles: 4,
};

/** AIM-120C, close to the analyzer's fit of the bundled sample pack (rounded). */
export const DEFAULT_MISSILE: MissileParams = {
  name: "AIM-120C",
  boostTimeS: 7,
  boostAccel: 146,
  sustainTimeS: 0,
  sustainAccel: 0,
  dragMach: [0.6, 1.05, 1.4, 1.9, 2.6, 3.5],
  dragCd: [6.3e-5, 8.7e-5, 9.4e-5, 8.2e-5, 6.8e-5, 5.8e-5],
  dragScale: 1,
  inducedCi: 500,
  liftK: 9.5e-4,
  maxG: 40,
  navConstant: 4,
  midcourse: "pursuit",
  pitbullRangeNm: 10,
  seekerRangeNm: 10,
  seekerSearchDeg: 10,
  seekerGimbalDeg: 60,
  fuzeRadiusM: 15,
  pk: 1,
  maxTofS: 120,
  minSpeedKt: 200,
  lethalMach: 0.9,
  loft: true,
  loftRangeNm: [10, 15, 25, 35, 50],
  loftGainFt: [0, 2800, 9600, 15400, 20000],
  loftClimbDeg: 25,
  loftDiveDeg: 40,
};

export const DEFAULT_RADAR: RadarParams = {
  gimbalDeg: 60,
  detectRangeNm: 80,
  rangeNm: 70,
};

export const DEFAULT_COUNTERMEASURES: CountermeasureParams = {
  chaff: 60,
  flares: 30,
};

export const DEFAULT_PARAMS: GameParams = {
  aircraft: DEFAULT_AIRCRAFT,
  missile: DEFAULT_MISSILE,
  radar: DEFAULT_RADAR,
  countermeasures: DEFAULT_COUNTERMEASURES,
};

export function cloneParams(p: GameParams): GameParams {
  return structuredClone(p);
}

/**
 * Overlays a (possibly partial or outdated) saved object onto the defaults, keeping only keys that
 * exist in the defaults and whose type matches. Unknown or broken values fall back to the default.
 */
export function mergeParams(saved: unknown): GameParams {
  const out = cloneParams(DEFAULT_PARAMS);
  if (!saved || typeof saved !== "object") return out;
  for (const group of ["aircraft", "missile", "radar", "countermeasures"] as const) {
    const src = (saved as Record<string, unknown>)[group];
    if (!src || typeof src !== "object") continue;
    const dst = out[group] as unknown as Record<string, unknown>;
    for (const [k, def] of Object.entries(dst)) {
      const v = (src as Record<string, unknown>)[k];
      if (v === undefined) continue;
      if (typeof def === "number" && typeof v === "number" && Number.isFinite(v)) dst[k] = v;
      else if (typeof def === "boolean" && typeof v === "boolean") dst[k] = v;
      else if (typeof def === "string" && typeof v === "string") dst[k] = v;
      else if (
        Array.isArray(def) &&
        Array.isArray(v) &&
        v.length === def.length &&
        v.every((x) => typeof x === "number" && Number.isFinite(x))
      )
        dst[k] = [...v];
    }
  }
  if (out.missile.midcourse !== "pursuit" && out.missile.midcourse !== "lead")
    out.missile.midcourse = "pursuit";
  return out;
}

/** Description of each editable field, for the in-game parameter editor. */
export type ParamField =
  | { group: keyof GameParams; key: string; label: string; unit?: string; kind: "number"; step?: number }
  | { group: keyof GameParams; key: string; label: string; unit?: string; kind: "numbers" }
  | { group: keyof GameParams; key: string; label: string; kind: "bool" }
  | { group: keyof GameParams; key: string; label: string; kind: "select"; options: string[] };

export const PARAM_FIELDS: ParamField[] = [
  { group: "missile", key: "boostTimeS", label: "Motor burn time", unit: "s", kind: "number", step: 0.5 },
  { group: "missile", key: "boostAccel", label: "Motor thrust acceleration", unit: "m/s²", kind: "number" },
  { group: "missile", key: "sustainTimeS", label: "Sustain burn time", unit: "s", kind: "number" },
  {
    group: "missile",
    key: "sustainAccel",
    label: "Sustain thrust acceleration",
    unit: "m/s²",
    kind: "number",
  },
  { group: "missile", key: "dragScale", label: "Drag multiplier", kind: "number", step: 0.05 },
  { group: "missile", key: "dragMach", label: "Drag table Mach", kind: "numbers" },
  { group: "missile", key: "dragCd", label: "Drag table cd", unit: "1/m", kind: "numbers" },
  { group: "missile", key: "inducedCi", label: "Turn (induced) drag factor", kind: "number" },
  { group: "missile", key: "liftK", label: "Lift limit factor", kind: "number", step: 0.0001 },
  { group: "missile", key: "maxG", label: "Max g", unit: "g", kind: "number" },
  {
    group: "missile",
    key: "midcourse",
    label: "Midcourse steering",
    kind: "select",
    options: ["pursuit", "lead"],
  },
  { group: "missile", key: "navConstant", label: "Terminal PN constant", kind: "number", step: 0.5 },
  { group: "missile", key: "pitbullRangeNm", label: "Goes active at", unit: "nm", kind: "number" },
  { group: "missile", key: "seekerRangeNm", label: "Seeker range", unit: "nm", kind: "number" },
  {
    group: "missile",
    key: "seekerSearchDeg",
    label: "Seeker search cone (half-angle)",
    unit: "°",
    kind: "number",
  },
  { group: "missile", key: "seekerGimbalDeg", label: "Seeker gimbal limit", unit: "°", kind: "number" },
  { group: "missile", key: "fuzeRadiusM", label: "Proximity fuze radius", unit: "m", kind: "number" },
  { group: "missile", key: "pk", label: "Kill chance when fuzed", unit: "0–1", kind: "number", step: 0.05 },
  { group: "missile", key: "maxTofS", label: "Self-destruct after", unit: "s", kind: "number" },
  {
    group: "missile",
    key: "minSpeedKt",
    label: "Self-destruct below (true airspeed)",
    unit: "kt",
    kind: "number",
  },
  {
    group: "missile",
    key: "lethalMach",
    label: "Launch zone: likely lethal if arriving above",
    unit: "Mach",
    kind: "number",
    step: 0.05,
  },
  { group: "missile", key: "loft", label: "Loft", kind: "bool" },
  { group: "missile", key: "loftRangeNm", label: "Loft table range", unit: "nm", kind: "numbers" },
  { group: "missile", key: "loftGainFt", label: "Loft table apex gain", unit: "ft", kind: "numbers" },
  { group: "missile", key: "loftClimbDeg", label: "Loft climb angle", unit: "°", kind: "number" },
  { group: "aircraft", key: "missiles", label: "Missiles per jet", kind: "number" },
  { group: "aircraft", key: "massKg", label: "Combat weight", unit: "kg", kind: "number" },
  { group: "aircraft", key: "gLimit", label: "g limit", unit: "g", kind: "number", step: 0.1 },
  { group: "aircraft", key: "normalG", label: "Normal turn g", unit: "g", kind: "number", step: 0.1 },
  { group: "aircraft", key: "milThrustKn", label: "MIL thrust (sea level)", unit: "kN", kind: "number" },
  {
    group: "aircraft",
    key: "abThrustKn",
    label: "Afterburner thrust (sea level)",
    unit: "kN",
    kind: "number",
  },
  { group: "aircraft", key: "tableMach", label: "Aero table Mach", kind: "numbers" },
  { group: "aircraft", key: "clMax", label: "Max lift coefficient", kind: "numbers" },
  { group: "aircraft", key: "cd0", label: "Zero-lift drag coefficient", kind: "numbers" },
  { group: "aircraft", key: "inducedK", label: "Induced drag factor", kind: "number", step: 0.01 },
  { group: "radar", key: "gimbalDeg", label: "Radar gimbal limit", unit: "°", kind: "number" },
  { group: "radar", key: "detectRangeNm", label: "Radar detection range", unit: "nm", kind: "number" },
  { group: "radar", key: "rangeNm", label: "TWS lock range (fire and datalink)", unit: "nm", kind: "number" },
  { group: "countermeasures", key: "chaff", label: "Chaff bundles per jet", kind: "number" },
  { group: "countermeasures", key: "flares", label: "Flares per jet", kind: "number" },
];
