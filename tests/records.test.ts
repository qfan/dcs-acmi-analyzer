import { describe, expect, it } from "vitest";
import { parseAcmi } from "../src/acmi/parser.ts";
import { summarize } from "../src/acmi/summary.ts";
import { analyze } from "../src/analysis/analyze.ts";
import {
  formatClock,
  killMatches,
  killRecords,
  NO_FILTER,
  pilotMatches,
  pilotSides,
  shotMatches,
  shotRecords,
  timeOfDay,
} from "../src/ui/records.ts";
import { fileChunks, sample } from "./helpers.ts";

describe("records for the UI tables (2v1 sample)", async () => {
  const rec = await parseAcmi(fileChunks(sample("dcs-2021-f16-2v1-acm.zip.acmi")));
  const summary = summarize(rec);
  const analysis = analyze(rec);
  const kills = killRecords(summary, analysis);
  const shots = shotRecords(summary, analysis);
  const sides = pilotSides(summary);

  it("labels kills in plain text", () => {
    expect(kills.map((k) => [k.victim.key, k.killer?.key, k.weapon])).toEqual([
      ["Adversary Front", "QFAN", "AIM-9X"],
      ["Adversary 2", "QFAN", "Gun (M61 20 PGU28)"],
      ["F-16C_50 (Player)", "Adversary 2", "P-73"],
    ]);
    expect(kills[2]?.notes).toContain("shooter already down");
  });

  it("filters by side, pilot and free text (all words must match)", () => {
    const count = (f: typeof NO_FILTER) => kills.filter((k) => killMatches(k, f)).length;
    expect(count(NO_FILTER)).toBe(3);
    expect(count({ ...NO_FILTER, side: "Red" })).toBe(3); // a Red party is in every kill
    expect(count({ ...NO_FILTER, pilot: "QFAN" })).toBe(2);
    expect(count({ ...NO_FILTER, pilot: "Adversary 2" })).toBe(2); // as killer and as victim
    expect(count({ ...NO_FILTER, text: "aim-9x" })).toBe(1);
    expect(count({ ...NO_FILTER, text: "qfan gun" })).toBe(1);
    expect(count({ ...NO_FILTER, text: "nonexistent" })).toBe(0);
    // His two R-73 launches, plus QFAN's gun burst that hit him.
    expect(shots.filter((s) => shotMatches(s, { ...NO_FILTER, pilot: "Adversary 2" }))).toHaveLength(3);
    expect(
      analysis.pilots
        .filter((p) => pilotMatches(p, sides.get(p.key) ?? "", { ...NO_FILTER, side: "Blue" }))
        .map((p) => p.key),
    ).toEqual(["QFAN", "F-16C_50 (Player)"]);
  });

  it("shows kill times since start or as mission time of day", () => {
    expect(formatClock("elapsed", summary.referenceTime, 65.68)).toBe("1:05");
    expect(formatClock("timeOfDay", summary.referenceTime, 65.68)).toBe("03:01:05");
  });
});

describe("time helpers", () => {
  it("converts mission seconds to time of day from ReferenceTime", () => {
    expect(timeOfDay("2018-08-01T03:00:00Z", 3725)).toBe("04:02:05");
    expect(timeOfDay(null, 10)).toBeNull();
    expect(timeOfDay("not a date", 10)).toBeNull();
    // Without a reference time, time of day falls back to time since start.
    expect(formatClock("timeOfDay", null, 3725)).toBe("1:02:05");
  });
});
