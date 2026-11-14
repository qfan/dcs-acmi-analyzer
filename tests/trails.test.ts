import { describe, expect, it } from "vitest";
import { trailSecondsFor } from "../src/map/trails.ts";

describe("trailSecondsFor", () => {
  it("gives every object the chosen length, selected or not", () => {
    expect(trailSecondsFor(1, 60, null, null)).toBe(60);
    expect(trailSecondsFor(1, 60, 1, null)).toBe(60);
    expect(trailSecondsFor(2, 60, 1, null)).toBe(60);
    expect(trailSecondsFor(1, 15, null, 1)).toBe(15);
  });

  it("keeps only the pair's trails once primary and secondary are both selected", () => {
    expect(trailSecondsFor(1, 60, 1, 2)).toBe(60);
    expect(trailSecondsFor(2, 60, 1, 2)).toBe(60);
    expect(trailSecondsFor(3, 60, 1, 2)).toBe(0);
  });

  it("'No trails' applies to selected objects too", () => {
    expect(trailSecondsFor(1, 0, 1, 2)).toBe(0);
    expect(trailSecondsFor(1, 0, 1, null)).toBe(0);
  });
});
