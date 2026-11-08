import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/settings/schema.ts";
import {
  distanceUnitM,
  fmtAlt,
  fmtAltShort,
  fmtDist,
  fmtSpeed,
  fmtVz,
  labelText,
} from "../src/settings/units.ts";

describe("unit formatting", () => {
  it("altitude in feet, metres, or both (first unit leads)", () => {
    expect(fmtAlt(6221, "ft")).toBe("20,410 ft");
    expect(fmtAlt(6221, "m")).toBe("6,221 m");
    expect(fmtAlt(6221, "ft+m")).toBe("20,410 ft (6,221 m)");
    expect(fmtAlt(6221, "m+ft")).toBe("6,221 m (20,410 ft)");
    expect(fmtAlt(null, "ft")).toBe("–");
    expect(fmtAltShort(6221, "ft")).toBe("20.4k ft");
    expect(fmtAltShort(6221, "m+ft")).toBe("6,220 m / 20.4k ft");
  });

  it("speed in knots, km/h, or both", () => {
    expect(fmtSpeed(177, "kt")).toBe("344 kt");
    expect(fmtSpeed(177, "kmh")).toBe("637 km/h");
    expect(fmtSpeed(177, "kt+kmh")).toBe("344 kt (637 km/h)");
  });

  it("distance in nautical miles, km, or both", () => {
    expect(fmtDist(1400, "nm")).toBe("0.76 nm");
    expect(fmtDist(18520, "nm")).toBe("10.0 nm");
    expect(fmtDist(1400, "km")).toBe("1.4 km");
    expect(fmtDist(545, "km")).toBe("545 m");
    expect(fmtDist(18520, "km+nm")).toBe("18.5 km (10.0 nm)");
    expect(distanceUnitM("nm+km")).toBe(1852);
    expect(distanceUnitM("km")).toBe(1000);
  });

  it("vertical speed follows the altitude unit", () => {
    expect(fmtVz(-10, "ft")).toBe("1,969 ft/min");
    expect(fmtVz(10, "m")).toBe("10 m/s");
  });

  it("builds map labels from the chosen fields", () => {
    const s = DEFAULT_SETTINGS; // pilot, aircraft, altitude
    expect(labelText("QFAN", "F-16C_50", 6221, 177, s)).toBe("QFAN F-16C_50 · 20.4k ft");
    const ru = { ...s, units: { ...s.units, altitude: "m" as const, speed: "kmh" as const } };
    const withSpeed = { ...ru, labels: { ...s.labels, aircraft: false, speed: true } };
    expect(labelText("QFAN", "F-16C_50", 6221, 177, withSpeed)).toBe("QFAN · 6,220 m · 637 km/h");
    // An unnamed AI aircraft always shows its type, even if aircraft names are turned off.
    expect(labelText("", "Su-27", 5000, 200, withSpeed)).toBe("Su-27 · 5,000 m · 720 km/h");
  });
});
