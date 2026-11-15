/**
 * Relay protocol and limits, shared by every relay (Node, Cloudflare) and the game client.
 *
 * The relay only understands this envelope. Game payloads (`d` in JSON messages, the bytes after
 * the first byte of binary messages) are opaque to it.
 *
 * Text frames carry JSON:
 *   client → relay   {t:"create", name?}             open a new room; the sender becomes its host
 *                    {t:"join", room, name?}         join a room by code
 *                    {t:"resume", room, token}       rejoin after a dropped connection (same peer id)
 *                    {t:"send", to?, d}              host: to = peer id or omitted (everyone)
 *                                                    guest: always delivered to the host (`to` ignored)
 *                    {t:"leave"}                     leave on purpose (no grace period)
 *   relay → client   {t:"welcome", room, you, host, token, peers, limits}
 *                    {t:"peer-joined"|"peer-away"|"peer-back"|"peer-left", id, name?}
 *                    {t:"msg", from, d}
 *                    {t:"error", code, message}      always followed by the relay closing the socket
 *
 * Binary frames: byte 0 is the peer id (client → relay: destination, 255 = everyone for the host;
 * relay → client: sender), the rest is the payload.
 */

export const PROTOCOL_VERSION = 1;

export const LIMITS = {
  /** Players per room, host included. */
  maxPeers: 12,
  /** Largest single message from a guest (bytes, whole frame payload). */
  maxGuestMessageBytes: 16 * 1024,
  /** Largest single message from the host (full-state resync). */
  maxHostMessageBytes: 64 * 1024,
  /** Sustained message rate and bytes per second per connection; buckets hold 2 s worth. */
  guestMessagesPerS: 20,
  guestBytesPerS: 16 * 1024,
  hostMessagesPerS: 60,
  hostBytesPerS: 128 * 1024,
  /** A new connection must send create/join/resume within this time (ms). */
  helloTimeoutMs: 5_000,
  /** A dropped peer can resume for this long before it is removed (ms). */
  resumeGraceMs: 60_000,
  /** A room closes when nothing has been relayed for this long (ms). */
  roomIdleMs: 10 * 60_000,
  /** A room closes this long after it was created, whatever happens (ms). */
  roomMaxAgeMs: 3 * 60 * 60_000,
  /** Longest player name shown to others (characters). */
  maxNameLength: 24,
} as const;

export type Limits = { readonly [K in keyof typeof LIMITS]: number };

/** Room codes: 6 characters with the ambiguous ones (0/O, 1/I/L) left out. */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 6;
export const BROADCAST = 255;

export type ErrorCode =
  | "bad-message"
  | "no-room"
  | "room-full"
  | "bad-token"
  | "rate-limit"
  | "too-large"
  | "timeout"
  | "room-closed"
  | "host-left"
  | "server-busy"
  | "not-in-room";

export type ClientMessage =
  | { t: "create"; name?: string }
  | { t: "join"; room: string; name?: string }
  | { t: "resume"; room: string; token: string }
  | { t: "send"; to?: number; d: unknown }
  | { t: "leave" };

export interface PeerInfo {
  id: number;
  name: string;
  away: boolean;
}

export type RelayMessage =
  | {
      t: "welcome";
      v: number;
      room: string;
      you: number;
      host: number;
      token: string;
      peers: PeerInfo[];
      limits: Limits;
    }
  | { t: "peer-joined" | "peer-back"; id: number; name: string }
  | { t: "peer-away" | "peer-left"; id: number }
  | { t: "msg"; from: number; d: unknown }
  | { t: "error"; code: ErrorCode; message: string };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
const isRoomCode = (x: unknown): x is string =>
  typeof x === "string" &&
  x.length === ROOM_CODE_LENGTH &&
  [...x].every((c) => ROOM_CODE_ALPHABET.includes(c));
const isName = (x: unknown) => x === undefined || typeof x === "string";

/** Cleans a player name: printable characters only, trimmed and length-capped. */
export function cleanName(x: unknown, fallback: string): string {
  if (typeof x !== "string") return fallback;
  const s = [...x]
    .filter((c) => {
      const n = c.codePointAt(0) ?? 0;
      // Control characters, zero-width and bidi-override characters.
      return !(
        n < 0x20 ||
        (n >= 0x7f && n <= 0x9f) ||
        (n >= 0x200b && n <= 0x200f) ||
        (n >= 0x2028 && n <= 0x202e)
      );
    })
    .join("")
    .trim();
  return s.slice(0, LIMITS.maxNameLength) || fallback;
}

/** Parses and checks a client text message; null when it isn't a valid envelope. */
export function parseClientMessage(text: string): ClientMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(m)) return null;
  switch (m.t) {
    case "create":
      return isName(m.name) ? { t: "create", name: m.name as string | undefined } : null;
    case "join":
      return isRoomCode(m.room) && isName(m.name)
        ? { t: "join", room: m.room, name: m.name as string | undefined }
        : null;
    case "resume":
      return isRoomCode(m.room) && typeof m.token === "string" && m.token.length <= 64
        ? { t: "resume", room: m.room, token: m.token }
        : null;
    case "send":
      if (!("d" in m)) return null;
      if (m.to !== undefined && !(Number.isInteger(m.to) && (m.to as number) >= 0 && (m.to as number) < 255))
        return null;
      return { t: "send", to: m.to as number | undefined, d: m.d };
    case "leave":
      return { t: "leave" };
    default:
      return null;
  }
}
