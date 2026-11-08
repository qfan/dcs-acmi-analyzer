import { streamAcmiBytes } from "./container.ts";
import { splitFields } from "./fields.ts";
import { LineSplitter, type LogicalLine } from "./lines.ts";
import {
  type AcmiEvent,
  type AcmiObject,
  KNOWN_NUMERIC,
  type ParseWarning,
  type Recording,
  TEXT_PROPS,
  type WarningKind,
} from "./model.ts";
import { NumberTrack, T_SLOTS, TextTrack, TransformTrack } from "./tracks.ts";

/**
 * Full ACMI 2.2 parser. See PLAN.md §2 for where real files differ from the official spec.
 *
 * Feed logical lines (from LineSplitter) to `line()`, then call `finish()`.
 */

/** Which state slot each T= component fills, by component count (see the spec's four forms). */
const T_LAYOUT: Record<number, readonly number[]> = {
  3: [0, 1, 2], // lon|lat|alt
  5: [0, 1, 2, 6, 7], // lon|lat|alt|u|v
  6: [0, 1, 2, 3, 4, 5], // lon|lat|alt|roll|pitch|yaw
  9: [0, 1, 2, 3, 4, 5, 6, 7, 8], // lon|lat|alt|roll|pitch|yaw|u|v|heading
};

const MAX_WARNINGS_PER_KIND = 25;

interface LiveObject {
  obj: AcmiObject;
  state: Float64Array;
  transform: TransformTrack | null;
  text: Map<string, TextTrack>;
  numbers: Map<string, NumberTrack>;
  tFormMask: number;
}

export class AcmiParser {
  private time = 0;
  private sawFrame = false;
  private lastFrame = Number.NEGATIVE_INFINITY;
  private timeStart = Number.POSITIVE_INFINITY;
  private timeEnd = Number.NEGATIVE_INFINITY;
  private lineCount = 0;
  private readonly active = new Map<string, LiveObject>();
  /** Most recent object for each ID, including removed ones (to link reused IDs). */
  private readonly lastById = new Map<string, LiveObject>();
  private readonly all: LiveObject[] = [];
  private readonly events: AcmiEvent[] = [];
  private readonly warnings: ParseWarning[] = [];
  private readonly warningCounts: Partial<Record<WarningKind, number>> = {};
  private authKeys = 0;
  private refSetBeforeObjects = true;
  private readonly r: Recording;

  constructor() {
    this.r = {
      container: { kind: "unknown" },
      fileType: null,
      fileVersion: null,
      globals: {},
      globalChanges: [],
      refLon: 0,
      refLat: 0,
      referenceTime: null,
      timeStart: 0,
      timeEnd: 0,
      objects: [],
      events: [],
      truncated: false,
      warnings: [],
      warningCounts: {},
      stats: {
        logicalLines: 0,
        frames: 0,
        framesBackwards: 0,
        objectLines: 0,
        removals: 0,
        tComponentCounts: {},
        objectsMixingTForms: 0,
        idReuses: 0,
        idReuseGaps: {},
        idReusesSameIdentity: 0,
        unknownProps: {},
        textBytes: 0,
        rawBytes: 0,
      },
    };
  }

  warn(kind: WarningKind, lineNo: number, message: string): void {
    const n = (this.warningCounts[kind] ?? 0) + 1;
    this.warningCounts[kind] = n;
    if (n <= MAX_WARNINGS_PER_KIND) this.warnings.push({ kind, lineNo, message });
  }

