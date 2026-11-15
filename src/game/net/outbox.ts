/**
 * Rate limits on what one side of a match sends, so normal play (holding a key, clicking fast)
 * never trips the relay's flood limits and gets someone disconnected.
 *
 * `Outbox`: a guest's messages to the host. Orders that set a state (heading, throttle, altitude…)
 * replace an older queued one for the same jet; one-shot orders (fire, chaff, flare) queue a few at
 * most. Everything is sent in order, at a sustained rate well under the relay's per-guest limit.
 *
 * `ReplyLimiter`: the host's replies to one guest (error messages, pongs, resyncs). A misbehaving
 * client could otherwise make the host flood the relay and get the whole room closed.
 */
import type { GuestMsg } from "../engine/protocol.ts";

/** Sustained guest messages per second, and burst (the relay allows 20/s with a 40 burst). */
export const OUTBOX_RATE_PER_S = 10;
export const OUTBOX_BURST = 20;
/** Most queued one-shot orders of one kind for one jet. */
const MAX_QUEUED_SHOTS = 3;

const STATE_CMDS = new Set(["steer", "throttle", "effort", "altitude", "target"]);

const keyOf = (m: GuestMsg): string | null =>
  m.k === "cmd" && STATE_CMDS.has(m.cmd.type) ? `${m.cmd.jetId}|${m.cmd.type}` : null;

export class Outbox {
  private readonly send: (m: GuestMsg) => void;
  private readonly rate: number;
  private readonly burst: number;
  private tokens: number;
  private last: number;
  private queue: GuestMsg[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;

  constructor(
    send: (m: GuestMsg) => void,
    rate = OUTBOX_RATE_PER_S,
    burst = OUTBOX_BURST,
    now: () => number = () => performance.now(),
  ) {
    this.send = send;
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.now = now;
    this.last = now();
  }

  push(m: GuestMsg): void {
    const key = keyOf(m);
    if (key) {
      const i = this.queue.findIndex((q) => keyOf(q) === key);
      if (i >= 0) {
        this.queue[i] = m; // only the latest heading/throttle/… matters
        this.flush();
        return;
      }
    } else if (m.k === "cmd") {
      const same = this.queue.filter(
        (q) => q.k === "cmd" && q.cmd.type === m.cmd.type && q.cmd.jetId === m.cmd.jetId,
      ).length;
      if (same >= MAX_QUEUED_SHOTS) return;
    } else if (m.k === "ping" && this.queue.some((q) => q.k === "ping")) return;
    this.queue.push(m);
    this.flush();
  }

  /** Messages waiting to go out (tests). */
  get pending(): number {
    return this.queue.length;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
  }

  private flush(): void {
    const now = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      this.send(this.queue.shift() as GuestMsg);
    }
    if (this.queue.length > 0 && !this.timer) {
      const waitMs = Math.ceil(((1 - this.tokens) / this.rate) * 1000);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, waitMs);
    }
  }
}

/** Least time (ms) between two host replies of one kind to one guest. */
export const REPLY_MIN_MS = { flash: 1000, pong: 900, sync: 5000 } as const;

export class ReplyLimiter {
  private readonly last = new Map<string, number>();

  /** True when the host may send this kind of reply to this peer now (and records it). */
  allow(peer: number, kind: keyof typeof REPLY_MIN_MS, now = performance.now()): boolean {
    const key = `${peer}|${kind}`;
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < REPLY_MIN_MS[kind]) return false;
    this.last.set(key, now);
    return true;
  }

  forget(peer: number): void {
    for (const k of [...this.last.keys()]) if (k.startsWith(`${peer}|`)) this.last.delete(k);
  }
}
