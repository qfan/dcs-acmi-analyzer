/**
 * Point-mass jet with an energy-manoeuvrability model: no flight model, no autopilot simulation.
 *
 *   thrust T(M, ρ)   drag D = q·S·(cd0(M) + k·CL²),  CL = n·W / (q·S)
 *   dV/dt = (T − D)/m − g·sin γ            level turn rate ω = g·tan(bank) / V,  n = 1/cos(bank)
 *   available g = min(g limit for the chosen effort, clMax(M)·q·S / W)
 *
 * So hard turns bleed speed through induced drag, thin air gives less lift and thrust, and the
 * turn rate falls off at both low and high speed.
 *
 * Vertical: a 3-DOF point mass in wind axes. Lift splits into a horizontal part (turning) and a
 * vertical part (holding γ against gravity, starting and ending climbs and dives), and the total
 * stays inside the g available. An altitude-hold autopilot flies to the ordered altitude:
 *   dV/dt = (T − D)/m − g·sin γ     dγ/dt = (L_v − g·cos γ)/V     dψ/dt = L_h/(V·cos γ)
 * so a climb trades speed for height and a dive buys speed back: energy height Es = h + V²/2g
 * changes only by (T − D)·V/W. The turn effort sets how steeply it climbs (Hold Spd: only on
 * excess power, so Mach is held).
 */
import { airDensity, DEG, FT, G, interp, KT, RHO0, speedOfSoundMs, tasFromCas } from "./atmosphere.ts";
import type { AircraftParams } from "./params.ts";
import { headingVec, type V3, wrap2Pi, wrapPi } from "./vec.ts";

export type Side = "blue" | "red";
export type Throttle = "idle" | "mil" | "ab";
export type Effort = "sustain" | "normal" | "max";

/**
 * What the pilot asks for. "heading" holds a compass heading. "relative" keeps a threat at a fixed
 * angle off the nose and keeps adjusting as the geometry changes: 0° hot, ~50° crank, 180° cold.
 * "notch" holds a 90° beam heading and periodically re-aligns against the threat's sensor bearing.
 * dir +1 turns right (threat ends up on the left), −1 turns left.
 */
export type Steer =
  | { mode: "heading"; hdg: number }
  | {
      mode: "relative";
      threatId: string;
      offsetDeg: number;
      dir: 1 | -1;
      label: string;
      /** Last commanded heading (rad) from RWR, held across brief missile RWR drop-outs. */
      lastHdg?: number;
    }
  | {
      mode: "notch";
      threatId: string;
      dir: 1 | -1;
      label: string;
      /** Locked-in heading (rad) held between periodic re-alignments. */
      hdg: number;
      /** Sim time of next periodic re-alignment check. */
      nextAlignAt: number;
    };

export interface Jet {
  id: string;
  side: Side;
  callsign: string;
  /** Initial spawn position (m), used for out-of-bounds loss checks. */
  startPos: V3;
  /** Position (m): x east, y north, z altitude MSL. */
  pos: V3;
  /** Altitude (m) the altitude-hold autopilot flies to. */
  altCmd: number;
  /** Heading (rad, clockwise from north), flight-path angle (rad), true airspeed (m/s). */
  hdg: number;
  gamma: number;
  speed: number;
  /** Bank angle (rad, right wing down positive) and current load factor. */
  bank: number;
  g: number;
  throttle: Throttle;
  effort: Effort;
  steer: Steer;
  alive: boolean;
  missiles: number;
  /** Chaff bundles and flares left (set by the scenario from the countermeasure parameters). */
  chaff: number;
  flares: number;
  /** Contact this jet's radar is told to track and shoot at. */
  targetId: string | null;
}

export function makeJet(
  p: AircraftParams,
  init: {
    id: string;
    side: Side;
    callsign: string;
    x: number;
    y: number;
    altM: number;
    hdgDeg: number;
    mach: number;
  },
): Jet {
  const hdg = init.hdgDeg * DEG;
  return {
    id: init.id,
    side: init.side,
    callsign: init.callsign,
    startPos: { x: init.x, y: init.y, z: init.altM },
    pos: { x: init.x, y: init.y, z: init.altM },
    altCmd: init.altM,
    hdg,
    gamma: 0,
    speed: init.mach * speedOfSoundMs(init.altM),
    bank: 0,
    g: 1,
    throttle: "mil",
    effort: "normal",
    steer: { mode: "heading", hdg },
    alive: true,
    missiles: Math.max(0, Math.round(p.missiles)),
    chaff: 0,
    flares: 0,
    targetId: null,
  };
}