  line({ text, lineNo }: LogicalLine): void {
    this.lineCount++;
    const st = this.r.stats;
    st.logicalLines++;
    if (text.length === 0) return;

    if (this.lineCount <= 2) {
      if (text.startsWith("FileType=")) {
        this.r.fileType = text.slice(9);
        return;
      }
      if (text.startsWith("FileVersion=")) {
        this.r.fileVersion = text.slice(12);
        return;
      }
    }

    const c0 = text.charCodeAt(0);
    if (c0 === 0x23 /* # */) {
      this.frame(text, lineNo);
      return;
    }
    if (c0 === 0x2d /* - */) {
      this.remove(text, lineNo);
      return;
    }
    if (c0 === 0x2f /* / */ && text.startsWith("//")) return;

    const fields = text.includes("\\") ? splitFields(text) : text.split(",");
    const id = normaliseId(fields[0] as string);
    if (id === null) {
      this.warn("bad-line", lineNo, `Unrecognised line: ${text.slice(0, 80)}`);
      return;
    }
    if (id === "0") {
      this.global(fields, lineNo);
      return;
    }
    st.objectLines++;
    this.objectLine(id, fields, lineNo);
  }

  private frame(text: string, lineNo: number): void {
    const s = text.slice(1);
    const t = s === "" ? Number.NaN : Number(s);
    if (!Number.isFinite(t)) {
      this.warn("bad-frame", lineNo, `Bad time frame: ${text.slice(0, 40)}`);
      return;
    }
    const st = this.r.stats;
    st.frames++;
    if (t < this.lastFrame) st.framesBackwards++;
    this.lastFrame = t;
    this.sawFrame = true;
    this.time = t;
    if (t < this.timeStart) this.timeStart = t;
    if (t > this.timeEnd) this.timeEnd = t;
  }

  private remove(text: string, lineNo: number): void {
    const id = normaliseId(text.slice(1));
    if (id === null) {
      this.warn("bad-id", lineNo, `Bad removal line: ${text.slice(0, 40)}`);
      return;
    }
    const live = this.active.get(id);
    if (!live) {
      this.warn("remove-unknown", lineNo, `Removal of unknown object ${id}`);
      return;
    }
    live.obj.removedAt = this.time;
    this.active.delete(id);
    this.r.stats.removals++;
  }

  private global(fields: string[], lineNo: number): void {
    for (let i = 1; i < fields.length; i++) {
      const f = fields[i] as string;
      const eq = f.indexOf("=");
      if (eq <= 0) continue;
      const key = f.slice(0, eq);
      const value = f.slice(eq + 1);
      switch (key) {
        case "AuthenticationKey":
          this.authKeys++;
          continue;
        case "Event":
          this.event(value, lineNo);
          continue;
        case "ReferenceLongitude":
        case "ReferenceLatitude": {
          const v = Number(value);
          if (value === "" || !Number.isFinite(v)) {
            this.warn("bad-number", lineNo, `${key} is not a number: ${value}`);
            continue;
          }
          const prev = key === "ReferenceLongitude" ? this.r.refLon : this.r.refLat;
          if (!this.refSetBeforeObjects && v !== prev)
            this.warn("reference-changed", lineNo, `${key} changed after objects were recorded`);
          if (key === "ReferenceLongitude") this.r.refLon = v;
          else this.r.refLat = v;
          break;
        }
        case "ReferenceTime":
          this.r.referenceTime = value;
          break;
      }
      this.r.globals[key] = value;
      this.r.globalChanges.push({ time: this.sawFrame ? this.time : 0, key, value });
    }
  }

  private event(value: string, lineNo: number): void {
    const parts = value.split("|");
    const type = parts[0] ?? "";
    const text = parts.length > 1 ? (parts[parts.length - 1] as string) : "";
    const objectIds: string[] = [];
    const params: Record<string, string> = {};
    for (let i = 1; i < parts.length - 1; i++) {
      const p = parts[i] as string;
      const colon = p.indexOf(":");
      if (colon > 0) {
        params[p.slice(0, colon)] = p.slice(colon + 1);
        continue;
      }
      const id = normaliseId(p);
      if (id !== null) objectIds.push(id);
    }
    const time = this.sawFrame ? this.time : 0;
    this.events.push({ time, type, objectIds, params, text, raw: value, lineNo });
    if (type === "Destroyed") {
      for (const id of objectIds) {
        const live = this.active.get(id);
        if (live && live.obj.destroyedAt === null) live.obj.destroyedAt = time;
      }
    }
  }

