/**
 * The Cloudflare relay's logic, run in Node against a small fake of the Durable Objects runtime
 * (storage, alarms, hibernatable WebSockets). The real runtime is exercised with `wrangler dev`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CfWebSocket,
  type DurableObjectState,
  type Env,
  runtime,
} from "../game/server/cloudflare/src/cf.ts";
import { RoomCounter } from "../game/server/cloudflare/src/counter.ts";
import { RelayRoom } from "../game/server/cloudflare/src/room.ts";
import worker, { isRoomCode, newRoomCode } from "../game/server/cloudflare/src/worker.ts";
import { LIMITS } from "../game/server/shared/protocol.ts";

/** The server end of a socket: records what it sends to the client. */
class FakeWs implements CfWebSocket {
  sent: unknown[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private att: unknown = null;
  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.closed) throw new Error("closed");
    this.sent.push(typeof data === "string" ? JSON.parse(data) : data);
  }
  close(code?: number, reason?: string): void {
    this.closed ??= { code, reason };
  }
  serializeAttachment(v: unknown): void {
    this.att = structuredClone(v);
  }
  deserializeAttachment(): unknown {
    return structuredClone(this.att);
  }
  last(t: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((m) => (m as { t?: string }).t === t) as Record<string, unknown>;
  }
}

class FakeCtx implements DurableObjectState {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  sockets: FakeWs[] = [];
  storage = {
    get: async <T>(k: string) => structuredClone(this.data.get(k)) as T | undefined,
    put: async (k: string, v: unknown) => void this.data.set(k, structuredClone(v)),
    delete: async (k: string) => this.data.delete(k),
    deleteAll: async () => this.data.clear(),
    list: async <T>(o?: { prefix?: string }) =>
      new Map([...this.data].filter(([k]) => k.startsWith(o?.prefix ?? ""))) as Map<string, T>,
    setAlarm: async (t: number) => {
      this.alarm = t;
    },
    deleteAlarm: async () => {
      this.alarm = null;
    },
  };
  acceptWebSocket(ws: CfWebSocket): void {
    this.sockets.push(ws as FakeWs);
  }
  getWebSockets(): CfWebSocket[] {
    return this.sockets.filter((s) => !s.closed);
  }
  async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    this.loading = fn();
    return this.loading as Promise<T>;
  }
  loading: Promise<unknown> = Promise.resolve();
}

/** A namespace that keeps one object per name, like Durable Objects do. */
function namespace<T>(make: (ctx: FakeCtx) => T) {
  const objects = new Map<string, { obj: T; ctx: FakeCtx }>();
  return {
    objects,
    idFromName: (name: string) => name,
    get(id: unknown) {
      const name = id as string;
      let o = objects.get(name);
      if (!o) {
        const ctx = new FakeCtx();
        o = { obj: make(ctx), ctx };
        objects.set(name, o);
      }
      const { obj } = o;
      const ctxRef = o;
      return {
        // Like the runtime, nothing reaches the object until its constructor's load has finished.
        fetch: async (input: string | Request, init?: RequestInit) => {
          await ctxRef.ctx.loading;
          return (obj as { fetch(r: Request): Promise<Response> }).fetch(
            new Request(typeof input === "string" ? input : input.url, init),
          );
        },
      };
    },
  };
}

const limits = { ...LIMITS, resumeGraceMs: 40, helloTimeoutMs: 40 };
let env: Env & { rooms: ReturnType<typeof namespace<RelayRoom>> };
const realRuntime = { ...runtime };

beforeEach(() => {
  // Node can't build a 101 response or a WebSocketPair: hand the test the server end instead.
  runtime.webSocketPair = () => [new FakeWs(), new FakeWs()];
  runtime.upgradeResponse = (client) => {
    const r = new Response(null, { status: 200 });
    (r as unknown as { client: CfWebSocket }).client = client;
    return r;
  };
  const counter = namespace((ctx) => new RoomCounter(ctx, {} as Env));
  const rooms = namespace((ctx) => new RelayRoom(ctx, env, limits));
  env = { ROOMS: rooms, COUNTER: counter, MAX_ROOMS: "2", ALLOW_NO_ORIGIN: "0", rooms };
});
afterEach(() => Object.assign(runtime, realRuntime));

const ORIGIN = "https://acmi.qfan.ca";
const wsRequest = (query = "", origin = ORIGIN) =>
  new Request(`https://relay.example/ws${query}`, {
    headers: { Upgrade: "websocket", ...(origin ? { Origin: origin } : {}) },
  });

/** Opens a socket through the Worker; returns the room's server end for it and the room object. */
async function connect(query = "") {
  const res = await worker.fetch(wsRequest(query), env);
  expect(res.status).toBe(200);
  const entry = [...env.rooms.objects.values()].find((o) => o.ctx.sockets.length > 0 && o.ctx.sockets.at(-1));
  const room = [...env.rooms.objects.values()].find((o) =>
    o.ctx.sockets.some((s) => !s.sent.length && !s.closed && o.ctx.sockets.at(-1) === s),
  );
  const o = room ?? entry;
  if (!o) throw new Error("no room object");
  await o.ctx.loading;
  return { ws: o.ctx.sockets.at(-1) as FakeWs, room: o };
}

const say = (o: { obj: RelayRoom }, ws: FakeWs, m: unknown) => o.obj.webSocketMessage(ws, JSON.stringify(m));