export const velocity = (j: Jet): V3 => {
  const u = headingVec(j.hdg, j.gamma);
  return { x: u.x * j.speed, y: u.y * j.speed, z: u.z * j.speed };
};

export const mach = (j: Jet): number => j.speed / speedOfSoundMs(j.pos.z);

const AIRCRAFT_LUT_MAX_M = 30000;
const AIRCRAFT_LUT_STEP_M = 100;
const AIRCRAFT_LUT_INV_STEP = 1 / AIRCRAFT_LUT_STEP_M;
const AIRCRAFT_LUT_COUNT = AIRCRAFT_LUT_MAX_M / AIRCRAFT_LUT_STEP_M;
const MAX_LUT_CACHE = 16;

function sampleAltLut(lut: Float64Array, altM: number): number {
  if (altM <= 0) return lut[0] as number;
  if (altM >= AIRCRAFT_LUT_MAX_M) return lut[AIRCRAFT_LUT_COUNT] as number;
  const scaled = altM * AIRCRAFT_LUT_INV_STEP;
  const i = scaled | 0;
  if (i >= AIRCRAFT_LUT_COUNT) return lut[AIRCRAFT_LUT_COUNT] as number;
  const y0 = lut[i] as number;
  return y0 + ((lut[i + 1] as number) - y0) * (scaled - i);
}

const thrustDensityCache = new Map<number, Float64Array>();
let lastThrustExp = Number.NaN;
let lastThrustLut: Float64Array | null = null;

function thrustDensityFactor(exp: number, altM: number): number {
  if (exp === 0) return 1;
  let lut = exp === lastThrustExp ? lastThrustLut : null;
  if (!lut) {
    lut = thrustDensityCache.get(exp) ?? null;
    if (!lut) {
      lut = new Float64Array(AIRCRAFT_LUT_COUNT + 1);
      for (let i = 0; i <= AIRCRAFT_LUT_COUNT; i++) {
        lut[i] = (airDensity(i * AIRCRAFT_LUT_STEP_M) / RHO0) ** exp;
      }
      if (thrustDensityCache.size >= MAX_LUT_CACHE) {
        const oldest = thrustDensityCache.keys().next().value;
        if (oldest !== undefined) thrustDensityCache.delete(oldest);
      }
      thrustDensityCache.set(exp, lut);
    }
    lastThrustExp = exp;
    lastThrustLut = lut;
  }
  return sampleAltLut(lut, altM);
}

export function thrustN(p: AircraftParams, throttle: Throttle, altM: number, m: number): number {
  const base = throttle === "ab" ? p.abThrustKn : throttle === "mil" ? p.milThrustKn : p.idleThrustKn;
  return base * 1000 * thrustDensityFactor(p.thrustDensityExp, altM) * (1 + p.thrustMachGain * m);
}

function sustainedGAt(
  p: AircraftParams,
  altM: number,
  speed: number,
  throttle: Throttle,
  gamma: number,
): number {
  const m = speed / speedOfSoundMs(altM);
  const qS = 0.5 * airDensity(altM) * speed * speed * p.wingAreaM2;
  const weight = p.massKg * G;
  const d0 = qS * interp(p.tableMach, p.cd0, m);
  const kTerm = (p.inducedK * weight * weight) / Math.max(qS, 1);
  const tAvail = thrustN(p, throttle, altM, m) - weight * Math.sin(gamma);
  return tAvail > d0 ? Math.sqrt((tAvail - d0) / Math.max(kTerm, 1e-6)) : 1;
}

/** Load factor at which thrust equals drag (zero energy bleed: dV/dt = 0) at the current state. */
export function sustainedG(p: AircraftParams, j: Pick<Jet, "pos" | "speed" | "throttle" | "gamma">): number {
  return sustainedGAt(p, j.pos.z, j.speed, j.throttle, j.gamma);
}

