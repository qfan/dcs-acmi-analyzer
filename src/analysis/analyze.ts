import type { AcmiObject, Recording } from "../acmi/model.ts";
import { indexAt } from "../acmi/tracks.ts";
import { dist, Geo, SpatialIndex } from "./geo.ts";

/**
 * Infers shots, hits and kills from a recording. DCS recordings contain no Event=, Parent= or
 * hit information, so everything here comes from geometry and timing. See PLAN.md §3.
 *
 * Calibrated against Tacview's own exported event log for one recording (tests/ground-truth).
 */

export const RULES = {
  /** Max distance from a weapon's first position to its launcher. */
  launchMaxM: 1500,
  /** Above this launch distance the shooter is reported with low confidence. */
  launchConfidentM: 300,
  /** Shells/bullets spawn at the muzzle. */
  shellLaunchMaxM: 300,
  /** A weapon whose closest approach to an object is within this is a hit. */
  hitRadiusM: 60,
  /** Bullets and shells. */
  shellHitRadiusM: 20,
  /** A victim removed within this many seconds after its last hit is credited to that hit. */
  killWindowS: 180,
  /** Removals followed by the same object reappearing within this gap are recorder glitches. */
  glitchGapS: 1,
  /** Aircraft slower than this when removed are treated as despawned, not crashed. */
  despawnSpeedMs: 30,
  /** Crash evidence: lost at least this much altitude in the last second before removal (m/s). */
  crashSinkMs: 20,
  /** Crash evidence: removed at or below this altitude (m MSL) while still moving. */
  surfaceAltM: 20,
  /** Two aircraft removed within this time and distance of each other: collision. */
  collisionWindowS: 1,
  collisionRadiusM: 100,
  /** A parachutist or ejection seat within this time and distance means the pilot ejected. */
  ejectWindowS: 5,
  ejectRadiusM: 500,
  /** Objects removed this close to the end of the recording without a hit: the recording ended, not a death. */
  endGraceS: 1,
  /** This many objects removed in one frame without hits: a mass despawn (server reset, script), not deaths. */
  massRemovalCount: 10,
  /** A weapon with no launcher in range that is already this fast when first seen was fired out of view. */
  inFlightSpeedMs: 150,
};

export type Confidence = "high" | "medium" | "low";

export interface ShooterInfo {
  uid: number;
  /** Pilot at launch time (empty for AI without a pilot name). */
  pilot: string;
  distanceM: number;
  confidence: Confidence;
}

export interface HitInfo {
  time: number;
  weaponUid: number;
  targetUid: number;
  /** Closest-approach distance between weapon and target. */
  missDistanceM: number;
}

export interface Shot {
  weaponUid: number;
  time: number;
  /** Bullets are grouped into bursts; for missiles, bombs and rockets this is 1. */
  rounds: number;
  isGun: boolean;
  shooter: ShooterInfo | null;
  /** Object the shooter had locked at launch (from LockedTarget), when recorded. */
  lockedTargetUid: number | null;
  /** When the weapon disappeared (null: still flying at the end). For bursts: last round. */
  endTime: number | null;
  hits: HitInfo[];
  outcome: "hit" | "miss" | "active";
  /**
   * No launcher in range and already moving fast when first seen: fired before the recording
   * started, or out of the recording client's view (multiplayer client recordings).
   */
  firstSeenInFlight: boolean;
}

export type DeathCause = "weapon" | "collision" | "crash" | "despawn" | "unknown";

export interface Kill {
  time: number;
  /** The victim's last object (after merging remove/re-add glitches). */
  victimUid: number;
  victimPilot: string;
  cause: DeathCause;
  killer: ShooterInfo | null;
  weaponUid: number | null;
  /** Weapon name, or the shell name for gun kills. */
  weaponName: string;
  isGun: boolean;
  /** Seconds between the deciding hit and the victim disappearing. */
  secondsAfterHit: number | null;
  /** Other shooters that also hit the victim within the window. */
  assists: number[];
  friendly: boolean;
  ejected: boolean;
  confidence: Confidence;
  /** For collisions: the other object. */
  otherUid: number | null;
  /** Engagement geometry for weapon kills (null for other causes). */
  details: KillDetails | null;
}

