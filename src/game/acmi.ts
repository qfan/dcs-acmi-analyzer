/**
 * Records a fight and writes it as a Tacview ACMI 2.2 text file, so it opens in this project's
 * viewer and analytics (and in Tacview). Names match what the analyzer recognises (FA-18C_hornet,
 * AIM_120C). The flat game world (metres east/north) is placed around a reference point.
 *
 * Sampling: everything every 0.25 s, plus an exact frame whenever a missile ends or a jet dies, so
 * the analyzer sees the true closest approach of a hit.
 */
import type { Jet } from "./sim/aircraft.ts";
import type { Missile } from "./sim/missile.ts";
import type { Decoy, World } from "./sim/world.ts";

const EARTH_R = 6371008.8;
const DEG = Math.PI / 180;
/** Reference point the flat world is placed around (open water; any place works). */
export const REF_LON = 56;
export const REF_LAT = 26;
const SAMPLE_EVERY_S = 0.25;
const DECOY_LIFE_S = 4;

const decoyKey = (d: Decoy) => `${d.jetId}|${d.kind}|${d.t0}`;

const fmt = (x: number, d: number) => (Number.isFinite(x) ? x.toFixed(d) : "");

/** ACMI text values escape commas (and backslashes). */
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/,/g, "\\,");

interface Frame {
  t: number;
  lines: string[];
}

export interface AcmiMeta {
  title: string;
  /** Real-world time the fight started, written as ReferenceTime. */
  startedAt: Date;
}

export class AcmiRecorder {
  private readonly frames: Frame[] = [];
  private readonly ids = new Map<string, string>();
  private readonly removed = new Set<string>();
  /** Keyed by owner, kind and release time, so copies of the same decoy (snapshots) match. */
  private readonly decoyIds = new Map<string, { id: string; t0: number }>();
  private nextJet = 0x101;
  private nextWeapon = 0x201;
  private nextDecoy = 0x1001;
  private nextSampleAt = 0;
  private readonly meta: AcmiMeta;
  private readonly kx: number;
  private readonly ky: number;

  constructor(meta: AcmiMeta) {
    this.meta = meta;
    this.ky = EARTH_R * DEG;
    this.kx = EARTH_R * Math.cos(REF_LAT * DEG) * DEG;
  }

  /** Lon/lat offsets (deg, from the reference point) and altitude, as an ACMI transform. */
  private transform(pos: { x: number; y: number; z: number }, roll = 0, pitch = 0, yaw = 0): string {
    const lon = pos.x / this.kx;
    const lat = pos.y / this.ky;
    return `T=${fmt(lon, 7)}|${fmt(lat, 7)}|${fmt(pos.z, 1)}|${fmt(roll, 1)}|${fmt(pitch, 1)}|${fmt(yaw, 1)}`;
  }

  private jetLine(j: Jet, first: boolean): string {
    const id = this.idOf(j.id, "jet");
    const t = this.transform(
      j.pos,
      (j.bank * 180) / Math.PI,
      (j.gamma * 180) / Math.PI,
      (j.hdg * 180) / Math.PI,
    );
    if (!first) return `${id},${t}`;
    const blue = j.side === "blue";
    return [
      `${id},${t}`,
      "Type=Air+FixedWing",
      "Name=FA-18C_hornet",
      `Pilot=${esc(j.callsign)}`,
      `CallSign=${esc(j.callsign)}`,
      `Color=${blue ? "Blue" : "Red"}`,
      `Coalition=${blue ? "Allies" : "Enemies"}`,
    ].join(",");
  }

  private missileLine(m: Missile, first: boolean): string {
    const id = this.idOf(m.id, "weapon");
    const v = m.vel;
    const yaw = (Math.atan2(v.x, v.y) * 180) / Math.PI;
    const pitch = (Math.atan2(v.z, Math.hypot(v.x, v.y)) * 180) / Math.PI;
    const t = this.transform(m.pos, 0, pitch, yaw);
    if (!first) return `${id},${t}`;
    const blue = m.side === "blue";
    const parent = this.ids.get(m.shooterId);
    return [
      `${id},${t}`,
      "Type=Weapon+Missile",
      "Name=AIM_120C",
      `Color=${blue ? "Blue" : "Red"}`,
      `Coalition=${blue ? "Allies" : "Enemies"}`,
      ...(parent ? [`Parent=${parent}`] : []),
    ].join(",");
  }

  private idOf(key: string, kind: "jet" | "weapon"): string {
    let id = this.ids.get(key);
    if (!id) {
      id = (kind === "jet" ? this.nextJet++ : this.nextWeapon++).toString(16);
      this.ids.set(key, id);
    }
    return id;
  }

  /** Call after every simulation step. */
  update(w: World): void {
    const lines: string[] = [];
    const due = w.t >= this.nextSampleAt - 1e-9;
    if (due) this.nextSampleAt = w.t + SAMPLE_EVERY_S;

    for (const j of w.jets) {
      const first = !this.ids.has(j.id);
      if (this.removed.has(j.id)) continue;
      if (first || due || !j.alive) lines.push(this.jetLine(j, first));
      if (!j.alive) {
        lines.push(`-${this.idOf(j.id, "jet")}`);
        this.removed.add(j.id);
      }
    }
    for (const m of w.missiles) {
      if (this.removed.has(m.id)) continue;
      const first = !this.ids.has(m.id);
      if (first || due || m.end) lines.push(this.missileLine(m, first));
      if (m.end) {
        lines.push(`-${this.idOf(m.id, "weapon")}`);
        this.removed.add(m.id);
      }
    }
    for (const d of w.decoys) {
      const key = decoyKey(d);
      if (this.decoyIds.has(key)) continue;
      const id = (this.nextDecoy++).toString(16);
      this.decoyIds.set(key, { id, t0: d.t0 });
      const owner = w.jets.find((j) => j.id === d.jetId);
      lines.push(
        [
          `${id},${this.transform(d.pos)}`,
          d.kind === "flare" ? "Type=Misc+Decoy+Flare" : "Type=Misc+Decoy+Chaff",
          d.kind === "flare" ? "Name=Flare" : "Name=Chaff",
          `Color=${owner?.side === "red" ? "Red" : "Blue"}`,
        ].join(","),
      );
    }
    for (const [key, d] of this.decoyIds)
      if (w.t - d.t0 >= DECOY_LIFE_S) {
        lines.push(`-${d.id}`);
        this.decoyIds.delete(key);
      }

    if (lines.length > 0) this.frames.push({ t: w.t, lines });
  }

  /** The recording as ACMI 2.2 text. */
  text(): string {
    const head = [
      "FileType=text/acmi/tacview",
      "FileVersion=2.2",
      `0,ReferenceTime=${this.meta.startedAt.toISOString().replace(/\.\d+Z$/, "Z")}`,
      `0,ReferenceLongitude=${REF_LON}`,
      `0,ReferenceLatitude=${REF_LAT}`,
      "0,DataSource=BVR Trainer",
      "0,DataRecorder=BVR Trainer",
      `0,Title=${esc(this.meta.title)}`,
    ];
    const body: string[] = [];
    for (const f of this.frames) body.push(`#${f.t.toFixed(2)}`, ...f.lines);
    return `${[...head, ...body].join("\n")}\n`;
  }
}

/** A file name like "BVR-Trainer-duel-25k-20261114-153012.txt.acmi". */
export function acmiFileName(scenarioId: string, altFt: number, startedAt: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const d = startedAt;
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `BVR-Trainer-${scenarioId}-${Math.round(altFt / 1000)}k-${stamp}.txt.acmi`;
}
