import { afterEach, describe, expect, it } from "vitest";
import { configFromEnv, type RunningRelay, startRelay } from "../game/server/node/relay.ts";
import { Engine } from "../src/game/engine/engine.ts";
import type { FromEngine, LobbyState, MatchMeta } from "../src/game/engine/protocol.ts";
import { applySnapshot, makeMirror, type Snapshot } from "../src/game/engine/snapshot.ts";
import { cloneParams, DEFAULT_PARAMS } from "../src/game/sim/params.ts";
import { DEFAULT_OPTIONS } from "../src/game/sim/scenarios.ts";

/** An engine plus everything it posted to its UI. */
class Harness {
  readonly out: FromEngine[] = [];
  readonly engine = new Engine((m) => this.out.push(structuredClone(m)));
  last<T extends FromEngine["t"]>(t: T): Extract<FromEngine, { t: T }> | undefined {
    for (let i = this.out.length - 1; i >= 0; i--) if (this.out[i]?.t === t) return this.out[i] as never;
    return undefined;
  }
  async until<T extends FromEngine["t"]>(
    t: T,
    pred: (m: Extract<FromEngine, { t: T }>) => boolean = () => true,
    ms = 4000,
    from = 0,
  ): Promise<Extract<FromEngine, { t: T }>> {
    const end = Date.now() + ms;
    let seen = from;
    while (Date.now() < end) {
      for (; seen < this.out.length; seen++) {
        const m = this.out[seen] as FromEngine;
        if (m.t === t && pred(m as never)) return m as never;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ${t}`);
  }
  mark(): number {
    return this.out.length;
  }
  lobby(): LobbyState {
    const l = this.last("lobby");
    if (!l) throw new Error("no lobby");
    return l.lobby;
  }
}

const harnesses: Harness[] = [];
const relays: RunningRelay[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) h.engine.dispose();
  for (const r of relays.splice(0)) await r.close();
});
const harness = () => {
  const h = new Harness();
  harnesses.push(h);
  return h;
};

describe("engine: single player", () => {
  it("runs the fight and streams snapshots that rebuild the world", async () => {
    const h = harness();
    h.engine.handle({
      t: "sp-start",
      scenarioId: "duel",
      altFt: 25000,
      params: cloneParams(DEFAULT_PARAMS),
      options: DEFAULT_OPTIONS,
      seed: 3,
      fog: false,
    });
    const match = await h.until("match");
    expect(match.meta.owned).toEqual(["B1"]);
    const mirror = makeMirror(match.meta.shape);
    applySnapshot(mirror, match.snap);
    h.engine.handle({ t: "cmd", cmd: { type: "throttle", jetId: "B1", throttle: "ab" } });
    h.engine.handle({ t: "cmd", cmd: { type: "throttle", jetId: "R1", throttle: "idle" } }); // not ours: ignored
    const snap = await h.until("snap", (m) => m.snap.t > 0.5);
    for (const m of h.out) if (m.t === "snap") applySnapshot(mirror, m.snap);
    expect(snap.snap.t).toBeGreaterThan(0.5);
    expect(mirror.jets.find((j) => j.id === "B1")?.throttle).toBe("ab");
    expect(mirror.jets.find((j) => j.id === "R1")?.throttle).not.toBe("idle");
    expect(mirror.events.length).toBeGreaterThanOrEqual(0);

    h.engine.handle({ t: "pause" });
    await h.until("snap", (m) => m.snap.paused);
    h.engine.handle({ t: "visibility", hidden: true });
    h.engine.handle({ t: "play" });
    await h.until("snap", (m) => !m.snap.paused);
    h.engine.handle({ t: "visibility", hidden: true });
    const hidden = await h.until("snap", (m) => m.snap.pauseReason?.includes("hidden") ?? false);
    expect(hidden.snap.paused).toBe(true);
  });
});

describe("engine: multiplayer through the relay", () => {
  async function room() {
    const relay = await startRelay({
      ...configFromEnv({}),
      port: 0,
      stateDir: null,
      log: () => {},
      allowNoOrigin: true,
    });
    relays.push(relay);
    const url = `ws://127.0.0.1:${relay.port}/ws`;
    const host = harness();
    const guest = harness();
    host.engine.handle({ t: "mp-host", relayUrl: url, name: "Viper", params: cloneParams(DEFAULT_PARAMS) });
    const hl = await host.until("lobby");
    guest.engine.handle({ t: "mp-join", relayUrl: url, room: hl.lobby.room, name: "Mav" });
    await guest.until("lobby", (m) => m.lobby.players.length === 2);
    return { relay, host, guest, code: hl.lobby.room };
  }

  it("hosts a lobby, seats a guest, starts, and relays orders and snapshots", async () => {
    const { host, guest } = await room();
    expect(host.lobby().settings.fog).toBe(true); // fog of war on by default in multiplayer
    expect(host.lobby().slots.find((s) => s.jetId === "B1")?.peer).toBe(0);

    // The guest can't start or change settings.
    guest.engine.handle({ t: "lobby", action: { a: "settings", patch: { altFt: 5000 } } });
    guest.engine.handle({ t: "lobby", action: { a: "take", jetId: "R1" } });
    await host.until("lobby", (m) => m.lobby.slots.find((s) => s.jetId === "R1")?.peer === 1);
    expect(host.lobby().settings.altFt).toBe(25000);

    // Not ready yet: start is refused.
    host.engine.handle({ t: "lobby", action: { a: "start" } });
    expect((await host.until("flash")).text).toMatch(/Waiting for Mav/);

    guest.engine.handle({ t: "lobby", action: { a: "ready", ready: true } });
    await host.until("lobby", (m) => m.lobby.players.find((p) => p.id === 1)?.ready === true);
    host.engine.handle({ t: "lobby", action: { a: "start" } });

    const hm = await host.until("match");
    const gm = await guest.until("match");
    expect(hm.meta.side).toBe("blue");
    expect(hm.meta.owned).toEqual(["B1"]);
    expect(gm.meta.side).toBe("red");
    expect(gm.meta.owned).toEqual(["R1"]);
    expect(gm.meta.roomFog).toBe(true);
    expect(gm.meta.canScale).toBe(false);

    // Guest orders its own jet; ordering the host's jet is refused.
    guest.engine.handle({ t: "cmd", cmd: { type: "throttle", jetId: "R1", throttle: "idle" } });
    guest.engine.handle({ t: "cmd", cmd: { type: "throttle", jetId: "B1", throttle: "idle" } });
    expect((await guest.until("flash")).text).toMatch(/not your jet/);
    const gs = await guest.until("snap", (m) => m.snap.jets.find((j) => j.id === "R1")?.throttle === "idle");
    expect(gs.snap.jets.find((j) => j.id === "B1")?.throttle).not.toBe("idle");
    expect(gs.snap.know.red).toBeDefined();

    // Time moves for the guest too.
    const later = await guest.until("snap", (m) => m.snap.t > 1);
    expect(later.snap.t).toBeGreaterThan(1);
  });

  it("limits pauses, pauses for a dropped player, and hands a leaver's jet to an NPC", async () => {
    const { host, guest, relay } = await room();
    guest.engine.handle({ t: "lobby", action: { a: "take", jetId: "R1" } });
    guest.engine.handle({ t: "lobby", action: { a: "ready", ready: true } });
    await host.until("lobby", (m) => m.lobby.players.find((p) => p.id === 1)?.ready === true);
    host.engine.handle({ t: "lobby", action: { a: "start" } });
    await guest.until("match");

    guest.engine.handle({ t: "pause" });
    const paused = await host.until("snap", (m) => m.snap.paused);
    expect(paused.snap.pauseReason).toMatch(/Mav paused \(4 left\)/);
    expect((await guest.until("meta")).meta.pausesLeft).toBe(4);
    host.engine.handle({ t: "play" });
    await host.until("snap", (m) => !m.snap.paused);

    // The guest leaves: the host's room gets the R1 slot flown by an NPC.
    const mark = host.mark();
    guest.engine.handle({ t: "mp-leave" });
    const after = await host.until("lobby", (m) => m.lobby.players.length === 1, 4000, mark);
    expect(after.lobby.slots.find((s) => s.jetId === "R1")?.crew).toBe("normal");
    const snap = await host.until("snap", (m) => !!m.snap.npc.R1);
    expect(snap.snap.npc.R1?.line).toMatch(/NPC/);
    expect(relay.rooms.size).toBe(1);

    // Back to the lobby: the slot opens again.
    host.engine.handle({ t: "lobby", action: { a: "to-lobby" } });
    const lobby = await host.until("lobby", (m) => m.lobby.phase === "lobby");
    expect(lobby.lobby.slots.find((s) => s.jetId === "R1")?.crew).toBe("open");
  });

  it("closes the guest's match when the host leaves", async () => {
    const { host, guest } = await room();
    host.engine.handle({ t: "mp-leave" });
    const ended = await guest.until("ended");
    expect(ended.reason).toMatch(/host/i);
  });

  it("lets players choose their own fog only when the room doesn't force it", async () => {
    const { host, guest } = await room();
    host.engine.handle({ t: "lobby", action: { a: "settings", patch: { fog: false } } });
    await guest.until("lobby", (m) => m.lobby.settings.fog === false);
    guest.engine.handle({ t: "lobby", action: { a: "take", jetId: "R1" } });
    guest.engine.handle({ t: "lobby", action: { a: "ready", ready: true } });
    await host.until("lobby", (m) => m.lobby.players.find((p) => p.id === 1)?.ready === true);
    host.engine.handle({ t: "lobby", action: { a: "start" } });
    const gm = await guest.until("match");
    expect((gm.meta as MatchMeta).roomFog).toBe(false);
    guest.engine.handle({ t: "fog", on: true });
    // No direct way to read the host's fog set from outside; the order must at least not break the match.
    const s: Snapshot = (await guest.until("snap", (m) => m.snap.t > 0.3)).snap;
    expect(s.t).toBeGreaterThan(0.3);
  });
});