export interface KillDetails {
  /** When the deciding weapon (or round) was launched. */
  launchTime: number;
  /** Seconds from launch to the deciding hit. */
  flightTimeS: number;
  /** Distance between shooter and victim at launch. */
  launchRangeM: number | null;
  missDistanceM: number;
  shooterAltM: number | null;
  shooterSpeedMs: number | null;
  victimAltM: number | null;
  victimSpeedMs: number;
}

/** Scoreboard key: the pilot name, or "Type (Group)" for units without one. Shared with the UI. */
export function pilotKey(name: string, group: string, pilot: string): string {
  return pilot || `${name}${group ? ` (${group})` : ""}`;
}

export interface PilotStats {
  /** Pilot name, or "Name (Group)" for unnamed AI. */
  key: string;
  pilot: string;
  coalition: string;
  aircraft: string[];
  shots: number;
  gunBursts: number;
  /** Shots and gun bursts that hit at least one object. */
  hits: number;
  kills: number;
  airKills: number;
  groundKills: number;
  seaKills: number;
  friendlyKills: number;
  deaths: number;
}

export interface Analysis {
  shots: Shot[];
  kills: Kill[];
  /** Objects hit but still present at the end of the recording. */
  damaged: { uid: number; hits: number; lastHit: number }[];
  pilots: PilotStats[];
  /** uids of objects that are a continuation of an earlier object (remove/re-add glitch). */
  mergedLives: number;
  /** Batches of objects removed together without hits (not counted as deaths). */
  massRemovals: { time: number; count: number; atEnd: boolean }[];
  /**
   * Objects that vanished with no hit, collision, ejection or crash evidence: players leaving,
   * despawn scripts, or (in multiplayer client recordings) units going out of view. Not deaths.
   */
  removedWithoutEvidence: { aircraft: number; other: number };
  /**
   * Protected recordings: objects whose horizontal positions are scrambled, so they take no part
   * in shooter/hit/kill inference. `protectedHeader` is true when the file has a PlaybackKey.
   */
  scrambled: { objects: number; aircraft: number; protectedHeader: boolean };
  timingMs: number;
}

const has = (o: AcmiObject, tag: string) => o.tags.includes(tag);
export const isWeapon = (o: AcmiObject) => has(o, "Weapon");
export const isShell = (o: AcmiObject) => has(o, "Projectile");
const isAirGroundSea = (o: AcmiObject) => has(o, "Air") || has(o, "Ground") || has(o, "Sea");
/** Things that can launch weapons: aircraft, vehicles, ships, emplacements (not people, buildings, airfields). */
export const isPlatform = (o: AcmiObject) =>
  isAirGroundSea(o) &&
  !has(o, "Weapon") &&
  !isShell(o) &&
  !has(o, "Human") &&
  !has(o, "Building") &&
  !has(o, "Aerodrome");
/** Things that can be hit: platforms, buildings, people, and weapons (interceptions). */
const isHittable = (o: AcmiObject) =>
  (isAirGroundSea(o) || has(o, "Weapon")) && !isShell(o) && !has(o, "Aerodrome");
/** Things whose loss counts as a kill. */
export const isVictim = (o: AcmiObject) =>
  isAirGroundSea(o) && !has(o, "Weapon") && !isShell(o) && !has(o, "Human") && !has(o, "Aerodrome");
export const isAircraft = (o: AcmiObject) => has(o, "Air") && (has(o, "FixedWing") || has(o, "Rotorcraft"));

export function textAt(o: AcmiObject, key: string, t: number): string {
  const d = o.text[key];
  if (!d || d.values.length === 0) return "";
  const i = indexAt(d.times, t);
  return (i < 0 ? d.values[0] : d.values[i]) ?? "";
}