/** Load factor available right now for an effort level (lift-, thrust-, or g-limited, at least 1). */
export function availableG(
  p: AircraftParams,
  j: Pick<Jet, "pos" | "speed" | "throttle" | "gamma">,
  effort: Effort,
): number {
  const m = j.speed / speedOfSoundMs(j.pos.z);
  const q = 0.5 * airDensity(j.pos.z) * j.speed * j.speed;
  const liftG = (interp(p.tableMach, p.clMax, m) * q * p.wingAreaM2) / (p.massKg * G);
  // Hold Spd turns as if level while climbing: the turn comes first, and the climb only gets the
  // power the turn leaves over (see climbLimits). Diving, gravity helps hold the speed.
  if (effort === "sustain")
    return Math.max(
      1,
      Math.min(p.gLimit, liftG, sustainedGAt(p, j.pos.z, j.speed, j.throttle, Math.min(0, j.gamma))),
    );
  return Math.max(1, Math.min(effort === "max" ? p.gLimit : p.normalG, liftG));
}

/** Drag (N) at a load factor. */
export function dragN(p: AircraftParams, altM: number, speed: number, n: number): number {
  const m = speed / speedOfSoundMs(altM);
  const qS = 0.5 * airDensity(altM) * speed * speed * p.wingAreaM2;
  const cl = (n * p.massKg * G) / Math.max(qS, 1);
  return qS * (interp(p.tableMach, p.cd0, m) + p.inducedK * cl * cl);
}

interface MinSpeedCacheEntry {
  minSpeedKt: number;
  massKg: number;
  wingAreaM2: number;
  tableMach: readonly number[];
  clMax: readonly number[];
  lut: Float64Array;
}

const minSpeedByParams = new WeakMap<AircraftParams, MinSpeedCacheEntry>();
const minSpeedByValue = new Map<string, Float64Array>();
let lastMinSpdRef: AircraftParams | null = null;
let lastMinSpdEntry: MinSpeedCacheEntry | null = null;

function computeMinSpeedMs(p: AircraftParams, altM: number): number {
  const rho = Math.max(airDensity(altM), 1e-4);
  const iasFloor = tasFromCas(p.minSpeedKt * KT, altM);
  const m = iasFloor / speedOfSoundMs(altM);
  const cl1g = Math.max(interp(p.tableMach, p.clMax, m), 0.1);
  const stall1g = Math.sqrt((2 * p.massKg * G) / (rho * Math.max(p.wingAreaM2, 1) * cl1g));
  return Math.max(1, iasFloor, stall1g);
}

function minSpeedMatches(e: MinSpeedCacheEntry, p: AircraftParams): boolean {
  return (
    e.minSpeedKt === p.minSpeedKt &&
    e.massKg === p.massKg &&
    e.wingAreaM2 === p.wingAreaM2 &&
    e.tableMach === p.tableMach &&
    e.clMax === p.clMax
  );
}

/** Minimum true airspeed (m/s) at `altM`: respects minSpeedKt as calibrated airspeed and stays >= 1g stall speed. */
export function minSpeedMs(p: AircraftParams, altM: number): number {
  let entry = lastMinSpdRef === p ? lastMinSpdEntry : null;
  if (!entry || !minSpeedMatches(entry, p)) {
    const cached = minSpeedByParams.get(p);
    if (cached && minSpeedMatches(cached, p)) {
      entry = cached;
    } else {
      const key = `${p.minSpeedKt}|${p.massKg}|${p.wingAreaM2}|${p.tableMach.join(",")}|${p.clMax.join(",")}`;
      let lut = minSpeedByValue.get(key);
      if (!lut) {
        lut = new Float64Array(AIRCRAFT_LUT_COUNT + 1);
        for (let i = 0; i <= AIRCRAFT_LUT_COUNT; i++) {
          lut[i] = computeMinSpeedMs(p, i * AIRCRAFT_LUT_STEP_M);
        }
        if (minSpeedByValue.size >= MAX_LUT_CACHE) {
          const oldest = minSpeedByValue.keys().next().value;
          if (oldest !== undefined) minSpeedByValue.delete(oldest);
        }
        minSpeedByValue.set(key, lut);
      }
      entry = {
        minSpeedKt: p.minSpeedKt,
        massKg: p.massKg,
        wingAreaM2: p.wingAreaM2,
        tableMach: p.tableMach,
        clMax: p.clMax,
        lut,
      };
      minSpeedByParams.set(p, entry);
    }
    lastMinSpdRef = p;
    lastMinSpdEntry = entry;
  }
  return sampleAltLut(entry.lut, altM);
}

