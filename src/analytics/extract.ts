import type { AcmiObject, Recording } from "../acmi/model.ts";
import { indexAt, T_HEADING, T_PITCH, T_YAW } from "../acmi/tracks.ts";
import {
  type Analysis,
  analyze,
  isAircraft,
  isPlatform,
  isShell,
  isWeapon,
  type Kill,
  RULES,
  textAt,
} from "../analysis/analyze.ts";
import { dist, Geo } from "../analysis/geo.ts";
import { weaponLabel } from "../ui/records.ts";
import { speedOfSoundMs } from "./atmosphere.ts";
import { buildShotTrack, DecoyIndex, measureMissileFlight } from "./flight.ts";
import {
  type AltitudeRelation,
  type AspectCategory,
  BVR_RANGE_M,
  type ClassificationThresholds,
  DEFAULT_THRESHOLDS,
  type EngagementDomain,
  type EngagementOutcome,
  EXTRACTOR_VERSION,
  type FileAnalytics,
  type InitialCondition,
  type MissileEngagement,
  type MissileFlight,
  type PlatformSnapshot,
  type RecordingMeta,
  type ShotTrack,
  type TargetSource,
  type WeaponClass,
} from "./model.ts";
import { assessFileQuality, engagementUfo, scanAircraftMotion } from "./quality.ts";

const EARTH_R = 6371008.8;
const DEG = Math.PI / 180;
type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const angleDeg = (a: V3, b: V3): number => {
  const l = len(a) * len(b);
  return l > 1e-9 ? Math.acos(Math.max(-1, Math.min(1, dot(a, b) / l))) / DEG : Number.NaN;
};

/** Speed of sound (m/s) at altitude h (m MSL) using the International Standard Atmosphere. */
export { speedOfSoundMs } from "./atmosphere.ts";

/** Classify target aspect angle (0° = tail-on, 90° = beam, 180° = head-on) into a tactical bucket. */
export function classifyAspect(aspectDeg: number): AspectCategory {
  if (!Number.isFinite(aspectDeg)) return "unknown";
  if (aspectDeg >= 150) return "head-on";
  if (aspectDeg >= 120) return "forward-quarter";
  if (aspectDeg >= 60) return "beam";
  if (aspectDeg >= 30) return "rear-quarter";
  return "tail-on";
}

/**
 * Classify launcher–target altitude relation:
 * - Within `coAltBandM` vertical separation: `co-alt-high` (mean alt >= `highAltFloorM`) or `co-alt-low`.
 * - Shooter above target by more than `coAltBandM`: `high-to-low` (look-down).
 * - Shooter below target by more than `coAltBandM`: `low-to-high` (look-up).
 */
export function classifyAltitudeRelation(
  shooterAltM: number | null,
  targetAltM: number | null,
  thresholds: ClassificationThresholds = DEFAULT_THRESHOLDS,
): AltitudeRelation {
  if (
    shooterAltM === null ||
    targetAltM === null ||
    !Number.isFinite(shooterAltM) ||
    !Number.isFinite(targetAltM)
  ) {
    return "unknown";
  }
  const altDiffM = targetAltM - shooterAltM;
  const meanAltM = 0.5 * (shooterAltM + targetAltM);
  if (Math.abs(altDiffM) <= thresholds.coAltBandM) {
    return meanAltM >= thresholds.highAltFloorM ? "co-alt-high" : "co-alt-low";
  }
  return altDiffM < 0 ? "high-to-low" : "low-to-high";
}

