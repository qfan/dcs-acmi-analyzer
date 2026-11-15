/**
 * Messages between the UI and the engine worker, and between multiplayer engines over the relay.
 *
 * The engine owns the fight (single player, or as multiplayer host) and the relay connection; the
 * UI only draws snapshots and sends orders. A guest's engine forwards the host's snapshots.
 */
import type { AiSkillChoice } from "../ai/doctrine.ts";
import type { Side } from "../sim/aircraft.ts";
import type { GameParams } from "../sim/params.ts";
import type { ScenarioOptions } from "../sim/scenarios.ts";
import type { Command } from "../sim/world.ts";
import type { Snapshot, WorldShape } from "./snapshot.ts";

/** What a viewer needs to know about the fight it is shown. */
export interface MatchMeta {
  mode: "sp" | "host" | "guest";
  scenarioId: string;
  title: string;
  altFt: number;
  shape: WorldShape;
  startedAt: number;
  /** The side this viewer plays (spectators: blue). */
  side: Side;
  /** Jets this viewer gives orders to. */
  owned: string[];
  /** Single player: the NPC flies blue too, orders are ignored. */
  watch: boolean;
  /** Multiplayer room rule: fog of war forced on for everyone (null in single player). */
  roomFog: boolean | null;
  /** This viewer may change time compression. */
  canScale: boolean;
  /** Multiplayer: pauses this viewer has left (null = unlimited). */
  pausesLeft: number | null;
  /** Not recording (infinite demo). */
  noRecord: boolean;
}

export type SlotState = "open" | "human" | AiSkillChoice | "closed";

export interface LobbySlot {
  jetId: string;
  side: Side;
  callsign: string;
  crew: SlotState;
  /** The player in this slot when `crew` is "human". */
  peer: number | null;
}

export interface LobbyPlayer {
  id: number;
  name: string;
  host: boolean;
  ready: boolean;
  away: boolean;
  rttMs: number | null;
}

export interface LobbySettings {
  scenarioId: string;
  altFt: number;
  missiles: number;
  /** Fog of war forced on for everyone. Off: each player chooses for themselves. */
  fog: boolean;
  /** Pause every N simulated seconds until every player is ready (0 = real time). */
  turnEveryS: number;
  /** Let the host use time compression. */
  timeCompression: boolean;
}

export interface LobbyState {
  room: string;
  phase: "lobby" | "playing";
  settings: LobbySettings;
  slots: LobbySlot[];
  players: LobbyPlayer[];
}

export type LobbyAction =
  | { a: "settings"; patch: Partial<LobbySettings> }
  | { a: "slot-crew"; jetId: string; crew: SlotState }
  | { a: "take"; jetId: string }
  | { a: "release" }
  | { a: "ready"; ready: boolean }
  | { a: "swap" }
  | { a: "start" }
  | { a: "to-lobby" };

export type NetStatus = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

/** UI → engine. */
export type ToEngine =
  | {
      t: "sp-start";
      scenarioId: string;
      altFt: number;
      params: GameParams;
      options: ScenarioOptions;
      seed: number;
      fog: boolean;
    }
  | { t: "stop" }
  | { t: "cmd"; cmd: Command }
  | { t: "pause" }
  | { t: "play" }
  | { t: "scale"; k: number }
  | { t: "fog"; on: boolean }
  | { t: "visibility"; hidden: boolean }
  | { t: "mp-host"; relayUrl: string; name: string; params: GameParams }
  | { t: "mp-join"; relayUrl: string; room: string; name: string }
  | { t: "lobby"; action: LobbyAction }
  | { t: "mp-leave" };

/** Engine → UI. */
export type FromEngine =
  | { t: "match"; meta: MatchMeta; snap: Snapshot }
  | { t: "snap"; snap: Snapshot }
  | { t: "meta"; meta: Partial<MatchMeta> }
  | { t: "flash"; text: string }
  | { t: "lobby"; lobby: LobbyState; you: number }
  | { t: "net"; status: NetStatus; message?: string }
  | { t: "ended"; reason: string };

/** Host → guests (inside relay messages). */
export type HostMsg =
  | { k: "lobby"; lobby: LobbyState }
  | { k: "start"; meta: Omit<MatchMeta, "mode" | "side" | "owned" | "pausesLeft">; snap: unknown }
  | { k: "snap"; snap: unknown }
  | { k: "pauses"; left: number }
  | { k: "flash"; text: string }
  | { k: "pong"; n: number };

/** Guest → host. */
export type GuestMsg =
  | { k: "lobby"; action: LobbyAction }
  | { k: "cmd"; cmd: Command }
  | { k: "pause" }
  | { k: "play" }
  | { k: "fog"; on: boolean }
  | { k: "sync" }
  | { k: "ping"; n: number; rttMs: number | null };

/** Default relay; self-hosters set their own in the Multiplayer tab. */
export const DEFAULT_RELAY_URL = "wss://relay.qfan.ca/ws";
/** Pauses each player gets per multiplayer match. */
export const MP_PAUSES = 5;
