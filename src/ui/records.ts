import type { ObjectSummary, RecordingSummary } from "../acmi/summary.ts";
import { type Analysis, type Kill, type PilotStats, pilotKey, type Shot } from "../analysis/analyze.ts";

/**
 * Plain-text records built from an Analysis: one source for the tables, search, filters and CSV export.
 * No React here so it can be unit-tested.
 */

export type Clock = "elapsed" | "timeOfDay";

export interface Party {
  /** Scoreboard key (pilot name, or "Type (Group)"). */
  key: string;
  pilot: string;
  aircraft: string;
  /** Tacview colour (Red, Blue, …): what users know as the side. */
  side: string;
  id: string;
  uid: number;
}

export interface KillRecord {
  kill: Kill;
  victim: Party;
  killer: Party | null;
  other: Party | null;
  weapon: string;
  cause: string;
  notes: string[];
  assists: Party[];
  searchText: string;
}

export interface ShotRecord {
  shot: Shot;
  shooter: Party | null;
  weapon: string;
  lockedTarget: Party | null;
  targets: Party[];
  result: string;
  searchText: string;
}

export interface Filter {
  /** Colour name, or "" for all sides. */
  side: string;
  /** Pilot key, or "" for everyone. */
  pilot: string;
  text: string;
}

export const NO_FILTER: Filter = { side: "", pilot: "", text: "" };

export function party(o: ObjectSummary | null | undefined, pilotAtTime: string): Party | null {
  if (!o) return null;
  const pilot = pilotAtTime || o.pilot;
  return {
    key: pilotKey(o.name, o.group, pilot),
    pilot,
    aircraft: o.name,
    side: o.color || o.coalition,
    id: o.id,
    uid: o.uid,
  };
}

export function partyLabel(p: Party | null): string {
  if (!p) return "";
  return p.pilot ? `${p.pilot} (${p.aircraft})` : p.aircraft;
}

export function weaponLabel(name: string, isGun: boolean): string {
  if (!name) return "";
  if (isGun) return `Gun (${name.replace(/^weapons\.shells\./, "").replace(/_/g, " ")})`;
  return name.replace(/_/g, "-");
}

const CAUSE_TEXT: Record<Kill["cause"], string> = {
  weapon: "Shot down / destroyed",
  collision: "Collision",
  crash: "Crashed (no weapon hit found)",
  despawn: "Despawned",
  unknown: "Unknown",
};

export function killRecords(summary: RecordingSummary, analysis: Analysis): KillRecord[] {
  const objs = summary.objects;
  return analysis.kills.map((k) => {
    const victimObj = objs[k.victimUid];
    const victim = party(victimObj, k.victimPilot) as Party;
    const killerObj = k.killer ? objs[k.killer.uid] : null;
    const killer = k.killer ? party(killerObj, k.killer.pilot) : null;
    const other = k.otherUid !== null ? party(objs[k.otherUid], "") : null;
    const assists = k.assists.map((u) => party(objs[u], "")).filter((p): p is Party => p !== null);
    const notes: string[] = [];
    if (k.friendly) notes.push("friendly fire");
    if (k.ejected) notes.push("pilot ejected");
    if (killerObj && killerObj.removedAt !== null && killerObj.removedAt < k.time - 0.05)
      notes.push("shooter already down");
    if (k.secondsAfterHit !== null && k.secondsAfterHit > 2)
      notes.push(`went down ${k.secondsAfterHit.toFixed(0)} s after the hit`);
    if (assists.length) notes.push(`also hit by ${assists.map(partyLabel).join(", ")}`);
    if (k.confidence !== "high") notes.push(`${k.confidence} confidence`);
    const weapon = k.cause === "weapon" ? weaponLabel(k.weaponName, k.isGun) : "";
    const cause = CAUSE_TEXT[k.cause];
    const searchText = [partyLabel(victim), partyLabel(killer), partyLabel(other), weapon, cause, ...notes]
      .join(" ")
      .toLowerCase();
    return { kill: k, victim, killer, other, weapon, cause, notes, assists, searchText };
  });
}