/** Specific excess power (m/s) at a load factor: positive means the jet gains energy. */
export function specificExcessPower(p: AircraftParams, j: Jet, n: number): number {
  const t = thrustN(p, j.throttle, j.pos.z, mach(j));
  return (j.speed * (t - dragN(p, j.pos.z, j.speed, n))) / (p.massKg * G);
}

/** Heading the steering mode asks for, given where the threat is. */
export function desiredHeading(j: Jet, threatPos: V3 | null): number {
  const s = j.steer;
  if (s.mode === "heading" || s.mode === "notch") return s.hdg;
  if (!threatPos) return s.lastHdg ?? j.hdg;
  const brg = Math.atan2(threatPos.x - j.pos.x, threatPos.y - j.pos.y);
  return wrap2Pi(brg + s.dir * s.offsetDeg * DEG);
}

/** Heading gain: desired turn rate per radian of heading error (1/s). */
const HEADING_GAIN = 1.5;
/** Altitude hold: wanted vertical speed per metre of altitude error (1/s). */
const ALT_GAIN = 0.08;
/** Flight-path angle gain: wanted γ rate per radian of γ error (1/s). */
const GAMMA_GAIN = 1.2;
/** Share of the g above 1 that pitching (starting or ending a climb or dive) may use; the rest stays for turning. */
const PITCH_G_SHARE = 0.6;
/** Low-speed protection: full climb angle above CLIMB_FULL × minimum speed, no climbing below CLIMB_NONE ×. */
const CLIMB_NONE = 1.15;
const CLIMB_FULL = 1.6;
/**
 * Change of true airspeed per metre of climb at constant Mach (1/s): the speed of sound falls with
 * temperature in the troposphere and is constant above 11 km.
 */
function machHoldDvDh(altM: number, speed: number): number {
  const dadh = (speedOfSoundMs(altM + 50) - speedOfSoundMs(altM - 50)) / 100;
  return (speed / speedOfSoundMs(altM)) * dadh;
}

/** Hold Spd dives no steeper than this (deg). */
const SUSTAIN_DIVE_DEG = 10;
/** γ never goes beyond this (rad): no loops. */
const GAMMA_MAX = 70 * DEG;

/** Lowest (hard deck) and highest altitude (m) a jet can be ordered to. */
export function altLimitsM(p: AircraftParams): { min: number; max: number } {
  const min = Math.max(0, p.minAltFt) * FT;
  return { min, max: Math.max(min, p.ceilingFt * FT) };
}

export const clampAltCmd = (p: AircraftParams, altM: number): number => {
  const { min, max } = altLimitsM(p);
  return Math.max(min, Math.min(max, altM));
};

/**
 * Steepest climb and dive (rad, both ≥ 0) the autopilot flies right now. Hold Spd climbs only as
 * steeply as excess power allows while holding Mach: (T − D)/W = sin γ · (1 + V·(dV/dh)_M / g), so
 * below 11 km the slight fall in true airspeed at constant Mach goes into height too.
 * Climbs fade out near minimum speed (a zoom tops out instead of stalling); dives are never refused.
 */
export function climbLimits(
  p: AircraftParams,
  j: Pick<Jet, "pos" | "speed" | "throttle" | "g" | "bank">,
  effort: Effort,
): { up: number; down: number } {
  const angle = (effort === "max" ? p.maxClimbDeg : p.normalClimbDeg) * DEG;
  let up = angle;
  let down = angle;
  if (effort === "sustain") {
    // Excess power left after the current turn (its horizontal load only, not the brief pull of
    // starting or ending the climb): turning hard leaves nothing to climb with.
    const weight = Math.max(p.massKg, 1) * G;
    const t = thrustN(p, j.throttle, j.pos.z, j.speed / speedOfSoundMs(j.pos.z));
    const turnG = j.g * Math.sin(j.bank);
    const nTurn = Math.sqrt(1 + turnG * turnG);
    const share = 1 + (j.speed * machHoldDvDh(j.pos.z, j.speed)) / G;
    const sinG = (t - dragN(p, j.pos.z, j.speed, nTurn)) / weight / Math.max(share, 0.5);
    up = Math.asin(Math.max(0, Math.min(Math.sin(angle), sinG)));
    down = Math.min(angle, SUSTAIN_DIVE_DEG * DEG);
  }
  const f = (j.speed / minSpeedMs(p, j.pos.z) - CLIMB_NONE) / (CLIMB_FULL - CLIMB_NONE);
  up *= Math.max(0, Math.min(1, f));
  return { up, down };
}

