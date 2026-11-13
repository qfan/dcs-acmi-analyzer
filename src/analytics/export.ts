import type { ShotTacticalMetrics } from "./derive.ts";
import { EXTRACTOR_VERSION, type FileAnalytics, type MissileEngagement } from "./model.ts";

const NM = 1852;
const FT = 1 / 0.3048;

function csvCell(val: string | number | boolean | null | undefined): string {
  if (val === null || val === undefined) return "";
  const s = typeof val === "number" ? (Number.isFinite(val) ? String(val) : "") : String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function engagementsToCsv(
  engagements: MissileEngagement[],
  tacticsById?: Map<string, ShotTacticalMetrics>,
): string {
  const headers = [
    "file",
    "mission",
    "dcs_patch",
    "recorded_at",
    "launch_time_s",
    "weapon",
    "weapon_class",
    "domain",
    "outcome",
    "is_kill",
    "defeat_mode",
    "shooter_pilot",
    "shooter_aircraft",
    "shooter_side",
    "shooter_alt_ft",
    "shooter_mach",
    "target_pilot",
    "target_aircraft",
    "target_side",
    "target_alt_ft",
    "target_mach",
    "slant_range_nm",
    "slant_range_km",
    "aspect_deg",
    "aspect_category",
    "altitude_relation",
    "alt_diff_ft",
    "look_angle_deg",
    "closure_kt",
    "tof_s",
    "max_missile_mach",
    "end_missile_mach",
    "loft_gain_ft",
    "cpa_m",
    "f_pole_nm",
    "shooter_max_crank_deg",
    "target_defense",
    "target_reaction_s",
    "died_unaware",
    "min_beam_offset_deg",
    "min_radial_vel_ms",
    "time_in_notch_s",
    "target_chaff",
    "target_flare",
  ];

  const rows = [headers.join(",")];
  for (const e of engagements) {
    const ic = e.initial;
    const fl = e.flight;
    const tac = tacticsById?.get(e.id);
    const r = [
      e.fileName,
      e.missionTitle,
      e.dcsPatch,
      e.recordedAt,
      e.launchTime.toFixed(1),
      e.weaponName,
      e.weaponClass,
      e.domain,
      e.outcome,
      e.isKill ? 1 : 0,
      tac?.defeatMode ?? "",
      e.shooter?.pilot ?? "",
      e.shooter?.name ?? "",
      e.shooter?.side ?? "",
      e.shooter?.altM !== null && e.shooter?.altM !== undefined ? Math.round(e.shooter.altM * FT) : "",
      e.shooter?.mach !== null && e.shooter?.mach !== undefined ? e.shooter.mach.toFixed(2) : "",
      e.target?.pilot ?? "",
      e.target?.name ?? "",
      e.target?.side ?? "",
      e.target?.altM !== null && e.target?.altM !== undefined ? Math.round(e.target.altM * FT) : "",
      e.target?.mach !== null && e.target?.mach !== undefined ? e.target.mach.toFixed(2) : "",
      ic ? (ic.slantRangeM / NM).toFixed(2) : "",
      ic ? (ic.slantRangeM / 1000).toFixed(2) : "",
      ic ? ic.aspectDeg.toFixed(1) : "",
      ic?.aspectCategory ?? "",
      ic?.altitudeRelation ?? "",
      ic ? Math.round(ic.altDiffM * FT) : "",
      ic ? ic.lookAngleDeg.toFixed(1) : "",
      ic ? Math.round(ic.closureMs * 1.94384) : "",
      (fl?.tofS ?? e.flightTimeS)?.toFixed(1) ?? "",
      fl ? fl.maxMach.toFixed(2) : "",
      fl ? fl.endMach.toFixed(2) : "",
      fl ? Math.round(fl.apexGainM * FT) : "",
      e.missDistanceM !== null ? Math.round(e.missDistanceM) : "",
      e.fPoleRangeM !== null ? (e.fPoleRangeM / NM).toFixed(2) : "",
      tac?.maxShooterCrankDeg !== null && tac?.maxShooterCrankDeg !== undefined
        ? tac.maxShooterCrankDeg.toFixed(1)
        : "",
      tac?.defenseType ?? "",
      tac?.reactionTimeS !== null && tac?.reactionTimeS !== undefined ? tac.reactionTimeS.toFixed(1) : "",
      tac ? (tac.diedUnaware ? 1 : 0) : "",
      tac?.minBeamOffsetDeg !== null && tac?.minBeamOffsetDeg !== undefined
        ? tac.minBeamOffsetDeg.toFixed(1)
        : "",
      tac?.minRadialVelMs !== null && tac?.minRadialVelMs !== undefined ? Math.round(tac.minRadialVelMs) : "",
      tac ? tac.timeInNotchS.toFixed(1) : "",
      tac?.targetChaffCount ?? "",
      tac?.targetFlareCount ?? "",
    ];
    rows.push(r.map(csvCell).join(","));
  }
  return rows.join("\n");
}

export interface SerializedDatasetBundle {
  format: "tacview-analytics-dataset";
  extractorVersion: number;
  exportedAt: string;
  files: FileAnalytics[];
}

const CALLSIGN_WINGS = [
  "Viper",
  "Hornet",
  "Tomcat",
  "Eagle",
  "Falcon",
  "Raptor",
  "Phantom",
  "Cobra",
  "Hawkeye",
  "Mustang",
  "Sabre",
  "Lightning",
  "Banshee",
  "Reaper",
  "Spartan",
  "Titan",
];

function isGenericAiPilotName(name: string): boolean {
  const s = name.trim();
  if (!s) return true;
  return (
    /^(Aerial|Ground|Rotary)[-\s]\d+/i.test(s) ||
    /^(MiG|Su|F-|FA-|J-|JF-)[-\s\dA-Z]+$/i.test(s) ||
    /^New callsign$/i.test(s) ||
    /^Adversary/i.test(s) ||
    /^\d+\.\d+$/.test(s)
  );
}

function callsignPrefixForAircraft(aircraft: string): string {
  const u = aircraft.toUpperCase();
  if (u.includes("16")) return "Viper";
  if (u.includes("18")) return "Hornet";
  if (u.includes("14")) return "Tomcat";
  if (u.includes("15")) return "Eagle";
  if (u.includes("27") || u.includes("30") || u.includes("33") || u.includes("J-11")) return "Flanker";
  if (u.includes("29")) return "Fulcrum";
  if (u.includes("31") || u.includes("25")) return "Foxhound";
  if (u.includes("17")) return "Thunder";
  if (u.includes("2000")) return "Mirage";
  return "";
}

const REDACTED_WINGS = new Set([...CALLSIGN_WINGS, "Flanker", "Fulcrum", "Foxhound", "Thunder", "Mirage"]);

/** True for a callsign this module produced (`Viper 1-1`), so re-redacting leaves it alone. */
function isRedactedCallsign(name: string): boolean {
  const m = /^([A-Za-z]+) \d+-\d+$/.exec(name);
  return m !== null && REDACTED_WINGS.has(m[1] as string);
}

/** Prefix every file and engagement ID so bundles loaded from different sources cannot collide. */
export function namespaceFileIds(files: FileAnalytics[], namespace: string): FileAnalytics[] {
  return files.map((f) => {
    const fileId = `${namespace}:${f.fileId}`;
    return {
      ...f,
      fileId,
      engagements: f.engagements.map((e) => ({ ...e, id: `${namespace}:${e.id}`, fileId })),
    };
  });
}

/**
 * Redact all player names, squadron tags (recording author, group names), filenames, file IDs
 * and mission titles in a dataset with deterministic tactical callsigns (`Viper 1-1`,
 * `Hornet 2-1`, etc.) and generic sortie titles so the dataset can be safely published in a
 * public repository. Running it again on redacted data keeps the existing callsigns.
 */
export function anonymizeDataset(files: FileAnalytics[], options?: { idPrefix?: string }): FileAnalytics[] {
  const idPrefix = options?.idPrefix ?? "bvr-sortie-";
  const pilotMap = new Map<string, string>();
  const wingCounters = new Map<string, number>();
  let fallbackIdx = 0;

  const mapPilot = (pilot: string | undefined, aircraft: string | undefined): string => {
    const raw = (pilot ?? "").trim();
    if (!raw) return "";
    if (isGenericAiPilotName(raw) || isRedactedCallsign(raw)) return raw;
    const existing = pilotMap.get(raw);
    if (existing) return existing;

    const acPrefix = callsignPrefixForAircraft(aircraft ?? "");
    const wing = acPrefix || CALLSIGN_WINGS[fallbackIdx++ % CALLSIGN_WINGS.length]!;
    const n = (wingCounters.get(wing) ?? 0) + 1;
    wingCounters.set(wing, n);
    const flightNum = Math.floor((n - 1) / 4) + 1;
    const elemNum = ((n - 1) % 4) + 1;
    const callsign = `${wing} ${flightNum}-${elemNum}`;
    pilotMap.set(raw, callsign);
    return callsign;
  };

  return files.map((f, idx) => {
    const num = String(idx + 1).padStart(2, "0");
    const patchTag = f.meta.dcsPatch ? `DCS ${f.meta.dcsPatch}` : "DCS";
    const datePart = f.meta.recordedAt ? f.meta.recordedAt.slice(0, 10) : "";
    const fileId = `${idPrefix}${num}`;
    const fileName = `bvr-sortie-${num}${datePart ? `-${datePart}` : ""}.acmi`;
    const missionTitle = `BVR Multiplayer Sortie #${num} (${patchTag}${datePart ? ` · ${datePart}` : ""})`;

    return {
      ...f,
      fileId,
      fileName,
      missionTitle,
      meta: {
        ...f.meta,
        // Author is typically "<squadron> | <handle>": never publish it.
        author: null,
        sessionKey: `${datePart || num}:${Math.round(f.durationS / 60)}`,
      },
      engagements: f.engagements.map((e, eIdx) => ({
        ...e,
        id: `${fileId}:${eIdx}`,
        fileId,
        fileName,
        missionTitle,
        shooter: e.shooter
          ? {
              ...e.shooter,
              pilot: mapPilot(e.shooter.pilot, e.shooter.name),
              // Mission-editor group names can carry squadron or player tags.
              group: "",
            }
          : null,
        target: e.target
          ? {
              ...e.target,
              pilot: mapPilot(e.target.pilot, e.target.name),
              group: "",
            }
          : null,
      })),
    };
  });
}

export function serializeDatasetBundle(files: FileAnalytics[], options?: { anonymize?: boolean }): string {
  const outFiles = options?.anonymize ? anonymizeDataset(files) : files;
  const payload: SerializedDatasetBundle = {
    format: "tacview-analytics-dataset",
    extractorVersion: EXTRACTOR_VERSION,
    exportedAt: new Date().toISOString(),
    files: outFiles,
  };
  return JSON.stringify(payload, (_k, v) => {
    if (v instanceof Float32Array) {
      return { __f32: Array.from(v, (n) => (Number.isFinite(n) ? Math.round(n) : null)) };
    }
    return v;
  });
}

export function parseDatasetBundle(jsonText: string): FileAnalytics[] {
  const parsed = JSON.parse(jsonText, (_k, v) => {
    if (v && typeof v === "object" && Array.isArray((v as { __f32?: unknown }).__f32)) {
      const arr = (v as { __f32: (number | null)[] }).__f32;
      return Float32Array.from(arr, (n) => (n === null ? Number.NaN : n));
    }
    return v;
  }) as SerializedDatasetBundle;
  if (!parsed || parsed.format !== "tacview-analytics-dataset" || !Array.isArray(parsed.files)) {
    throw new Error("Invalid analytics dataset JSON bundle.");
  }
  return parsed.files;
}

export function triggerDownload(filename: string, content: string, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
