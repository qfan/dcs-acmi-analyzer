/**
 * The few Cloudflare Workers runtime types this relay uses, declared here so the code type-checks
 * (and its logic runs in Node tests) without the full @cloudflare/workers-types package.
 * Shapes follow the Workers runtime API: https://developers.cloudflare.com/durable-objects/
 */

/** A server-side WebSocket accepted with the Hibernation API. */
export interface CfWebSocket {
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  /** Small per-socket state that survives the Durable Object hibernating. */
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface DurableObjectState {
  readonly storage: DurableObjectStorage;
  acceptWebSocket(ws: CfWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): CfWebSocket[];
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

export interface DurableObjectStub {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

export interface Env {
  ROOMS: DurableObjectNamespace;
  COUNTER: DurableObjectNamespace;
  /** "0" refuses everything (kill switch). */
  RELAY_ENABLED?: string;
  /** Comma-separated pages allowed to connect (":*" = any port). */
  ALLOWED_ORIGINS?: string;
  /** "1" accepts clients that send no Origin header. */
  ALLOW_NO_ORIGIN?: string;
  /** Rooms open at once across the whole relay. */
  MAX_ROOMS?: string;
}

/**
 * Runtime pieces the Workers platform provides and Node doesn't (tests replace them): a WebSocket
 * pair, and the 101 response that hands one end to the client.
 */
export const runtime = {
  webSocketPair(): [CfWebSocket, CfWebSocket] {
    const Pair = (globalThis as unknown as { WebSocketPair: new () => Record<0 | 1, CfWebSocket> })
      .WebSocketPair;
    const p = new Pair();
    return [p[0], p[1]];
  },
  upgradeResponse(client: CfWebSocket): Response {
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  },
};

/** Random token: 18 bytes, base64url (Web Crypto, available in Workers and Node). */
export function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(18));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
