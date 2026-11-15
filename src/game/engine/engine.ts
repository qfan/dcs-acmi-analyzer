/**
 * The game engine: runs the authoritative fight off the UI thread (single player, or as the
 * multiplayer host) and owns the relay connection. The UI talks to it only through messages
 * (protocol.ts), so it runs the same in a Web Worker and in Node tests.
 *
 * Hidden browser tabs throttle main-thread timers to about once a second; a worker's are not, so a
 * multiplayer host can switch tabs without stalling everyone's fight.
 */
import { AI_SKILL_CHOICES } from "../ai/doctrine.ts";
import { RelayClient } from "../net/relayClient.ts";
import type { Side } from "../sim/aircraft.ts";
import type { GameParams } from "../sim/params.ts";
import {
  buildMultiplayer,
  DEFAULT_OPTIONS,
  npcTakeover,
  type SlotCrew,
  scenarioById,
  scenarioSlots,
} from "../sim/scenarios.ts";
import type { Command } from "../sim/world.ts";
import {
  type FromEngine,
  type GuestMsg,
  type HostMsg,
  type LobbyAction,
  type LobbySettings,
  type LobbySlot,
  type LobbyState,
  type MatchMeta,
  MP_PAUSES,
  type ToEngine,
} from "./protocol.ts";
import { DEFAULT_AUTOPAUSE, GameSession, PLAYER_SIDE } from "./session.ts";
import {
  buildSnapshot,
  type Snapshot,
  SnapshotCursor,
  snapshotFromNet,
  snapshotToJson,
  worldShape,
} from "./snapshot.ts";

/** Sim tick (ms). The sim itself steps at 50 Hz inside `advance`. */
const TICK_MS = 16;
/** Network snapshots: at most every 100 ms, slower when big (bytes per second budget). */
const NET_MIN_MS = 100;
const NET_BYTES_PER_S = 160_000;
/** Largest snapshot the host sends (the relay allows 64 KB). */
const NET_MAX_BYTES = 60_000;
const PING_MS = 2_000;
const LOBBY_REFRESH_MS = 2_000;
/** UI snapshots while nothing moves (paused), so NPC panels and the like stay fresh. */
const IDLE_SNAP_MS = 250;

type Mode = "idle" | "sp" | "host" | "guest";

export const MP_ALTITUDES_FT = [5000, 15000, 25000, 35000] as const;
export const MP_LOADOUTS = [4, 6, 8, 10] as const;

/** Relay refusals that mean "try another relay" (before getting into a room). */
const HOST_RETRY = new Set(["unreachable", "bad-url", "timeout", "server-busy"]);
const JOIN_RETRY = new Set(["unreachable", "bad-url", "timeout", "server-busy", "no-room"]);

const TURN_PREFIX = "Turn:";
const AWAY_PREFIX = "Waiting for";
const RELAY_PAUSE = "Connection to the relay lost";

export class Engine {
  private readonly post: (m: FromEngine) => void;
  private mode: Mode = "idle";
  private session: GameSession | null = null;
  private uiCursor = new SnapshotCursor();
  private uiSide: Side = PLAYER_SIDE;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private lastUiSnapT = Number.NaN;
  private lastUiSnapAt = 0;
  private lastUiState = "";

  // Multiplayer (host and guest)
  private relay: RelayClient | null = null;
  private you = -1;
  private hostId = -1;
  private lobby: LobbyState | null = null;
  private params: GameParams | null = null;
  // Host only
  private owners = new Map<string, number>();
  /** Slots players held when the match started. */
  private humanSlots = new Set<string>();
  private personalFog = new Map<number, boolean>();
  private pausesLeft = new Map<number, number>();
  private turnReady = new Set<number>();
  private netCursor = new SnapshotCursor();
  private lastNetAt = 0;
  private netEveryMs = NET_MIN_MS;
  private lobbyDirty = false;
  private lobbyTimer: ReturnType<typeof setInterval> | null = null;
  private matchMeta: Omit<MatchMeta, "mode" | "side" | "owned" | "pausesLeft"> | null = null;
  // Guest only
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingN = 0;
  private pingSentAt = 0;
  private rttMs: number | null = null;
  private inMatch = false;
  private pendingStart = false;