export function analyze(rec: Recording): Analysis {
  const started = performance.now();
  const geo = new Geo(rec);
  const objs = rec.objects;

  // Objects whose positions are scrambled (protected recordings) take no part in geometry.
  const usable = (o: AcmiObject) => !geo.scrambled(o);
  const platforms = objs.filter((o) => isPlatform(o) && usable(o));
  const platformIndex = new SpatialIndex(geo, platforms);
  const weapons = objs.filter(isWeapon);
  const weaponIndex = new SpatialIndex(geo, weapons.filter(usable));
  const hittables = objs.filter((o) => isHittable(o) && usable(o));
  const hitIndex = new SpatialIndex(geo, hittables);
  // Parachutists and ejection seats (DCS names seats like "PILOT_SU27_SEAT").
  const chutes = objs.filter((o) => (has(o, "Parachutist") || /SEAT/i.test(o.name)) && usable(o));
  const scrambledObjs = objs.filter((o) => (isPlatform(o) || isWeapon(o)) && geo.scrambled(o));

  // --- Shooters -------------------------------------------------------------------------------
  const shooterOf = new Map<number, ShooterInfo | null>();
  const findShooter = (w: AcmiObject, maxM: number): ShooterInfo | null => {
    if (geo.scrambled(w)) return null;
    const t = w.createdAt;
    const p = geo.pos(w, t);
    if (!p) return null;
    let best: { o: AcmiObject; d: number } | null = null;
    let bestAny: { o: AcmiObject; d: number } | null = null;
    for (const o of platformIndex.near(p, t, maxM)) {
      if (o === w) continue;
      const q = geo.pos(o, t);
      if (!q) continue;
      const d = dist(p, q);
      if (d > maxM) continue;
      if (!bestAny || d < bestAny.d) bestAny = { o, d };
      if ((!w.coalition || o.coalition === w.coalition) && (!best || d < best.d)) best = { o, d };
    }
    const pick = best ?? bestAny;
    if (pick) {
      const conf: Confidence =
        pick.d <= RULES.launchConfidentM && pick === best
          ? "high"
          : pick.d <= RULES.launchConfidentM
            ? "medium"
            : "low";
      return { uid: pick.o.uid, pilot: textAt(pick.o, "Pilot", t), distanceM: pick.d, confidence: conf };
    }
    // Sub-munitions: spawned next to another weapon of the same side; inherit its shooter.
    for (const o of weaponIndex.near(p, t, 200)) {
      if (o === w || o.createdAt >= w.createdAt) continue;
      const q = geo.pos(o, t);
      if (!q || dist(p, q) > 200) continue;
      const parent = shooterOf.get(o.uid);
      if (parent) return { ...parent, confidence: "low" };
    }
    return null;
  };

  // Parent= wins when the recorder provides it.
  const byId = new Map<string, AcmiObject[]>();
  for (const o of objs) {
    const l = byId.get(o.id);
    if (l) l.push(o);
    else byId.set(o.id, [o]);
  }
  const objectWithIdAt = (id: string, t: number): AcmiObject | null => {
    for (const o of byId.get(id) ?? []) if (geo.alive(o, t, 0.5)) return o;
    return null;
  };

  // --- Hits -----------------------------------------------------------------------------------
  const hitsOn = new Map<number, HitInfo[]>();
  const findHits = (w: AcmiObject, radius: number, shooterUid: number | null): HitInfo[] => {
    if (w.removedAt === null || geo.scrambled(w)) return [];
    const tEnd = w.removedAt;
    const last = geo.lastSample(w);
    if (!last) return [];
    const v = geo.lastVel(w);
    const gap = Math.min(1, Math.max(0, tEnd - last.t));
    // Pre-filter: the weapon and the target both move during the gap (targets up to ~Mach 3.5).
    const reach = radius + (Math.hypot(v[0], v[1], v[2]) + MAX_TARGET_SPEED_MS) * gap + 50;
    const out: HitInfo[] = [];
    for (const o of hitIndex.near(last.p, tEnd, reach)) {
      if (o === w || o.uid === shooterUid) continue;
      if (o.createdAt > tEnd) continue;
      const ca = geo.closestApproach(w, o, tEnd);
      if (ca && ca.d <= radius)
        out.push({ time: tEnd, weaponUid: w.uid, targetUid: o.uid, missDistanceM: ca.d });
    }
    out.sort((a, b) => a.missDistanceM - b.missDistanceM);
    for (const h of out) {
      const l = hitsOn.get(h.targetUid);
      if (l) l.push(h);
      else hitsOn.set(h.targetUid, [h]);
    }
    return out;
  };

  const shots: Shot[] = [];
  // Missiles, rockets, bombs, torpedoes.
  for (const w of [...weapons].sort((a, b) => a.createdAt - b.createdAt)) {
    let shooter: ShooterInfo | null = null;
    if (w.parent) {
      const p = objectWithIdAt(w.parent, w.createdAt);
      if (p)
        shooter = { uid: p.uid, pilot: textAt(p, "Pilot", w.createdAt), distanceM: 0, confidence: "high" };
    }
    shooter ??= findShooter(w, RULES.launchMaxM);
    shooterOf.set(w.uid, shooter);
    let lockedTargetUid: number | null = null;
    if (shooter) {
      const s = objs[shooter.uid] as AcmiObject;
      const lt = textAt(s, "LockedTarget", w.createdAt);
      const target = lt ? objectWithIdAt(lt.toLowerCase().replace(/^0+(?=.)/, ""), w.createdAt) : null;
      lockedTargetUid = target ? target.uid : null;
    }
    const hits = findHits(w, RULES.hitRadiusM, shooter?.uid ?? null);
    shots.push({
      weaponUid: w.uid,
      time: w.createdAt,
      rounds: 1,
      isGun: false,
      shooter,
      lockedTargetUid,
      endTime: w.removedAt,
      hits,
      outcome: hits.length ? "hit" : w.removedAt === null ? "active" : "miss",
      firstSeenInFlight: !shooter && geo.speed(w, w.createdAt) >= RULES.inFlightSpeedMs,
    });
  }

  // Guns: attribute each round, then group rounds into bursts per shooter.
  const shells = objs.filter(isShell).sort((a, b) => a.createdAt - b.createdAt);
  // Rounds from the same shooter less than BURST_GAP_S apart belong to one burst.
  const openBurst = new Map<number, { shot: Shot; lastSpawn: number }>();
  for (const s of shells) {
    const shooter = findShooter(s, RULES.shellLaunchMaxM);
    shooterOf.set(s.uid, shooter);
    const hits = findHits(s, RULES.shellHitRadiusM, shooter?.uid ?? null);
    const key = shooter?.uid ?? -1;
    const open = openBurst.get(key);
    if (open && s.createdAt - open.lastSpawn <= BURST_GAP_S) {
      const burst = open.shot;
      burst.rounds++;
      burst.hits.push(...hits);
      burst.endTime = Math.max(burst.endTime ?? burst.time, s.removedAt ?? s.createdAt);
      open.lastSpawn = s.createdAt;
      if (hits.length) burst.outcome = "hit";
      continue;
    }
    const shot: Shot = {
      weaponUid: s.uid,
      time: s.createdAt,
      rounds: 1,
      isGun: true,
      shooter,
      lockedTargetUid: null,
      endTime: s.removedAt ?? s.createdAt,
      hits: [...hits],
      outcome: hits.length ? "hit" : "miss",
      firstSeenInFlight: false,
    };
    openBurst.set(key, { shot, lastSpawn: s.createdAt });
    shots.push(shot);
  }
  shots.sort((a, b) => a.time - b.time);

  // --- Entities: merge remove/re-add glitches ------------------------------------------------
  const nextLife = new Map<number, number>();
  let mergedLives = 0;
  for (const o of objs) {
    if (o.previousUid === null || o.reappearGap === null) continue;
    const p = objs[o.previousUid];
    if (p && o.reappearGap <= RULES.glitchGapS && p.name === o.name && p.type === o.type) {
      nextLife.set(p.uid, o.uid);
      mergedLives++;
    }
  }
  const continuation = new Set(nextLife.values());

  // --- Kills ----------------------------------------------------------------------------------
  const kills: Kill[] = [];
  const damaged: Analysis["damaged"] = [];
  const removedVictims: AcmiObject[] = [];
  for (const root of objs) {
    if (!isVictim(root) || continuation.has(root.uid)) continue;
    // Without real positions we can't tell a kill from a player leaving; only explicit events count.
    if (geo.scrambled(root) && root.destroyedAt === null) continue;
    // Walk the chain of lives to the last one; collect hits from all of them.
    const lives = [root];
    for (let u = nextLife.get(root.uid); u !== undefined; u = nextLife.get(u))
      lives.push(objs[u] as AcmiObject);
    const last = lives[lives.length - 1] as AcmiObject;
    const hits = lives.flatMap((l) => hitsOn.get(l.uid) ?? []).sort((a, b) => a.time - b.time);
    const deathTime = last.destroyedAt ?? last.removedAt;
    if (deathTime === null) {
      if (hits.length)
        damaged.push({ uid: last.uid, hits: hits.length, lastHit: (hits[hits.length - 1] as HitInfo).time });
      continue;
    }
    removedVictims.push(last);
    const window = hits.filter((h) => h.time <= deathTime + 0.05 && deathTime - h.time <= RULES.killWindowS);
    const ejected = detectEjection(last, deathTime);
    if (window.length) {
      const decisive = window[window.length - 1] as HitInfo;
      const weapon = objs[decisive.weaponUid] as AcmiObject;
      const killer = shooterOf.get(weapon.uid) ?? null;
      const others = new Set<number>();
      for (const h of window) {
        const s = shooterOf.get(h.weaponUid);
        if (s && s.uid !== killer?.uid) others.add(s.uid);
      }
      // A round can be logged as removed a frame after its victim; that still counts as 0 s.
      const dt = Math.max(0, deathTime - decisive.time);
      const killerObj = killer ? (objs[killer.uid] as AcmiObject) : null;
      // The victim object alive at launch (it may be an earlier life of a glitch chain).
      const launch = weapon.createdAt;
      const victimAtLaunch = lives.find((l) => geo.alive(l, launch)) ?? last;
      const pk = killerObj ? geo.pos(killerObj, launch) : null;
      const pv = geo.pos(victimAtLaunch, launch);
      kills.push({
        time: deathTime,
        victimUid: last.uid,
        victimPilot: textAt(last, "Pilot", deathTime),
        cause: "weapon",
        killer,
        weaponUid: weapon.uid,
        weaponName: weapon.name,
        isGun: isShell(weapon),
        secondsAfterHit: dt,
        assists: [...others],
        friendly: !!killerObj && !!killerObj.coalition && killerObj.coalition === last.coalition,
        ejected,
        confidence: dt <= 2 && killer?.confidence === "high" ? "high" : dt <= 30 && killer ? "medium" : "low",
        otherUid: null,
        details: {
          launchTime: launch,
          flightTimeS: decisive.time - launch,
          launchRangeM: pk && pv ? dist(pk, pv) : null,
          missDistanceM: decisive.missDistanceM,
          shooterAltM: killerObj ? geo.altAt(killerObj, launch) : null,
          shooterSpeedMs: killerObj ? geo.speed(killerObj, launch) : null,
          victimAltM: geo.altAt(victimAtLaunch, launch),
          victimSpeedMs: geo.speed(victimAtLaunch, launch),
        },
      });
      continue;
    }
    kills.push({
      time: deathTime,
      victimUid: last.uid,
      victimPilot: textAt(last, "Pilot", deathTime),
      cause: "unknown",
      killer: null,
      weaponUid: null,
      weaponName: "",
      isGun: false,
      secondsAfterHit: null,
      assists: [],
      friendly: false,
      ejected,
      confidence: "low",
      otherUid: null,
      details: null,
    });
  }

  // Removals without a hit that are really the recording ending or a mass despawn, not deaths.
  const massRemovals: Analysis["massRemovals"] = [];
  {
    const byTime = new Map<string, Kill[]>();
    for (const k of kills) {
      if (k.cause !== "unknown") continue;
      const key = k.time.toFixed(3);
      const l = byTime.get(key);
      if (l) l.push(k);
      else byTime.set(key, [k]);
    }
    const drop = new Set<Kill>();
    for (const batch of byTime.values()) {
      const t = (batch[0] as Kill).time;
      const atEnd = t >= rec.timeEnd - RULES.endGraceS;
      if (atEnd || batch.length >= RULES.massRemovalCount) {
        massRemovals.push({ time: t, count: batch.length, atEnd });
        for (const k of batch) drop.add(k);
      }
    }
    if (drop.size) {
      const kept = kills.filter((k) => !drop.has(k));
      kills.length = 0;
      kills.push(...kept);
    }
    massRemovals.sort((a, b) => a.time - b.time);
  }

  // Classify deaths without a weapon: collision, crash, despawn.
  for (const k of kills) {
    if (k.cause !== "unknown") continue;
    const v = objs[k.victimUid] as AcmiObject;
    if (!isAircraft(v)) continue;
    const t = k.time;
    const tLast = geo.lastSample(v)?.t ?? t;
    const speed = geo.speed(v, Math.max(v.createdAt, tLast - 0.5));
    // Slow or parked (after landing, on the ramp): a despawn, never a collision or crash.
    if (speed < RULES.despawnSpeedMs) {
      k.cause = "despawn";
      continue;
    }
    const pv = geo.pos(v, t);
    const other = removedVictims.find(
      (o) =>
        o !== v &&
        isAircraft(o) &&
        Math.abs((o.destroyedAt ?? o.removedAt ?? Number.NaN) - t) <= RULES.collisionWindowS &&
        pv !== null &&
        (() => {
          const po = geo.pos(o, t);
          return po !== null && dist(pv, po) <= RULES.collisionRadiusM;
        })(),
    );
    if (other) {
      k.cause = "collision";
      k.otherUid = other.uid;
      k.confidence = "medium";
      continue;
    }
    // A crash needs evidence: sinking fast, reaching the surface while moving, or an ejection.
    // Without it, an aircraft vanishing in flight is a player leaving, a despawn, or going out of view.
    const alt = geo.altAt(v, tLast);
    const altBefore = geo.altAt(v, tLast - 1);
    const sink = alt !== null && altBefore !== null ? altBefore - alt : 0;
    const atSurface = alt !== null && alt <= RULES.surfaceAltM;
    if (k.ejected || atSurface || sink >= RULES.crashSinkMs) {
      k.cause = "crash";
      k.confidence = k.ejected || atSurface ? "medium" : "low";
    }
  }
  // Aircraft that despawned, and anything that vanished without any evidence of being destroyed,
  // are not deaths. They are counted separately.
  const removedWithoutEvidence = { aircraft: 0, other: 0 };
  const deaths = kills.filter((k) => {
    if (k.cause === "despawn") return false;
    if (k.cause !== "unknown") return true;
    if (isAircraft(objs[k.victimUid] as AcmiObject)) removedWithoutEvidence.aircraft++;
    else removedWithoutEvidence.other++;
    return false;
  });
  deaths.sort((a, b) => a.time - b.time);

  return {
    shots,
    kills: deaths,
    damaged,
    pilots: pilotStats(rec, shots, deaths),
    massRemovals,
    removedWithoutEvidence,
    scrambled: {
      objects: scrambledObjs.length,
      aircraft: scrambledObjs.filter(isAircraft).length,
      protectedHeader: rec.globals.PlaybackKey !== undefined,
    },
    mergedLives,
    timingMs: performance.now() - started,
  };

  function detectEjection(v: AcmiObject, t: number): boolean {
    if (!isAircraft(v)) return false;
    const pv = geo.pos(v, t);
    if (!pv) return false;
    for (const o of chutes) {
      if (Math.abs(o.createdAt - t) > RULES.ejectWindowS) continue;
      const po = geo.pos(o, o.createdAt);
      if (po && dist(pv, po) <= RULES.ejectRadiusM) return true;
    }
    return false;
  }
}