/** Classify a weapon by its DCS/Tacview name, tags, and shooter/target domains. */
export function classifyWeapon(
  w: AcmiObject,
  shooter: AcmiObject | null,
  target: AcmiObject | null,
): WeaponClass {
  if (isShell(w)) return "Gun";
  const n = w.name.toUpperCase();
  const shooterIsSurface =
    shooter !== null && (shooter.tags.includes("Ground") || shooter.tags.includes("Sea"));

  // Explicit SAM patterns or surface-launched missiles against air targets
  if (
    /^(SA\d|S-\d|S_\d|MIM_|PATRIOT|HAWK|ROLAND|TOR_|BUK_|KUB_|OSA_|STRELA|IGLA|STINGER|SM_2|SM-2|RIM_|SEA_SPARROW|ASTER|CROTALE|CHAPARRAL|NASAMS|HQ[-_]?7|HQ[-_]?16|5V55|48N6|9M3\d|9M9\d|3M9)/i.test(
      n,
    ) ||
    (shooterIsSurface && (!target || target.tags.includes("Air") || target.tags.includes("Weapon")))
  ) {
    return "SAM";
  }

  // Active Radar Homing (Fox-3)
  if (
    /AIM[_-]?120|AIM[_-]?54|[RP][_-]?77|RVV|SD[_-]?10|PL[_-]?12|PL[_-]?15|MICA[_-]?EM|METEOR|[RP][_-]?37/i.test(
      n,
    )
  ) {
    return "A2A-ARH";
  }

  // Infrared Homing (Fox-2)
  if (
    /AIM[_-]?9|[RP][_-]?73|[RP][_-]?60|[RP][_-]?27(ET|TE|T)|[RP][_-]?(23|24|40)T|MAGIC|MICA[_-]?IR|PL[_-]?5|PL[_-]?8|PYTHON|IRIS[_-]?T|ASRAAM|[RP][_-]?13M|[RP][_-]?3S|GAR[_-]?8/i.test(
      n,
    )
  ) {
    return "A2A-IR";
  }

  // Semi-Active Radar Homing (Fox-1)
  if (
    /AIM[_-]?7|[RP][_-]?27(ER|PE|R|P)|[RP][_-]?(23|24|40)[RP]|[RP][_-]?33|SUPER[_-]?530|530D|SPARROW/i.test(n)
  ) {
    return "A2A-SARH";
  }

  // Air-to-Ground / Bombs / Rockets / Decoys
  if (
    w.tags.includes("Bomb") ||
    w.tags.includes("Rocket") ||
    w.tags.includes("Torpedo") ||
    w.tags.includes("Decoy") ||
    /AGM|GBU|MK[_-]?\d|CBU|FAB|KAB|BETAB|OFAB|KH[_-]?\d|X[_-]?\d\d|S[_-]?(5|8|13|24|25)|HYDRA|ZUNI|MAVERICK|HARM|HARPOON|VIKHR|ATAKA|HELLFIRE|BRIMSTONE|STORM|JSOW|JDAM|SLAM|TALD|ADM[_-]?141|RB[_-]?(04|05|15|75)|BK[_-]?90/i.test(
      n,
    )
  ) {
    return "A2G";
  }

  if (shooter && shooter.tags.includes("Air") && (!target || target.tags.includes("Air"))) {
    return "A2A-Other";
  }
  return "A2G";
}

function platformDomain(o: AcmiObject): PlatformSnapshot["domain"] {
  if (o.tags.includes("Weapon")) return "weapon";
  if (o.tags.includes("Air")) return o.tags.includes("Rotorcraft") ? "heli" : "air";
  if (o.tags.includes("Ground")) return "ground";
  if (o.tags.includes("Sea")) return "sea";
  return "other";
}

function engagementDomain(
  wClass: WeaponClass,
  shooter: PlatformSnapshot | null,
  target: PlatformSnapshot | null,
): EngagementDomain {
  if (target?.domain === "weapon") return "Intercept";
  if (wClass === "SAM") return "SAM";
  if (wClass === "A2A-ARH" || wClass === "A2A-SARH" || wClass === "A2A-IR" || wClass === "A2A-Other") {
    return "A2A";
  }
  if (wClass === "A2G") return "A2G";
  if (shooter?.domain === "air" && target?.domain === "air") return "A2A";
  if ((shooter?.domain === "ground" || shooter?.domain === "sea") && target?.domain === "air") return "SAM";
  if (shooter?.domain === "air" && (target?.domain === "ground" || target?.domain === "sea")) return "A2G";
  return "Other";
}

interface LocalKinematics {
  lonDeg: number;
  latDeg: number;
  altM: number;
  /** Local velocity [vEast, vNorth, vUp] in m/s. */
  velEnu: V3;
  speedMs: number;
  /** Nose unit vector in [East, North, Up]. */
  noseEnu: V3;
  headingDeg: number;
  pitchDeg: number;
}

