/**
 * RelayRoom: one Durable Object per room code, holding the room's WebSockets with the Hibernation
 * API. Between messages (a lobby waiting for players, say) Cloudflare may evict the object from
 * memory while keeping the sockets open; it is billed only while it works. So the room is saved to
 * the object's storage on every change of who is in it, and rebuilt from storage plus the open
 * sockets when the object wakes up. Timeouts run on the object's alarm.
 *
 * The room rules themselves are the shared `Room` class, the same as the Node relay's.
 */
import {
  type ErrorCode,
  LIMITS,
  type Limits,
  parseClientMessage,
  type RelayMessage,
} from "../../shared/protocol.ts";
import { type Peer, type PeerSocket, Room, type RoomState } from "../../shared/room.ts";
import { type CfWebSocket, type DurableObjectState, type Env, randomToken, runtime } from "./cf.ts";

/** What each socket remembers across hibernation. */
type Attachment = { pending: true; since: number; intent: "create" | "join" } | { peerId: number };

const ROOM_KEY = "room";
const CODE_KEY = "code";
/** Save the "last relayed" time at most this often while messages flow (ms). */
const SAVE_ACTIVITY_MS = 30_000;
const CLOSE_POLICY = 1008;

export class RelayRoom {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  private readonly limits: Limits;
  private room: Room | null = null;
  private code = "";
  private savedActivity = 0;
  /** One PeerSocket wrapper per WebSocket, so the room can tell connections apart. */
  private readonly socks = new Map<CfWebSocket, PeerSocket>();

  constructor(ctx: DurableObjectState, env: Env, limits: Limits = LIMITS) {
    this.ctx = ctx;
    this.env = env;
    this.limits = limits;
    void ctx.blockConcurrencyWhile(() => this.load());
  }

