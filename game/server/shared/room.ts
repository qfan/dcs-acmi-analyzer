/**
 * One relay room, independent of the transport: the Node relay and the Cloudflare Durable Object
 * both drive this class. It never touches the network itself; it calls the `PeerSocket` it is given.
 * Time is passed in (ms) so tests can run it without waiting.
 */
import {
  BROADCAST,
  type ClientMessage,
  cleanName,
  type ErrorCode,
  LIMITS,
  type Limits,
  type PeerInfo,
  PROTOCOL_VERSION,
  type RelayMessage,
} from "./protocol.ts";

/** What a room needs from a connection. */
export interface PeerSocket {
  sendText(text: string): void;
  sendBinary(data: Uint8Array): void;
  /** Closes the connection; must be safe to call more than once. */
  close(code: number, reason: string): void;
}

/** Token bucket: `rate` per second, holding up to `burstS` seconds' worth. */
export class Bucket {
  private readonly rate: number;
  private readonly burstS: number;
  private level: number;
  private last: number;
  constructor(rate: number, now: number, burstS = 2) {
    this.rate = rate;
    this.burstS = burstS;
    this.level = rate * burstS;
    this.last = now;
  }
  take(amount: number, now: number): boolean {
    this.level = Math.min(this.rate * this.burstS, this.level + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.level < amount) return false;
    this.level -= amount;
    return true;
  }
}

export interface Peer {
  readonly id: number;
  readonly name: string;
  readonly token: string;
  sock: PeerSocket | null;
  /** While disconnected: when the resume grace runs out (ms). */
  awayUntil: number;
  msgs: Bucket;
  bytes: Bucket;
}

/** Random source for tokens, supplied by the transport (Node `crypto`, Web Crypto). */
export type TokenSource = () => string;

/** A room as saved between wake-ups (see `Room.save`). */
export interface RoomState {
  code: string;
  createdAt: number;
  lastRelayAt: number;
  hostId: number;
  nextId: number;
  peers: { id: number; name: string; token: string; awayUntil: number; connected: boolean }[];
}

const CLOSE_NORMAL = 1000;
const CLOSE_POLICY = 1008;

export class Room {
  readonly peers = new Map<number, Peer>();
  readonly createdAt: number;
  hostId = -1;
  closed = false;
  /** Why the room closed, once it has. */
  closeCode: ErrorCode | null = null;
  private lastRelayAt: number;
  private nextId = 0;
  readonly code: string;
  private readonly newToken: TokenSource;
  private readonly limits: Limits;

  constructor(code: string, now: number, newToken: TokenSource, limits: Limits = LIMITS) {
    this.code = code;
    this.newToken = newToken;
    this.limits = limits;
    this.createdAt = now;
    this.lastRelayAt = now;
  }

  /** When something was last relayed between two or more peers (ms). */
  get lastActivity(): number {
    return this.lastRelayAt;
  }

  /** Everything needed to rebuild the room later (a Durable Object that slept). Sockets aren't saved. */
  save(): RoomState {
    return {
      code: this.code,
      createdAt: this.createdAt,
      lastRelayAt: this.lastRelayAt,
      hostId: this.hostId,
      nextId: this.nextId,
      peers: [...this.peers.values()].map((p) => ({
        id: p.id,
        name: p.name,
        token: p.token,
        awayUntil: p.awayUntil,
        connected: !!p.sock,
      })),
    };
  }

  /**
   * Rebuilds a saved room. `socketFor` returns the live connection of a peer that was connected;
   * one that has none any more counts as dropped from `now` (its resume grace starts again).
   */
  static restore(
    s: RoomState,
    now: number,
    newToken: TokenSource,
    socketFor: (peerId: number) => PeerSocket | null,
    limits: Limits = LIMITS,
  ): Room {
    const room = new Room(s.code, s.createdAt, newToken, limits);
    room.lastRelayAt = s.lastRelayAt;
    room.hostId = s.hostId;
    room.nextId = s.nextId;
    for (const p of s.peers) {
      const sock = p.connected ? socketFor(p.id) : null;
      room.peers.set(p.id, {
        id: p.id,
        name: p.name,
        token: p.token,
        sock,
        awayUntil: sock ? 0 : p.connected ? now + limits.resumeGraceMs : p.awayUntil,
        ...room.buckets(p.id === s.hostId, now),
      });
    }
    return room;
  }