/** Interpolate lon, lat, alt, velocity (in local East-North-Up metres/s) and nose orientation at time t. */
function kinematicsAt(rec: Recording, o: AcmiObject, t: number): LocalKinematics | null {
  const tf = o.transform;
  if (!tf || tf.times.length === 0) return null;
  const n = tf.times.length;
  let i = indexAt(tf.times, t);
  if (i < 0) i = 0;
  const j = i + 1 < n ? i + 1 : i;
  const t0 = tf.times[i] as number;
  const t1 = tf.times[j] as number;
  const f = j > i && t > t0 ? Math.min(1, (t - t0) / (t1 - t0)) : 0;

  const lon0 = (tf.lon[i] as number) + rec.refLon;
  const lat0 = (tf.lat[i] as number) + rec.refLat;
  const lon1 = (tf.lon[j] as number) + rec.refLon;
  const lat1 = (tf.lat[j] as number) + rec.refLat;
  if (!Number.isFinite(lon0 + lat0)) return null;

  const lonDeg = Number.isFinite(lon1) ? lon0 + (lon1 - lon0) * f : lon0;
  const latDeg = Number.isFinite(lat1) ? lat0 + (lat1 - lat0) * f : lat0;

  const a0 = tf.rest[i * 7] as number;
  const a1 = tf.rest[j * 7] as number;
  const alt0 = Number.isFinite(a0) ? a0 : 0;
  const alt1 = Number.isFinite(a1) ? a1 : alt0;
  const altM = alt0 + (alt1 - alt0) * f;

  // Estimate velocity over a small window around t
  const iVel0 = Math.max(0, indexAt(tf.times, Math.max(tf.times[0] as number, t - 0.5)));
  const iVel1 = Math.min(n - 1, Math.max(iVel0 + 1, indexAt(tf.times, t + 0.5) + 1));
  const dt = (tf.times[iVel1] as number) - (tf.times[iVel0] as number);
  const kx = EARTH_R * Math.cos(latDeg * DEG) * DEG;
  const ky = EARTH_R * DEG;
  let vx = 0;
  let vy = 0;
  let vz = 0;
  if (dt > 1e-4) {
    const dLon = (tf.lon[iVel1] as number) - (tf.lon[iVel0] as number);
    const dLat = (tf.lat[iVel1] as number) - (tf.lat[iVel0] as number);
    const va0 = tf.rest[iVel0 * 7] as number;
    const va1 = tf.rest[iVel1 * 7] as number;
    if (Number.isFinite(dLon) && Number.isFinite(dLat)) {
      vx = (dLon * kx) / dt;
      vy = (dLat * ky) / dt;
    }
    if (Number.isFinite(va0) && Number.isFinite(va1)) {
      vz = (va1 - va0) / dt;
    }
  }
  const velEnu: V3 = [vx, vy, vz];
  const speedMs = len(velEnu);
  const horizSpeed = Math.hypot(vx, vy);

  let yaw = tf.rest[i * 7 + (T_YAW - 2)] as number;
  if (!Number.isFinite(yaw)) yaw = tf.rest[i * 7 + (T_HEADING - 2)] as number;
  if (!Number.isFinite(yaw)) yaw = horizSpeed > 1 ? Math.atan2(vx, vy) / DEG : 0;
  const headingDeg = ((yaw % 360) + 360) % 360;

  let pitchDeg = tf.rest[i * 7 + (T_PITCH - 2)] as number;
  if (!Number.isFinite(pitchDeg)) {
    pitchDeg = horizSpeed > 1 || Math.abs(vz) > 0.1 ? Math.atan2(vz, horizSpeed) / DEG : 0;
  }

  const hRad = headingDeg * DEG;
  const pRad = pitchDeg * DEG;
  const noseFromAtt: V3 = [Math.sin(hRad) * Math.cos(pRad), Math.cos(hRad) * Math.cos(pRad), Math.sin(pRad)];
  const noseEnu: V3 = len(noseFromAtt) > 0 ? noseFromAtt : speedMs > 1 ? velEnu : [0, 1, 0];

  return { lonDeg, latDeg, altM, velEnu, speedMs, noseEnu, headingDeg, pitchDeg };
}

