import { describe, expect, it } from "vitest";
import {
  fmtRate,
  JOG_DEAD_PX,
  JOG_LATCH_PX,
  JOG_MAX_RATE,
  JOG_MIN_RATE,
  JOG_TRAVEL_PX,
  jogOffset,
  jogRate,
  wouldLatch,
} from "../src/ui/jog.ts";

describe("jog rate", () => {
  it("is zero in the dead zone and symmetric", () => {
    expect(jogRate(0)).toBe(0);
    expect(jogRate(JOG_DEAD_PX)).toBe(0);
    expect(jogRate(-JOG_DEAD_PX)).toBe(0);
    expect(jogRate(50)).toBeCloseTo(-jogRate(-50), 12);
  });

  it("runs from slow motion just past the dead zone to the maximum at full travel", () => {
    expect(jogRate(JOG_DEAD_PX + 0.01)).toBeCloseTo(JOG_MIN_RATE, 2);
    expect(jogRate(JOG_TRAVEL_PX)).toBeCloseTo(JOG_MAX_RATE, 9);
    expect(jogRate(-JOG_TRAVEL_PX * 3)).toBeCloseTo(-JOG_MAX_RATE, 9); // clamped
  });

  it("grows monotonically, and equal travel multiplies the rate equally", () => {
    let prev = 0;
    for (let dx = JOG_DEAD_PX + 1; dx <= JOG_TRAVEL_PX; dx++) {
      const r = jogRate(dx);
      expect(r).toBeGreaterThan(prev);
      prev = r;
    }
    expect(jogRate(40) / jogRate(30)).toBeCloseTo(jogRate(90) / jogRate(80), 9);
  });

  it("puts real time (1×) within reach, before the middle of the travel", () => {
    const one = jogOffset(1);
    expect(one).toBeGreaterThan(JOG_DEAD_PX);
    expect(one).toBeLessThan(JOG_TRAVEL_PX / 2);
    expect(jogRate(one)).toBeCloseTo(1, 9);
    expect(jogRate(jogOffset(-4))).toBeCloseTo(-4, 9);
  });
});

describe("jog latch", () => {
  it("latches only when moved off the line at a non-zero rate while held", () => {
    expect(wouldLatch({ dx: 60, dy: JOG_LATCH_PX, holding: true })).toBe(true);
    expect(wouldLatch({ dx: -60, dy: -JOG_LATCH_PX - 5, holding: true })).toBe(true);
    expect(wouldLatch({ dx: 60, dy: JOG_LATCH_PX - 1, holding: true })).toBe(false);
    expect(wouldLatch({ dx: 2, dy: 40, holding: true })).toBe(false); // dead zone: nothing to keep
    expect(wouldLatch({ dx: 60, dy: 40, holding: false })).toBe(false);
  });

  it("formats rates compactly", () => {
    expect(fmtRate(0.25)).toBe("0.25×");
    expect(fmtRate(-3.24)).toBe("3.2×");
    expect(fmtRate(20)).toBe("20×");
  });
});