  constructor(post: (m: FromEngine) => void) {
    this.post = post;
  }

  handle(m: ToEngine): void {
    switch (m.t) {
      case "sp-start":
        this.leaveMp();
        this.startSingle(m);
        return;
      case "stop":
        this.stopSession();
        return;
      case "cmd":
        this.onCommand(m.cmd);
        return;
      case "pause":
      case "play":
        if (this.mode === "sp") this.spTime(m.t);
        else if (this.mode === "host") this.mpTime(this.you, m.t);
        else if (this.mode === "guest") this.toHost({ k: m.t });
        return;
      case "scale":
        if (
          this.session &&
          (this.mode === "sp" || (this.mode === "host" && this.lobby?.settings.timeCompression))
        )
          this.session.timeScale = m.k;
        return;
      case "fog":
        if (this.mode === "sp" && this.session) this.session.fog = m.on;
        else if (this.mode === "host") this.setPersonalFog(this.you, m.on);
        else if (this.mode === "guest") this.toHost({ k: "fog", on: m.on });
        return;
      case "visibility":
        if (
          this.mode === "sp" &&
          m.hidden &&
          this.session &&
          !this.session.paused &&
          !this.session.world.outcome
        )
          this.session.pause("Paused while the tab was hidden.");
        return;
      case "mp-host":
        this.stopSession();
        this.leaveMp();
        this.startHosting(m.relayUrls, m.name, m.params);
        return;
      case "mp-join":
        this.stopSession();
        this.leaveMp();
        this.startJoining(m.relayUrls, m.room, m.name);
        return;
      case "lobby":
        if (this.mode === "host") this.lobbyAction(this.you, m.action);
        else if (this.mode === "guest") this.toHost({ k: "lobby", action: m.action });
        return;
      case "mp-leave":
        this.stopSession();
        this.leaveMp();
        this.post({ t: "net", status: "idle" });
        return;
    }
  }

  dispose(): void {
    this.stopSession();
    this.leaveMp();
  }

  // ---------------------------------------------------------------- single player

  private startSingle(m: Extract<ToEngine, { t: "sp-start" }>): void {
    this.stopSession();
    const s = new GameSession(m.scenarioId, m.altFt, m.params, DEFAULT_AUTOPAUSE, m.seed, m.options, {
      record: false,
    });
    s.fog = m.fog;
    this.mode = "sp";
    this.uiSide = PLAYER_SIDE;
    const scenario = scenarioById(m.scenarioId);
    this.beginSession(s, {
      mode: "sp",
      scenarioId: m.scenarioId,
      title: scenario.title,
      altFt: m.altFt,
      shape: worldShape(s.world),
      startedAt: s.startedAt.getTime(),
      side: PLAYER_SIDE,
      owned: s.watch ? [] : s.world.jets.filter((j) => j.side === PLAYER_SIDE).map((j) => j.id),
      watch: s.watch,
      roomFog: null,
      canScale: true,
      pausesLeft: null,
      noRecord: s.world.infinite,
    });
  }

  private spTime(what: "pause" | "play"): void {
    const s = this.session;
    if (!s) return;
    if (what === "play") s.play();
    else s.pause("Paused.");
  }

  // ---------------------------------------------------------------- session loop

  private beginSession(s: GameSession, meta: MatchMeta): void {
    this.session = s;
    this.uiCursor = new SnapshotCursor();
    this.lastUiSnapT = Number.NaN;
    this.post({ t: "match", meta, snap: buildSnapshot(s, [meta.side], this.uiCursor) });
    this.lastUiSnapT = s.world.t;
    this.lastTick = performance.now();
    this.timer ??= setInterval(() => this.tick(), TICK_MS);
  }

  private stopSession(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.session = null;
    if (this.mode === "sp") this.mode = "idle";
  }