describe("cloudflare relay", () => {
  it("routes: health, 404s, upgrades only, origin check, room code format", async () => {
    const h = await worker.fetch(new Request("https://r/healthz", { headers: { Origin: ORIGIN } }), env);
    expect(await h.text()).toBe("ok\n");
    expect(h.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect((await worker.fetch(new Request("https://r/"), env)).status).toBe(404);
    expect((await worker.fetch(new Request("https://r/ws"), env)).status).toBe(426);
    expect((await worker.fetch(wsRequest("", "https://evil.example"), env)).status).toBe(403);
    expect((await worker.fetch(wsRequest("", ""), env)).status).toBe(403);
    expect((await worker.fetch(wsRequest("?room=bad"), env)).status).toBe(400);
    expect(isRoomCode(newRoomCode())).toBe(true);
    env.RELAY_ENABLED = "0";
    expect((await worker.fetch(wsRequest(), env)).status).toBe(503);
    expect(await (await worker.fetch(new Request("https://r/healthz"), env)).text()).toBe("disabled\n");
  });

  it("creates a room, joins it, relays, and survives the object hibernating", async () => {
    const host = await connect();
    await say(host.room, host.ws, { t: "create", name: "Viper" });
    const welcome = host.ws.last("welcome") as { room: string; you: number };
    expect(isRoomCode(welcome.room)).toBe(true);

    const guest = await connect(`?room=${welcome.room}`);
    expect(guest.room).toBe(host.room); // same Durable Object
    await say(guest.room, guest.ws, { t: "join", room: welcome.room, name: "Mav" });
    expect(guest.ws.last("welcome")).toMatchObject({ you: 1, host: 0 });
    expect(host.ws.last("peer-joined")).toMatchObject({ id: 1, name: "Mav" });

    await say(guest.room, guest.ws, { t: "send", d: { cmd: "fire" } });
    expect(host.ws.last("msg")).toEqual({ t: "msg", from: 1, d: { cmd: "fire" } });

    // Hibernation: the object is dropped from memory and rebuilt from storage and the open sockets.
    const woken = new RelayRoom(host.room.ctx, env, limits);
    await host.room.ctx.loading;
    await woken.webSocketMessage(host.ws, JSON.stringify({ t: "send", d: { snap: 1 } }));
    expect(guest.ws.last("msg")).toEqual({ t: "msg", from: 0, d: { snap: 1 } });
    await woken.webSocketMessage(guest.ws, JSON.stringify({ t: "send", d: "after wake" }));
    expect(host.ws.last("msg")).toMatchObject({ from: 1, d: "after wake" });
  });

  it("keeps a dropped seat for the grace period, then frees it; the room ends with its host", async () => {
    const host = await connect();
    await say(host.room, host.ws, { t: "create", name: "Viper" });
    const code = (host.ws.last("welcome") as { room: string }).room;
    const guest = await connect(`?room=${code}`);
    await say(guest.room, guest.ws, { t: "join", room: code, name: "Mav" });
    const token = (guest.ws.last("welcome") as { token: string }).token;

    guest.ws.close(1006);
    await guest.room.obj.webSocketClose(guest.ws, 1006, "", false);
    expect(host.ws.last("peer-away")).toMatchObject({ id: 1 });
    expect(host.room.ctx.alarm).not.toBeNull();

    // Resume within the grace period: same seat.
    const back = await connect(`?room=${code}`);
    await say(back.room, back.ws, { t: "resume", room: code, token });
    expect(back.ws.last("welcome")).toMatchObject({ you: 1 });
    expect(host.ws.last("peer-back")).toMatchObject({ id: 1 });

    // Drop again and let the grace run out.
    back.ws.close(1006);
    await back.room.obj.webSocketClose(back.ws, 1006, "", false);
    await new Promise((r) => setTimeout(r, 60));
    await host.room.obj.alarm();
    expect(host.ws.last("peer-left")).toMatchObject({ id: 1 });

    // The host leaves: room over, storage cleared, counter released.
    await say(host.room, host.ws, { t: "leave" });
    expect(host.room.ctx.data.size).toBe(0);
    const h = await worker.fetch(new Request("https://r/healthz"), env);
    expect(await h.text()).toBe("ok\n");
  });

  it("refuses unknown rooms, bad hellos, slow hellos, and new rooms past the cap", async () => {
    const lost = await connect("?room=ABCDEF");
    await say(lost.room, lost.ws, { t: "join", room: "ABCDEF", name: "Ice" });
    expect(lost.ws.last("error")).toMatchObject({ code: "no-room" });
    expect(lost.ws.closed).not.toBeNull();

    const junk = await connect();
    await junk.room.obj.webSocketMessage(junk.ws, "not json");
    expect(junk.ws.last("error")).toMatchObject({ code: "bad-message" });

    const shy = await connect();
    await new Promise((r) => setTimeout(r, 60));
    await shy.room.obj.alarm();
    expect(shy.ws.last("error")).toMatchObject({ code: "timeout" });

    // MAX_ROOMS is 2 here.
    for (let i = 0; i < 2; i++) {
      const h = await connect();
      await say(h.room, h.ws, { t: "create", name: `H${i}` });
      expect(h.ws.last("welcome")).toBeDefined();
    }
    expect(await (await worker.fetch(new Request("https://r/healthz"), env)).text()).toBe("busy\n");
    const third = await connect();
    await say(third.room, third.ws, { t: "create", name: "H3" });
    expect(third.ws.last("error")).toMatchObject({ code: "server-busy" });
  });
});
