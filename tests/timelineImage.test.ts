import { describe, expect, it } from "vitest";
import { DEFAULT_MILSIM_TIMELINE } from "../src/analytics/timeline.ts";
import {
  KNEEBOARD_PLAN_ORDER,
  KNEEBOARD_PLANS,
  kneeboardColumnLayout,
  laneMembership,
  planGateChain,
  planRows,
  roundUpTable,
  secondsToNextGate,
} from "../src/analytics/timelineImage.ts";

describe("kneeboard plans", () => {
  const codes = (p: Parameters<typeof planRows>[0]) => planRows(p).map((r) => r.key);

  it("keeps all 14 rows on the 'all' card", () => {
    expect(codes("all")).toHaveLength(14);
  });

  it("stops the skate card at MOR and its reattack", () => {
    const rows = codes("skate");
    expect(rows).toContain("morNm");
    expect(rows).toContain("mrarNm");
    for (const k of ["drNm", "lsrNm", "marNm", "sternWezNm", "ofrNm", "dfrNm"] as const) {
      expect(rows).not.toContain(k);
    }
  });

  it("gives banzai the merge gates and factor ranges but not the out ranges", () => {
    const rows = codes("banzai");
    for (const k of ["ofrNm", "dfrNm", "drNm", "lsrNm", "marNm", "sternWezNm"] as const) {
      expect(rows).toContain(k);
    }
    expect(rows).not.toContain("morNm");
    expect(rows).not.toContain("mrarNm");
  });

  it("only highlights and rewords gates the plan shows, in chart order", () => {
    for (const p of KNEEBOARD_PLAN_ORDER) {
      const shown = new Set(codes(p));
      for (const k of KNEEBOARD_PLANS[p].critical) expect(shown.has(k)).toBe(true);
      for (const k of Object.keys(KNEEBOARD_PLANS[p].descriptions)) expect(shown.has(k as never)).toBe(true);
    }
  });

  it("marks lane gates as used, flown through, or outside the plan's span", () => {
    const skate = laneMembership("skate");
    expect(skate.morNm).toBe("use");
    expect(skate.ofrNm).toBe("pass"); // between THREAT RANGE and COMMIT, not acted on
    expect(skate.drNm).toBe("none"); // after the skate is over
    const banzai = laneMembership("banzai");
    expect(banzai.morNm).toBe("pass");
    expect(banzai.sternWezNm).toBe("use");
    expect(laneMembership("shortSkate").mrarNm).toBe("pass");
    expect(laneMembership("shortSkate").sternWezNm).toBe("none");
  });

  it("times each plan's gates to the next gate on its own card", () => {
    const ar2 = DEFAULT_MILSIM_TIMELINE["AR-2"];
    // Skate: MOR is the last step, nothing after it
    expect(planGateChain("skate").at(-1)).toBe("morNm");
    expect(secondsToNextGate(ar2, "morNm", 1200, 0, planGateChain("skate"))).toBeNull();
    // Banzai skips MOR: SR 38 → DR 23 is 15 nm = 45 s at 1200 kt
    expect(secondsToNextGate(ar2, "nltSrNm", 1200, 0, planGateChain("banzai"))).toBeCloseTo(45);
  });
});

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

describe("kneeboard column layout", () => {
  it("keeps every tier right of the gates by default", () => {
    expect(kneeboardColumnLayout(false)).toEqual({ left: [], right: ["IR/SAR-1", "SAR-2", "AR-1", "AR-2"] });
  });

  it("moves AR-1 and AR-2 left of the gates when asked", () => {
    expect(kneeboardColumnLayout(true)).toEqual({ left: ["AR-1", "AR-2"], right: ["IR/SAR-1", "SAR-2"] });
  });
});