  /** Advances the fight and sends snapshots to the UI and, as host, to the guests. */
  tick(now = performance.now()): void {
    const s = this.session;
    if (!s) return;
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;
    s.advance(dt);
    if (this.mode === "host") this.hostAfterAdvance();
    const state = `${s.paused}|${s.pauseReason}|${s.timeScale}`;
    if (
      s.world.t !== this.lastUiSnapT ||
      state !== this.lastUiState ||
      now - this.lastUiSnapAt > IDLE_SNAP_MS
    ) {
      this.lastUiSnapT = s.world.t;
      this.lastUiState = state;
      this.lastUiSnapAt = now;
      this.post({ t: "snap", snap: buildSnapshot(s, [this.uiSide], this.uiCursor) });
    }
    if (this.mode === "host" && now - this.lastNetAt >= this.netEveryMs) {
      this.lastNetAt = now;
      this.sendNetSnapshot(this.netCursor);
    }
  }

  // ---------------------------------------------------------------- commands

  private onCommand(cmd: Command): void {
    if (this.mode === "guest") {
      this.toHost({ k: "cmd", cmd });
      return;
    }
    const s = this.session;
    if (!s) return;
    if (this.mode === "sp") {
      if (s.watch) return;
      const j = s.world.jets.find((x) => x.id === cmd.jetId);
      if (j?.side !== PLAYER_SIDE) return;
      const err = s.applyCommand(cmd);
      if (err) this.post({ t: "flash", text: err });
      return;
    }
    if (this.mode === "host") this.hostCommand(this.you, cmd);
  }

  private hostCommand(from: number, cmd: Command): void {
    const s = this.session;
    if (!s) return;
    const err = this.owners.get(cmd.jetId) !== from ? "That is not your jet." : s.applyCommand(cmd);
    if (err) this.flashTo(from, err);
  }

  // ---------------------------------------------------------------- multiplayer: common

