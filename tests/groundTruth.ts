import { readFileSync } from "node:fs";
import type { AcmiObject, Recording } from "../src/acmi/model.ts";
import type { Analysis } from "../src/analysis/analyze.ts";

/**
 * Score our inferred shots and hits against an event log exported from Tacview itself
 * (CSV with Mission Time, Primary/Secondary/Relevant Object columns).
 *
 * Tacview shows display names ("F/A-18C Hornet") where the file has DCS type names
 * ("FA-18C_hornet"), and renumbers object IDs, so rows are matched by time, names and pilots.
 */

export interface TacviewRow {
  time: number;
  primaryName: string;
  primaryPilot: string;
  event: string;
  secondaryName: string;
  relevantName: string;
  relevantPilot: string;
}

export function readTacviewCsv(path: string): TacviewRow[] {
  const text = readFileSync(path, "utf8").replace(/^﻿/, "");
  const [header, ...lines] = text.split(/\r?\n/).filter((l) => l.length > 0);
  const cols = (header ?? "").split(",");
  const ix = (name: string) => {
    const i = cols.indexOf(name);
    if (i < 0) throw new Error(`CSV column missing: ${name}`);
    return i;
  };
  const c = {
    time: ix("Mission Time"),
    pName: ix("Primary Object Name"),
    pPilot: ix("Primary Object Pilot"),
    event: ix("Event"),
    sName: ix("Secondary Object Name"),
    rName: ix("Relevant Object Name"),
    rPilot: ix("Relevant Object Pilot"),
  };
  return lines.map((l) => {
    const f = l.split(",");
    return {
      time: Number(f[c.time]),
      primaryName: f[c.pName] ?? "",
      primaryPilot: f[c.pPilot] ?? "",
      event: f[c.event] ?? "",
      secondaryName: f[c.sName] ?? "",
      relevantName: f[c.rName] ?? "",
      relevantPilot: f[c.rPilot] ?? "",
    };
  });
}

export interface Score {
  fired: { tacview: number; matched: number; shooterAgrees: number; mismatches: string[] };
  hits: {
    tacview: number;
    ours: number;
    matched: number;
    missed: string[];
    extra: { time: number; victim: string; weapon: string; d: number }[];
  };
}

/**
 * @param displayName maps a DCS type name to Tacview's display name (unknown names pass through).
 */
export function score(
  rec: Recording,
  a: Analysis,
  rows: TacviewRow[],
  displayName: (dcsName: string) => string,
): Score {
  const objs = rec.objects;
  const name = (uid: number) => displayName((objs[uid] as AcmiObject).name);
  const near = (x: number, y: number) => Math.abs(x - y) < 0.06;

  // HasFired: Primary = shooter (with pilot at the time), Secondary = weapon.
  const firedRows = rows.filter((r) => r.event === "HasFired");
  const shots = a.shots.filter((s) => !s.isGun);
  const usedShots = new Set<number>();
  let matched = 0;
  let shooterAgrees = 0;
  const firedMismatch: string[] = [];
  for (const r of firedRows) {
    const s = shots.find(
      (x) => !usedShots.has(x.weaponUid) && near(x.time, r.time) && name(x.weaponUid) === r.secondaryName,
    );
    if (!s) {
      firedMismatch.push(`no shot for ${r.time} ${r.secondaryName}`);
      continue;
    }
    usedShots.add(s.weaponUid);
    matched++;
    const ourShooter = s.shooter ? `${name(s.shooter.uid)}/${s.shooter.pilot}` : "(none)";
    const theirs = `${r.primaryName}/${r.primaryPilot}`;
    if (ourShooter === theirs) shooterAgrees++;
    else firedMismatch.push(`${r.time} ${r.secondaryName}: Tacview says ${theirs}, we say ${ourShooter}`);
  }

  // HasBeenHitBy: Primary = victim, Secondary = weapon, Relevant = weapon's shooter.
  const hitRows = rows.filter((r) => r.event === "HasBeenHitBy");
  const ourHits = a.shots.flatMap((s) =>
    s.isGun
      ? []
      : s.hits.map((h) => ({
          time: h.time,
          victim: name(h.targetUid),
          weapon: name(h.weaponUid),
          d: h.missDistanceM,
          used: false,
        })),
  );
  let hitMatched = 0;
  const missed: string[] = [];
  for (const r of hitRows) {
    const h = ourHits.find(
      (x) => !x.used && near(x.time, r.time) && x.victim === r.primaryName && x.weapon === r.secondaryName,
    );
    if (h) {
      h.used = true;
      hitMatched++;
    } else missed.push(`${r.time} ${r.primaryName} hit by ${r.secondaryName}`);
  }
  const extra = ourHits
    .filter((h) => !h.used)
    .map(({ time, victim, weapon, d }) => ({ time, victim, weapon, d }))
    .sort((x, y) => x.time - y.time);
  return {
    fired: { tacview: firedRows.length, matched, shooterAgrees, mismatches: firedMismatch },
    hits: { tacview: hitRows.length, ours: ourHits.length, matched: hitMatched, missed, extra },
  };
}
