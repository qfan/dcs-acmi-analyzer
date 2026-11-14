/**
 * Fits a small point-mass "energy budget" model per missile type from the flyout tracks of the loaded
 * recordings. Everything here is deterministic: the same recordings always give the same models.
 *
 * Along the coast phase (motor off), the aerodynamic acceleration along the flight path is
 *
 *   a_t = -cd(M) * rho * v^2  -  ci * L^2 / (rho * v^2)
 *
 * where L is the measured lift acceleration (how hard the missile is turning). `cd` is fitted per Mach
 * band and `ci` once, by robust (Huber) least squares over every coast sample of every shot. The motor
 * (boost and optional sustain), the loft habit (apex gain vs launch range) and the slowest speeds real
 * kills happened at come straight from the tracks.
 */
import { speedOfSoundMs } from "./atmosphere.ts";
import { type MissileEngagement, TRACK_STRIDE } from "./model.ts";

export const G = 9.80665;
export const FT_TO_M = 0.3048;
export const NM_TO_M = 1852;

/** Mach band edges for the drag table. */
export const MACH_BANDS = [0, 0.9, 1.2, 1.6, 2.2, 3.0, 9] as const;
export const MACH_BAND_COUNT = MACH_BANDS.length - 1;
/** Launch range bins (nm) for the loft table. */
export const LOFT_RANGE_BINS_NM: readonly [number, number][] = [
  [0, 10],
  [10, 20],
  [20, 30],
  [30, 40],
  [40, 60],
  [60, 120],
];

/** Tunable rules. Each is a judgement call, kept here so it is visible and testable. */
export const FIT_RULES = {
  /** Fewer shots than this and a missile gets no model. */
  minShots: 25,
  /** Fewer coast samples than this and the drag fit is not attempted. */
  minCoastSamples: 200,
  /** Samples are skipped this long after the motor stops and before the track ends (detonation, loss). */
  coastStartPadS: 1.5,
  coastEndPadS: 2.5,
  /** Late-phase window used to find when a sustain motor stops. */
  lateCoastFromS: 35,
  /** Median thrust above this (m/s²) in a 1 s bin means the motor is still burning. */
  motorOnAccel: 12,
  /** A loft bin needs this many co-altitude shots to count. */
  minLoftBinShots: 15,
  /** A missile "lofts" only if some trusted bin climbs at least this much (ft). */
  minLoftGainFt: 3000,
  /** Co-altitude means shooter and target within this (m) for the loft table. */
  loftCoAltM: 2000,
  /** Kills slower than this share of the slowest kills are ignored for the "still reaches you" speed. */
  reachKillQuantile: 0.1,
  /** Arriving at this Mach or more counts as dangerous to a defending target. */
  dangerousMach: 1.5,
  /** Sanity: supersonic drag below this fraction of transonic drag means the motor model missed thrust. */
  minSupersonicDragRatio: 0.5,
} as const;

export interface LoftBin {
  label: string;
  fromNm: number;
  toNm: number;
  shots: number;
  /** Median apex gain over launch altitude (ft). */
  medianGainFt: number;
}

export interface ReplayError {
  /** Shots replayed. */
  n: number;
  /** |predicted − recorded| speed at the end of the coast, in Mach. */
  medianMach: number;
  p90Mach: number;
  /** Same with a single drag value for all Mach numbers, for comparison. */
  flatDragMedianMach: number;
}

