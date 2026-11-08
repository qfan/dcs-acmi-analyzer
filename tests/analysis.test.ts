import { describe, expect, it } from "vitest";
import type { AcmiObject, Recording } from "../src/acmi/model.ts";
import { parseAcmi } from "../src/acmi/parser.ts";
import { type Analysis, analyze } from "../src/analysis/analyze.ts";
import { readTacviewCsv, score } from "./groundTruth.ts";
import { fileChunks, fixture, sample } from "./helpers.ts";

const name = (r: Recording, uid: number | null | undefined) =>
  uid === null || uid === undefined ? null : (r.objects[uid] as AcmiObject).name;

describe("analysis: built-in 2v1 sample (outcome checked by hand)", async () => {
  const r = await parseAcmi(fileChunks(sample("dcs-2021-f16-2v1-acm.zip.acmi")));
  const a: Analysis = analyze(r);

  it("finds the three kills with the right killers and weapons", () => {
    const summary = a.kills.map((k) => ({
      t: k.time,
      victim: name(r, k.victimUid),
      killer: k.killer?.pilot,
      weapon: k.weaponName,
      gun: k.isGun,
    }));
    expect(summary).toEqual([
      { t: 65.68, victim: "MiG-29A", killer: "QFAN", weapon: "AIM_9X", gun: false },
      { t: 121.23, victim: "Su-27", killer: "QFAN", weapon: "weapons.shells.M61_20_PGU28", gun: true },
      // The Su-27's R-73 was already in flight when the Su-27 died: a posthumous kill.
      { t: 121.53, victim: "F-16C_50", killer: "Adversary 2", weapon: "P_73", gun: false },
    ]);
    expect(a.kills.every((k) => !k.friendly && k.cause === "weapon")).toBe(true);
  });

  it("records engagement details for the AIM-9X kill", () => {
    const d = a.kills[0]?.details;
    expect(d?.launchTime).toBe(62.55);
    expect(d?.flightTimeS).toBeCloseTo(3.13, 2);
    expect(d?.missDistanceM).toBeLessThan(20);
    // A heat-seeker shot from inside 3 km; both jets at roughly 6 km altitude.
    expect(d?.launchRangeM).toBeGreaterThan(300);
    expect(d?.launchRangeM).toBeLessThan(3000);
    expect(d?.shooterAltM).toBeGreaterThan(5000);
    expect(d?.victimSpeedMs).toBeGreaterThan(100);
    expect(a.kills.every((k) => (k.cause === "weapon") === (k.details !== null))).toBe(true);
  });

  it("attributes every missile to its launcher", () => {
    const missiles = a.shots.filter((s) => !s.isGun).map((s) => [name(r, s.weaponUid), s.shooter?.pilot]);
    expect(missiles).toEqual([
      ["AIM_9X", "QFAN"],
      ["P_73", "Adversary 2"],
      ["P_73", "Adversary 2"],
    ]);
  });

  it("groups gun rounds into bursts", () => {
    const bursts = a.shots.filter((s) => s.isGun);
    expect(bursts.every((b) => b.shooter?.pilot === "QFAN")).toBe(true);
    expect(bursts.reduce((n, b) => n + b.rounds, 0)).toBe(204); // all Projectile+Shell objects
  });

  it("summarises pilots", () => {
    const qfan = a.pilots.find((p) => p.key === "QFAN");
    expect(qfan).toMatchObject({ kills: 2, airKills: 2, deaths: 0, shots: 1 });
    expect(a.pilots.find((p) => p.key === "Adversary 2")).toMatchObject({ kills: 1, deaths: 1, shots: 2 });
  });
});

