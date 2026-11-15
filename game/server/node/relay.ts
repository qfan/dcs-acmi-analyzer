/**
 * Standalone multiplayer relay (Node.js 24+, no dependencies). Run:
 *
 *   node game/server/node/relay.ts
 *
 * Configuration comes from environment variables; see README.md. The relay forwards messages
 * between browsers in rooms. It never opens outbound connections and never tells players each
 * other's addresses.
 */
import { randomBytes, randomInt } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  type ErrorCode,
  LIMITS,
  type Limits,
  parseClientMessage,
  type RelayMessage,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from "../shared/protocol.ts";
import { type Peer, type PeerSocket, Room } from "../shared/room.ts";
import { EgressBudget } from "./budget.ts";
import { checkUpgrade, rejectUpgrade, WsConnection } from "./websocket.ts";

export interface RelayConfig {
  host: string;
  port: number;
  /** Exact Origin values allowed to connect; "*" allows any. */
  allowedOrigins: string[];
  /** Accept connections that send no Origin header (non-browser clients). */
  allowNoOrigin: boolean;
  maxRooms: number;
  maxConnections: number;
  maxConnectionsPerIp: number;
  /** Take the client address from the last X-Forwarded-For entry (only behind your own proxy). */
  trustProxy: boolean;
  monthlyEgressGb: number;
  /** Where the egress counter is saved; null keeps it in memory. */
  stateDir: string | null;
  /** Kill switch: false refuses every connection. */
  enabled: boolean;
  limits: Limits;
  log: (line: string) => void;
}

export const DEFAULT_ORIGINS = [
  "https://acmi.qfan.ca",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
];

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const num = (k: string, d: number) => {
    const v = Number(env[k]);
    return env[k] !== undefined && env[k] !== "" && Number.isFinite(v) ? v : d;
  };
  const flag = (k: string, d: boolean) => (env[k] === undefined || env[k] === "" ? d : env[k] === "1");
  return {
    host: env.RELAY_HOST || "127.0.0.1",
    port: num("RELAY_PORT", 8787),
    allowedOrigins: env.RELAY_ALLOWED_ORIGINS
      ? env.RELAY_ALLOWED_ORIGINS.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : DEFAULT_ORIGINS,
    allowNoOrigin: flag("RELAY_ALLOW_NO_ORIGIN", false),
    maxRooms: num("RELAY_MAX_ROOMS", 20),
    maxConnections: num("RELAY_MAX_CONNECTIONS", 200),
    maxConnectionsPerIp: num("RELAY_MAX_PER_IP", 8),
    trustProxy: flag("RELAY_TRUST_PROXY", false),
    monthlyEgressGb: num("RELAY_MONTHLY_EGRESS_GB", 200),
    stateDir: env.RELAY_STATE_DIR || env.STATE_DIRECTORY || "relay-state",
    enabled: flag("RELAY_ENABLED", true),
    limits: LIMITS,
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
  };
}

/** Repeated failed joins (wrong codes) from one address lock it out for a while. */
const FAILED_JOIN_LIMIT = 20;
const FAILED_JOIN_WINDOW_MS = 10 * 60_000;

export interface RunningRelay {
  server: Server;
  port: number;
  rooms: Map<string, Room>;
  budget: EgressBudget;
  close(): Promise<void>;
}