export interface MissileModel {
  /** Display name, e.g. "R-77" for Tacview's "P-77". */
  weapon: string;
  /** Raw weapon names that were grouped into this model. */
  rawNames: string[];
  shots: number;
  kills: number;
  coastSamples: number;
  /** Boost motor: until peak speed (s) at this thrust acceleration (m/s²). */
  boostS: number;
  boostAccel: number;
  /** Motor fully off (s); after boostS and before this a sustain motor gives sustainAccel. */
  motorEndS: number;
  sustainAccel: number;
  peakMach: number;
  /** Drag coefficient per Mach band, in 1/m (a = cd * rho * v²). */
  cd: number[];
  /** Induced drag factor (a = ci * L² / (rho v²)). */
  ci: number;
  /** Lift limit: L ≤ liftK * rho * v² (99th percentile of what the tracks show). */
  liftK: number;
  loft: LoftBin[];
  lofts: boolean;
  /** Arrival Mach of the slowest 10% of kills: slower than this it rarely kills anything. */
  reachMach: number;
  /** Median arrival Mach of kills. */
  killMachMedian: number | null;
  /** Longest flight time of any kill (s); extends the sim horizon past defaultMaxTofS if kills occur later. */
  maxKillTofS: number | null;
  replay: ReplayError;
  /** DCS patches (major.minor) and shot counts behind the model. */
  patches: Record<string, number>;
  /** "suspect" when the fit fails a sanity check; reason says why. */
  quality: "good" | "suspect";
  qualityNote: string | null;
}

const isaTemp = (h: number) => (h <= 11000 ? 288.15 - 0.0065 * h : 216.65);
/** ISA air density (kg/m³). */
export function airDensity(altM: number): number {
  const h = Math.max(0, Math.min(30000, altM));
  return h <= 11000 ? 1.225 * (isaTemp(h) / 288.15) ** 4.2559 : 0.36392 * Math.exp(-(h - 11000) / 6341.6);
}

export function machBand(mach: number): number {
  for (let i = 0; i < MACH_BAND_COUNT; i++) if (mach < MACH_BANDS[i + 1]!) return i;
  return MACH_BAND_COUNT - 1;
}

/** Groups Tacview weapon names into one model per missile variant, with a familiar display name. */
export function canonicalMissile(weaponName: string): string {
  const u = weaponName.toUpperCase().replace(/[_\s]/g, "-");
  if (/AIM-?120C/.test(u)) return "AIM-120C";
  if (/AIM-?120B/.test(u) || u === "AIM-120") return "AIM-120B";
  if (/AIM-?54/.test(u))
    return `${u.includes("54C") ? "AIM-54C" : "AIM-54A"}-${u.includes("MK60") ? "Mk60" : "Mk47"}`;
  if (/AIM-?7/.test(u)) {
    const m = u.match(/AIM-?7([A-Z]*)/);
    return `AIM-7${m?.[1] ? m[1] : "M"}`;
  }
  if (/SD-?10|PL-?12/.test(u)) return "SD-10";
  if (/R-?77|RVV|P-77/.test(u)) return "R-77";
  if (/27ER|P-27PE|R-27-?ER/.test(u)) return "R-27ER";
  if (/27ET|P-27TE/.test(u)) return "R-27ET";
  if (/P-27P$|R-27R/.test(u)) return "R-27R";
  if (/MICA/.test(u)) return "MICA-EM";
  if (/530D|M\.S530D/.test(u)) return "Super 530D";
  return weaponName;
}

function median(a: number[]): number {
  if (a.length === 0) return Number.NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)]!;
}
function quantile(a: number[], p: number): number {
  if (a.length === 0) return Number.NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
}

/** One resampled flyout point with its kinematics. */
interface KinPoint {
  t: number;
  v: number;
  h: number;
  /** Flight path angle (rad). */
  gam: number;
  /** Aerodynamic + thrust acceleration along the path (m/s²). */
  at: number;
  /** Lift acceleration magnitude (m/s²). */
  lift: number;
  mach: number;
  /** rho * v². */
  q: number;
}

