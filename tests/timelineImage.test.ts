import { describe, expect, it } from "vitest";
import { DEFAULT_MILSIM_TIMELINE } from "../src/analytics/timeline.ts";
import { roundUpTable, secondsToNextGate } from "../src/analytics/timelineImage.ts";

describe("roundUpTable", () => {
  it("rounds every gate up to a whole nm without touching the input", () => {
    const src = DEFAULT_MILSIM_TIMELINE;
    const fitted = { ...src, "AR-2": { ...src["AR-2"], morNm: 36.2, drNm: 22.0000001, marNm: 17.5 } };
    const r = roundUpTable(fitted);
    expect(r["AR-2"].morNm).toBe(37);
    expect(r["AR-2"].drNm).toBe(22);
    expect(r["AR-2"].marNm).toBe(18);
    expect(r["SAR-2"]).toEqual(src["SAR-2"]);
    expect(fitted["AR-2"].morNm).toBe(36.2);
  });

  it("feeds gate times the rounded values", () => {
    // MOR 36.2 → DR 22.4 is 13.8 nm raw; rounded 37 → 23 is 14 nm = 42 s at 1200 kt
    const col = { ...DEFAULT_MILSIM_TIMELINE["AR-2"], morNm: 36.2, drNm: 22.4 };
    const r = roundUpTable({ ...DEFAULT_MILSIM_TIMELINE, "AR-2": col });
    expect(secondsToNextGate(r["AR-2"], "morNm", 1200)).toBeCloseTo(42);
  });
});

describe("secondsToNextGate", () => {
  const ar2 = DEFAULT_MILSIM_TIMELINE["AR-2"];

  it("converts the nm between consecutive flow gates to seconds at the closure", () => {
    // NLT COMMIT 75 → TAC RANGE 63: 12 nm at 1200 kt = 36 s
    expect(secondsToNextGate(ar2, "nltCommitNm", 1200)).toBeCloseTo(36);
    // MOR 37 → DR 23: 14 nm at 1200 kt = 42 s
    expect(secondsToNextGate(ar2, "morNm", 1200)).toBeCloseTo(42);
  });

  it("applies the strike-fighter bonus to SR and MOR only", () => {
    // MELD 45 → SR 38+2: 5 nm
    expect(secondsToNextGate(ar2, "meldSortNm", 1200, 2)).toBeCloseTo(15);
    // SR 40 → MOR 39: 1 nm
    expect(secondsToNextGate(ar2, "nltSrNm", 1200, 2)).toBeCloseTo(3);
    // MOR 39 → DR 23: 16 nm
    expect(secondsToNextGate(ar2, "morNm", 1200, 2)).toBeCloseTo(48);
  });

  it("gives no time off the chain, at its end, or when the next gate is not closer", () => {
    expect(secondsToNextGate(ar2, "threatRangeNm", 1200)).toBeNull();
    expect(secondsToNextGate(ar2, "pumpNm", 1200)).toBeNull();
    expect(secondsToNextGate(ar2, "marNm", 1200)).toBeNull();
    expect(secondsToNextGate({ ...ar2, tacRangeNm: 80 }, "nltCommitNm", 1200)).toBeNull();
    expect(secondsToNextGate(ar2, "nltCommitNm", 0)).toBeNull();
  });
});