  private leaveMp(): void {
    if (this.mode === "host" || this.mode === "guest") {
      this.relay?.leave();
      this.relay = null;
      this.mode = "idle";
    }
    if (this.lobbyTimer) clearInterval(this.lobbyTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.lobbyTimer = null;
    this.pingTimer = null;
    this.lobby = null;
    this.inMatch = false;
    this.owners.clear();
    this.personalFog.clear();
    this.pausesLeft.clear();
    this.turnReady.clear();
  }

  private postLobby(): void {
    if (this.lobby) this.post({ t: "lobby", lobby: this.lobby, you: this.you });
  }

  private flashTo(peer: number, text: string): void {
    if (peer === this.you) this.post({ t: "flash", text });
    else this.toPeer(peer, { k: "flash", text });
  }

  private toHost(m: GuestMsg): void {
    this.relay?.send(m);
  }

  private toPeer(peer: number, m: HostMsg): void {
    this.relay?.send(m, peer);
  }

  private broadcast(m: HostMsg): void {
    this.relay?.send(m);
  }

  private nameOf(id: number): string {
    return this.lobby?.players.find((p) => p.id === id)?.name ?? `Player ${id + 1}`;
  }

  // ---------------------------------------------------------------- multiplayer: host

  private startHosting(urls: string[], name: string, params: GameParams, attempt = 0): void {
    const url = urls[attempt];
    if (!url) {
      this.mode = "host";
      this.mpClosed("No server is taking new rooms right now. Try again later, or use your own relay.");
      return;
    }
    this.mode = "host";
    this.params = params;
    let welcomed = false;
    const relay = new RelayClient(url, {
      onStatus: (status) => {
        this.post({ t: "net", status, relay: status === "connected" ? url : undefined });
        const s = this.session;
        if (status === "reconnecting" && s && !s.paused && !s.world.outcome)
          s.pause(`${RELAY_PAUSE}: reconnecting…`);
      },
      onWelcome: (info) => {
        welcomed = true;
        if (info.resumed) {
          if (this.session?.pauseReason?.startsWith(RELAY_PAUSE)) this.session.play();
          this.broadcastLobby();
          if (this.session) this.netCursor.full = true;
          return;
        }
        this.you = info.you;
        this.hostId = info.host;
        this.lobby = this.initialLobby(info.room, name, params);
        this.postLobby();
        this.lobbyTimer = setInterval(() => {
          if (this.lobbyDirty) this.broadcastLobby();
        }, LOBBY_REFRESH_MS);
      },
      onPeer: (kind, id, peerName) => this.hostPeer(kind, id, peerName),
      onMessage: (from, d) => this.hostMessage(from, d as GuestMsg),
      onClosed: (code, message) => {
        // This relay can't open a room: try the next one.
        if (!welcomed && this.relay === relay && HOST_RETRY.has(code) && attempt + 1 < urls.length) {
          this.relay = null;
          this.startHosting(urls, name, params, attempt + 1);
          return;
        }
        this.mpClosed(message);
      },
    });
    this.relay = relay;
    relay.create(name);
  }

  private initialLobby(room: string, name: string, params: GameParams): LobbyState {
    const settings: LobbySettings = {
      scenarioId: "duel",
      altFt: 25000,
      missiles: nearest(MP_LOADOUTS, params.aircraft.missiles),
      fog: true,
      turnEveryS: 0,
      timeCompression: false,
    };
    const lobby: LobbyState = {
      room,
      phase: "lobby",
      settings,
      slots: this.slotsFor(settings.scenarioId),
      players: [{ id: this.you, name, host: true, ready: true, away: false, rttMs: null }],
    };
    const first = lobby.slots.find((s) => s.side === "blue");
    if (first) {
      first.crew = "human";
      first.peer = this.you;
    }
    return lobby;
  }

  private slotsFor(scenarioId: string): LobbySlot[] {
    return scenarioSlots(scenarioId, this.params as GameParams).map((j) => ({
      jetId: j.id,
      side: j.side,
      callsign: j.callsign,
      crew: "open",
      peer: null,
    }));
  }

  private broadcastLobby(): void {
    this.lobbyDirty = false;
    if (!this.lobby) return;
    this.postLobby();
    this.broadcast({ k: "lobby", lobby: this.lobby });
  }

  private hostPeer(kind: "joined" | "away" | "back" | "left", id: number, name?: string): void {
    const lobby = this.lobby;
    if (!lobby) return;
    const player = lobby.players.find((p) => p.id === id);
    if (kind === "joined") {
      lobby.players.push({
        id,
        name: name ?? `Player ${id + 1}`,
        host: false,
        ready: false,
        away: false,
        rttMs: null,
      });
      this.broadcastLobby();
      if (this.session) this.sendMatchTo(id);
      return;
    }
    if (!player) return;
    const s = this.session;
    const slotted = lobby.slots.some((sl) => sl.peer === id);
    if (kind === "away") {
      player.away = true;
      if (s && slotted && !s.world.outcome)
        s.pause(`${AWAY_PREFIX} ${player.name} to reconnect (up to 60 s).`);
    } else if (kind === "back") {
      player.away = false;
      if (s) this.sendMatchTo(id);
      this.resumeIfNobodyAway();
    } else {
      lobby.players = lobby.players.filter((p) => p.id !== id);
      for (const sl of lobby.slots) {
        if (sl.peer !== id) continue;
        sl.peer = null;
        if (s) {
          sl.crew = "normal";
          this.owners.delete(sl.jetId);
          if (s.world.jets.some((j) => j.id === sl.jetId && j.alive)) npcTakeover(s.world, sl.jetId);
          this.flashAll(`${player.name} left: an NPC flies ${sl.callsign} now.`);
        } else sl.crew = "open";
      }
      this.turnReady.delete(id);
      this.resumeIfNobodyAway();
    }
    this.broadcastLobby();
  }

  private resumeIfNobodyAway(): void {
    const s = this.session;
    if (!s?.pauseReason?.startsWith(AWAY_PREFIX)) return;
    const stillAway = this.lobby?.players.find(
      (p) => p.away && this.lobby?.slots.some((sl) => sl.peer === p.id),
    );
    if (stillAway) s.pause(`${AWAY_PREFIX} ${stillAway.name} to reconnect (up to 60 s).`);
    else s.play();
  }

  private flashAll(text: string): void {
    this.post({ t: "flash", text });
    this.broadcast({ k: "flash", text });
  }

  private hostMessage(from: number, m: GuestMsg): void {
    if (!m || typeof m !== "object") return;
    switch (m.k) {
      case "lobby":
        this.lobbyAction(from, m.action);
        return;
      case "cmd":
        this.hostCommand(from, m.cmd);
        return;
      case "pause":
      case "play":
        this.mpTime(from, m.k);
        return;
      case "fog":
        this.setPersonalFog(from, m.on);
        return;
      case "sync":
        if (this.lobby) this.toPeer(from, { k: "lobby", lobby: this.lobby });
        if (this.session) this.sendMatchTo(from);
        return;
      case "ping": {
        this.toPeer(from, { k: "pong", n: m.n });
        const p = this.lobby?.players.find((x) => x.id === from);
        if (p && typeof m.rttMs === "number" && p.rttMs !== Math.round(m.rttMs)) {
          p.rttMs = Math.round(m.rttMs);
          this.lobbyDirty = true;
        }
        return;
      }
    }
  }

  private lobbyAction(from: number, act: LobbyAction): void {
    const lobby = this.lobby;
    if (!lobby || !act || typeof act !== "object") return;
    const isHost = from === this.you;
    const me = lobby.players.find((p) => p.id === from);
    if (!me) return;
    const inLobby = lobby.phase === "lobby";
    switch (act.a) {
      case "settings": {
        if (!isHost || !inLobby) return;
        const p = act.patch;
        const st = lobby.settings;
        if (
          typeof p.scenarioId === "string" &&
          scenarioById(p.scenarioId).mp &&
          p.scenarioId !== st.scenarioId
        ) {
          st.scenarioId = p.scenarioId;
          const humans = lobby.players.map((x) => x.id);
          lobby.slots = this.slotsFor(st.scenarioId);
          // The host keeps a seat; everyone else picks again.
          const first = lobby.slots.find((s) => s.side === "blue");
          if (first) {
            first.crew = "human";
            first.peer = this.you;
          }
          for (const x of lobby.players) if (x.id !== this.you && humans.includes(x.id)) x.ready = false;
        }
        if (typeof p.altFt === "number" && (MP_ALTITUDES_FT as readonly number[]).includes(p.altFt))
          st.altFt = p.altFt;
        if (typeof p.missiles === "number" && (MP_LOADOUTS as readonly number[]).includes(p.missiles))
          st.missiles = p.missiles;
        if (typeof p.fog === "boolean") st.fog = p.fog;
        if (typeof p.turnEveryS === "number" && p.turnEveryS >= 0 && p.turnEveryS <= 120)
          st.turnEveryS = p.turnEveryS;
        if (typeof p.timeCompression === "boolean") st.timeCompression = p.timeCompression;
        break;
      }
      case "slot-crew": {
        if (!isHost || !inLobby) return;
        const sl = lobby.slots.find((s) => s.jetId === act.jetId);
        if (!sl || sl.crew === "human") return;
        const ok =
          act.crew === "open" ||
          act.crew === "closed" ||
          (AI_SKILL_CHOICES as readonly string[]).includes(act.crew);
        if (!ok) return;
        sl.crew = act.crew;
        break;
      }
      case "take": {
        if (!inLobby) return;
        const sl = lobby.slots.find((s) => s.jetId === act.jetId);
        if (sl?.crew !== "open") return;
        for (const s of lobby.slots)
          if (s.peer === from) {
            s.peer = null;
            s.crew = "open";
          }
        sl.crew = "human";
        sl.peer = from;
        if (!isHost) me.ready = false;
        break;
      }
      case "release": {
        if (!inLobby) return;
        for (const s of lobby.slots)
          if (s.peer === from) {
            s.peer = null;
            s.crew = "open";
          }
        if (!isHost) me.ready = false;
        break;
      }
      case "ready":
        if (!inLobby || isHost) return;
        me.ready = !!act.ready;
        break;
      case "swap": {
        if (!isHost || !inLobby) return;
        const blue = lobby.slots.filter((s) => s.side === "blue");
        const red = lobby.slots.filter((s) => s.side === "red");
        for (let i = 0; i < Math.min(blue.length, red.length); i++) {
          const b = blue[i] as LobbySlot;
          const r = red[i] as LobbySlot;
          [b.crew, r.crew] = [r.crew, b.crew];
          [b.peer, r.peer] = [r.peer, b.peer];
        }
        break;
      }
      case "start":
        if (!isHost || !inLobby) return;
        this.startMatch();
        return;
      case "to-lobby":
        if (!isHost || inLobby) return;
        this.backToLobby();
        return;
      default:
        return;
    }
    this.broadcastLobby();
  }

  /** Why the host can't start yet, or null when it can. */
  private notReady(): string | null {
    const lobby = this.lobby;
    if (!lobby) return "No room.";
    for (const side of ["blue", "red"] as Side[])
      if (!lobby.slots.some((s) => s.side === side && s.crew !== "closed"))
        return `The ${side} side needs at least one jet.`;
    const waiting = lobby.players.filter(
      (p) => !p.host && lobby.slots.some((s) => s.peer === p.id) && !p.ready,
    );
    if (waiting.length > 0) return `Waiting for ${waiting.map((p) => p.name).join(", ")} to be ready.`;
    return null;
  }

  private startMatch(): void {
    const lobby = this.lobby;
    const params = this.params;
    if (!lobby || !params) return;
    const why = this.notReady();
    if (why) {
      this.post({ t: "flash", text: why });
      return;
    }
    const st = lobby.settings;
    const p: GameParams = { ...params, aircraft: { ...params.aircraft, missiles: st.missiles } };
    const crew: Record<string, SlotCrew> = {};
    this.owners.clear();
    for (const sl of lobby.slots) {
      crew[sl.jetId] = sl.crew === "open" ? "normal" : sl.crew;
      if (sl.crew === "human" && sl.peer !== null) this.owners.set(sl.jetId, sl.peer);
    }
    this.humanSlots = new Set(this.owners.keys());
    const seed = Math.floor(Math.random() * 1e9);
    const world = buildMultiplayer(st.scenarioId, p, st.altFt, seed, crew);
    const s = new GameSession(
      st.scenarioId,
      st.altFt,
      p,
      { ...DEFAULT_AUTOPAUSE, turnEveryS: st.turnEveryS },
      seed,
      DEFAULT_OPTIONS,
      { world, record: false },
    );
    this.pausesLeft.clear();
    for (const pl of lobby.players) this.pausesLeft.set(pl.id, MP_PAUSES);
    this.turnReady.clear();
    lobby.phase = "playing";
    this.matchMeta = {
      scenarioId: st.scenarioId,
      title: scenarioById(st.scenarioId).title,
      altFt: st.altFt,
      shape: worldShape(world),
      startedAt: s.startedAt.getTime(),
      watch: false,
      roomFog: st.fog,
      canScale: st.timeCompression,
      noRecord: false,
    };
    this.session = s;
    this.refreshFogJets();
    this.broadcastLobby();
    this.netCursor = new SnapshotCursor();
    this.broadcast({ k: "start", meta: this.matchMeta, snap: null });
    this.lastNetAt = 0;
    this.uiSide = this.sideOf(this.you);
    this.beginSession(s, this.metaFor(this.you, "host"));
    this.sendNetSnapshot(this.netCursor);
  }

  private metaFor(peer: number, mode: "host" | "guest"): MatchMeta {
    const lobby = this.lobby as LobbyState;
    const m = this.matchMeta as NonNullable<Engine["matchMeta"]>;
    return {
      ...m,
      mode,
      side: sideFromLobby(lobby, peer),
      owned: lobby.slots.filter((s) => s.peer === peer && s.crew === "human").map((s) => s.jetId),
      canScale: mode === "host" && m.canScale,
      pausesLeft: this.pausesLeft.get(peer) ?? MP_PAUSES,
    };
  }

  private sideOf(peer: number): Side {
    return this.lobby ? sideFromLobby(this.lobby, peer) : PLAYER_SIDE;
  }

  /** Sends the match start and a full snapshot to one peer (late join, reconnect, resync). */
  private sendMatchTo(peer: number): void {
    const s = this.session;
    if (!s || !this.matchMeta) return;
    this.toPeer(peer, { k: "start", meta: this.matchMeta, snap: null });
    this.sendNetSnapshot(new SnapshotCursor(), peer);
  }

  private sendNetSnapshot(cur: SnapshotCursor, to?: number): void {
    const s = this.session;
    if (!s || !this.relay) return;
    const json = snapshotToJson(buildSnapshot(s, ["blue", "red"], cur));
    if (json.length > NET_MAX_BYTES) {
      // Too big for the relay (only possible with very many missiles in the air): skip it rather
      // than get disconnected; the next one goes out a little later.
      this.netEveryMs = 1000;
      return;
    }
    if (to === undefined) this.netEveryMs = Math.max(NET_MIN_MS, (json.length / NET_BYTES_PER_S) * 1000);
    this.relay.sendJson(`{"k":"snap","snap":${json}}`, to);
  }

  private hostAfterAdvance(): void {
    const s = this.session;
    if (!s) return;
    // A turn just ended: everyone must say they are ready before the fight goes on.
    if (s.paused && s.pauseReason?.startsWith(TURN_PREFIX) && !s.pauseReason.includes("waiting for")) {
      this.turnReady.clear();
      this.updateTurnReason();
    }
  }

  private humansInMatch(): number[] {
    const ids = new Set(this.owners.values());
    return [...ids].filter((id) => this.lobby?.players.some((p) => p.id === id));
  }

  private updateTurnReason(): void {
    const s = this.session;
    if (!s) return;
    const waiting = this.humansInMatch().filter((id) => !this.turnReady.has(id));
    if (waiting.length === 0) {
      this.turnReady.clear();
      s.play();
      return;
    }
    s.pause(
      `${TURN_PREFIX} give orders, then press Play. Turn waiting for ${waiting.map((id) => this.nameOf(id)).join(", ")}.`,
    );
  }

  private mpTime(from: number, what: "pause" | "play"): void {
    const s = this.session;
    if (!s || s.world.outcome) return;
    if (what === "play") {
      if (!s.paused) return;
      if (s.pauseReason?.startsWith(TURN_PREFIX)) {
        this.turnReady.add(from);
        this.updateTurnReason();
        return;
      }
      if (s.pauseReason?.startsWith(AWAY_PREFIX) || s.pauseReason?.startsWith(RELAY_PAUSE)) {
        this.flashTo(from, "Waiting for a player to reconnect.");
        return;
      }
      s.play();
      return;
    }
    if (s.paused) return;
    const left = this.pausesLeft.get(from) ?? 0;
    if (left <= 0) {
      this.flashTo(from, "You have no pauses left this match.");
      return;
    }
    this.pausesLeft.set(from, left - 1);
    s.pause(`${this.nameOf(from)} paused (${left - 1} left). Anyone can press Play.`);
    if (from === this.you) this.post({ t: "meta", meta: { pausesLeft: left - 1 } });
    else this.toPeer(from, { k: "pauses", left: left - 1 });
  }

  private setPersonalFog(peer: number, on: boolean): void {
    if (this.lobby?.settings.fog) return;
    this.personalFog.set(peer, on);
    this.refreshFogJets();
  }

  private refreshFogJets(): void {
    const s = this.session;
    if (!s) return;
    const roomFog = !!this.lobby?.settings.fog;
    s.fogJets = new Set(
      [...this.owners].filter(([, peer]) => roomFog || this.personalFog.get(peer)).map(([id]) => id),
    );
  }

  private backToLobby(): void {
    const lobby = this.lobby;
    if (!lobby) return;
    this.stopSession();
    this.matchMeta = null;
    lobby.phase = "lobby";
    for (const p of lobby.players) p.ready = p.host;
    // Players who left during the match had their jets taken over: open those slots again.
    for (const sl of lobby.slots) if (this.humanSlots.has(sl.jetId) && sl.peer === null) sl.crew = "open";
    this.humanSlots.clear();
    this.owners.clear();
    this.broadcastLobby();
  }

  private mpClosed(message: string): void {
    const wasMp = this.mode === "host" || this.mode === "guest";
    this.stopSession();
    this.relay = null;
    this.leaveMp();
    if (wasMp) {
      this.post({ t: "net", status: "closed", message });
      this.post({ t: "ended", reason: message });
    }
  }

  // ---------------------------------------------------------------- multiplayer: guest

  private startJoining(urls: string[], room: string, name: string, attempt = 0, sawNoRoom = false): void {
    const url = urls[attempt];
    this.mode = "guest";
    if (!url) {
      this.mpClosed("No server to join.");
      return;
    }
    let welcomed = false;
    const relay = new RelayClient(url, {
      onStatus: (status) => this.post({ t: "net", status, relay: status === "connected" ? url : undefined }),
      onWelcome: (info) => {
        welcomed = true;
        this.you = info.you;
        this.hostId = info.host;
        if (info.resumed) this.toHost({ k: "sync" });
        this.pingTimer ??= setInterval(() => this.ping(), PING_MS);
      },
      onPeer: (kind, id) => {
        if (id === this.hostId && kind === "away")
          this.post({ t: "flash", text: "The host lost connection; waiting…" });
      },
      onMessage: (from, d) => {
        if (from === this.hostId) this.guestMessage(d as HostMsg);
      },
      onClosed: (code, message) => {
        const noRoom = sawNoRoom || code === "no-room";
        // Not on this relay (or it is unreachable): look on the next one.
        if (!welcomed && this.relay === relay && JOIN_RETRY.has(code) && attempt + 1 < urls.length) {
          this.relay = null;
          this.startJoining(urls, room, name, attempt + 1, noRoom);
          return;
        }
        this.mpClosed(
          !welcomed && noRoom && urls.length > 1 ? "No room with that code on any server." : message,
        );
      },
    });
    this.relay = relay;
    relay.join(room, name);
  }

  private ping(): void {
    this.pingN++;
    this.pingSentAt = performance.now();
    this.toHost({ k: "ping", n: this.pingN, rttMs: this.rttMs });
  }

  private guestMessage(m: HostMsg): void {
    if (!m || typeof m !== "object") return;
    switch (m.k) {
      case "lobby": {
        const wasPlaying = this.lobby?.phase === "playing";
        this.lobby = m.lobby;
        this.postLobby();
        if (wasPlaying && m.lobby.phase === "lobby") this.inMatch = false;
        return;
      }
      case "start":
        this.matchMeta = m.meta;
        this.pendingStart = true;
        return;
      case "snap": {
        const snap: Snapshot = snapshotFromNet(m.snap);
        if (this.pendingStart || !this.inMatch) {
          if (!snap.full || !this.lobby || !this.matchMeta) return;
          this.pendingStart = false;
          this.inMatch = true;
          const meta: MatchMeta = {
            ...this.matchMeta,
            mode: "guest",
            side: sideFromLobby(this.lobby, this.you),
            owned: this.lobby.slots
              .filter((s) => s.peer === this.you && s.crew === "human")
              .map((s) => s.jetId),
            canScale: false,
            pausesLeft: MP_PAUSES,
          };
          this.post({ t: "match", meta, snap });
          return;
        }
        this.post({ t: "snap", snap });
        return;
      }
      case "pauses":
        this.post({ t: "meta", meta: { pausesLeft: m.left } });
        return;
      case "flash":
        this.post({ t: "flash", text: m.text });
        return;
      case "pong":
        if (m.n === this.pingN) this.rttMs = performance.now() - this.pingSentAt;
        return;
    }
  }
}

function nearest(choices: readonly number[], x: number): number {
  return choices.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a), choices[0] ?? x);
}

/** The side a player flies on (spectators watch from blue). */
export function sideFromLobby(lobby: LobbyState, peer: number): Side {
  return lobby.slots.find((s) => s.peer === peer && s.crew === "human")?.side ?? PLAYER_SIDE;
}
