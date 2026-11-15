/**
 * Worst-case multiplayer load: 6v6, every jet firing all 10 missiles and dumping every chaff
 * bundle and flare. Snapshots must stay under the relay's message limit and still give guests
 * the whole fight; guests holding keys must not be disconnected.
 */
import { describe, expect, it } from "vitest";
import type { GuestMsg } from "../src/game/engine/protocol.ts";
import { DEFAULT_AUTOPAUSE, GameSession } from "../src/game/engine/session.ts";
import {
  applySnapshot,
  buildSnapshot,
  makeMirror,
  SnapshotCursor,
  snapshotFromNet,
  snapshotToJson,
  worldShape,
} from "../src/game/engine/snapshot.ts";
import { Outbox, ReplyLimiter } from "../src/game/net/outbox.ts";
import { NM } from "../src/game/sim/atmosphere.ts";
import { cloneParams, DEFAULT_PARAMS } from "../src/game/sim/params.ts";
import { buildMultiplayer, DEFAULT_OPTIONS } from "../src/game/sim/scenarios.ts";
import { SIM_DT } from "../src/game/sim/world.ts";

/** The relay's host message limit is 64 KB; the host keeps under 60,000 bytes. */
const NET_MAX_BYTES = 60_000;

function spamFight() {
  const p = cloneParams(DEFAULT_PARAMS);
  p.aircraft.missiles = 10;
  const crew: Record<string, "human"> = {};
  for (let i = 1; i <= 6; i++) {
    crew[`B${i}`] = "human";
    crew[`R${i}`] = "human";
  }
  const world = buildMultiplayer("6v6", p, 35000, 7, crew);
  // Close the range so every jet can shoot at once.
  for (const j of world.jets) if (j.side === "red") j.pos.y = j.pos.y - 80 * NM;
  return new GameSession("6v6", 35000, p, DEFAULT_AUTOPAUSE, 7, DEFAULT_OPTIONS, { world, record: false });
}

describe("worst-case spam", () => {
  it("keeps snapshots under the relay limit and gives the guest the whole fight", () => {
    const s = spamFight();
    const w = s.world;
    const cur = new SnapshotCursor();
    const mirror = makeMirror(worldShape(w));
    let maxBytes = 0;
    let maxDecoys = 0;
    let maxMissiles = 0;
    const reds = w.jets.filter((j) => j.side === "red");
    const blues = w.jets.filter((j) => j.side === "blue");
    for (let step = 0; step < 12 / SIM_DT; step++) {
      for (const j of w.jets) {
        if (!j.alive) continue;
        const foes = j.side === "blue" ? reds : blues;
        const tgt = foes[step % foes.length];
        if (j.missiles > 0 && tgt?.alive) s.applyCommand({ type: "fire", jetId: j.id, targetId: tgt.id });
        s.applyCommand({ type: "chaff", jetId: j.id });
        s.applyCommand({ type: "flare", jetId: j.id });
      }
      s.advance(SIM_DT);
      maxDecoys = Math.max(maxDecoys, w.decoys.length);
      maxMissiles = Math.max(maxMissiles, w.missiles.filter((m) => !m.end).length);
      if (step % 5 === 4) {
        const json = snapshotToJson(buildSnapshot(s, ["blue", "red"], cur));
        maxBytes = Math.max(maxBytes, json.length);
        applySnapshot(mirror, snapshotFromNet(JSON.parse(`{"k":"snap","snap":${json}}`).snap));
      }
    }
    expect(maxMissiles).toBe(120);
    expect(maxDecoys).toBeGreaterThan(1000);
    expect(maxBytes).toBeLessThan(NET_MAX_BYTES);
    // The guest saw every event and every missile, and the same decoys in the same places.
    expect(mirror.eventOffset + mirror.events.length).toBe(w.eventOffset + w.events.length);
    expect(mirror.missiles.map((m) => [m.id, m.end])).toEqual(w.missiles.map((m) => [m.id, m.end]));
    expect(mirror.decoys.map((d) => d.seq)).toEqual(w.decoys.map((d) => d.seq));
    for (const [i, d] of mirror.decoys.entries()) {
      const h = w.decoys[i];
      if (!h) continue;
      expect(Math.hypot(d.pos.x - h.pos.x, d.pos.y - h.pos.y, d.pos.z - h.pos.z)).toBeLessThan(1);
    }
  }, 30_000);

  it("paces a guest holding keys: latest state wins, a few shots queue, the rest wait or drop", () => {
    let now = 0;
    const sent: GuestMsg[] = [];
    const out = new Outbox(
      (m) => sent.push(m),
      10,
      20,
      () => now,
    );
    for (let i = 0; i < 100; i++) {
      out.push({ k: "cmd", cmd: { type: "throttle", jetId: "R1", throttle: i % 2 ? "ab" : "mil" } });
      out.push({ k: "cmd", cmd: { type: "chaff", jetId: "R1" } });
    }
    expect(sent.length).toBe(20); // the burst
    expect(out.pending).toBeLessThanOrEqual(4); // one throttle (latest) + at most 3 chaff
    now += 10_000;
    out.push({ k: "ping", n: 1, rttMs: null });
    const last = sent.filter((m) => m.k === "cmd" && m.cmd.type === "throttle").at(-1);
    expect(last).toEqual({ k: "cmd", cmd: { type: "throttle", jetId: "R1", throttle: "ab" } });
    expect(out.pending).toBe(0);
    out.dispose();
  });

  it("limits how often the host answers one guest", () => {
    const r = new ReplyLimiter();
    expect(r.allow(1, "flash", 0)).toBe(true);
    expect(r.allow(1, "flash", 500)).toBe(false);
    expect(r.allow(2, "flash", 500)).toBe(true);
    expect(r.allow(1, "flash", 1000)).toBe(true);
    expect(r.allow(1, "sync", 1000)).toBe(true);
    expect(r.allow(1, "sync", 4000)).toBe(false);
  });
});