const BURST_GAP_S = 1;
const MAX_TARGET_SPEED_MS = 1200;

function pilotStats(rec: Recording, shots: Shot[], kills: Kill[]): PilotStats[] {
  const objs = rec.objects;
  const stats = new Map<string, PilotStats>();
  const keyFor = (o: AcmiObject, pilot: string) => pilotKey(o.name, o.group, pilot);
  const get = (uid: number, pilot: string): PilotStats => {
    const o = objs[uid] as AcmiObject;
    const key = keyFor(o, pilot);
    let s = stats.get(key);
    if (!s) {
      s = {
        key,
        pilot,
        coalition: o.coalition,
        aircraft: [],
        shots: 0,
        gunBursts: 0,
        hits: 0,
        kills: 0,
        airKills: 0,
        groundKills: 0,
        seaKills: 0,
        friendlyKills: 0,
        deaths: 0,
      };
      stats.set(key, s);
    }
    if (o.name && !s.aircraft.includes(o.name)) s.aircraft.push(o.name);
    return s;
  };
  for (const sh of shots) {
    if (!sh.shooter) continue;
    const s = get(sh.shooter.uid, sh.shooter.pilot);
    if (sh.isGun) s.gunBursts++;
    else s.shots++;
    // Shots (or bursts) that hit at least one object; a blast can hit several.
    if (sh.hits.length) s.hits++;
  }
  for (const k of kills) {
    const v = objs[k.victimUid] as AcmiObject;
    get(k.victimUid, k.victimPilot).deaths++;
    if (!k.killer) continue;
    const s = get(k.killer.uid, k.killer.pilot);
    if (k.friendly) {
      s.friendlyKills++;
      continue;
    }
    s.kills++;
    if (has(v, "Air")) s.airKills++;
    else if (has(v, "Sea")) s.seaKills++;
    else s.groundKills++;
  }
  return [...stats.values()]
    .filter((s) => s.shots + s.gunBursts + s.kills + s.deaths + s.friendlyKills > 0)
    .sort((a, b) => b.kills - a.kills || b.shots - a.shots || a.key.localeCompare(b.key));
}
