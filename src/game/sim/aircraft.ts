/**
 * Point-mass jet with an energy-manoeuvrability model: no flight model, no autopilot simulation.
 *
 *   thrust T(M, ρ)   drag D = q·S·(cd0(M) + k·CL²),  CL = n·W / (q·S)
 *   dV/dt = (T − D)/m − g·sin γ            level turn rate ω = g·tan(bank) / V,  n = 1/cos(bank)
 *   available g = min(g limit for the chosen effort, clMax(M)·q·S / W)
 *
 * So hard turns bleed speed through induced drag, thin air gives less lift and thrust, and the
 * turn rate falls off at both low and high speed. Altitude is held constant for now (γ = 0); the
 * state already carries γ for the later climb/dive phase.
 */
import { airDensity, DEG, G, interp, KT, RHO0, speedOfSoundMs } from "./atmosphere.ts";
import type { AircraftParams } from "./params.ts";
import { headingVec, type V3, wrapPi } from "./vec.ts";

export type Side = "blue" | "red";
export type Throttle = "idle" | "mil" | "ab";
export type Effort = "sustain" | "normal" | "max";

/**
 * What the pilot asks for. "heading" holds a compass heading. "relative" keeps a threat at a fixed
 * angle off the nose and keeps adjusting as the geometry changes: 0° hot, ~50° crank, 90° notch
 * (beam), 180° cold. dir +1 turns right (threat ends up on the left), −1 turns left.
 */
export type Steer =
  | { mode: "heading"; hdg: number }
  | { mode: "relative"; threatId: string; offsetDeg: number; dir: 1 | -1; label: string };

export interface Jet {
  id: string;
  side: Side;
  callsign: string;
  /** Initial spawn position (m), used for out-of-bounds loss checks. */
  startPos: V3;
  /** Position (m): x east, y north, z altitude MSL. */
  pos: V3;
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

export function thrustN(p: AircraftParams, throttle: Throttle, altM: number, m: number): number {
  const base = throttle === "ab" ? p.abThrustKn : throttle === "mil" ? p.milThrustKn : p.idleThrustKn;
  const sigma = airDensity(altM) / RHO0;
  return base * 1000 * sigma ** p.thrustDensityExp * (1 + p.thrustMachGain * m);
}

/** Load factor at which thrust equals drag (zero energy bleed: dV/dt = 0) at the current state. */
export function sustainedG(p: AircraftParams, j: Pick<Jet, "pos" | "speed" | "throttle" | "gamma">): number {
  const m = j.speed / speedOfSoundMs(j.pos.z);
  const qS = 0.5 * airDensity(j.pos.z) * j.speed * j.speed * p.wingAreaM2;
  const weight = p.massKg * G;
  const d0 = qS * interp(p.tableMach, p.cd0, m);
  const kTerm = (p.inducedK * weight * weight) / Math.max(qS, 1);
  const tAvail = thrustN(p, j.throttle, j.pos.z, m) - weight * Math.sin(j.gamma);
  return tAvail > d0 ? Math.sqrt((tAvail - d0) / Math.max(kTerm, 1e-6)) : 1;
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
  if (effort === "sustain") return Math.max(1, Math.min(p.gLimit, liftG, sustainedG(p, j)));
  return Math.max(1, Math.min(effort === "max" ? p.gLimit : p.normalG, liftG));
}

/** Drag (N) at a load factor. */
export function dragN(p: AircraftParams, altM: number, speed: number, n: number): number {
  const m = speed / speedOfSoundMs(altM);
  const qS = 0.5 * airDensity(altM) * speed * speed * p.wingAreaM2;
  const cl = (n * p.massKg * G) / Math.max(qS, 1);
  return qS * (interp(p.tableMach, p.cd0, m) + p.inducedK * cl * cl);
}

/** Minimum true airspeed (m/s) at `altM`: respects minSpeedKt as IAS and stays >= 1g stall speed. */
export function minSpeedMs(p: AircraftParams, altM: number): number {
  const rho = Math.max(airDensity(altM), 1e-4);
  const sigma = rho / RHO0;
  const iasFloor = (p.minSpeedKt * KT) / Math.sqrt(sigma);
  const m = iasFloor / speedOfSoundMs(altM);
  const cl1g = Math.max(interp(p.tableMach, p.clMax, m), 0.1);
  const stall1g = Math.sqrt((2 * p.massKg * G) / (rho * Math.max(p.wingAreaM2, 1) * cl1g));
  return Math.max(1, iasFloor, stall1g);
}

/** Specific excess power (m/s) at a load factor: positive means the jet gains energy. */
export function specificExcessPower(p: AircraftParams, j: Jet, n: number): number {
  const t = thrustN(p, j.throttle, j.pos.z, mach(j));
  return (j.speed * (t - dragN(p, j.pos.z, j.speed, n))) / (p.massKg * G);
}

/** Heading the steering mode asks for, given where the threat is. */
export function desiredHeading(j: Jet, threatPos: V3 | null): number {
  const s = j.steer;
  if (s.mode === "heading" || !threatPos) return s.mode === "heading" ? s.hdg : j.hdg;
  const brg = Math.atan2(threatPos.x - j.pos.x, threatPos.y - j.pos.y);
  return brg + s.dir * s.offsetDeg * DEG;
}

/** Heading gain: desired turn rate per radian of heading error (1/s). */
const HEADING_GAIN = 1.5;

export function stepJet(p: AircraftParams, j: Jet, desiredHdg: number, dt: number): void {
  if (!j.alive) return;
  const err = wrapPi(desiredHdg - j.hdg);
  const nAvail = availableG(p, j, j.effort);
  const bankMax = Math.acos(1 / nAvail);
  // Bank needed for the turn rate we want, limited by the g available.
  const wantRate = HEADING_GAIN * err;
  let wantBank = Math.atan((wantRate * j.speed) / G);
  wantBank = Math.max(-bankMax, Math.min(bankMax, wantBank));
  const rollStep = p.rollRateDegS * DEG * dt;
  j.bank += Math.max(-rollStep, Math.min(rollStep, wantBank - j.bank));
  j.bank = Math.max(-bankMax, Math.min(bankMax, j.bank));
  j.g = 1 / Math.cos(j.bank);
  const turnRate = (G * Math.tan(j.bank)) / j.speed;
  j.hdg = (j.hdg + turnRate * dt + 2 * Math.PI) % (2 * Math.PI);

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