  /** Rebuilds the room after a wake-up: saved state plus the sockets that are still open. */
  private async load(): Promise<void> {
    this.code = (await this.ctx.storage.get<string>(CODE_KEY)) ?? "";
    const saved = await this.ctx.storage.get<RoomState>(ROOM_KEY);
    if (!saved) return;
    const byPeer = new Map<number, CfWebSocket>();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a && "peerId" in a) byPeer.set(a.peerId, ws);
    }
    this.room = Room.restore(
      saved,
      Date.now(),
      randomToken,
      (id) => {
        const ws = byPeer.get(id);
        return ws ? this.wrap(ws) : null;
      },
      this.limits,
    );
    this.savedActivity = saved.lastRelayAt;
  }

  private wrap(ws: CfWebSocket): PeerSocket {
    let s = this.socks.get(ws);
    if (!s) {
      s = {
        sendText: (t) => {
          try {
            ws.send(t);
          } catch {
            // Already closed: the close handler deals with it.
          }
        },
        sendBinary: (b) => {
          try {
            ws.send(b);
          } catch {
            // Already closed.
          }
        },
        close: (code, reason) => {
          try {
            ws.close(code, reason.slice(0, 120));
          } catch {
            // Already closed.
          }
        },
      };
      this.socks.set(ws, s);
    }
    return s;
  }

  /** The Worker forwards a WebSocket upgrade here, with the room code and what the client wants. */
  async fetch(req: Request): Promise<Response> {
    const intent = req.headers.get("x-relay-intent") === "create" ? "create" : "join";
    const code = req.headers.get("x-relay-room") ?? "";
    if (intent === "create") {
      // Someone already has this code (open room, or a socket about to create one): pick another.
      if ((this.room && !this.room.closed) || this.ctx.getWebSockets().length > 0)
        return new Response("taken", { status: 409 });
      this.code = code;
      await this.ctx.storage.put(CODE_KEY, code);
    }
    const [client, server] = runtime.webSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pending: true, since: Date.now(), intent } satisfies Attachment);
    await this.schedule();
    return runtime.upgradeResponse(client);
  }

  async webSocketMessage(ws: CfWebSocket, message: string | ArrayBuffer): Promise<void> {
    const now = Date.now();
    const a = ws.deserializeAttachment() as Attachment;
    const sock = this.wrap(ws);
    if ("pending" in a) {
      await this.hello(ws, sock, a, message, now);
      return;
    }
    const room = this.room;
    const peer = room?.peers.get(a.peerId);
    if (!room || !peer || peer.sock !== sock) {
      sock.close(CLOSE_POLICY, "not-in-room");
      return;
    }
    const before = membership(room);
    if (typeof message === "string") {
      const size = new TextEncoder().encode(message).byteLength;
      const msg = parseClientMessage(message);
      if (!msg) {
        this.fail(sock, "bad-message", "unrecognised message");
        room.onDisconnect(peer, sock, now);
      } else room.onText(peer, msg, size, now);
    } else room.onBinary(peer, new Uint8Array(message), now);
    if (room.closed) await this.finish();
    else if (membership(room) !== before || room.lastActivity - this.savedActivity > SAVE_ACTIVITY_MS)
      await this.save();
  }

  /** The first message on a socket: create the room, join it, or resume a seat. */
  private async hello(
    ws: CfWebSocket,
    sock: PeerSocket,
    a: Extract<Attachment, { pending: true }>,
    message: string | ArrayBuffer,
    now: number,
  ): Promise<void> {
    const msg = typeof message === "string" && message.length <= 1024 ? parseClientMessage(message) : null;
    if (!msg || msg.t === "send" || msg.t === "leave")
      return this.fail(sock, "bad-message", "expected create, join or resume");
    let peer: Peer | null = null;
    if (msg.t === "create") {
      if (a.intent !== "create" || this.room)
        return this.fail(sock, "bad-message", "create needs a new room");
      if (!(await this.register(now))) return this.fail(sock, "server-busy", "the relay is full; try later");
      this.room = new Room(this.code, now, randomToken, this.limits);
      peer = this.room.join(sock, msg.name, now);
    } else {
      const room = this.room;
      if (!room || room.closed || msg.room !== this.code)
        return this.fail(sock, "no-room", "no room with that code");
      peer = msg.t === "join" ? room.join(sock, msg.name, now) : room.resume(sock, msg.token, now);
      if (!peer)
        return msg.t === "join"
          ? this.fail(sock, "room-full", "the room is full")
          : this.fail(sock, "bad-token", "can't resume that seat");
    }
    if (!peer) return this.fail(sock, "room-full", "the room is full");
    ws.serializeAttachment({ peerId: peer.id } satisfies Attachment);
    await this.save();
  }

  async webSocketClose(ws: CfWebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    await this.dropped(ws);
    try {
      ws.close(1000, "closed");
    } catch {
      // Already closed.
    }
  }

  async webSocketError(ws: CfWebSocket, _error: unknown): Promise<void> {
    await this.dropped(ws);
  }

  private async dropped(ws: CfWebSocket): Promise<void> {
    const sock = this.socks.get(ws) ?? this.wrap(ws);
    this.socks.delete(ws);
    const a = ws.deserializeAttachment() as Attachment | null;
    const room = this.room;
    if (!a || !("peerId" in a) || !room) return;
    const peer = room.peers.get(a.peerId);
    if (peer) room.onDisconnect(peer, sock, Date.now());
    await this.save();
  }

  /** Timeouts: unanswered hellos, resume graces, idle and old rooms. */
  async alarm(): Promise<void> {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a && "pending" in a && now - a.since >= this.limits.helloTimeoutMs)
        this.fail(this.wrap(ws), "timeout", "no create, join or resume in time");
    }
    const room = this.room;
    if (room) {
      room.tick(now);
      if (room.closed) {
        await this.finish();
        return;
      }
      await this.save();
    } else await this.schedule();
  }

  /** Sets the alarm for the next timeout, if any. */
  private async schedule(): Promise<void> {
    let next = this.room && !this.room.closed ? this.room.nextDeadline() : Number.POSITIVE_INFINITY;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a && "pending" in a) next = Math.min(next, a.since + this.limits.helloTimeoutMs);
    }
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 50));
    else await this.ctx.storage.deleteAlarm();
  }

  private async save(): Promise<void> {
    const room = this.room;
    if (!room) return;
    this.savedActivity = room.lastActivity;
    await this.ctx.storage.put(ROOM_KEY, room.save());
    await this.schedule();
  }

  /** The room is over: tell the counter, forget everything. */
  private async finish(): Promise<void> {
    const code = this.code;
    this.room = null;
    this.code = "";
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    await this.counter(`/close?code=${encodeURIComponent(code)}`);
  }

  /** Registers this room with the relay-wide counter; false when the relay is full. */
  private async register(now: number): Promise<boolean> {
    const max = Number(this.env.MAX_ROOMS ?? "20") || 20;
    const until = now + this.limits.roomMaxAgeMs;
    const res = await this.counter(`/open?code=${encodeURIComponent(this.code)}&max=${max}&until=${until}`);
    return !!res && ((await res.json()) as { ok: boolean }).ok;
  }

  private async counter(path: string): Promise<Response | null> {
    try {
      const stub = this.env.COUNTER.get(this.env.COUNTER.idFromName("global"));
      return await stub.fetch(`https://counter${path}`);
    } catch {
      return null;
    }
  }

  private fail(sock: PeerSocket, code: ErrorCode, message: string): void {
    sock.sendText(JSON.stringify({ t: "error", code, message } satisfies RelayMessage));
    sock.close(CLOSE_POLICY, code);
  }
}

/** Who is in the room and connected: saved whenever this changes. */
function membership(room: Room): string {
  return (
    [...room.peers.values()].map((p) => `${p.id}${p.sock ? "+" : "-"}`).join(",") + (room.closed ? "x" : "")
  );
}
