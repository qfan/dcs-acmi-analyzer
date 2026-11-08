import { describe, expect, it } from "vitest";
import type { AcmiObject } from "../src/acmi/model.ts";
import { parseAcmi } from "../src/acmi/parser.ts";
import { aspectWords, engagementAt } from "../src/map/engagement.ts";
import { buildMapData } from "../src/map/mapData.ts";

/**
 * Synthetic two-ship set-ups. Reference point 0°N 0°E, so 0.001° ≈ 111.3 m both ways.
 * Each aircraft flies straight and level; "a" is the primary (ownship), "b" the secondary (target).
 */
const DEG_M = 111_319.5;
async function twoShip(a: Ship, b: Ship) {
  const line = (id: string, s: Ship, t: number) =>
    `${id},T=${(s.x + s.vx * t) / DEG_M}|${(s.y + s.vy * t) / DEG_M}|${s.alt}|0|0|${s.hdg}`;
  let body = "FileType=text/acmi/tacview\nFileVersion=2.2\n";
  for (let t = 0; t <= 4; t += 0.25) {
    body += `#${t}\n${line("a", a, t)}${t === 0 ? ",Type=Air+FixedWing,Name=A" : ""}\n`;
    body += `${line("b", b, t)}${t === 0 ? ",Type=Air+FixedWing,Name=B" : ""}\n`;
  }
  const rec = await parseAcmi(
    (async function* () {
      yield new TextEncoder().encode(body);
    })(),
  );
  const d = buildMapData(rec, null);
  const tr = (id: string) => {
    const uid = (rec.objects.find((o) => o.id === id) as AcmiObject).uid;
    return d.tracks.find((x) => x.uid === uid) as (typeof d.tracks)[number];
  };
  return engagementAt(d, tr("a"), tr("b"), 2);
}
interface Ship {
  x: number;
  y: number;
  alt: number;
  vx: number;
  vy: number;
  hdg: number;
}

describe("engagement geometry", () => {
  it("target dead ahead, same direction, we're faster: on its tail, closing", async () => {
    const e = await twoShip(
      { x: 0, y: 0, alt: 5000, vx: 0, vy: 250, hdg: 0 },
      { x: 0, y: 2000, alt: 5000, vx: 0, vy: 200, hdg: 0 },
    );
    expect(e?.range).toBeCloseTo(1900, -1); // 2000 m minus 2 s × 50 m/s
    expect(e?.closure).toBeCloseTo(50, 0);
    expect(e?.ataDeg).toBeCloseTo(0, 0); // on our nose
    expect(e?.aspectDeg).toBeCloseTo(0, 0); // we're on its tail
    expect(e?.angleOffTailDeg).toBeCloseTo(0, 0);
    expect(e?.targetAtaDeg).toBeCloseTo(180, 0); // we're behind it
    expect(e?.clock).toBe(12);
    expect(e?.elevation).toBe("level");
    expect(e?.timeToMergeS).toBeCloseTo(38, 0);
    expect(aspectWords(e?.aspectDeg ?? Number.NaN)).toBe("on its tail");
  });

  it("head-on pass: nose-on aspect, opposite headings, closing fast", async () => {
    const e = await twoShip(
      { x: 0, y: 0, alt: 5000, vx: 0, vy: 250, hdg: 0 },
      { x: 0, y: 10000, alt: 5000, vx: 0, vy: -250, hdg: 180 },
    );
    // The map projection uses the mean Earth radius: ground distances are 0.11% shorter than this
    // test's equatorial metres, so 500 m/s reads as ~499.4.
    expect(Math.abs((e?.closure ?? 0) - 500)).toBeLessThan(500 * 0.002);
    expect(e?.aspectDeg).toBeCloseTo(180, 0);
    expect(e?.angleOffTailDeg).toBeCloseTo(180, 0);
    expect(e?.targetAtaDeg).toBeCloseTo(0, 0); // we're on its nose too
    expect(aspectWords(e?.aspectDeg ?? Number.NaN)).toBe("head-on");
  });

  it("beam: target crossing left to right 3 o'clock, above us, opening", async () => {
    const e = await twoShip(
      { x: 0, y: 0, alt: 3000, vx: 0, vy: 200, hdg: 0 },
      // Off our right wing, 1,500 m higher, flying parallel: we see its side (beam aspect).
      { x: 4000, y: 400, alt: 4500, vx: 0, vy: 200, hdg: 0 },
    );
    expect(e?.clock).toBe(3);
    expect(e?.elevation).toBe("high");
    expect(e?.altDiff).toBeCloseTo(1500, 0);
    expect(e?.aspectDeg).toBeGreaterThan(60);
    expect(e?.aspectDeg).toBeLessThan(120);
    expect(aspectWords(e?.aspectDeg ?? Number.NaN)).toBe("beam");
    expect(e?.timeToMergeS).toBeNull(); // not closing
  });
});