export function shotRecords(summary: RecordingSummary, analysis: Analysis): ShotRecord[] {
  const objs = summary.objects;
  return analysis.shots.map((s) => {
    const shooter = s.shooter ? party(objs[s.shooter.uid], s.shooter.pilot) : null;
    const weapon = weaponLabel(objs[s.weaponUid]?.name ?? "", s.isGun);
    const lockedTarget = s.lockedTargetUid !== null ? party(objs[s.lockedTargetUid], "") : null;
    const targets = [...new Set(s.hits.map((h) => h.targetUid))]
      .map((u) => party(objs[u], ""))
      .filter((p): p is Party => p !== null);
    const result =
      s.outcome === "hit"
        ? `Hit ${targets.map(partyLabel).join(", ")}`
        : s.outcome === "active"
          ? "Still flying at the end"
          : "Missed";
    const searchText = [partyLabel(shooter), weapon, partyLabel(lockedTarget), result]
      .join(" ")
      .toLowerCase();
    return { shot: s, shooter, weapon, lockedTarget, targets, result, searchText };
  });
}

const textMatches = (searchText: string, q: string) => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((w) => searchText.includes(w));
};

export function killMatches(r: KillRecord, f: Filter): boolean {
  const involved = [r.victim, r.killer, r.other];
  if (f.side && !involved.some((p) => p?.side === f.side)) return false;
  if (f.pilot && !involved.some((p) => p?.key === f.pilot)) return false;
  return textMatches(r.searchText, f.text);
}

export function shotMatches(r: ShotRecord, f: Filter): boolean {
  if (f.side && r.shooter?.side !== f.side && !r.targets.some((t) => t.side === f.side)) return false;
  if (f.pilot && r.shooter?.key !== f.pilot && !r.targets.some((t) => t.key === f.pilot)) return false;
  return textMatches(r.searchText, f.text);
}

export function pilotMatches(p: PilotStats, side: string, f: Filter): boolean {
  if (f.side && side !== f.side) return false;
  if (f.pilot && p.key !== f.pilot) return false;
  return textMatches(`${p.key} ${p.aircraft.join(" ")}`.toLowerCase(), f.text);
}

/** Side (colour) of each pilot key, taken from the objects they flew. */
export function pilotSides(summary: RecordingSummary): Map<string, string> {
  const m = new Map<string, string>();
  for (const o of summary.objects) {
    const key = pilotKey(o.name, o.group, o.pilot);
    if (!m.has(key) && (o.color || o.coalition)) m.set(key, o.color || o.coalition);
  }
  return m;
}

// --- Time -----------------------------------------------------------------------------------------