/** Starts the relay and resolves once it listens. */
export function startRelay(cfg: RelayConfig): Promise<RunningRelay> {
  const rooms = new Map<string, Room>();
  const perIp = new Map<string, number>();
  const failedJoins = new Map<string, { n: number; since: number }>();
  const budget = new EgressBudget(cfg.stateDir, cfg.monthlyEgressGb);
  let connections = 0;
  /** Every open WebSocket, so shutdown can close the ones not in a room yet. */
  const live = new Set<WsConnection>();
  const newToken = () => randomBytes(18).toString("base64url");

  const newCode = (): string => {
    for (;;) {
      let code = "";
      for (let i = 0; i < ROOM_CODE_LENGTH; i++)
        code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
  };

  const clientIp = (req: IncomingMessage): string => {
    if (cfg.trustProxy) {
      const fwd = req.headers["x-forwarded-for"];
      const last = (Array.isArray(fwd) ? fwd.join(",") : (fwd ?? "")).split(",").pop()?.trim();
      if (last) return last;
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  const originAllowed = (origin: string | undefined): boolean => {
    if (origin === undefined) return cfg.allowNoOrigin;
    return cfg.allowedOrigins.includes("*") || cfg.allowedOrigins.includes(origin);
  };

  const lockedOut = (ip: string, now: number): boolean => {
    const f = failedJoins.get(ip);
    if (!f) return false;
    if (now - f.since > FAILED_JOIN_WINDOW_MS) {
      failedJoins.delete(ip);
      return false;
    }
    return f.n >= FAILED_JOIN_LIMIT;
  };

  const noteFailedJoin = (ip: string, now: number) => {
    const f = failedJoins.get(ip);
    if (!f || now - f.since > FAILED_JOIN_WINDOW_MS) failedJoins.set(ip, { n: 1, since: now });
    else f.n++;
  };

  const closeRoom = (room: Room, code: ErrorCode, message: string) => {
    room.close(code, message);
    if (rooms.get(room.code) === room) rooms.delete(room.code);
    cfg.log(`room ${room.code} closed (${room.closeCode ?? code}); ${rooms.size} open`);
  };

  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end(cfg.enabled && !budget.exceeded ? "ok\n" : "disabled\n");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
  });
  // Plain HTTP requests are tiny here; keep slow or idle clients from holding sockets.
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.maxHeadersCount = 50;

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const now = Date.now();
    const ip = clientIp(req);
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/ws") return rejectUpgrade(socket, 404, "Not Found");
    if (!cfg.enabled || budget.exceeded) return rejectUpgrade(socket, 503, "Service Unavailable");
    if (!originAllowed(req.headers.origin)) return rejectUpgrade(socket, 403, "Forbidden");
    if (lockedOut(ip, now)) return rejectUpgrade(socket, 429, "Too Many Requests");
    if (connections >= cfg.maxConnections || (perIp.get(ip) ?? 0) >= cfg.maxConnectionsPerIp)
      return rejectUpgrade(socket, 503, "Service Unavailable");
    const check = checkUpgrade(req);
    if ("status" in check) return rejectUpgrade(socket, check.status, check.reason);

    connections++;
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    let room: Room | null = null;
    let peer: Peer | null = null;

    const sendError = (code: ErrorCode, message: string) => {
      ws.sendText(JSON.stringify({ t: "error", code, message } satisfies RelayMessage));
      ws.close(1008, code);
    };

    const ws: WsConnection = new WsConnection(
      socket,
      check.accept,
      {
        onText(text, size) {
          const msg = parseClientMessage(text);
          const t = Date.now();
          if (room && peer) {
            if (!msg) {
              sendError("bad-message", "unrecognised message");
              return;
            }
            room.onText(peer, msg, size, t);
            if (room.closed) closeRoom(room, "room-closed", "room closed");
            return;
          }
          clearTimeout(helloTimer);
          if (!msg || size > 1024) return sendError("bad-message", "expected create, join or resume");
          if (msg.t === "create") {
            if (rooms.size >= cfg.maxRooms) return sendError("server-busy", "the relay is full; try later");
            const r = new Room(newCode(), t, newToken, cfg.limits);
            rooms.set(r.code, r);
            room = r;
            peer = r.join(sock, msg.name, t);
            cfg.log(`room ${r.code} created; ${rooms.size} open`);
            return;
          }
          if (msg.t === "join" || msg.t === "resume") {
            const r = rooms.get(msg.room);
            if (!r || r.closed) {
              noteFailedJoin(ip, t);
              return sendError("no-room", "no room with that code");
            }
            const p = msg.t === "join" ? r.join(sock, msg.name, t) : r.resume(sock, msg.token, t);
            if (!p) {
              if (msg.t === "resume") noteFailedJoin(ip, t);
              return msg.t === "join"
                ? sendError("room-full", "the room is full")
                : sendError("bad-token", "can't resume that seat");
            }
            room = r;
            peer = p;
            return;
          }
          sendError("not-in-room", "join a room first");
        },
        onBinary(data) {
          if (!room || !peer) return sendError("not-in-room", "join a room first");
          room.onBinary(peer, data, Date.now());
          if (room.closed) closeRoom(room, "room-closed", "room closed");
        },
        onClose() {
          clearTimeout(helloTimer);
          live.delete(ws);
          connections--;
          const n = (perIp.get(ip) ?? 1) - 1;
          if (n <= 0) perIp.delete(ip);
          else perIp.set(ip, n);
          if (room && peer) room.onDisconnect(peer, sock, Date.now());
        },
      },
      {
        maxMessageBytes: cfg.limits.maxHostMessageBytes,
        idleTimeoutMs: 60_000,
        pingIntervalMs: 25_000,
        onBytesOut: (n) => budget.add(n),
      },
    );
    const sock: PeerSocket = {
      sendText: (s) => ws.sendText(s),
      sendBinary: (b) => ws.sendBinary(b),
      close: (code, reason) => ws.close(code, reason),
    };
    const helloTimer = setTimeout(() => {
      if (!room) sendError("timeout", "no create, join or resume in time");
    }, cfg.limits.helloTimeoutMs);
    live.add(ws);
    ws.start(head);
  });

  // Housekeeping: room timeouts, budget enforcement and saving.
  let lastSave = Date.now();
  const housekeeping = setInterval(() => {
    const now = Date.now();
    const over = budget.exceeded || !cfg.enabled;
    for (const room of [...rooms.values()]) {
      if (over) closeRoom(room, "server-busy", "the relay has stopped for now");
      else {
        room.tick(now);
        if (room.closed) closeRoom(room, "room-closed", "room closed");
      }
    }
    if (now - lastSave > 60_000) {
      lastSave = now;
      saveBudget();
    }
  }, 1000);
  housekeeping.unref();

  const saveBudget = () => {
    try {
      budget.save();
    } catch (e) {
      cfg.log(`could not save the egress counter: ${(e as Error).message}`);
    }
  };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.host, () => {
      const port = (server.address() as AddressInfo).port;
      cfg.log(`relay listening on ${cfg.host}:${port}; origins ${cfg.allowedOrigins.join(" ")}`);
      resolve({
        server,
        port,
        rooms,
        budget,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(housekeeping);
            for (const room of [...rooms.values()]) closeRoom(room, "room-closed", "the relay is restarting");
            for (const ws of [...live]) ws.close(1001, "the relay is restarting");
            saveBudget();
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const relay = await startRelay(configFromEnv());
  const stop = async () => {
    await relay.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