/** Energy height Es = h + V²/2g (m): the altitude the jet could zoom to by trading all its speed. */
export const energyHeightM = (j: Pick<Jet, "pos" | "speed">): number =>
  j.pos.z + (j.speed * j.speed) / (2 * G);

/** Vertical speed (m/s, up positive). */
export const verticalSpeed = (j: Pick<Jet, "speed" | "gamma">): number => j.speed * Math.sin(j.gamma);

export function stepJet(p: AircraftParams, j: Jet, desiredHdg: number, dt: number): void {
  if (!j.alive) return;
  const v = Math.max(j.speed, 1);
  const cosG = Math.cos(j.gamma);
  const aMax = availableG(p, j, j.effort) * G;

  // Vertical: altitude error → wanted vertical speed (inside the climb/dive limits) → wanted γ →
  // vertical lift. Level flight needs exactly 1 g·cos γ of it.
  const lim = climbLimits(p, j, j.effort);
  const vzWant = Math.max(
    -v * Math.sin(lim.down),
    Math.min(v * Math.sin(lim.up), ALT_GAIN * (j.altCmd - j.pos.z)),
  );
  const gammaWant = Math.asin(Math.max(-1, Math.min(1, vzWant / v)));
  const pitchBudget = Math.max(0.5 * G, PITCH_G_SHARE * (aMax - G));
  const pitchAccel = Math.max(-pitchBudget, Math.min(pitchBudget, GAMMA_GAIN * (gammaWant - j.gamma) * v));
  const lv = Math.max(-G, Math.min(aMax, G * cosG + pitchAccel));

  // Horizontal: heading error → wanted turn rate → horizontal lift, with the g left over.
  const err = wrapPi(desiredHdg - j.hdg);
  const lhMax = Math.sqrt(Math.max(0, aMax * aMax - lv * lv));
  const lhWant = Math.max(-lhMax, Math.min(lhMax, HEADING_GAIN * err * v * Math.max(cosG, 0.2)));
  let lh: number;
  if (lv > 0.2 * G) {
    // Roll onset: bank (the angle of the lift vector) changes at most at the roll rate.
    const bankMax = Math.atan2(lhMax, lv);
    const wantBank = Math.atan2(lhWant, lv);
    const rollStep = p.rollRateDegS * DEG * dt;
    let bank = j.bank + Math.max(-rollStep, Math.min(rollStep, wantBank - j.bank));
    bank = Math.max(-bankMax, Math.min(bankMax, bank));
    lh = lv * Math.tan(bank);
  } else {
    // Unloaded (pushing over): little lift to point, so the turn simply follows.
    lh = lhWant;
  }
  // Bank is the lift vector's angle from vertical; pushing below 0 g must not read as inverted
  // (atan2 would give 180°, and the roll logic would turn that into a turn nobody asked for).
  j.bank = Math.atan2(lh, Math.max(lv, 0.01));
  j.g = Math.sqrt(lh * lh + lv * lv) / G;
  j.hdg = (j.hdg + (lh / (v * Math.max(cosG, 0.2))) * dt + 2 * Math.PI) % (2 * Math.PI);
  j.gamma = Math.max(-GAMMA_MAX, Math.min(GAMMA_MAX, j.gamma + ((lv - G * cosG) / v) * dt));

  const m = mach(j);
  const mass = Math.max(p.massKg, 1);
  const accel =
    (thrustN(p, j.throttle, j.pos.z, m) - dragN(p, j.pos.z, j.speed, j.g)) / mass - G * Math.sin(j.gamma);
  j.speed = Math.max(minSpeedMs(p, j.pos.z), j.speed + accel * dt);

  const u = headingVec(j.hdg, j.gamma);
  j.pos.x += u.x * j.speed * dt;
  j.pos.y += u.y * j.speed * dt;
  j.pos.z += u.z * j.speed * dt;
}