  private objectLine(id: string, fields: string[], lineNo: number): void {
    const time = this.sawFrame ? this.time : 0;
    let live = this.active.get(id);
    if (!live) {
      const prev = this.lastById.get(id);
      const life = prev ? prev.obj.life + 1 : 0;
      let reappearGap: number | null = null;
      if (prev) {
        const st = this.r.stats;
        st.idReuses++;
        reappearGap = time - (prev.obj.removedAt ?? time);
        const bucket =
          reappearGap < 0.1 ? "<0.1s" : reappearGap < 1 ? "<1s" : reappearGap < 10 ? "<10s" : ">=10s";
        st.idReuseGaps[bucket] = (st.idReuseGaps[bucket] ?? 0) + 1;
        this.warn(
          "id-reused",
          lineNo,
          `Object ID ${id} reappeared ${reappearGap.toFixed(2)} s after removal (new object #${life + 1})`,
        );
      }
      live = {
        obj: {
          uid: this.all.length,
          id,
          life,
          previousUid: prev ? prev.obj.uid : null,
          reappearGap,
          createdAt: time,
          removedAt: null,
          destroyedAt: null,
          name: "",
          type: "",
          tags: [],
          pilot: "",
          group: "",
          coalition: "",
          color: "",
          country: "",
          callSign: "",
          parent: "",
          tForms: [],
          transform: null,
          text: {},
          numbers: {},
          firstLine: lineNo,
        },
        state: new Float64Array(T_SLOTS).fill(Number.NaN),
        transform: null,
        text: new Map(),
        numbers: new Map(),
        tFormMask: 0,
      };
      this.active.set(id, live);
      this.lastById.set(id, live);
      this.all.push(live);
      this.refSetBeforeObjects = false;
    }

    for (let i = 1; i < fields.length; i++) {
      const f = fields[i] as string;
      const eq = f.indexOf("=");
      if (eq <= 0) {
        if (f !== "") this.warn("bad-line", lineNo, `Field without '=': ${f.slice(0, 40)}`);
        continue;
      }
      const key = f.slice(0, eq);
      const value = f.slice(eq + 1);
      if (key === "T") {
        this.transform(live, value, time, lineNo);
      } else if (TEXT_PROPS.has(key)) {
        let tr = live.text.get(key);
        if (!tr) {
          tr = new TextTrack();
          live.text.set(key, tr);
        }
        tr.push(time, value);
      } else {
        const known = KNOWN_NUMERIC.has(key);
        if (!known) {
          const u = this.r.stats.unknownProps;
          u[key] = (u[key] ?? 0) + 1;
        }
        const v = value === "" ? Number.NaN : Number(value);
        if (Number.isFinite(v)) {
          let tr = live.numbers.get(key);
          if (!tr) {
            tr = new NumberTrack();
            live.numbers.set(key, tr);
          }
          tr.push(time, v);
        } else {
          if (known) this.warn("bad-number", lineNo, `${key} is not a number: ${value.slice(0, 40)}`);
          // Keep unknown non-numeric values as text so nothing is lost.
          let tr = live.text.get(key);
          if (!tr) {
            tr = new TextTrack();
            live.text.set(key, tr);
          }
          tr.push(time, value);
        }
      }
    }
  }

  private transform(live: LiveObject, value: string, time: number, lineNo: number): void {
    const parts = value.split("|");
    const n = parts.length;
    const layout = T_LAYOUT[n];
    const counts = this.r.stats.tComponentCounts;
    counts[n] = (counts[n] ?? 0) + 1;
    if (!layout) {
      this.warn(
        "t-components",
        lineNo,
        `T= has ${n} components (expected 3, 5, 6 or 9): ${value.slice(0, 60)}`,
      );
      return;
    }
    live.tFormMask |= 1 << n;
    const s = live.state;
    for (let i = 0; i < n; i++) {
      const p = parts[i] as string;
      if (p === "") continue; // empty component = unchanged
      const v = Number(p);
      if (!Number.isFinite(v)) {
        this.warn("bad-number", lineNo, `Bad T= component '${p}'`);
        continue;
      }
      s[layout[i] as number] = v;
    }
    if (!live.transform) live.transform = new TransformTrack();
    live.transform.push(time, s);
  }

