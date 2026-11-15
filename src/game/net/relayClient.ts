/**
 * Client side of the relay protocol (game/server/shared/protocol.ts): opens a room or joins one,
 * sends and receives game messages, and resumes the same seat after a dropped connection. Runs in
 * the engine worker (or Node, in tests): it only needs the standard WebSocket.
 */
import type { PeerInfo, RelayMessage } from "../../../game/server/shared/protocol.ts";

export interface RelayHandlers {
  onWelcome(info: { room: string; you: number; host: number; peers: PeerInfo[]; resumed: boolean }): void;
  onPeer(kind: "joined" | "away" | "back" | "left", id: number, name?: string): void;
  onMessage(from: number, d: unknown): void;
  onStatus(status: "connecting" | "connected" | "reconnecting"): void;
  /** The room is gone for good (closed, host left, refused); no more callbacks after this. */
  onClosed(code: string, message: string): void;
}

/** How long to keep trying to resume (ms): a little under the relay's grace period. */
const RESUME_FOR_MS = 55_000;
const RETRY_MS = 2_000;

export class RelayClient {
  private ws: WebSocket | null = null;
  private room = "";
  private token = "";
  private done = false;
  private resumeUntil = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly url: string;
  private readonly h: RelayHandlers;

  constructor(url: string, handlers: RelayHandlers) {
    this.url = url;
    this.h = handlers;
  }

  create(name: string): void {
    this.open({ t: "create", name });
  }

  join(room: string, name: string): void {
    this.open({ t: "join", room: room.trim().toUpperCase(), name });
  }

  /** Sends a game message: the host to one peer or everyone; a guest always to the host. */
  send(d: unknown, to?: number): void {
    this.sendRaw(JSON.stringify(to === undefined ? { t: "send", d } : { t: "send", to, d }));
  }

  /** Sends an already-serialised payload (avoids stringifying big snapshots twice). */
  sendJson(json: string, to?: number): void {
    this.sendRaw(`{"t":"send",${to === undefined ? "" : `"to":${to},`}"d":${json}}`);
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && !!this.token;
  }

  leave(): void {
    if (this.done) return;
    this.done = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: "leave" }));
    this.ws?.close();
    this.ws = null;
  }

  private sendRaw(text: string): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.token) this.ws.send(text);
  }

  private open(hello: unknown): void {
    this.h.onStatus(this.token ? "reconnecting" : "connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.fail("bad-url", "That relay address is not valid.");
      return;
    }
    this.ws = ws;
    let fatal = false;
    ws.onopen = () => ws.send(JSON.stringify(hello));
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      let m: RelayMessage;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      switch (m.t) {
        case "welcome": {
          const resumed = !!this.token;
          this.room = m.room;
          this.token = m.token;
          this.resumeUntil = 0;
          this.h.onStatus("connected");
          this.h.onWelcome({ room: m.room, you: m.you, host: m.host, peers: m.peers, resumed });
          break;
        }
        case "peer-joined":
          this.h.onPeer("joined", m.id, m.name);
          break;
        case "peer-back":
          this.h.onPeer("back", m.id, m.name);
          break;
        case "peer-away":
          this.h.onPeer("away", m.id);
          break;
        case "peer-left":
          this.h.onPeer("left", m.id);
          break;
        case "msg":
          this.h.onMessage(m.from, m.d);
          break;
        case "error":
          fatal = true;
          this.fail(m.code, m.message);
          break;
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.done || fatal) return;
      if (!this.token) {
        this.fail("unreachable", "Could not reach the relay.");
        return;
      }
      // Dropped mid-room: try to resume the same seat for a while.
      if (this.resumeUntil === 0) this.resumeUntil = Date.now() + RESUME_FOR_MS;
      if (Date.now() > this.resumeUntil) {
        this.fail("timeout", "Lost the connection to the relay.");
        return;
      }
      this.h.onStatus("reconnecting");
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (!this.done) this.open({ t: "resume", room: this.room, token: this.token });
      }, RETRY_MS);
    };
    ws.onerror = () => {
      // onclose follows and decides what to do.
    };
  }

  private fail(code: string, message: string): void {
    if (this.done) return;
    this.done = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
    this.h.onClosed(code, message);
  }
}