describe("analysis rules on synthetic recordings", () => {
  const H = "FileType=text/acmi/tacview\nFileVersion=2.2\n0,ReferenceLongitude=40\n0,ReferenceLatitude=40\n";
  const run = async (body: string) => {
    const r = await parseAcmi(
      (async function* () {
        // A trailing frame keeps the events away from the end-of-recording rule.
        yield new TextEncoder().encode(`${H + body}#60\n`);
      })(),
    );
    return { r, a: analyze(r) };
  };
  // ~0.001 deg of latitude is ~111 m; of longitude at 40N ~85 m.
  const jet = (id: string, lon: number, alt: number, extra = "") =>
    `${id},T=${lon}|0|${alt},Type=Air+FixedWing,Name=F-16C_50,Coalition=Enemies,Color=Blue${extra}`;

  it("does not count the DCS remove-and-re-add glitch as a death", async () => {
    const { a } = await run(
      `#0\n${jet("a", 0, 5000, ",Pilot=P1")}\n#1\na,T=0.001|0|5000\n#1.5\n-a\n#1.52\n${jet("a", 0.0011, 5000, ",Pilot=P1")}\n#3\na,T=0.002|0|5000\n`,
    );
    expect(a.mergedLives).toBe(1);
    expect(a.kills).toEqual([]);
  });

  it("classifies a fast removal near nothing as a crash and a stationary one as a despawn (not listed)", async () => {
    const { r, a } = await run(
      `#0\n${jet("a", 0, 500)}\n${jet("b", 0.1, 0)}\n#1\na,T=0.004|0|400\nb,T=0.1|0|0\n#2\na,T=0.008|0|300\n-a\nb,T=0.1|0|0\n-b\n`,
    );
    expect(a.kills.map((k) => [name(r, k.victimUid), k.cause])).toEqual([["F-16C_50", "crash"]]);
    expect(a.kills[0]?.victimUid).toBe(0);
  });

  it("does not count aircraft or units that simply vanish (player left, out of view) as losses", async () => {
    const { a } = await run(
      `#0\n${jet("a", 0, 3000)}\n1f,T=0.5|0.5|0,Type=Ground+AntiAircraft,Name=Tor 9A331\n` +
        `#1\na,T=0.003|0|3000\n#2\na,T=0.006|0|3000\n-a\n-1f\n`,
    );
    expect(a.kills).toEqual([]);
    expect(a.removedWithoutEvidence).toEqual({ aircraft: 1, other: 1 });
  });

  it("does not count objects removed when the recording ends, or mass removals, as losses", async () => {
    const units = Array.from({ length: 12 }, (_, i) => (0x100 + i).toString(16));
    const spawn = units.map((id, i) => `${id},T=0.${i}|0|0,Type=Ground+Vehicle,Name=T-72B`).join("\n");
    const remove = units.map((id) => `-${id}`).join("\n");
    const { a } = await run(`#0\n${spawn}\n#10\n${remove}\n`);
    expect(a.kills).toEqual([]);
    expect(a.massRemovals).toEqual([{ time: 10, count: 12, atEnd: false }]);
  });

  it("leaves aircraft with scrambled positions (protected recordings) out of the kill list", async () => {
    // Real shape: longitude/latitude jump by degrees every frame while altitude stays smooth.
    const lons = [2.56, 3.8, 6.79, 4.35, 4.59, 1.2, 5.5, 2.1];
    const lines = lons.map((lon, i) => `#${i * 0.2}\n${jet("a", lon, 300 - i)}`).join("\n");
    const { a } = await run(`0,PlaybackKey=x\n${lines}\n#2\n-a\n`);
    expect(a.scrambled).toEqual({ objects: 1, aircraft: 1, protectedHeader: true });
    expect(a.kills).toEqual([]);
  });

  it("detects a mid-air collision", async () => {
    const { a } = await run(
      `#0\n${jet("a", 0, 3000)}\n${jet("b", 0.002, 3000)}\n#1\na,T=0.0005|0|3000\nb,T=0.0015|0|3000\n#1.1\n-a\n-b\n`,
    );
    expect(a.kills.map((k) => k.cause)).toEqual(["collision", "collision"]);
  });

  it("credits a kill to the pilot flying the shooter at launch time, and flags friendly fire", async () => {
    const { r, a } = await run(
      // IDs must be hexadecimal: a = shooter, c = victim, d = missile.
      `#0\n${jet("a", 0, 5000, ",Pilot=First")}\n${jet("c", 0.05, 5000, ",Pilot=Victim")}\n` +
        `#5\na,Pilot=Second\n#6\nd,T=0.0001|0|5000,Type=Weapon+Missile,Name=AIM_120C,Coalition=Enemies\n` +
        `#9\nd,T=0.05|0|5000\n#9.1\n-d\n-c\n`,
    );
    expect(a.kills).toHaveLength(1);
    expect(a.kills[0]).toMatchObject({ cause: "weapon", weaponName: "AIM_120C", friendly: true });
    expect(a.kills[0]?.killer?.pilot).toBe("Second");
    expect(name(r, a.kills[0]?.killer?.uid)).toBe("F-16C_50");
  });
});

describe("analysis vs Tacview's own exported event log (SAMs vs TALD decoys, 2024)", async () => {
  const r = await parseAcmi(fileChunks(fixture("ground-truth/dcs-2024-sam-vs-tald.zip.acmi")));
  const a = analyze(r);
  const rows = readTacviewCsv(fixture("ground-truth/dcs-2024-sam-vs-tald.tacview-events.csv"));
  const DISPLAY: Record<string, string> = {
    "FA-18C_hornet": "F/A-18C Hornet",
    ADM_141A: "ADM-141A TALD",
    MOSCOW: "Moskva",
    "S-300PS 5P85C ln": "SA-10 Grumble (LN)",
    "S-300PS 5P85D ln": "SA-10 Grumble (LN)",
    "Tor 9A331": "SA-15 Gauntlet",
    SA9M330: "9M330",
  };
  const s = score(r, a, rows, (n) => DISPLAY[n] ?? n);

  it("finds every weapon Tacview says was fired, with the same shooter and pilot", () => {
    expect(s.fired.mismatches).toEqual([]);
    expect(s.fired).toMatchObject({ tacview: 122, matched: 122, shooterAgrees: 122 });
  });

  it("reproduces Tacview's hits, differing only in understood ways", () => {
    if (process.env.DETAIL) console.log(JSON.stringify(s.hits, null, 2));
    expect(s.hits.matched).toBe(40);
    // Not reported by us, by design:
    expect(s.hits.missed).toEqual([
      // A SAM self-destructing 114-133 m from the ship that launched it: we never count a
      // weapon hitting its own launcher.
      "293.74 Moskva hit by SA5B55",
      "315.99 Moskva hit by SA5B55",
      "374.4 Moskva hit by SA5B55",
      // Tacview's ~150 m radius counts this near miss; the TALD flew on for 5 more seconds.
      "482.72 ADM-141A TALD hit by SA5B55",
    ]);
  });

  it("only adds hits Tacview logged as the victim being destroyed at that same moment (interceptions)", () => {
    // Tacview judges hits from the last sampled positions (up to 250 m apart here); closest approach
    // shows 3-19 m. Each extra hit must be on an object Tacview says was destroyed in that frame.
    expect(s.hits.extra.length).toBe(26);
    for (const h of s.hits.extra) {
      expect(h.d).toBeLessThan(20);
      const destroyed = rows.some(
        (r) =>
          r.event === "HasBeenDestroyed" && r.primaryName === h.victim && Math.abs(r.time - h.time) < 0.06,
      );
      expect(destroyed, `${h.time} ${h.victim}`).toBe(true);
    }
  });
});