  /** `tail` is the incomplete last line of a cut-off file, which is reported and ignored. */
  finish(tail: LogicalLine | null): Recording {
    const r = this.r;
    if (tail) {
      r.truncated = true;
      this.warn(
        "truncated",
        tail.lineNo,
        `File ends mid-line (unfinished recording); ignored: ${tail.text.slice(0, 60)}`,
      );
    }
    if (r.fileType !== "text/acmi/tacview")
      this.warn("header", 1, `Unexpected FileType: ${r.fileType ?? "(missing)"}`);
    if (r.fileVersion === null) this.warn("header", 2, "Missing FileVersion");
    else if (r.fileVersion !== "2.2")
      this.warn("header", 2, `FileVersion ${r.fileVersion} is untested (expected 2.2)`);
    if (this.authKeys > 0) r.globals.AuthenticationKey = `(${this.authKeys} keys)`;

    r.timeStart = Number.isFinite(this.timeStart) ? Math.min(this.timeStart, 0) : 0;
    r.timeEnd = Number.isFinite(this.timeEnd) ? this.timeEnd : 0;

    for (const live of this.all) {
      const o = live.obj;
      if (live.transform) o.transform = live.transform.finish();
      for (const [k, tr] of live.text) o.text[k] = tr.finish();
      for (const [k, tr] of live.numbers) o.numbers[k] = tr.finish();
      const last = (k: string) => {
        const d = o.text[k];
        return d?.values.length ? (d.values[d.values.length - 1] as string) : "";
      };
      o.name = last("Name");
      o.type = last("Type");
      o.tags = o.type ? o.type.split("+") : [];
      o.pilot = last("Pilot");
      o.group = last("Group");
      o.coalition = last("Coalition");
      o.color = last("Color");
      o.country = last("Country");
      o.callSign = last("CallSign");
      o.parent = normaliseId(last("Parent")) ?? "";
      for (const n of [3, 5, 6, 9]) if (live.tFormMask & (1 << n)) o.tForms.push(n);
      if (o.previousUid !== null) {
        const p = r.objects[o.previousUid]; // already finished: objects are pushed in uid order
        if (p && p.name === o.name && p.pilot === o.pilot) r.stats.idReusesSameIdentity++;
      }
      if (o.tForms.length > 1) r.stats.objectsMixingTForms++;
      r.objects.push(o);
    }
    r.events = this.events;
    r.warnings = this.warnings;
    r.warningCounts = this.warningCounts;
    return r;
  }
}

/** Lowercase hex, leading zeros stripped ("0" stays "0"). Returns null if not a valid 64-bit hex ID. */
export function normaliseId(s: string): string | null {
  if (s.length === 0 || s.length > 16) return null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const isHex = (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
    if (!isHex) return null;
  }
  while (start < s.length - 1 && s.charCodeAt(start) === 48) start++;
  return s.slice(start).toLowerCase();
}

/** Parse a whole ACMI byte stream (zip or plain). */
export async function parseAcmi(
  source: AsyncIterable<Uint8Array>,
  onProgress?: (rawBytes: number) => void,
): Promise<Recording> {
  const parser = new AcmiParser();
  let textBytes = 0;
  let rawBytes = 0;
  const splitter = new LineSplitter((l) => parser.line(l));
  const container = await streamAcmiBytes(
    source,
    (bytes) => {
      textBytes += bytes.length;
      splitter.push(bytes);
    },
    (raw) => {
      rawBytes = raw;
      onProgress?.(raw);
    },
  );
  const { incompleteTail } = splitter.end();
  if (container.incomplete)
    parser.warn(
      "incomplete-zip",
      0,
      "The zip archive was never finished (missing sizes or cut-off data); recovered what was there.",
    );
  const rec = parser.finish(incompleteTail);
  rec.container = container;
  rec.stats.textBytes = textBytes;
  rec.stats.rawBytes = rawBytes;
  return rec;
}