/** Velocity and acceleration by central differences over ±1 s of the 0.5 s track. */
export function flyoutKinematics(e: MissileEngagement): (KinPoint | null)[] {
  const tr = e.track;
  if (!tr) return [];
  const { n, dt, data } = tr;
  const k = Math.max(1, Math.round(1 / dt));
  const pos = (i: number, c: number) => data[i * TRACK_STRIDE + c]!;
  const vel: ([number, number, number] | null)[] = [];
  for (let i = 0; i < n; i++) {
    if (i < k || i + k >= n) {
      vel.push(null);
      continue;
    }
    const v: [number, number, number] = [0, 0, 0];
    let ok = true;
    for (let c = 0; c < 3; c++) {
      const d = (pos(i + k, c) - pos(i - k, c)) / (2 * k * dt);
      if (!Number.isFinite(d)) ok = false;
      v[c] = d;
    }
    vel.push(ok ? v : null);
  }
  const out: (KinPoint | null)[] = [];
  for (let i = 0; i < n; i++) {
    const v0 = vel[i];
    const va = i - k >= 0 ? vel[i - k] : null;
    const vb = i + k < n ? vel[i + k] : null;
    if (!v0 || !va || !vb) {
      out.push(null);
      continue;
    }
    const acc = [0, 1, 2].map((c) => (vb[c]! - va[c]!) / (2 * k * dt)) as [number, number, number];
    acc[2] += G;
    const v = Math.hypot(v0[0], v0[1], v0[2]);
    if (v < 1) {
      out.push(null);
      continue;
    }
    const u = [v0[0] / v, v0[1] / v, v0[2] / v] as const;
    const at = acc[0] * u[0] + acc[1] * u[1] + acc[2] * u[2];
    const lift = Math.hypot(acc[0] - at * u[0], acc[1] - at * u[1], acc[2] - at * u[2]);
    const h = pos(i, 2);
    const rho = airDensity(h);
    out.push({
      t: i * dt,
      v,
      h,
      gam: Math.asin(Math.max(-1, Math.min(1, u[2]))),
      at,
      lift,
      mach: v / speedOfSoundMs(h),
      q: rho * v * v,
    });
  }
  return out;
}

/** Solves A x = b (small, dense) by Gaussian elimination with partial pivoting. */
function solveNormal(A: Float64Array[], b: Float64Array): number[] {
  const p = b.length;
  for (let i = 0; i < p; i++) A[i]![i]! += 1e-12 + A[i]![i]! * 1e-9;
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r;
    [A[c], A[piv]] = [A[piv]!, A[c]!];
    [b[c], b[piv]] = [b[piv]!, b[c]!];
    if (Math.abs(A[c]![c]!) < 1e-30) continue;
    for (let r = c + 1; r < p; r++) {
      const f = A[r]![c]! / A[c]![c]!;
      for (let j = c; j < p; j++) A[r]![j]! -= f * A[c]![j]!;
      b[r]! -= f * b[c]!;
    }
  }
  const x = new Array<number>(p).fill(0);
  for (let c = p - 1; c >= 0; c--) {
    let sum = b[c]!;
    for (let j = c + 1; j < p; j++) sum -= A[c]![j]! * x[j]!;
    x[c] = Math.abs(A[c]![c]!) < 1e-30 ? 0 : sum / A[c]![c]!;
  }
  return x;
}

/** Coast samples for the drag regression. Each row has two non-zero terms: q in its Mach band, and L²/q. */
export interface DragRows {
  band: Uint8Array;
  /** rho * v². */
  q: Float64Array;
  /** L² / (rho v²). */
  ind: Float64Array;
  /** Measured deceleration along the path (m/s²). */
  y: Float64Array;
  /** L / (rho v²), for the lift limit. */
  liftRatio: Float64Array;
}

/** Median of |residual| from at most ~40k evenly spaced rows (plenty for a scale estimate). */
function residualScale(res: Float64Array): number {
  const stride = Math.max(1, Math.floor(res.length / 40000));
  const sub = new Float64Array(Math.ceil(res.length / stride));
  for (let i = 0, j = 0; i < res.length; i += stride, j++) sub[j] = res[i]!;
  sub.sort();
  return sub[Math.floor(sub.length / 2)]! || 1;
}

/**
 * Huber-weighted least squares (IRLS) so detonations, track glitches and chaff jumps cannot drag the
 * fit. Returns [cd per Mach band..., ci], or with `flat` a single drag value for every Mach number.
 */
