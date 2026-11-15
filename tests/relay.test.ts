import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { configFromEnv, type RelayConfig, type RunningRelay, startRelay } from "../game/server/node/relay.ts";
import { LIMITS, type Limits } from "../game/server/shared/protocol.ts";

const ORIGIN = "http://localhost:5173";
const running: RunningRelay[] = [];

async function relay(over: Partial<RelayConfig> = {}, limits: Partial<Limits> = {}): Promise<RunningRelay> {
  const r = await startRelay({
    ...configFromEnv({}),
    port: 0,
    stateDir: null,
    log: () => {},
    ...over,
    limits: { ...LIMITS, ...limits },
  });
  running.push(r);
  return r;
}

afterEach(async () => {
  while (running.length) await running.pop()?.close();
});

/** A test client that queues every message it receives. */
class Client {
  readonly ws: WebSocket;
  readonly inbox: unknown[] = [];
  private waiters: (() => void)[] = [];
  closed = false;
  opened: Promise<boolean>;

  constructor(port: number, origin: string | null = ORIGIN) {
    const init = origin ? { headers: { Origin: origin } } : {};
    // Node's WebSocket (undici) accepts extra headers as a second argument.
    this.ws = new (WebSocket as unknown as new (u: string, i: object) => WebSocket)(
      `ws://127.0.0.1:${port}/ws`,
      init,
    );
    this.ws.binaryType = "arraybuffer";
    this.opened = new Promise((res) => {
      this.ws.onopen = () => res(true);
      this.ws.onerror = () => res(false);
    });
    this.ws.onmessage = (e) => {
      this.inbox.push(
        typeof e.data === "string" ? JSON.parse(e.data) : new Uint8Array(e.data as ArrayBuffer),
      );
      this.wake();
    };
    this.ws.onclose = () => {
      this.closed = true;
      this.wake();
    };
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  send(m: unknown) {
    const text = typeof m === "string" ? m : JSON.stringify(m);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(text);
    else void this.opened.then((ok) => ok && this.ws.send(text));
  }

  /** Next message (optionally of type `t`), skipping others; fails after a timeout. */
  async next<T = Record<string, unknown>>(t?: string, timeoutMs = 2000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.inbox.findIndex((m) => t === undefined || (m as { t?: string }).t === t);
      if (i >= 0) return this.inbox.splice(i, 1)[0] as T;
      if (this.closed && t !== undefined) throw new Error(`closed before "${t}"`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${t ?? "a message"}`);
      await new Promise<void>((res) => {
        this.waiters.push(res);
        setTimeout(res, left);
      });
    }
  }

  async waitClosed(timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    return this.closed;
  }
}

async function hostAndGuest(r: RunningRelay) {
  const host = new Client(r.port);
  host.send({ t: "create", name: "Viper" });
  const hw = await host.next<{ room: string; you: number; host: number; token: string }>("welcome");
  const guest = new Client(r.port);
  guest.send({ t: "join", room: hw.room, name: "Mav" });
  const gw = await guest.next<{ you: number; host: number; token: string; peers: unknown[] }>("welcome");
  await host.next("peer-joined");
  return { host, guest, room: hw.room, hw, gw };
}

describe("relay", () => {
  it("answers health checks and nothing else over plain HTTP", async () => {
    const r = await relay();
    expect(await (await fetch(`http://127.0.0.1:${r.port}/healthz`)).text()).toBe("ok\n");
    expect((await fetch(`http://127.0.0.1:${r.port}/`)).status).toBe(404);
  });

  it("lets allowed pages read its health, and says busy at the room cap", async () => {
    const r = await relay({ maxRooms: 1 });
    const health = (origin: string) =>
      fetch(`http://127.0.0.1:${r.port}/healthz`, { headers: { Origin: origin } });
    const ok = await health(ORIGIN);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(await ok.text()).toBe("ok\n");
    const other = await health("https://evil.example");
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    await hostAndGuest(r);
    expect(await (await health(ORIGIN)).text()).toBe("busy\n");
  });

  it("creates a room, joins it, and forwards host and guest messages", async () => {
    const r = await relay();
    const { host, guest, hw, gw } = await hostAndGuest(r);
    expect(hw.room).toMatch(/^[A-Z2-9]{6}$/);
    expect(hw.you).toBe(0);
    expect(gw.you).toBe(1);
    expect(gw.host).toBe(0);
    expect(gw.peers).toHaveLength(2);

    guest.send({ t: "send", d: { cmd: "fire" } });
    expect(await host.next("msg")).toEqual({ t: "msg", from: 1, d: { cmd: "fire" } });

    host.send({ t: "send", d: { snap: 1 } });
    expect(await guest.next("msg")).toEqual({ t: "msg", from: 0, d: { snap: 1 } });
    host.send({ t: "send", to: 1, d: { only: "you" } });
    expect(await guest.next("msg")).toEqual({ t: "msg", from: 0, d: { only: "you" } });
  });

  it("delivers a guest's message only to the host, whatever `to` says", async () => {
    const r = await relay();
    const { host, guest, room } = await hostAndGuest(r);
    const third = new Client(r.port);
    third.send({ t: "join", room });
    await third.next("welcome");
    guest.send({ t: "send", to: 2, d: "psst" });
    expect(await host.next("msg")).toMatchObject({ from: 1, d: "psst" });
    await expect(third.next("msg", 300)).rejects.toThrow(/timed out/);
  });

  it("forwards binary messages with the sender's id in byte 0", async () => {
    const r = await relay();
    const { host, guest } = await hostAndGuest(r);
    host.ws.send(new Uint8Array([255, 7, 8, 9]));
    expect([...(await guest.next<Uint8Array>())]).toEqual([0, 7, 8, 9]);
    guest.ws.send(new Uint8Array([42, 1]));
    expect([...(await host.next<Uint8Array>())]).toEqual([1, 1]);
  });

  it("matches origins exactly, or any port for entries ending in :*", async () => {
    const { originMatches } = await import("../game/server/node/relay.ts");
    const allowed = ["https://acmi.qfan.ca", "http://localhost:*"];
    expect(originMatches(allowed, "https://acmi.qfan.ca")).toBe(true);
    expect(originMatches(allowed, "http://localhost:5175")).toBe(true);
    expect(originMatches(allowed, "http://localhost")).toBe(false);
    expect(originMatches(allowed, "http://localhost:5175.evil.example")).toBe(false);
    expect(originMatches(allowed, "http://localhostevil.example:80")).toBe(false);
    expect(originMatches(allowed, "https://acmi.qfan.ca.evil.example")).toBe(false);
  });

  it("refuses other origins and, by default, clients without an Origin", async () => {
    const r = await relay();
    expect(await new Client(r.port, "https://evil.example").opened).toBe(false);
    expect(await new Client(r.port, null).opened).toBe(false);
    const r2 = await relay({ allowNoOrigin: true });
    expect(await new Client(r2.port, null).opened).toBe(true);
  });

  it("rejects unknown room codes, full rooms and bad first messages", async () => {
    const r = await relay({}, { maxPeers: 2 });
    const lost = new Client(r.port);
    lost.send({ t: "join", room: "ABCDEF" });
    expect(await lost.next("error")).toMatchObject({ code: "no-room" });
    expect(await lost.waitClosed()).toBe(true);

    const { room } = await hostAndGuest(r);
    const late = new Client(r.port);
    late.send({ t: "join", room });
    expect(await late.next("error")).toMatchObject({ code: "room-full" });

    const junk = new Client(r.port);
    junk.send("not json");
    expect(await junk.next("error")).toMatchObject({ code: "bad-message" });
  });

  it("kicks a guest for oversized messages and for flooding", async () => {
    const r = await relay({}, { maxGuestMessageBytes: 1000, guestMessagesPerS: 5 });
    const a = await hostAndGuest(r);
    a.guest.send({ t: "send", d: "x".repeat(2000) });
    expect(await a.guest.next("error")).toMatchObject({ code: "too-large" });
    expect(await a.host.next("peer-left")).toMatchObject({ id: 1 });

    const b = await hostAndGuest(r);
    for (let i = 0; i < 20; i++) b.guest.send({ t: "send", d: i });
    expect(await b.guest.next("error")).toMatchObject({ code: "rate-limit" });
  });

  it("closes frames whose declared length is over the cap before reading them", async () => {
    const r = await relay();
    const sock = connect(r.port, "127.0.0.1");
    const got: Buffer[] = [];
    sock.on("data", (c: Buffer) => got.push(c));
    const closed = new Promise<void>((res) => sock.on("close", () => res()));
    sock.write(
      "GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Origin: ${ORIGIN}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
    );
    // A masked binary frame claiming 2^40 bytes, with no payload behind it.
    const head = Buffer.alloc(14);
    head[0] = 0x82;
    head[1] = 0xff;
    head.writeBigUInt64BE(2n ** 40n, 2);
    sock.write(head);
    await closed;
    const text = Buffer.concat(got).toString("latin1");
    expect(text).toContain("101 Switching Protocols");
    expect(text).toContain("message too large");
  });

  it("lets a dropped player resume the same seat with its token", async () => {
    const r = await relay();
    const { host, guest, room, gw } = await hostAndGuest(r);
    guest.ws.close();
    expect(await host.next("peer-away")).toMatchObject({ id: 1 });
    const back = new Client(r.port);
    back.send({ t: "resume", room, token: gw.token });
    expect(await back.next("welcome")).toMatchObject({ you: 1 });
    expect(await host.next("peer-back")).toMatchObject({ id: 1 });
    back.send({ t: "send", d: "again" });
    expect(await host.next("msg")).toMatchObject({ from: 1 });

    const thief = new Client(r.port);
    thief.send({ t: "resume", room, token: "wrong" });
    expect(await thief.next("error")).toMatchObject({ code: "bad-token" });
  });

  it("removes a dropped player after the grace period, and closes the room when the host goes", async () => {
    const r = await relay({}, { resumeGraceMs: 200 });
    const { host, guest } = await hostAndGuest(r);
    guest.ws.close();
    expect(await host.next("peer-left", 3000)).toMatchObject({ id: 1 });

    const b = await hostAndGuest(r);
    b.host.send({ t: "leave" });
    expect(await b.guest.next("error")).toMatchObject({ code: "host-left" });
    expect(r.rooms.has(b.room)).toBe(false);
  });

  it("drops connections that never say hello, and closes idle rooms", async () => {
    const r = await relay({}, { helloTimeoutMs: 200, roomIdleMs: 300 });
    const shy = new Client(r.port);
    expect(await shy.next("error")).toMatchObject({ code: "timeout" });

    const { guest, room } = await hostAndGuest(r);
    expect(await guest.next("error", 3000)).toMatchObject({ code: "room-closed" });
    expect(r.rooms.has(room)).toBe(false);
  });

  it("refuses new rooms past the room cap", async () => {
    const r = await relay({ maxRooms: 1 });
    await hostAndGuest(r);
    const extra = new Client(r.port);
    extra.send({ t: "create" });
    expect(await extra.next("error")).toMatchObject({ code: "server-busy" });
  });

  it("stops when the monthly egress budget is spent or the kill switch is off", async () => {
    const r = await relay({ monthlyEgressGb: 1e-6 }); // 1,000 bytes
    const { host, guest } = await hostAndGuest(r);
    host.send({ t: "send", d: "y".repeat(1200) });
    expect(await guest.next("error", 3000)).toMatchObject({ code: "server-busy" });
    expect(await new Client(r.port).opened).toBe(false);
    expect(await (await fetch(`http://127.0.0.1:${r.port}/healthz`)).text()).toBe("disabled\n");

    const off = await relay({ enabled: false });
    expect(await new Client(off.port).opened).toBe(false);
  });

  it("limits connections per address", async () => {
    const r = await relay({ maxConnectionsPerIp: 2 });
    const a = new Client(r.port);
    const b = new Client(r.port);
    expect(await a.opened).toBe(true);
    expect(await b.opened).toBe(true);
    expect(await new Client(r.port).opened).toBe(false);
  });
});
