/** A fight exported from the game must read back through the viewer's own parser and analysis. */
import { describe, expect, it } from "vitest";
import { parseAcmi } from "../src/acmi/parser.ts";
import { analyze } from "../src/analysis/analyze.ts";
import { acmiFileName } from "../src/game/acmi.ts";
import { NM } from "../src/game/sim/atmosphere.ts";
import { cloneParams, DEFAULT_PARAMS } from "../src/game/sim/params.ts";
import { command, jetById } from "../src/game/sim/world.ts";
import { DEFAULT_AUTOPAUSE, GameSession } from "../src/game/ui/session.ts";

async function* bytes(text: string) {
  yield new TextEncoder().encode(text);
}

/** Support drill at 35k: fire at 30 nm and crank, which kills the drone. */
function supportedShot(): GameSession {
  const s = new GameSession("support", 35000, cloneParams(DEFAULT_PARAMS), DEFAULT_AUTOPAUSE, 3);
  let fired = false;
  while (!s.world.outcome && s.world.t < 300) {
    const b = jetById(s.world, "B1");
    const r = jetById(s.world, "R1");
    if (b && r && !fired && Math.hypot(b.pos.x - r.pos.x, b.pos.y - r.pos.y) <= 30 * NM) {
      fired = command(s.world, { type: "fire", jetId: "B1", targetId: "R1" }) === null;
      command(s.world, {
        type: "steer",
        jetId: "B1",
        steer: { mode: "relative", threatId: "R1", offsetDeg: 40, dir: 1, label: "crank" },
      });
      command(s.world, { type: "chaff", jetId: "B1" });
    }
    s.advance(0.25);
  }
  return s;
}

describe("game: .acmi export", () => {
  it("reads back with the shot, its shooter and the kill", async () => {
    const s = supportedShot();
    expect(s.world.events.some((e) => e.type === "kill")).toBe(true);
    if (!s.recorder) throw new Error("expected recorder");
    const text = s.recorder.text();
    expect(text.startsWith("FileType=text/acmi/tacview\nFileVersion=2.2\n")).toBe(true);

    const rec = await parseAcmi(bytes(text));
    const jets = rec.objects.filter((o) => o.name === "FA-18C_hornet");
    expect(jets.map((o) => o.pilot).sort()).toEqual(["Drone", "Viper 1"]);
    expect(rec.objects.some((o) => o.name === "AIM_120C")).toBe(true);
    expect(rec.objects.some((o) => o.tags.includes("Decoy"))).toBe(true);

    const a = analyze(rec);
    const missileShots = a.shots.filter((x) => !x.isGun);
    expect(missileShots).toHaveLength(1);
    expect(missileShots[0]?.shooter?.pilot).toBe("Viper 1");
    expect(missileShots[0]?.outcome).toBe("hit");
    expect(a.kills).toHaveLength(1);
    expect(a.kills[0]?.victimPilot).toBe("Drone");
    expect(a.kills[0]?.killer?.pilot).toBe("Viper 1");
  });

  it("names files by scenario, altitude and start time", () => {
    expect(acmiFileName("duel", 25000, new Date(2026, 10, 14, 15, 30, 12))).toBe(
      "BVR-Trainer-duel-25k-20261114-153012.txt.acmi",
    );
  });
});