export function fitDrag(rows: DragRows, flat = false, iterations = 6): number[] {
  const n = rows.y.length;
  const p = flat ? 1 : MACH_BAND_COUNT + 1;
  const ci = MACH_BAND_COUNT;
  const w = new Float64Array(n).fill(1);
  const res = new Float64Array(n);
  let x = new Array<number>(p).fill(0);
  for (let it = 0; it < iterations; it++) {
    const A = Array.from({ length: p }, () => new Float64Array(p));
    const b = new Float64Array(p);
    for (let r = 0; r < n; r++) {
      const wr = w[r]!;
      const q = rows.q[r]!;
      const y = rows.y[r]!;
      if (flat) {
        A[0]![0]! += wr * q * q;
        b[0]! += wr * q * y;
        continue;
      }
      const k = rows.band[r]!;
      const d = rows.ind[r]!;
      A[k]![k]! += wr * q * q;
      A[k]![ci]! += wr * q * d;
      A[ci]![k]! += wr * q * d;
      A[ci]![ci]! += wr * d * d;
      b[k]! += wr * q * y;
      b[ci]! += wr * d * y;
    }
    x = solveNormal(A, b);
    for (let r = 0; r < n; r++) {
      const pred = flat ? x[0]! * rows.q[r]! : x[rows.band[r]!]! * rows.q[r]! + x[ci]! * rows.ind[r]!;
      res[r] = Math.abs(rows.y[r]! - pred);
    }
    const scale = 1.345 * 1.4826 * residualScale(res);
    for (let r = 0; r < n; r++) {
      const z = res[r]! / scale;
      w[r] = z <= 1 ? 1 : 1 / z;
    }
  }
  return x;
}

interface Shot {
  e: MissileEngagement;
  k: (KinPoint | null)[];
  tofS: number;
  peakAtS: number;
}

function dragRows(shots: Shot[], fromS: (s: Shot) => number): DragRows {
  const band: number[] = [];
  const q: number[] = [];
  const ind: number[] = [];
  const y: number[] = [];
  const liftRatio: number[] = [];
  for (const s of shots) {
    const t0 = fromS(s);
    const t1 = s.tofS - FIT_RULES.coastEndPadS;
    for (const p of s.k) {
      if (!p || p.t <= t0 || p.t >= t1 || p.v < 150 || p.v > 2000) continue;
      band.push(machBand(p.mach));
      q.push(p.q);
      ind.push((p.lift * p.lift) / p.q);
      y.push(-p.at);
      liftRatio.push(p.lift / p.q);
    }
  }
  return {
    band: Uint8Array.from(band),
    q: Float64Array.from(q),
    ind: Float64Array.from(ind),
    y: Float64Array.from(y),
    liftRatio: Float64Array.from(liftRatio),
  };
}

const dragAccel = (cd: number[], ci: number, p: KinPoint) =>
  Math.max(0, cd[machBand(p.mach)]!) * p.q + (ci * p.lift * p.lift) / p.q;

