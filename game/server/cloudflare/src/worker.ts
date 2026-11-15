/**
 * Cloudflare relay: the Worker in front of the room Durable Objects.
 *
 *   GET /healthz            ok | busy | disabled (readable by allowed pages, for the game's server picker)
 *   GET /ws                 WebSocket: open a new room (the Worker picks its code)
 *   GET /ws?room=CODE       WebSocket: join or resume a seat in that room
 *
 * Origins are checked here, before any Durable Object is involved. Everything else is the shared
 * relay protocol (game/server/shared/protocol.ts), handled by RelayRoom.
 */
import {
  DEFAULT_ORIGINS,
  type HealthState,
  healthHeaders,
  originMatches,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from "../../shared/protocol.ts";
import type { Env } from "./cf.ts";

export { RoomCounter } from "./counter.ts";
export { RelayRoom } from "./room.ts";

/** Tries at most this many random codes for a new room (a clash is about 1 in 900 million). */
const CREATE_TRIES = 3;

export function allowedOrigins(env: Env): string[] {
  const list = env.ALLOWED_ORIGINS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list?.length ? list : DEFAULT_ORIGINS;
}

export function isRoomCode(s: string): boolean {
  return s.length === ROOM_CODE_LENGTH && [...s].every((c) => ROOM_CODE_ALPHABET.includes(c));
}

export function newRoomCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(ROOM_CODE_LENGTH));
  let code = "";
  for (const x of b) code += ROOM_CODE_ALPHABET[x % ROOM_CODE_ALPHABET.length];
  return code;
}

const text = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/plain", ...headers } });

async function health(env: Env): Promise<HealthState> {
  if (env.RELAY_ENABLED === "0") return "disabled";
  try {
    const stub = env.COUNTER.get(env.COUNTER.idFromName("global"));
    const { rooms } = (await (await stub.fetch("https://counter/count")).json()) as { rooms: number };
    return rooms >= (Number(env.MAX_ROOMS ?? "20") || 20) ? "busy" : "ok";
  } catch {
    return "ok";
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") ?? undefined;
    const allowed = allowedOrigins(env);

    if (url.pathname === "/healthz" && req.method === "GET")
      return new Response(`${await health(env)}\n`, { headers: healthHeaders(allowed, origin) });
    if (url.pathname !== "/ws") return text("not found\n", 404);
    if (req.method !== "GET" || req.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return text("upgrade required\n", 426);
    if (env.RELAY_ENABLED === "0") return text("disabled\n", 503);
    if (origin === undefined ? env.ALLOW_NO_ORIGIN !== "1" : !originMatches(allowed, origin))
      return text("forbidden\n", 403);

    const forward = (code: string, intent: "create" | "join") => {
      const headers = new Headers(req.headers);
      headers.set("x-relay-room", code);
      headers.set("x-relay-intent", intent);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(req.url, { method: "GET", headers });
    };

    const room = url.searchParams.get("room");
    if (room !== null) {
      if (!isRoomCode(room)) return text("bad room code\n", 400);
      return forward(room, "join");
    }
    for (let i = 0; i < CREATE_TRIES; i++) {
      const res = await forward(newRoomCode(), "create");
      if (res.status !== 409) return res;
    }
    return text("busy\n", 503);
  },
};
