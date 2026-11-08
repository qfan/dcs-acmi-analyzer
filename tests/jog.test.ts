import { describe, expect, it } from "vitest";
import {
  fmtRate,
  JOG_DEAD_PX,
  JOG_LATCH_PX,
  JOG_MAX_RATE,
  JOG_MIN_RATE,
  JOG_SLOW_SHARE,
  JOG_TRAVEL_PX,
  jogOffset,
  jogRate,
  playRateOf,
  speedChoices,
  wouldLatch,
} from "../src/ui/jog.ts";

/** Offset at a fraction of the usable travel (past the dead zone). */
const at = (f: number) => JOG_DEAD_PX + f * (JOG_TRAVEL_PX - JOG_DEAD_PX);

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

  it("keeps slow motion to the inner 30% of the travel; real time is at that boundary", () => {
    expect(JOG_SLOW_SHARE).toBeCloseTo(0.3, 9);
    expect(jogRate(at(JOG_SLOW_SHARE))).toBeCloseTo(1, 9);
    expect(jogRate(at(JOG_SLOW_SHARE - 0.01))).toBeLessThan(1);
    expect(jogRate(at(JOG_SLOW_SHARE + 0.01))).toBeGreaterThan(1);
    expect(jogOffset(1)).toBeCloseTo(at(JOG_SLOW_SHARE), 9);
  });

  it("grows monotonically and continuously", () => {
    let prev = 0;
    for (let dx = JOG_DEAD_PX + 0.5; dx <= JOG_TRAVEL_PX; dx += 0.5) {
      const r = jogRate(dx);
      expect(r).toBeGreaterThan(prev);
      expect(r / Math.max(prev, JOG_MIN_RATE)).toBeLessThan(1.25); // no jumps between half-pixels
      prev = r;
    }
  });

  it("inverts: the offset for a rate gives that rate back", () => {
    for (const r of [0.11, 0.25, 0.5, 1, 2, 3.1, 8, 16, 20, -0.3, -4])
      expect(jogRate(jogOffset(r))).toBeCloseTo(r, 9);
    expect(jogOffset(JOG_MIN_RATE)).toBeCloseTo(JOG_DEAD_PX, 9); // the slowest speed is at the dead zone's edge
    expect(jogOffset(0)).toBe(0);
    expect(jogOffset(64)).toBeCloseTo(JOG_TRAVEL_PX, 9); // past the jog's range: pinned to the end
  });
});

describe("jog latch and play speed", () => {
  it("latches only when moved off the line at a non-zero rate", () => {
    expect(wouldLatch({ dx: 60, dy: JOG_LATCH_PX })).toBe(true);
    expect(wouldLatch({ dx: -60, dy: -JOG_LATCH_PX - 5 })).toBe(true);
    expect(wouldLatch({ dx: 60, dy: JOG_LATCH_PX - 1 })).toBe(false);
    expect(wouldLatch({ dx: 2, dy: 40 })).toBe(false); // dead zone: nothing to keep
  });

  it("plays in real time when no speed is set", () => {
    expect(playRateOf(0)).toBe(1);
    expect(playRateOf(-2.5)).toBe(-2.5);
  });

  it("lists the presets, plus a latched in-between speed in order", () => {
    expect(speedChoices(0).map((o) => o.value)).toEqual([1, 2, 4, 8, 16, 32, 64]);
    const c = speedChoices(3.1);
    expect(c.map((o) => o.value)).toEqual([1, 2, 3.1, 4, 8, 16, 32, 64]);
    expect(speedChoices(-0.5)[0]).toEqual({ value: -0.5, label: "◀ 0.50×" });
  });

  it("formats rates compactly", () => {
    expect(fmtRate(0.25)).toBe("0.25×");
    expect(fmtRate(-3.24)).toBe("3.2×");
    expect(fmtRate(20)).toBe("20×");
    expect(fmtRate(1)).toBe("1×");
    expect(fmtRate(1.01)).toBe("1×");
  });
});