  /** The next time `tick` has something to do (ms): a resume grace ending, idling out, or old age. */
  nextDeadline(): number {
    let t = Math.min(this.createdAt + this.limits.roomMaxAgeMs, this.lastRelayAt + this.limits.roomIdleMs);
    for (const p of this.peers.values()) if (!p.sock) t = Math.min(t, p.awayUntil);
    return t;
  }

  /** Peers with a live connection. */
  get presentCount(): number {
    let n = 0;
    for (const p of this.peers.values()) if (p.sock) n++;
    return n;
  }

  /** Adds a connection as a new peer (the first one becomes host). Null when the room is full. */
  join(sock: PeerSocket, name: unknown, now: number): Peer | null {
    if (this.closed || this.peers.size >= this.limits.maxPeers || this.nextId >= BROADCAST) return null;
    const id = this.nextId++;
    const isHost = this.hostId < 0;
    if (isHost) this.hostId = id;
    const peer: Peer = {
      id,
      name: cleanName(name, isHost ? "Host" : `Player ${id + 1}`),
      token: this.newToken(),
      sock,
      awayUntil: 0,
      ...this.buckets(isHost, now),
    };
    this.peers.set(id, peer);
    this.welcome(peer);
    this.broadcast({ t: "peer-joined", id, name: peer.name }, id);
    return peer;
  }

  /** Reattaches a dropped peer that presents its token. Null when the token doesn't match. */
  resume(sock: PeerSocket, token: string, now: number): Peer | null {
    if (this.closed) return null;
    for (const peer of this.peers.values()) {
      if (peer.token !== token) continue;
      // A resume while the old socket still looks open (half-dead connection) replaces it.
      peer.sock?.close(CLOSE_NORMAL, "replaced by a newer connection");
      peer.sock = sock;
      peer.awayUntil = 0;
      Object.assign(peer, this.buckets(peer.id === this.hostId, now));
      this.welcome(peer);
      this.broadcast({ t: "peer-back", id: peer.id, name: peer.name }, peer.id);
      return peer;
    }
    return null;
  }

  /** Handles a JSON message from a peer already in the room. `size` is the frame payload length. */
  onText(peer: Peer, msg: ClientMessage, size: number, now: number): void {
    if (!this.admit(peer, size, now)) return;
    if (msg.t === "leave") {
      this.remove(peer, "left");
      return;
    }
    if (msg.t !== "send") {
      this.kick(peer, "bad-message", "already in a room");
      return;
    }
    const out = JSON.stringify({ t: "msg", from: peer.id, d: msg.d } satisfies RelayMessage);
    if (peer.id === this.hostId) {
      if (msg.to === undefined) this.broadcastRaw(out, peer.id);
      else this.peers.get(msg.to)?.sock?.sendText(out);
    } else {
      this.peers.get(this.hostId)?.sock?.sendText(out);
    }
    if (this.presentCount > 1) this.lastRelayAt = now;
  }

  /** Handles a binary message: byte 0 is the destination (host only; 255 = everyone). */
  onBinary(peer: Peer, data: Uint8Array, now: number): void {
    if (!this.admit(peer, data.length, now)) return;
    if (data.length < 1) {
      this.kick(peer, "bad-message", "empty binary message");
      return;
    }
    const out = new Uint8Array(data.length);
    out.set(data);
    const to = data[0] as number;
    out[0] = peer.id;
    if (peer.id === this.hostId) {
      if (to === BROADCAST) {
        for (const p of this.peers.values()) if (p.id !== peer.id) p.sock?.sendBinary(out);
      } else this.peers.get(to)?.sock?.sendBinary(out);
    } else {
      this.peers.get(this.hostId)?.sock?.sendBinary(out);
    }
    if (this.presentCount > 1) this.lastRelayAt = now;
  }

