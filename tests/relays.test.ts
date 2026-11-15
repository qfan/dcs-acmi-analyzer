import { describe, expect, it } from "vitest";
import {
  BUILTIN_RELAYS,
  blockedAsMixedContent,
  healthUrl,
  inviteLink,
  isRelayUrl,
  knownRelays,
  orderRelays,
  type ProbeResult,
  parseInvite,
  relayLabel,
} from "../src/game/net/relays.ts";

const CF = BUILTIN_RELAYS[0]?.url as string;
const OR = BUILTIN_RELAYS[1]?.url as string;

describe("relay list and invites", () => {
  it("puts this computer's relay first only on a local page", () => {
    expect(knownRelays({ hostname: "localhost" }).map((r) => r.key)).toEqual(["local", "cf", "or"]);
    expect(knownRelays({ hostname: "acmi.qfan.ca" }).map((r) => r.key)).toEqual(["cf", "or"]);
    expect(CF).toBe("wss://bvr-mini-game-server-cf.qfan.ca/ws");
    expect(OR).toBe("wss://bvr-mini-game-server-or.qfan.ca/ws");
  });

  it("accepts only ws/wss addresses and flags ws:// on https pages", () => {
    expect(isRelayUrl("wss://relay.example/ws")).toBe(true);
    expect(isRelayUrl("ws://100.64.0.2:8787/ws")).toBe(true);
    expect(isRelayUrl("https://relay.example/ws")).toBe(false);
    expect(isRelayUrl("wss://user:pw@relay.example/ws")).toBe(false);
    expect(isRelayUrl("not a url")).toBe(false);
    expect(blockedAsMixedContent("ws://x/ws", "https:")).toBe(true);
    expect(blockedAsMixedContent("wss://x/ws", "https:")).toBe(false);
    expect(blockedAsMixedContent("ws://x/ws", "http:")).toBe(false);
  });

  it("derives the health address from the relay address", () => {
    expect(healthUrl(CF)).toBe("https://bvr-mini-game-server-cf.qfan.ca/healthz");
    expect(healthUrl("ws://localhost:8787/ws")).toBe("http://localhost:8787/healthz");
    expect(healthUrl("wss://x.example/game/ws?a=1")).toBe("https://x.example/game/healthz");
  });

  it("orders relays: quickest working first; full ones only for joining", () => {
    const relays = knownRelays({ hostname: "acmi.qfan.ca" });
    const probes = new Map<string, ProbeResult>([
      [CF, { state: "ok", ms: 80 }],
      [OR, { state: "ok", ms: 30 }],
    ]);
    expect(orderRelays(relays, probes, "host")).toEqual([OR, CF]);
    probes.set(OR, { state: "busy", ms: 30 });
    expect(orderRelays(relays, probes, "host")).toEqual([CF]);
    expect(orderRelays(relays, probes, "join")).toEqual([CF, OR]);
    probes.set(CF, { state: "down", ms: null });
    expect(orderRelays(relays, probes, "host")).toEqual([CF]); // unknown is still worth a try
  });

  it("writes and reads invite links with built-in keys or full custom addresses", () => {
    const relays = knownRelays({ hostname: "acmi.qfan.ca" });
    const page = "https://acmi.qfan.ca/game.html";
    const cf = inviteLink(page, "K7QM3D", CF, relays);
    expect(cf).toBe(`${page}#join=K7QM3D&r=cf`);
    expect(parseInvite(new URL(cf).hash, relays)).toEqual({ room: "K7QM3D", relayUrl: CF });
    const custom = inviteLink(page, "K7QM3D", "wss://my-pc.tail1.ts.net/ws", relays);
    expect(parseInvite(new URL(custom).hash, relays)).toEqual({
      room: "K7QM3D",
      relayUrl: "wss://my-pc.tail1.ts.net/ws",
    });
    expect(parseInvite("#join=K7QM3D", relays)).toEqual({ room: "K7QM3D", relayUrl: null });
    expect(parseInvite("#join=K7QM3D&r=javascript:alert(1)", relays)).toEqual({
      room: "K7QM3D",
      relayUrl: null,
    });
    expect(parseInvite("#join=bad", relays)).toBeNull();
    expect(relayLabel(CF, relays)).toBe("Cloudflare");
    expect(relayLabel("wss://my-pc.tail1.ts.net/ws", relays)).toBe("my-pc.tail1.ts.net");
  });
});