function fitOne(weapon: string, engagements: MissileEngagement[]): MissileModel | null {
  const shots: Shot[] = [];
  for (const e of engagements) {
    const fl = e.flight;
    if (!fl || !e.track || fl.tofS < 8 || fl.maxMach > 7) continue;
    shots.push({ e, k: flyoutKinematics(e), tofS: fl.tofS, peakAtS: fl.maxSpeedAtS });
  }
  if (shots.length < FIT_RULES.minShots) return null;
  const boostS = median(shots.map((s) => s.peakAtS));

  // Stage 1: drag from the late coast only, to find when a sustain motor stops.
  let motorEndS = boostS;
  const late = dragRows(shots, (s) =>
    Math.max(FIT_RULES.lateCoastFromS, s.peakAtS + FIT_RULES.coastStartPadS),
  );
  if (late.y.length >= FIT_RULES.minCoastSamples) {
    const x1 = fitDrag(late);
    const cd1 = x1.slice(0, MACH_BAND_COUNT);
    const ci1 = x1[MACH_BAND_COUNT]!;
    const bins = new Map<number, number[]>();
    for (const s of shots)
      for (const p of s.k) {
        if (!p || p.v < 150 || p.t >= 60) continue;
        const b = Math.round(p.t);
        let arr = bins.get(b);
        if (!arr) {
          arr = [];
          bins.set(b, arr);
        }
        arr.push(p.at + dragAccel(cd1, ci1, p));
      }
    for (const [b, arr] of [...bins].sort((x, y) => x[0] - y[0])) {
      if (arr.length > 30 && median(arr) > FIT_RULES.motorOnAccel) motorEndS = Math.max(motorEndS, b + 0.5);
      else if (b > boostS + 3) break;
    }
  }

  // Stage 2: drag from the whole coast.
  const coastFrom = (s: Shot) => Math.max(s.peakAtS, motorEndS) + FIT_RULES.coastStartPadS;
  const coast = dragRows(shots, coastFrom);
  if (coast.y.length < FIT_RULES.minCoastSamples) return null;
  const x = fitDrag(coast);
  const cd = x.slice(0, MACH_BAND_COUNT).map((c) => Math.max(0, c));
  const ci = Math.max(0, x[MACH_BAND_COUNT]!);
  const flatCd = fitDrag(coast, true)[0]!;

  // Motor thrust = measured acceleration + modelled drag.
  const boostThr: number[] = [];
  const sustainThr: number[] = [];
  for (const s of shots)
    for (const p of s.k) {
      if (!p || p.v < 150) continue;
      if (p.t > 1 && p.t < s.peakAtS - 1) boostThr.push(p.at + dragAccel(cd, ci, p));
      else if (p.t > s.peakAtS + 1 && p.t < motorEndS - 0.5) sustainThr.push(p.at + dragAccel(cd, ci, p));
    }
  // Short-burn missiles (peakAtS <= ~3 s) have too few interior central-difference samples before peak
  // speed; estimate average boost thrust from launch-to-peak speed gain plus midpoint drag and climb.
  if (boostThr.length < 5) {
    for (const s of shots) {
      const tr = s.e.track;
      if (!tr || !(s.peakAtS > 0)) continue;
      const v0 = Number.isFinite(tr.data[3]) ? tr.data[3]! : s.e.shooter?.speedMs;
      const vPeak = s.e.flight?.maxSpeedMs;
      if (v0 == null || vPeak == null || !Number.isFinite(v0 + vPeak)) continue;
      const h0 = Number.isFinite(tr.data[2]) ? tr.data[2]! : (s.e.shooter?.altM ?? 0);
      const peakIdx = Math.min(tr.n - 1, Math.max(0, Math.round(s.peakAtS / tr.dt)));
      const h1Raw = tr.data[peakIdx * TRACK_STRIDE + 2];
      const h1 = h1Raw !== undefined && Number.isFinite(h1Raw) ? h1Raw : h0;
      const vm = Math.max(1, 0.5 * (v0 + vPeak));
      const hm = 0.5 * (h0 + h1);
      const rho = airDensity(hm);
      const drag = Math.max(0, cd[machBand(vm / speedOfSoundMs(hm))]!) * rho * vm * vm;
      const grav = G * ((h1 - h0) / Math.max(1, vm * s.peakAtS));
      boostThr.push((vPeak - v0) / s.peakAtS + drag + grav);
    }
  }

  // Replay each coast along its real path with the fitted model and compare end speed.
  const errs: number[] = [];
  const errsFlat: number[] = [];
  for (const s of shots) {
    const t0 = coastFrom(s);
    const t1 = s.tofS - FIT_RULES.coastEndPadS;
    const pts = s.k.filter((p): p is KinPoint => !!p && p.t > t0 && p.t < t1 && p.v > 150);
    if (pts.length < 20) continue;
    let v = pts[0]!.v;
    let vf = v;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1]!;
      const dt = pts[i]!.t - p.t;
      const rho = airDensity(p.h);
      const a = speedOfSoundMs(p.h);
      v +=
        (-cd[machBand(v / a)]! * rho * v * v - (ci * p.lift * p.lift) / (rho * v * v) - G * Math.sin(p.gam)) *
        dt;
      vf += (-flatCd * rho * vf * vf - G * Math.sin(p.gam)) * dt;
    }
    const last = pts[pts.length - 1]!;
    const a = speedOfSoundMs(last.h);
    errs.push(Math.abs(v - last.v) / a);
    errsFlat.push(Math.abs(vf - last.v) / a);
  }

  const loft: LoftBin[] = [];
  for (const [fromNm, toNm] of LOFT_RANGE_BINS_NM) {
    const gains = shots
      .filter((s) => {
        const r = (s.e.initial?.slantRangeM ?? 0) / NM_TO_M;
        const sa = s.e.shooter?.altM;
        const ta = s.e.target?.altM ?? sa;
        return (
          r >= fromNm && r < toNm && sa != null && ta != null && Math.abs(ta - sa) < FIT_RULES.loftCoAltM
        );
      })
      .map((s) => (s.e.flight?.apexGainM ?? 0) / FT_TO_M);
    if (gains.length >= 5)
      loft.push({
        label: `${fromNm}–${toNm}`,
        fromNm,
        toNm,
        shots: gains.length,
        medianGainFt: median(gains),
      });
  }
  const lofts = loft.some(
    (b) => b.shots >= FIT_RULES.minLoftBinShots && b.medianGainFt >= FIT_RULES.minLoftGainFt,
  );

  const killMach: number[] = [];
  const killTof: number[] = [];
  for (const e of engagements) {
    if (!e.isKill || !e.flight?.cpaMissileSpeedMs) continue;
    killMach.push(e.flight.cpaMissileSpeedMs / speedOfSoundMs(e.target?.altM ?? null));
    killTof.push(e.flight.tofS);
  }

  const patches: Record<string, number> = {};
  for (const s of shots) {
    const p = (s.e.dcsPatch ?? "?").split(".").slice(0, 2).join(".");
    patches[p] = (patches[p] ?? 0) + 1;
  }

  const transonic = cd[machBand(1.0)]!;
  const supersonic = cd[machBand(2.5)]!;
  const suspect = transonic > 0 && supersonic < FIT_RULES.minSupersonicDragRatio * transonic;

  return {
    weapon,
    rawNames: [...new Set(engagements.map((e) => e.weaponName))].sort(),
    shots: shots.length,
    kills: engagements.filter((e) => e.isKill).length,
    coastSamples: coast.y.length,
    boostS,
    boostAccel: boostThr.length > 0 ? Math.max(0, median(boostThr)) : 0,
    motorEndS,
    sustainAccel: sustainThr.length > 30 ? Math.max(0, median(sustainThr)) : 0,
    peakMach: median(shots.map((s) => s.e.flight?.maxMach ?? 0)),
    cd,
    ci,
    liftK: quantile(Array.from(coast.liftRatio), 0.99),
    loft,
    lofts,
    reachMach: killMach.length >= 5 ? Math.max(0.6, quantile(killMach, FIT_RULES.reachKillQuantile)) : 0.8,
    killMachMedian: killMach.length ? median(killMach) : null,
    maxKillTofS: killTof.length ? Math.max(...killTof) : null,
    replay: {
      n: errs.length,
      medianMach: errs.length ? median(errs) : 0,
      p90Mach: errs.length ? quantile(errs, 0.9) : 0,
      flatDragMedianMach: errsFlat.length ? median(errsFlat) : 0,
    },
    patches,
    quality: suspect ? "suspect" : "good",
    qualityNote: suspect
      ? "Supersonic drag came out implausibly low: a motor phase was probably missed, so thrust leaked into the drag fit."
      : null,
  };
}

/** Fits one model per radar-guided air-to-air missile with enough tracked shots. */
export function fitMissileModels(engagements: MissileEngagement[]): MissileModel[] {
  const groups = new Map<string, MissileEngagement[]>();
  for (const e of engagements) {
    if (e.domain !== "A2A" || e.isGun || !e.track || !e.flight) continue;
    if (e.weaponClass !== "A2A-ARH" && e.weaponClass !== "A2A-SARH") continue;
    const key = canonicalMissile(e.weaponName);
    let g = groups.get(key);
    if (!g) {
      g = [];
      groups.set(key, g);
    }
    g.push(e);
  }
  const models: MissileModel[] = [];
  for (const [weapon, list] of groups) {
    const m = fitOne(weapon, list);
    if (m) models.push(m);
  }
  return models.sort((a, b) => b.shots - a.shots);
}