function buildSnapshot(rec: Recording, o: AcmiObject, t: number, pilotOverride?: string): PlatformSnapshot {
  const k = kinematicsAt(rec, o, t);
  const pilot = pilotOverride !== undefined ? pilotOverride : textAt(o, "Pilot", t) || o.pilot;
  const altM = k ? k.altM : null;
  const speedMs = k ? k.speedMs : null;
  const sos = speedOfSoundMs(altM);
  return {
    uid: o.uid,
    id: o.id,
    name: o.name || "(unnamed)",
    pilot,
    group: o.group,
    side: o.color || o.coalition || "Unknown",
    coalition: o.coalition,
    domain: platformDomain(o),
    altM,
    speedMs,
    mach: speedMs !== null && sos > 0 ? speedMs / sos : null,
    vzMs: k ? k.velEnu[2] : null,
    headingDeg: k ? k.headingDeg : null,
    pitchDeg: k ? k.pitchDeg : null,
  };
}

/** Compute relative 3D / tangent-plane initial conditions between shooter A and target B at launch time t. */
export function computeInitialCondition(
  rec: Recording,
  shooterObj: AcmiObject,
  targetObj: AcmiObject,
  t: number,
  thresholds: ClassificationThresholds = DEFAULT_THRESHOLDS,
): InitialCondition | null {
  const A = kinematicsAt(rec, shooterObj, t);
  const B = kinematicsAt(rec, targetObj, t);
  if (!A || !B) return null;

  const midLatRad = 0.5 * (A.latDeg + B.latDeg) * DEG;
  const kx = EARTH_R * Math.cos(midLatRad) * DEG;
  const ky = EARTH_R * DEG;
  const dx = (B.lonDeg - A.lonDeg) * kx;
  const dy = (B.latDeg - A.latDeg) * ky;
  const dz = B.altM - A.altM;

  const los: V3 = [dx, dy, dz];
  const horizontalRangeM = Math.hypot(dx, dy);
  const slantRangeM = Math.hypot(dx, dy, dz);
  if (slantRangeM < 1e-3) return null;

  const relV = sub(B.velEnu, A.velEnu);
  const closureMs = -dot(relV, los) / slantRangeM;
  const back: V3 = [-dx, -dy, -dz];

  // Plan-view (horizontal) vectors for aspect and heading crossing angle so steep look-up/look-down
  // angles don't distort 180° head-on or 0° tail-on classification (vertical geometry is in altitudeRelation).
  const backHoriz: V3 = [-dx, -dy, 0];
  const tailBHoriz: V3 = [-B.velEnu[0], -B.velEnu[1], 0];
  const noseBBackHoriz: V3 = [-B.noseEnu[0], -B.noseEnu[1], 0];
  const velAHoriz: V3 = [A.velEnu[0], A.velEnu[1], 0];
  const velBHoriz: V3 = [B.velEnu[0], B.velEnu[1], 0];

  const aspectDeg =
    len(velBHoriz) > 1 && horizontalRangeM > 1
      ? angleDeg(tailBHoriz, backHoriz)
      : horizontalRangeM > 1
        ? angleDeg(noseBBackHoriz, backHoriz)
        : angleDeg([-B.velEnu[0], -B.velEnu[1], -B.velEnu[2]], back);
  const hcaDeg =
    len(velAHoriz) > 1 && len(velBHoriz) > 1
      ? angleDeg(velAHoriz, velBHoriz)
      : angleDeg([A.noseEnu[0], A.noseEnu[1], 0], [B.noseEnu[0], B.noseEnu[1], 0]);
  const shooterAtaDeg = angleDeg(A.noseEnu, los);
  const targetAtaDeg = angleDeg(B.noseEnu, back);

  const bearingDeg = (((Math.atan2(dx, dy) / DEG) % 360) + 360) % 360;
  const relBearing = (((bearingDeg - A.headingDeg) % 360) + 360) % 360;
  const clock = Math.round(relBearing / 30) % 12 || 12;
  const lookAngleDeg = Math.atan2(dz, horizontalRangeM) / DEG;
  const meanAltM = 0.5 * (A.altM + B.altM);

  return {
    slantRangeM,
    horizontalRangeM,
    altDiffM: dz,
    meanAltM,
    lookAngleDeg,
    aspectDeg: Number.isFinite(aspectDeg) ? aspectDeg : 180,
    hcaDeg: Number.isFinite(hcaDeg) ? hcaDeg : 180,
    shooterAtaDeg: Number.isFinite(shooterAtaDeg) ? shooterAtaDeg : 0,
    targetAtaDeg: Number.isFinite(targetAtaDeg) ? targetAtaDeg : 0,
    clock,
    closureMs,
    aspectCategory: classifyAspect(aspectDeg),
    altitudeRelation: classifyAltitudeRelation(A.altM, B.altM, thresholds),
  };
}

