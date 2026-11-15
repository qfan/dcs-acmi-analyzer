/**
 * Which relays the game knows, how to check them, and how invite links name them.
 *
 * A room exists on one relay only, so an invite carries its relay: a short key for the built-in
 * ones, or the full address for a custom one. It lives in the URL fragment (`#join=…&r=…`), which
 * browsers never send to any server.
 */
import type { HealthState } from "../../../game/server/shared/protocol.ts";

export interface RelayInfo {
  /** Short key for invite links ("cf", "or", "local"); custom relays have none. */
  key: string | null;
  label: string;
  url: string;
}

/** The public relays, in the order "Automatic" prefers them when both are up and equally quick. */
export const BUILTIN_RELAYS: readonly RelayInfo[] = [
  { key: "cf", label: "Cloudflare", url: "wss://bvr-mini-game-server-cf.qfan.ca/ws" },
  { key: "or", label: "Oracle", url: "wss://bvr-mini-game-server-or.qfan.ca/ws" },
];

/** While developing on localhost, the relay on this computer comes first. */
export function knownRelays(loc: { hostname: string } = location): RelayInfo[] {
  const h = loc.hostname;
  const local = h === "localhost" || h === "127.0.0.1";
  return local
    ? [{ key: "local", label: "This computer", url: `ws://${h}:8787/ws` }, ...BUILTIN_RELAYS]
    : [...BUILTIN_RELAYS];
}

/** Only ws:// and wss:// addresses with a host. */
export function isRelayUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return (u.protocol === "ws:" || u.protocol === "wss:") && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** True when a page on https can't use this address (browsers block ws:// there). */
export function blockedAsMixedContent(url: string, pageProtocol: string = location.protocol): boolean {
  return pageProtocol === "https:" && url.startsWith("ws:");
}

/** The relay's health URL: same host, https/http instead of wss/ws, path /healthz. */
export function healthUrl(wsUrl: string): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.pathname = u.pathname.replace(/\/ws\/?$/, "") + "/healthz";
  u.search = "";
  u.hash = "";
  return u.toString();
}

export type ProbeState = HealthState | "down" | "checking";

export interface ProbeResult {
  state: ProbeState;
  /** Round trip of the health check (ms), when it answered. */
  ms: number | null;
}

/** Asks a relay whether it takes new rooms. Anything but a readable answer counts as down. */
export async function probeRelay(url: string, timeoutMs = 3000): Promise<ProbeResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetch(healthUrl(url), { cache: "no-store", signal: ctl.signal, credentials: "omit" });
    const text = (await res.text()).trim();
    const ms = Math.round(performance.now() - t0);
    const state: ProbeState = text === "ok" || text === "busy" || text === "disabled" ? text : "down";
    return { state, ms: state === "down" ? null : ms };
  } catch {
    return { state: "down", ms: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Relays to try, in order. Hosting needs one that takes rooms: the ones that said "ok" (quickest
 * first), then any that didn't answer (a relay without CORS can still work), never busy or
 * disabled ones. Joining tries every relay that might hold the room.
 */
export function orderRelays(
  relays: readonly RelayInfo[],
  probes: ReadonlyMap<string, ProbeResult>,
  purpose: "host" | "join",
): string[] {
  const ok = relays
    .filter((r) => probes.get(r.url)?.state === "ok")
    .sort((a, b) => (probes.get(a.url)?.ms ?? 1e9) - (probes.get(b.url)?.ms ?? 1e9));
  const unknown = relays.filter((r) => {
    const s = probes.get(r.url)?.state;
    return s === undefined || s === "checking" || s === "down";
  });
  const full = relays.filter((r) => {
    const s = probes.get(r.url)?.state;
    return s === "busy" || s === "disabled";
  });
  const order = purpose === "host" ? [...ok, ...unknown] : [...ok, ...full, ...unknown];
  return [...new Set(order.map((r) => r.url))];
}

/** An invite link for a room on `relayUrl`. */
export function inviteLink(
  pageUrl: string,
  room: string,
  relayUrl: string,
  relays: readonly RelayInfo[],
): string {
  const key = relays.find((r) => r.url === relayUrl)?.key;
  const r = key ?? relayUrl;
  return `${pageUrl}#join=${room}&r=${encodeURIComponent(r)}`;
}

/** Reads `#join=CODE[&r=key-or-url]` from an invite link. */
export function parseInvite(
  hash: string,
  relays: readonly RelayInfo[],
): { room: string; relayUrl: string | null } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const room = (params.get("join") ?? "").toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(room)) return null;
  const r = params.get("r");
  if (!r) return { room, relayUrl: null };
  const known = relays.find((x) => x.key === r)?.url ?? BUILTIN_RELAYS.find((x) => x.key === r)?.url;
  if (known) return { room, relayUrl: known };
  return { room, relayUrl: isRelayUrl(r) ? r : null };
}

/** A label for a relay address: the built-in name, or the host for a custom one. */
export function relayLabel(url: string, relays: readonly RelayInfo[]): string {
  const known = relays.find((r) => r.url === url);
  if (known) return known.label;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
