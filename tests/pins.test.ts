import { describe, expect, it } from "vitest";
import { parsePins } from "../src/ui/pins.tsx";

describe("parsePins", () => {
  it("reads saved left/right pins for known panels", () => {
    expect(parsePins('{"kills":"left","shots":"right"}')).toEqual({ kills: "left", shots: "right" });
  });

  it("drops unknown panels and bad sides", () => {
    expect(parsePins('{"kills":"top","nope":"left","pilots":"left"}')).toEqual({ pilots: "left" });
  });

  it("falls back to no pins on missing or broken storage", () => {
    expect(parsePins(null)).toEqual({});
    expect(parsePins("{oops")).toEqual({});
    expect(parsePins('"left"')).toEqual({});
  });
});