/** Parse DCS version ("2.9.15.9599") and patch ("2.9.15") from DataSource header string. */
export function parseDcsVersion(dataSource: string | undefined): {
  dcsVersion: string | null;
  dcsPatch: string | null;
} {
  if (!dataSource) return { dcsVersion: null, dcsPatch: null };
  const m = dataSource.match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
  if (!m) {
    const trimmed = dataSource.trim();
    return { dcsVersion: trimmed || null, dcsPatch: trimmed || null };
  }
  const dcsVersion = m[1]!;
  const patchMatch = dcsVersion.match(/^(\d+\.\d+\.\d+)/);
  return {
    dcsVersion,
    dcsPatch: patchMatch ? patchMatch[1]! : dcsVersion,
  };
}

/**
 * Extract all missile and weapon engagements with full initial conditions from a parsed Recording.
 */
export function extractFileAnalytics(
  rec: Recording,
  fileName: string,
  fileSize = 0,
  existingAnalysis?: Analysis,
  fileId = fileName,
): FileAnalytics {
  const t0 = performance.now();
  const analysis = existingAnalysis ?? analyze(rec);
  const geo = new Geo(rec);
  const decoyIndex = new DecoyIndex(rec, geo);
  const objs = rec.objects;
  const { dcsVersion, dcsPatch } = parseDcsVersion(rec.globals.DataSource);
  const recordedAt = rec.globals.RecordingTime || rec.referenceTime || null;

  // Map remove/re-add glitch chains so we can find the victim life alive at weapon launch time
  const prevLife = new Map<number, number>();
  for (const o of objs) {
    if (o.previousUid !== null && o.reappearGap !== null && o.reappearGap <= RULES.glitchGapS) {
      const p = objs[o.previousUid];
      if (p && p.name === o.name && p.type === o.type) {
        prevLife.set(o.uid, p.uid);
      }
    }
  }
  const lifeAliveAt = (uid: number, t: number): AcmiObject => {
    let curr = objs[uid] as AcmiObject;
    while (curr && !geo.alive(curr, t, 0.5)) {
      const prev = prevLife.get(curr.uid);
      if (prev === undefined) break;
      curr = objs[prev] as AcmiObject;
    }
    return curr;
  };

  // Map weaponUid -> Kill (for weapon kills), including all shell UIDs belonging to a gun burst
  const killByWeaponUid = new Map<number, Kill>();
  for (const k of analysis.kills) {
    if (k.cause === "weapon" && k.weaponUid !== null) {
      killByWeaponUid.set(k.weaponUid, k);
    }
  }
  const findKillForShot = (shot: Analysis["shots"][number]): Kill | null => {
    const direct = killByWeaponUid.get(shot.weaponUid);
    if (direct) return direct;
    for (const h of shot.hits) {
      const k = killByWeaponUid.get(h.weaponUid);
      if (k) return k;
    }
    return null;
  };

  // Platforms usable as candidate targets when inferring missed-missile targets
  const candidateTargets = objs.filter((o) => isPlatform(o) && !geo.scrambled(o));

  const inferTargetForMissedMissile = (
    w: AcmiObject,
    shooterObj: AcmiObject | null,
  ): { target: AcmiObject; caDistM: number | null } | null => {
    const tLaunch = w.createdAt;
    const tEnd = w.removedAt ?? rec.timeEnd;
    const shooterSide = shooterObj?.coalition || w.coalition;

    // 1. Check which opposing platform the weapon came closest to near its end of flight (within 15 km)
    const pEnd = geo.pos(w, tEnd);
    if (pEnd) {
      let bestEnd: { o: AcmiObject; d: number } | null = null;
      for (const cand of candidateTargets) {
        if (cand === shooterObj) continue;
        if (shooterSide && cand.coalition && cand.coalition === shooterSide) continue;
        if (!geo.alive(cand, tEnd, 2) || !geo.alive(cand, tLaunch, 2)) continue;
        const pc = geo.pos(cand, tEnd);
        if (!pc) continue;
        const d = dist(pEnd, pc);
        if (d <= 15000 && (!bestEnd || d < bestEnd.d)) {
          bestEnd = { o: cand, d };
        }
      }
      if (bestEnd) return { target: bestEnd.o, caDistM: bestEnd.d };
    }

    // 2. Fallback: opposing aircraft in the shooter's forward cone (ATA <= 50°, range <= 110 km) at launch
    if (shooterObj) {
      const kShooter = kinematicsAt(rec, shooterObj, tLaunch);
      if (kShooter) {
        let bestCone: { o: AcmiObject; score: number } | null = null;
        for (const cand of candidateTargets) {
          if (cand === shooterObj || !isAircraft(cand)) continue;
          if (shooterSide && cand.coalition && cand.coalition === shooterSide) continue;
          if (!geo.alive(cand, tLaunch, 1)) continue;
          const ic = computeInitialCondition(rec, shooterObj, cand, tLaunch);
          if (!ic || ic.slantRangeM > 110000 || ic.shooterAtaDeg > 50) continue;
          // Prefer small ATA and reasonable range
          const score = ic.shooterAtaDeg * 1000 + ic.slantRangeM * 0.2;
          if (!bestCone || score < bestCone.score) {
            bestCone = { o: cand, score };
          }
        }
        if (bestCone) return { target: bestCone.o, caDistM: null };
      }
    }
    return null;
  };

  const missionTitle = rec.globals.Title || fileName.replace(/\.(zip|txt)?\.acmi$/i, "");
  const engagements: MissileEngagement[] = [];

  const matchedKillUids = new Set<number>();

  analysis.shots.forEach((shot, idx) => {
    const w = objs[shot.weaponUid] as AcmiObject | undefined;
    if (!w) return;

    const kill = findKillForShot(shot);
    if (kill?.weaponUid !== null && kill?.weaponUid !== undefined) {
      matchedKillUids.add(kill.weaponUid);
    }
    const shooterInfo = kill?.killer ?? shot.shooter;
    const shooterObj = shooterInfo ? (objs[shooterInfo.uid] as AcmiObject) : null;

    let targetObjAtLaunch: AcmiObject | null = null;
    let targetObjAtEnd: AcmiObject | null = null;
    let targetSource: TargetSource = "none";
    let missDistanceM: number | null = null;

    if (kill) {
      targetObjAtEnd = objs[kill.victimUid] as AcmiObject;
      targetObjAtLaunch = lifeAliveAt(kill.victimUid, shot.time);
      targetSource = "kill";
      missDistanceM = kill.details?.missDistanceM ?? shot.hits[0]?.missDistanceM ?? null;
    } else if (shot.hits.length > 0) {
      const h = shot.hits[0]!;
      targetObjAtEnd = objs[h.targetUid] as AcmiObject;
      targetObjAtLaunch = lifeAliveAt(h.targetUid, shot.time);
      targetSource = "hit";
      missDistanceM = h.missDistanceM;
    } else if (shot.lockedTargetUid !== null) {
      targetObjAtEnd = objs[shot.lockedTargetUid] as AcmiObject;
      targetObjAtLaunch = lifeAliveAt(shot.lockedTargetUid, shot.time);
      targetSource = "locked";
    } else if (!shot.isGun) {
      const inferred = inferTargetForMissedMissile(w, shooterObj);
      if (inferred) {
        targetObjAtLaunch = inferred.target;
        targetObjAtEnd = inferred.target;
        targetSource = "inferred";
        missDistanceM = inferred.caDistM;
      }
    }

    const shooterSnap = shooterObj ? buildSnapshot(rec, shooterObj, shot.time, shooterInfo?.pilot) : null;
    const targetSnap = targetObjAtLaunch
      ? buildSnapshot(rec, targetObjAtLaunch, shot.time, kill?.victimPilot)
      : null;

    const wClass = classifyWeapon(w, shooterObj, targetObjAtLaunch);
    const domain = engagementDomain(wClass, shooterSnap, targetSnap);

    const initial =
      shooterObj && targetObjAtLaunch
        ? computeInitialCondition(rec, shooterObj, targetObjAtLaunch, shot.time)
        : null;

    let outcome: EngagementOutcome = "miss";
    if (kill) outcome = "kill";
    else if (shot.outcome === "hit") {
      outcome = targetObjAtEnd && isWeapon(targetObjAtEnd) ? "intercept" : "hit-damaged";
    } else if (shot.outcome === "active") {
      outcome = "active";
    }

    const hitOrEndTime = kill?.details
      ? kill.details.launchTime + kill.details.flightTimeS
      : (shot.hits[0]?.time ?? shot.endTime);
    const flightTimeS = hitOrEndTime !== null && hitOrEndTime >= shot.time ? hitOrEndTime - shot.time : null;

    // Terminal F-pole distance between shooter and target at impact time
    let fPoleRangeM: number | null = null;
    if (shooterObj && targetObjAtEnd && hitOrEndTime !== null) {
      const ps = geo.pos(shooterObj, hitOrEndTime);
      const pt = geo.pos(targetObjAtEnd, hitOrEndTime);
      if (ps && pt) fPoleRangeM = dist(ps, pt);
    }

    const targetLives: AcmiObject[] = [];
    if (targetObjAtLaunch) targetLives.push(targetObjAtLaunch);
    if (targetObjAtEnd && targetObjAtEnd !== targetObjAtLaunch) targetLives.push(targetObjAtEnd);

    const isAirDefenseOrA2AMissile =
      !shot.isGun && (domain === "A2A" || domain === "SAM" || domain === "Intercept");
    const flight: MissileFlight | null = isAirDefenseOrA2AMissile
      ? measureMissileFlight(geo, w, targetLives, shot.time)
      : null;
    if (missDistanceM === null && flight?.cpaM !== null && flight?.cpaM !== undefined) {
      missDistanceM = flight.cpaM;
    }
    const track: ShotTrack | null =
      isAirDefenseOrA2AMissile && (shooterObj || targetLives.length > 0)
        ? buildShotTrack(rec, geo, decoyIndex, w, shooterObj, targetLives, shot.time)
        : null;

    const friendlyFire =
      kill?.friendly ??
      Boolean(
        shot.outcome === "hit" &&
          shooterObj?.coalition &&
          targetObjAtEnd?.coalition &&
          shooterObj.coalition === targetObjAtEnd.coalition,
      );

    engagements.push({
      id: `${fileId}:${idx}`,
      fileId,
      fileName,
      missionTitle,
      weaponUid: w.uid,
      weaponRawName: w.name,
      weaponName: weaponLabel(w.name, shot.isGun) || w.name || "Unknown Weapon",
      weaponClass: wClass,
      isGun: shot.isGun,
      rounds: shot.rounds,
      domain,
      launchTime: shot.time,
      endTime: shot.endTime,
      killTime: kill?.time ?? null,
      flightTimeS,
      missDistanceM,
      fPoleRangeM,
      outcome,
      isKill: kill !== null,
      isHit: shot.outcome === "hit" || kill !== null,
      friendlyFire,
      targetEjected: kill?.ejected ?? false,
      confidence: kill?.confidence ?? shooterInfo?.confidence ?? "low",
      firstSeenInFlight: shot.firstSeenInFlight,
      shooter: shooterSnap,
      target: targetSnap,
      targetSource,
      initial,
      dcsPatch,
      recordedAt,
      flight,
      track,
    });
  });

  // Also check if any weapon kill was attributed to a weapon not in `shots` (rare)
  analysis.kills.forEach((kill, kIdx) => {
    if (kill.cause !== "weapon" || kill.weaponUid === null) return;
    if (matchedKillUids.has(kill.weaponUid)) return;
    const w = objs[kill.weaponUid] as AcmiObject | undefined;
    if (!w) return;
    const launchTime = kill.details?.launchTime ?? w.createdAt;
    const shooterObj = kill.killer ? (objs[kill.killer.uid] as AcmiObject) : null;
    const targetObjAtLaunch = lifeAliveAt(kill.victimUid, launchTime);
    const targetObjAtEnd = objs[kill.victimUid] as AcmiObject;
    const targetLives: AcmiObject[] = [targetObjAtLaunch];
    if (targetObjAtEnd && targetObjAtEnd !== targetObjAtLaunch) targetLives.push(targetObjAtEnd);

    const shooterSnap = shooterObj ? buildSnapshot(rec, shooterObj, launchTime, kill.killer?.pilot) : null;
    const targetSnap = buildSnapshot(rec, targetObjAtLaunch, launchTime, kill.victimPilot);
    const wClass = classifyWeapon(w, shooterObj, targetObjAtLaunch);
    const domain = engagementDomain(wClass, shooterSnap, targetSnap);
    const initial = shooterObj
      ? computeInitialCondition(rec, shooterObj, targetObjAtLaunch, launchTime)
      : null;
    const isAirDefenseOrA2AMissile =
      !kill.isGun && (domain === "A2A" || domain === "SAM" || domain === "Intercept");
    const flight: MissileFlight | null = isAirDefenseOrA2AMissile
      ? measureMissileFlight(geo, w, targetLives, launchTime)
      : null;
    const track: ShotTrack | null = isAirDefenseOrA2AMissile
      ? buildShotTrack(rec, geo, decoyIndex, w, shooterObj, targetLives, launchTime)
      : null;

    engagements.push({
      id: `${fileId}:kill-${kIdx}`,
      fileId,
      fileName,
      missionTitle,
      weaponUid: w.uid,
      weaponRawName: w.name,
      weaponName: weaponLabel(w.name, kill.isGun) || w.name || "Unknown Weapon",
      weaponClass: wClass,
      isGun: kill.isGun,
      rounds: 1,
      domain,
      launchTime,
      endTime: w.removedAt,
      killTime: kill.time,
      flightTimeS: kill.details?.flightTimeS ?? null,
      missDistanceM: kill.details?.missDistanceM ?? flight?.cpaM ?? null,
      fPoleRangeM: null,
      outcome: "kill",
      isKill: true,
      isHit: true,
      friendlyFire: kill.friendly,
      targetEjected: kill.ejected,
      confidence: kill.confidence,
      firstSeenInFlight: false,
      shooter: shooterSnap,
      target: targetSnap,
      targetSource: "kill",
      initial,
      dcsPatch,
      recordedAt,
      flight,
      track,
    });
  });

  engagements.sort((a, b) => a.launchTime - b.launchTime);

  const motion = scanAircraftMotion(rec, geo);
  for (const e of engagements) {
    if (e.isGun || e.domain === "A2G") continue;
    const sh = e.shooter ? motion.get(e.shooter.uid) : undefined;
    const tg = e.target ? motion.get(e.target.uid) : undefined;
    if (!sh && !tg) continue;
    e.ufo = engagementUfo(e, sh, [tg]);
  }
  const quality = assessFileQuality(rec, geo, motion, engagements, analysis.scrambled.aircraft);

  const durationS = Math.max(0, rec.timeEnd - rec.timeStart);
  const a2aMissileShots = engagements.filter((e) => e.domain === "A2A" && !e.isGun).length;
  const bvrShots = engagements.filter(
    (e) => e.domain === "A2A" && !e.isGun && (e.initial?.slantRangeM ?? 0) >= BVR_RANGE_M,
  ).length;
  const meta: RecordingMeta = {
    dcsVersion,
    dcsPatch,
    recorder: rec.globals.DataRecorder || null,
    recordedAt,
    author: rec.globals.Author || null,
    sessionKey: `${recordedAt ?? fileName}|${missionTitle}|${Math.round(durationS / 10) * 10}`,
    a2aMissileShots,
    bvrShots,
  };

  return {
    fileId,
    fileName,
    fileSize,
    missionTitle,
    theater: rec.globals.Theater || "",
    referenceTime: rec.referenceTime,
    durationS,
    aircraftCount: objs.filter(isAircraft).length,
    weaponsReleasedCount: objs.filter(isWeapon).length,
    scrambledObjects: analysis.scrambled.objects,
    protectedHeader: analysis.scrambled.protectedHeader,
    engagements,
    parseMs: performance.now() - t0,
    meta,
    quality,
    extractorVersion: EXTRACTOR_VERSION,
  };
}