export function formatElapsed(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/** In-mission time of day (UTC, as the simulator reports it), or null if ReferenceTime is missing. */
export function timeOfDay(referenceTime: string | null, sec: number): string | null {
  if (!referenceTime) return null;
  const base = Date.parse(referenceTime);
  if (Number.isNaN(base)) return null;
  return new Date(base + sec * 1000).toISOString().slice(11, 19);
}

export function formatClock(clock: Clock, referenceTime: string | null, sec: number): string {
  return clock === "timeOfDay" ? (timeOfDay(referenceTime, sec) ?? formatElapsed(sec)) : formatElapsed(sec);
}

// --- Units ------------------------------------------------------------------------------------------

export const fmtAlt = (m: number | null) =>
  m === null ? "–" : `${Math.round(m).toLocaleString()} m (${Math.round(m * 3.28084).toLocaleString()} ft)`;
export const fmtSpeed = (ms: number | null) =>
  ms === null
    ? "–"
    : `${Math.round(ms * 3.6).toLocaleString()} km/h (${Math.round(ms * 1.943844).toLocaleString()} kt)`;
export const fmtRange = (m: number | null) =>
  m === null
    ? "–"
    : m < 1000
      ? `${Math.round(m)} m`
      : `${(m / 1000).toFixed(1)} km (${(m / 1852).toFixed(1)} nm)`;

// --- CSV ----------------------------------------------------------------------------------------------

type Cell = string | number | boolean | null;

/**
 * RFC 4180 CSV with a UTF-8 BOM (so Excel reads non-ASCII names) and CRLF line ends.
 * Text cells that start with = + - @ are prefixed with ' so spreadsheets don't run them as formulas;
 * pilot names in multiplayer recordings are chosen by other people.
 */
export function toCsv(header: string[], rows: Cell[][]): string {
  const cell = (v: Cell): string => {
    if (v === null) return "";
    if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "";
    if (typeof v === "boolean") return v ? "yes" : "no";
    let s = v;
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${[header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

export function killsCsv(records: KillRecord[], referenceTime: string | null): string {
  return toCsv(
    [
      "Time (s)",
      "Time of day (UTC)",
      "Lost pilot",
      "Lost aircraft",
      "Lost side",
      "Killer pilot",
      "Killer aircraft",
      "Killer side",
      "Weapon",
      "Cause",
      "Launch range (m)",
      "Weapon flight time (s)",
      "Miss distance (m)",
      "Seconds after hit",
      "Friendly fire",
      "Pilot ejected",
      "Confidence",
      "Also hit by",
      "Lost object ID",
      "Killer object ID",
    ],
    records.map((r) => {
      const k = r.kill;
      const d = k.details;
      return [
        k.time,
        timeOfDay(referenceTime, k.time),
        r.victim.pilot,
        r.victim.aircraft,
        r.victim.side,
        r.killer?.pilot ?? (r.other ? partyLabel(r.other) : ""),
        r.killer?.aircraft ?? "",
        r.killer?.side ?? r.other?.side ?? "",
        r.weapon,
        r.cause,
        d?.launchRangeM ?? null,
        d?.flightTimeS ?? null,
        d?.missDistanceM ?? null,
        k.secondsAfterHit,
        k.friendly,
        k.ejected,
        k.confidence,
        r.assists.map(partyLabel).join("; "),
        r.victim.id,
        r.killer?.id ?? "",
      ];
    }),
  );
}

export function shotsCsv(records: ShotRecord[], referenceTime: string | null): string {
  return toCsv(
    [
      "Time (s)",
      "Time of day (UTC)",
      "Shooter pilot",
      "Shooter aircraft",
      "Shooter side",
      "Weapon",
      "Rounds",
      "Locked target",
      "Result",
      "Targets hit",
      "Shooter confidence",
    ],
    records.map((r) => [
      r.shot.time,
      timeOfDay(referenceTime, r.shot.time),
      r.shooter?.pilot ?? "",
      r.shooter?.aircraft ?? "",
      r.shooter?.side ?? "",
      r.weapon,
      r.shot.rounds,
      partyLabel(r.lockedTarget),
      r.shot.outcome,
      r.targets.map(partyLabel).join("; "),
      r.shot.shooter?.confidence ?? "",
    ]),
  );
}

export function pilotsCsv(pilots: PilotStats[], sides: Map<string, string>): string {
  return toCsv(
    [
      "Pilot",
      "Side",
      "Aircraft",
      "Kills",
      "Air kills",
      "Ground kills",
      "Sea kills",
      "Friendly kills",
      "Deaths",
      "Shots",
      "Gun bursts",
      "Hits",
    ],
    pilots.map((p) => [
      p.key,
      sides.get(p.key) ?? p.coalition,
      p.aircraft.join("; "),
      p.kills,
      p.airKills,
      p.groundKills,
      p.seaKills,
      p.friendlyKills,
      p.deaths,
      p.shots,
      p.gunBursts,
      p.hits,
    ]),
  );
}

/** A file-name-safe base from the mission title or file name. */
export function exportBaseName(summary: RecordingSummary, fileName: string): string {
  const raw = summary.globals.Title || fileName.replace(/(\.zip|\.txt)?\.acmi$/i, "");
  return raw.replace(/[\\/:*?"<>|]+/g, "_").trim() || "recording";
}