  /** The peer's connection dropped: keep its slot for the resume grace period. */
  onDisconnect(peer: Peer, sock: PeerSocket, now: number): void {
    if (this.closed || peer.sock !== sock) return; // already replaced by a resume
    peer.sock = null;
    peer.awayUntil = now + this.limits.resumeGraceMs;
    this.broadcast({ t: "peer-away", id: peer.id }, peer.id);
  }

  /** Expires dropped peers and closes the room when idle, too old or abandoned. Call about once a second. */
  tick(now: number): void {
    if (this.closed) return;
    for (const peer of [...this.peers.values()]) {
      if (!peer.sock && now >= peer.awayUntil) this.remove(peer, "timed out");
      if (this.closed) return;
    }
    if (now - this.createdAt >= this.limits.roomMaxAgeMs)
      this.close("room-closed", "the room reached its 3-hour limit");
    else if (now - this.lastRelayAt >= this.limits.roomIdleMs)
      this.close("room-closed", "the room was idle for 10 minutes");
    else if (this.presentCount === 0 && this.peers.size === 0) this.close("room-closed", "everyone left");
  }

  /** Closes the room and every connection in it. */
  close(code: ErrorCode, message: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    const text = JSON.stringify({ t: "error", code, message } satisfies RelayMessage);
    for (const p of this.peers.values()) {
      p.sock?.sendText(text);
      p.sock?.close(CLOSE_NORMAL, code);
      p.sock = null;
    }
    this.peers.clear();
  }

  private buckets(isHost: boolean, now: number): Pick<Peer, "msgs" | "bytes"> {
    const l = this.limits;
    return isHost
      ? { msgs: new Bucket(l.hostMessagesPerS, now), bytes: new Bucket(l.hostBytesPerS, now) }
      : { msgs: new Bucket(l.guestMessagesPerS, now), bytes: new Bucket(l.guestBytesPerS, now) };
  }

  /** Size and rate checks for one incoming message; kicks the peer when it breaks them. */
  private admit(peer: Peer, size: number, now: number): boolean {
    const max = peer.id === this.hostId ? this.limits.maxHostMessageBytes : this.limits.maxGuestMessageBytes;
    if (size > max) {
      this.kick(peer, "too-large", `messages are limited to ${max} bytes`);
      return false;
    }
    if (!peer.msgs.take(1, now) || !peer.bytes.take(size, now)) {
      this.kick(peer, "rate-limit", "too many messages");
      return false;
    }
    return true;
  }

  private welcome(peer: Peer): void {
    const peers: PeerInfo[] = [...this.peers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      away: !p.sock,
    }));
    this.send(peer, {
      t: "welcome",
      v: PROTOCOL_VERSION,
      room: this.code,
      you: peer.id,
      host: this.hostId,
      token: peer.token,
      peers,
      limits: this.limits,
    });
  }

  /** Removes a peer for good. Losing the host closes the room. */
  private remove(peer: Peer, why: string): void {
    this.peers.delete(peer.id);
    peer.sock?.close(CLOSE_NORMAL, why);
    peer.sock = null;
    if (peer.id === this.hostId) this.close("host-left", "the host left");
    else this.broadcast({ t: "peer-left", id: peer.id }, -1);
  }

  private kick(peer: Peer, code: ErrorCode, message: string): void {
    this.send(peer, { t: "error", code, message });
    const sock = peer.sock;
    peer.sock?.close(CLOSE_POLICY, code);
    peer.sock = null;
    // A peer kicked for breaking the rules does not get a resume grace.
    if (sock) this.remove(peer, code);
  }

  private send(peer: Peer, msg: RelayMessage): void {
    peer.sock?.sendText(JSON.stringify(msg));
  }

  private broadcast(msg: RelayMessage, except: number): void {
    this.broadcastRaw(JSON.stringify(msg), except);
  }

  private broadcastRaw(text: string, except: number): void {
    for (const p of this.peers.values()) if (p.id !== except) p.sock?.sendText(text);
  }
}
