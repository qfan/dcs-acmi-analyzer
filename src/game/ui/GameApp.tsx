import { useCallback, useEffect, useRef, useState } from "react";
import { toWorld, type View } from "../../map/render.ts";
import { saveLastFile } from "../../ui/lastFile.ts";
import { SiteFooter } from "../../ui/SiteFooter.tsx";
import { acmiFileName } from "../acmi.ts";
import type { NpcStatus } from "../ai/doctrine.ts";
import { DEFAULT_RELAY_URL, type LobbyAction, type LobbyState, type NetStatus } from "../engine/protocol.ts";
import { TIME_SCALES } from "../engine/session.ts";
import {
  altLimitsM,
  availableG,
  energyHeightM,
  type Jet,
  mach,
  type Side,
  specificExcessPower,
  type Throttle,
  verticalSpeed,
} from "../sim/aircraft.ts";
import { casFromTas, FT, KT, NM } from "../sim/atmosphere.ts";
import { missileMach } from "../sim/missile.ts";
import type { GameParams } from "../sim/params.ts";
import { DEFAULT_OPTIONS, SCENARIOS, type ScenarioOptions, scenarioById } from "../sim/scenarios.ts";
import { wrap2Pi } from "../sim/vec.ts";
import {
  awaitingCall,
  type Command,
  jetById,
  type Outcome,
  rwrContacts,
  type World,
  waitingOnMissiles,
} from "../sim/world.ts";
import { BGM_TRACKS, type BgmPlayer, createBgmPlayer } from "./bgm.ts";
import { drawScene, type Hit, sideCol } from "./draw.ts";
import { createEngineClient, type EngineClient } from "./engineClient.ts";
import { LobbyPanel, MultiplayerTab } from "./Lobby.tsx";
import { ParamEditor } from "./ParamEditor.tsx";
import { SinglePlayerTab, StartDialog, type StartTab } from "./StartDialog.tsx";
import { loadLast, loadMp, loadParams, saveLast, saveMp, saveParams } from "./storage.ts";
import { SessionView } from "./view.ts";

/** Crank keeps the threat just inside the 60° radar gimbal. */
const CRANK_DEG = 50;
const HUD_MS = 100;
/** Altitude order steps (ft): arrow keys / small buttons, Page keys / big buttons. */
const ALT_STEP_FT = 1000;
const ALT_BIG_STEP_FT = 5000;
/** Vertical speeds below this (ft/min) count as level in the readouts. */
const LEVEL_FPM = 300;

const fmtTime = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const deg = (r: number) => Math.round(((r * 180) / Math.PI + 360) % 360);
const fmtSigned = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x))}`;

/** The relay the game uses unless the player set their own: a local one while developing. */
function defaultRelayUrl(): string {
  const h = location.hostname;
  return h === "localhost" || h === "127.0.0.1" ? `ws://${h}:8787/ws` : DEFAULT_RELAY_URL;
}

/** A room code from an invite link (`#join=CODE`); the fragment never reaches any server. */
function inviteCode(): string | null {
  const m = /(?:^#|&)join=([A-Z2-9]{6})\b/i.exec(location.hash);
  return m?.[1] ? m[1].toUpperCase() : null;
}

/** Altitude readout subline: climbing/diving rate and where to, or level. */
function altSub(j: Jet): string {
  const fpm = (verticalSpeed(j) / FT) * 60;
  const to = `→ ${(Math.round(j.altCmd / FT / 100) * 100).toLocaleString()}`;
  if (Math.abs(fpm) < LEVEL_FPM) return Math.abs(j.altCmd - j.pos.z) < 100 * FT ? "level" : to;
  return `${fpm > 0 ? "↑" : "↓"}${(Math.abs(fpm) / 1000).toFixed(1)}k fpm ${to}`;
}

/** Result title and text from this viewer's side (the sim words its outcomes for blue). */
function result(o: Outcome, side: Side, mp: boolean): { title: string; text: string } {
  if (o.winner === null) return { title: OUTCOME_TITLE[o.kind], text: o.reason };
  const won = o.winner === side;
  if (!mp && side === "blue") return { title: won ? "Victory" : "Defeat", text: o.reason };
  return {
    title: won ? "Victory" : "Defeat",
    text: won ? "Every jet on the other side was destroyed." : "Your side was shot down.",
  };
}

export function GameApp() {
  const [params, setParams] = useState<GameParams>(loadParams);
  const last = loadLast();
  const [scenarioId, setScenarioId] = useState(
    last?.scenarioId && !scenarioById(last.scenarioId).mpOnly
      ? last.scenarioId
      : (SCENARIOS[0]?.id ?? "duel"),
  );
  const [altFt, setAltFt] = useState<number>(last?.altFt ?? 25000);
  const [options, setOptions] = useState<ScenarioOptions>(last?.options ?? DEFAULT_OPTIONS);
  const [session, setSession] = useState<SessionView | null>(null);
  const sessionRef = useRef<SessionView | null>(null);
  const [showStart, setShowStart] = useState(true);
  const [startTab, setStartTab] = useState<StartTab>(() => (inviteCode() ? "multi" : "single"));
  const [showParams, setShowParams] = useState(false);
  const [endSeen, setEndSeen] = useState(false);
  const [labels, setLabels] = useState(true);
  const [radarSectors, setRadarSectors] = useState(true);
  const [sideView, setSideView] = useState(true);
  const [follow, setFollow] = useState(true);
  /** Fog of war: off by default each time the page opens (single player). */
  const [fog, setFog] = useState(false);
  const fogRef = useRef(fog);
  fogRef.current = fog;
  const [flash, setFlash] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [bgmOn, setBgmOn] = useState(false);
  const bgmRef = useRef<BgmPlayer | null>(null);
  const [, setTick] = useState(0);

  // Multiplayer
  const mpSaved = loadMp();
  const [mpName, setMpName] = useState(mpSaved.name);
  const [relayUrl, setRelayUrl] = useState(mpSaved.relayUrl || defaultRelayUrl());
  const [joinCode, setJoinCode] = useState(() => inviteCode() ?? "");
  const [lobby, setLobby] = useState<LobbyState | null>(null);
  const [you, setYou] = useState(-1);
  const [net, setNet] = useState<NetStatus>("idle");
  const [netMsg, setNetMsg] = useState<string | null>(null);

  const engineRef = useRef<EngineClient | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<View>({ cx: 0, cy: 0, scale: 0.01, w: 800, h: 600 });
  const hitsRef = useRef<Hit[]>([]);
  const followRef = useRef(follow);
  followRef.current = follow;
  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const radarSectorsRef = useRef(radarSectors);
  radarSectorsRef.current = radarSectors;
  const sideViewRef = useRef(sideView);
  sideViewRef.current = sideView;

  const send = useCallback((m: Parameters<EngineClient["send"]>[0]) => engineRef.current?.send(m), []);

  /** Drops the fight on screen (the engine has already stopped or left it). */
  const clearView = useCallback(() => {
    sessionRef.current = null;
    setSession(null);
  }, []);

  useEffect(() => {
    const player = createBgmPlayer();
    bgmRef.current = player;
    return () => {
      player.dispose();
      bgmRef.current = null;
    };
  }, []);

  // The engine worker: the fight runs there; snapshots come back here.
  useEffect(() => {
    const engine = createEngineClient();
    engineRef.current = engine;
    const unsub = engine.subscribe((m) => {
      switch (m.t) {
        case "match": {
          const v = new SessionView(m.meta, m.snap, fogRef.current);
          // A room without forced fog: tell the host this player's own choice from the start.
          if (m.meta.mode !== "sp" && m.meta.roomFog === false && fogRef.current) engine.send({ t: "fog", on: true });
          sessionRef.current = v;
          setSession(v);
          setShowStart(false);
          setEndSeen(false);
          fitView(viewRef.current, v);
          return;
        }
        case "snap":
          sessionRef.current?.apply(m.snap);
          return;
        case "meta": {
          const v = sessionRef.current;
          if (v) v.meta = { ...v.meta, ...m.meta };
          setTick((t) => t + 1);
          return;
        }
        case "flash":
          setFlash(m.text);
          return;
        case "lobby":
          setLobby(m.lobby);
          setYou(m.you);
          if (m.lobby.phase === "lobby" && sessionRef.current?.multiplayer) {
            sessionRef.current = null;
            setSession(null);
            setStartTab("multi");
            setShowStart(true);
          }
          return;
        case "net":
          setNet(m.status);
          if (m.message !== undefined) setNetMsg(m.message);
          if (m.status === "connected") setNetMsg(null);
          if (m.status === "idle" || m.status === "closed") setLobby(null);
          return;
        case "ended":
          if (sessionRef.current?.multiplayer) {
            sessionRef.current = null;
            setSession(null);
          }
          setFlash(m.reason);
          setNetMsg(m.reason);
          setLobby(null);
          setStartTab("multi");
          setShowStart(true);
          return;
      }
    });
    const onVis = () => engine.send({ t: "visibility", hidden: document.hidden });
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      unsub();
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  // An invite link opened the page: keep the code, drop it from the address bar.
  useEffect(() => {
    if (inviteCode()) history.replaceState(null, "", location.pathname + location.search);
  }, []);

  const mp = !!session?.multiplayer;
  const isHost = session?.meta.mode === "host" || !!lobby?.players.find((p) => p.id === you)?.host;

  const toggleFog = (on: boolean) => {
    if (session?.meta.roomFog) return;
    setFog(on);
    fogRef.current = on;
    if (session) session.fog = on;
    send({ t: "fog", on });
    setTick((t) => t + 1);
  };

  const start = useCallback(
    (id = scenarioId, alt = altFt) => {
      if (lobby) {
        send({ t: "mp-leave" });
        setLobby(null);
      }
      send({
        t: "sp-start",
        scenarioId: id,
        altFt: alt,
        params,
        options,
        seed: Math.floor(Math.random() * 1e9),
        fog: fogRef.current,
      });
      saveLast(id, alt, options);
    },
    [scenarioId, altFt, params, options, lobby, send],
  );

  const issue = useCallback(
    (make: (j: Jet) => Command | null) => {
      if (!session) return;
      if (session.watch) {
        setFlash("Watch mode: the NPC flies blue. Start the scenario with Blue: You fly to give orders.");
        return;
      }
      for (const id of session.selected) {
        if (!session.ownsJet(id)) continue;
        const j = jetById(session.world, id);
        if (!j?.alive) continue;
        const c = make(j);
        if (c) send({ t: "cmd", cmd: c });
      }
    },
    [session, send],
  );

  /**
   * For defensive turns (Notch / Cold), an active missile on RWR is highest priority, else the
   * nearest known/guessed enemy. For offensive turns (Hot / Crank), steer against the targeted
   * enemy if known, else the nearest known/guessed enemy. Never tracks unseen bandits live.
   */
  const steerRel = useCallback(
    (offsetDeg: number, dir: 1 | -1, label: string, vsMissile = false) =>
      issue((j) => {
        if (!session) return null;
        const w = session.world;
        const missile = vsMissile ? nearestRwrMissile(w, j) : null;
        if (missile) {
          return {
            type: "steer",
            jetId: j.id,
            steer: { mode: "relative", threatId: missile, offsetDeg, dir, label: `${label} vs ${missile}` },
          };
        }
        const targetPos = !vsMissile && j.targetId ? session.knownEnemyPos(j.targetId) : null;
        const enemy =
          targetPos && j.targetId ? { id: j.targetId, pos: targetPos } : nearestKnownEnemy(session, j);
        if (!enemy) return null;
        if (session.sees(enemy.id)) {
          return {
            type: "steer",
            jetId: j.id,
            steer: { mode: "relative", threatId: enemy.id, offsetDeg, dir, label },
          };
        }
        const brg = Math.atan2(enemy.pos.x - j.pos.x, enemy.pos.y - j.pos.y);
        return {
          type: "steer",
          jetId: j.id,
          steer: { mode: "heading", hdg: wrap2Pi(brg + (dir * offsetDeg * Math.PI) / 180) },
        };
      }),
    [issue, session],
  );

  /** Climbs or dives every selected jet by `deltaFt` from its current altitude order, snapped to the step. */
  const stepAlt = useCallback(
    (deltaFt: number) =>
      issue((j) => {
        const snap = Math.abs(deltaFt) >= ALT_BIG_STEP_FT ? ALT_BIG_STEP_FT : ALT_STEP_FT;
        const ft = Math.round((j.altCmd / FT + deltaFt) / snap) * snap;
        return { type: "altitude", jetId: j.id, altM: ft * FT };
      }),
    [issue],
  );

  /** Levels off: holds the altitude each selected jet is at now (rounded to 500 ft). */
  const levelOff = useCallback(
    () => issue((j) => ({ type: "altitude", jetId: j.id, altM: Math.round(j.pos.z / FT / 500) * 500 * FT })),
    [issue],
  );

  /**
   * Saves the fight so far as an .acmi file: download it, open it in this site's viewer, or both.
   * "Open in viewer" stores it as the viewer's last file (IndexedDB, this browser only) and opens
   * the viewer in a new tab, which picks it up and keeps it across refreshes.
   */
  const exportFight = useCallback(
    async (mode: ExportMode) => {
      setShowExport(false);
      if (!session?.recorder) return;
      const name = acmiFileName(session.scenarioId, session.altFt, session.startedAt);
      const blob = new Blob([session.recorder.text()], { type: "text/plain" });
      if (mode !== "viewer") downloadBlob(blob, name);
      if (mode === "download") return;
      // Open the tab now, while the click still counts as a user action (pop-up blockers).
      const tab = window.open("", "_blank");
      const stored = await saveLastFile(blob, name, "game");
      if (!stored) {
        tab?.close();
        setFlash("This browser would not store the recording (storage blocked?). Use Download instead.");
        return;
      }
      if (tab) tab.location.href = "./index.html";
      else setFlash("Pop-up blocked. Open the ACMI viewer page: it will show this fight.");
    },
    [session],
  );

  const togglePause = useCallback(() => {
    if (!session) return;
    send({ t: session.paused ? "play" : "pause" });
  }, [session, send]);

  const setScale = useCallback(
    (k: number) => {
      if (!session?.meta.canScale) return;
      send({ t: "scale", k });
    },
    [session, send],
  );

  const lobbyAction = useCallback((a: LobbyAction) => send({ t: "lobby", action: a }), [send]);

  const hostGame = () => {
    saveMp(mpName.trim(), relayUrl === defaultRelayUrl() ? "" : relayUrl);
    setNetMsg(null);
    clearView();
    send({ t: "mp-host", relayUrl, name: mpName.trim(), params });
  };
  const joinGame = () => {
    saveMp(mpName.trim(), relayUrl === defaultRelayUrl() ? "" : relayUrl);
    setNetMsg(null);
    clearView();
    send({ t: "mp-join", relayUrl, room: joinCode, name: mpName.trim() });
  };
  const leaveRoom = () => {
    send({ t: "mp-leave" });
    setLobby(null);
    if (sessionRef.current?.multiplayer) clearView();
  };

  // Main loop: refresh the launch zone and draw. The fight itself runs in the engine worker.
  useEffect(() => {
    if (!session) {
      // No fight on screen: don't leave the last frame of the previous one behind the dialogs.
      const c = canvasRef.current;
      c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
      return;
    }
    let raf = 0;
    let lastHud = 0;
    const frame = (now: number) => {
      session.refreshZone(now);
      const c = canvasRef.current;
      if (c) {
        const ctx = c.getContext("2d");
        const v = viewRef.current;
        const dpr = window.devicePixelRatio || 1;
        const w = c.clientWidth;
        const h = c.clientHeight;
        if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
          c.width = Math.round(w * dpr);
          c.height = Math.round(h * dpr);
        }
        v.w = w;
        v.h = h;
        if (followRef.current) centerOnFight(v, session);
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          hitsRef.current = drawScene(
            ctx,
            v,
            session,
            labelsRef.current,
            radarSectorsRef.current,
            sideViewRef.current,
          );
        }
      }
      if (now - lastHud > HUD_MS) {
        lastHud = now;
        setTick((t) => t + 1);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [session]);

  // Keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (showParams || showStart) {
        if (e.key === "Escape") {
          setShowParams(false);
          if (session) setShowStart(false);
        }
        return;
      }
      if (e.target instanceof Element && e.target.closest("input, select, textarea")) return;
      const k = e.key.toLowerCase();
      if (k === " ") togglePause();
      else if (k >= "1" && k <= "5") setScale(TIME_SCALES[Number(k) - 1] ?? 1);
      else if (k === "f") issue((j) => ({ type: "fire", jetId: j.id }));
      else if (k === "h") steerRel(0, 1, "hot");
      else if (k === "q") steerRel(CRANK_DEG, -1, "crank left");
      else if (k === "e") steerRel(CRANK_DEG, 1, "crank right");
      else if (k === "a") steerRel(90, -1, "notch left", true);
      else if (k === "d") steerRel(90, 1, "notch right", true);
      else if (k === "c") steerRel(180, 1, "cold", true);
      else if (k === "insert") issue((j) => ({ type: "chaff", jetId: j.id }));
      else if (k === "delete") issue((j) => ({ type: "flare", jetId: j.id }));
      else if (k === "t")
        issue((j) => ({
          type: "throttle",
          jetId: j.id,
          throttle: ({ idle: "mil", mil: "ab", ab: "idle" } as const)[j.throttle],
        }));
      else if (k === "g")
        issue((j) => ({
          type: "effort",
          jetId: j.id,
          effort: ({ sustain: "normal", normal: "max", max: "sustain" } as const)[j.effort],
        }));
      else if (k === "arrowleft" || k === "arrowright")
        issue((j) => ({
          type: "steer",
          jetId: j.id,
          steer: {
            mode: "heading",
            hdg: wrap2Pi(
              (j.steer.mode === "heading" ? j.steer.hdg : j.hdg) +
                ((k === "arrowleft" ? -10 : 10) * Math.PI) / 180,
            ),
          },
        }));
      else if (k === "arrowup" || k === "arrowdown")
        stepAlt((k === "arrowup" ? 1 : -1) * (e.shiftKey ? ALT_BIG_STEP_FT : ALT_STEP_FT));
      else if (k === "pageup" || k === "pagedown") stepAlt((k === "pageup" ? 1 : -1) * ALT_BIG_STEP_FT);
      else if (k === "l") levelOff();
      else if (k === "v") setFollow(true);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [issue, steerRel, stepAlt, levelOff, togglePause, setScale, showParams, showStart, session]);

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 3500);
    return () => clearTimeout(id);
  }, [flash]);

  useEffect(() => {
    if (!showExport) return;
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && !exportMenuRef.current?.contains(e.target)) setShowExport(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowExport(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [showExport]);

  // Mouse: left click selects / designates, left drag pans, right click sets heading, wheel zooms.
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const pickAt = (sx: number, sy: number): string | null => {
    let best: string | null = null;
    let bd = 16;
    for (const h of hitsRef.current) {
      const d = Math.hypot(h.sx - sx, h.sy - sy);
      if (d < bd) {
        bd = d;
        best = h.id;
      }
    }
    return best;
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current?.getBoundingClientRect();
    return r ? [e.clientX - r.left, e.clientY - r.top] : [0, 0];
  };
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    setFollow(false);
    const v = viewRef.current;
    v.cx -= dx / v.scale;
    v.cy += dy / v.scale;
    d.x = e.clientX;
    d.y = e.clientY;
  };
  const onMouseUp = (e: React.MouseEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved || !session || e.button !== 0) return;
    const [sx, sy] = local(e);
    const id = pickAt(sx ?? 0, sy ?? 0);
    const j = jetById(session.world, id);
    if (!j) return;
    if (session.ownsJet(j.id) || session.watch) {
      if (!e.shiftKey || session.watch) session.selected.clear();
      if (e.shiftKey && !session.watch && session.selected.has(j.id)) session.selected.delete(j.id);
      else session.selected.add(j.id);
      setTick((t) => t + 1);
    } else if (j.alive && j.side !== session.side)
      issue((mine) => ({ type: "target", jetId: mine.id, targetId: j.id }));
  };
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!session || session.watch) return;
    const [sx, sy] = local(e);
    const [wx, wy] = toWorld(viewRef.current, sx ?? 0, sy ?? 0);
    issue((j) => ({
      type: "steer",
      jetId: j.id,
      steer: { mode: "heading", hdg: Math.atan2(wx - j.pos.x, wy - j.pos.y) },
    }));
  };
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const [wx, wy] = toWorld(v, sx, sy);
      const k = Math.exp(-e.deltaY * 0.0015);
      v.scale = Math.max(2e-4, Math.min(0.2, v.scale * k));
      if (!followRef.current) {
        const [wx2, wy2] = toWorld(v, sx, sy);
        v.cx += wx - wx2;
        v.cy += wy - wy2;
      }
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  }, []);

  const w = session?.world;
  const p = session?.primary();
  const tgt = p ? jetById(w ?? null, p.targetId) : undefined;
  const pAi = session && p ? (session.npc[p.id]?.status ?? null) : null;
  const npcControlled = !!session?.watch || pAi !== null || (!!p && !!session && !session.ownsJet(p.id));
  const watchJets = session?.watch && w ? w.jets.filter((j) => j.alive && session.sees(j.id)) : [];
  const ended = !!w?.outcome;
  const scenario = scenarioById(session?.scenarioId ?? scenarioId);
  const roomFog = session?.meta.roomFog === true;
  const fogOn = session ? session.fog : fog;
  const inviteUrl = lobby ? `${location.origin}${location.pathname}#join=${lobby.room}` : "";
  const res = w?.outcome && session ? result(w.outcome, session.side, mp) : null;

  return (
    <div className="g-app">
      <header className="g-top">
        <strong className="g-title">BVR Trainer</strong>
        <span className="g-muted g-hide-narrow">
          {scenario.title} · {(session?.altFt ?? altFt).toLocaleString()} ft
        </span>
        {session?.watch && <span className="g-watch-badge">NPC vs NPC · Watch</span>}
        {mp && lobby && (
          <span className={`g-net g-net-${net}`} title={`Relay: ${net}`}>
            ● Room {lobby.room}
          </span>
        )}
        <span className="g-grow" />
        {session && (
          <>
            <span className="g-clock">{fmtTime(w?.t ?? 0)}</span>
            <button
              type="button"
              className="g-primary g-play"
              onClick={togglePause}
              disabled={ended || (mp && !session.paused && session.meta.pausesLeft === 0)}
              title={
                mp
                  ? session.paused
                    ? "Space: resume (in turn mode, says you are ready)"
                    : `Space: pause (${session.meta.pausesLeft ?? 0} left)`
                  : "Space"
              }
            >
              {session.paused ? "▶ Play" : "❚❚ Pause"}
              {mp && !session.paused ? ` (${session.meta.pausesLeft ?? 0})` : ""}
            </button>
            {session.meta.canScale && (
              <div className="g-seg" title="Time compression">
                {TIME_SCALES.map((k, i) => (
                  <button
                    type="button"
                    key={k}
                    className={session.timeScale === k ? "on" : ""}
                    onClick={(e) => {
                      setScale(k);
                      e.currentTarget.blur();
                    }}
                    title={`Key ${i + 1}`}
                  >
                    {k}×
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        <button
          type="button"
          className={`g-bgm ${bgmOn ? "on" : ""}`}
          aria-pressed={bgmOn}
          aria-label={bgmOn ? "Disable background music" : "Enable background music"}
          disabled={!BGM_TRACKS.length}
          onClick={(e) => {
            const next = !bgmOn;
            setBgmOn(next);
            bgmRef.current?.setEnabled(next);
            e.currentTarget.blur(); // keep Space and the game keys working
          }}
          title={
            BGM_TRACKS.length
              ? bgmOn
                ? "Background music: ON (click to disable)"
                : "Background music: OFF (click to enable)"
              : "No background music tracks available"
          }
        >
          ♫
        </button>
        <button
          type="button"
          className={`g-fog ${fogOn ? "on" : ""}`}
          aria-pressed={fogOn}
          disabled={roomFog}
          onClick={(e) => {
            toggleFog(!fogOn);
            e.currentTarget.blur(); // keep Space and the game keys working
          }}
          title={
            roomFog
              ? "The room has fog of war on for everyone"
              : "Fog of war: show only what your radar and RWR tell you"
          }
        >
          {fogOn ? "◐ Fog of war: ON" : "○ Fog of war: OFF"}
          {roomFog ? " 🔒" : ""}
        </button>
        <button type="button" onClick={() => setShowStart(true)}>
          New game
        </button>
        {!mp && (
          <button
            type="button"
            onClick={() => session && start(session.scenarioId, session.altFt)}
            disabled={!session}
          >
            Restart
          </button>
        )}
        {mp && isHost && lobby?.phase === "playing" && (
          <button
            type="button"
            onClick={() => lobbyAction({ a: "to-lobby" })}
            title="End the match for everyone"
          >
            End match
          </button>
        )}
        <button type="button" onClick={() => setShowParams(true)} disabled={mp}>
          Parameters
        </button>
        <div className="g-menu" ref={exportMenuRef}>
          <button
            type="button"
            disabled={!session?.recorder}
            aria-haspopup="menu"
            aria-expanded={showExport}
            onClick={() => setShowExport((v) => !v)}
            title={
              session && !session.recorder
                ? "ACMI recording is disabled in infinite demo mode"
                : "Save this fight as a Tacview .acmi recording (works mid-fight too)"
            }
          >
            Export .acmi ▾
          </button>
          {showExport && session?.recorder && (
            <div className="g-menu-list" role="menu">
              <ExportButtons onExport={exportFight} />
            </div>
          )}
        </div>
        <a className="g-link g-hide-narrow" href="./index.html">
          ACMI viewer
        </a>
      </header>

      <div className="g-body">
        <div className="g-stage">
          <canvas
            ref={canvasRef}
            className="g-canvas"
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={() => {
              drag.current = null;
            }}
            onContextMenu={onContextMenu}
          />
          {session?.paused && session.pauseReason && !ended && (
            <div className="g-banner">
              <span>⏸ {session.pauseReason}</span>
            </div>
          )}
          {w && session && awaitingCall(w) && !session.paused && (
            <div className="g-banner g-banner-wait">
              <span>{waitBanner(w, session.fog, session.side)}</span>
            </div>
          )}
          {mp && net === "reconnecting" && (
            <div className="g-banner g-banner-wait">
              <span>Connection to the relay lost: reconnecting…</span>
            </div>
          )}
          {flash && <div className="g-flash">{flash}</div>}
          <div className="g-stage-tools">
            <label>
              <input
                type="checkbox"
                checked={follow}
                onChange={(e) => {
                  setFollow(e.target.checked);
                  e.target.blur();
                }}
              />{" "}
              Follow fight
            </label>
            <label>
              <input
                type="checkbox"
                checked={labels}
                onChange={(e) => {
                  setLabels(e.target.checked);
                  e.target.blur();
                }}
              />{" "}
              Labels
            </label>
            <label>
              <input
                type="checkbox"
                checked={radarSectors}
                onChange={(e) => {
                  setRadarSectors(e.target.checked);
                  e.target.blur();
                }}
              />{" "}
              Radar sectors
            </label>
            <label>
              <input
                type="checkbox"
                checked={sideView}
                onChange={(e) => {
                  setSideView(e.target.checked);
                  e.target.blur();
                }}
              />{" "}
              Side view
            </label>
          </div>
        </div>

        <aside className="g-side">
          {mp && lobby && <PlayersCard lobby={lobby} you={you} />}
          {session?.watch && watchJets.length > 0 && (
            <section className="g-card g-watch-bar" aria-label="Inspect AI jet">
              <div className="g-watch-head">
                <span className="g-muted">Inspect AI</span>
                <span className="g-watch-mode">No player control</span>
              </div>
              <div className="g-watch-jets">
                {watchJets.map((j) => {
                  const st = session.npc[j.id]?.status;
                  const active = session.selected.has(j.id);
                  return (
                    <button
                      type="button"
                      key={j.id}
                      className={`g-watch-jet ${active ? "on" : ""}`}
                      onClick={() => {
                        session.selected.clear();
                        session.selected.add(j.id);
                        setTick((t) => t + 1);
                      }}
                    >
                      <span className="g-watch-dot" style={{ background: sideCol(j.side) }} />
                      <span>{j.callsign}</span>
                      {st && <span className={`g-ai-pill g-ai-pill-${st.state}`}>{st.state}</span>}
                    </button>
                  );
                })}
              </div>
            </section>
          )}
          {session && p && w && (
            <section className="g-card">
              <h3 style={{ color: sideCol(p.side) }}>{p.callsign}</h3>
              <div className="g-stats">
                <Stat
                  k="Speed"
                  v={`M${mach(p).toFixed(2)}`}
                  sub={`${Math.round(casFromTas(p.speed, p.pos.z) / KT)} KCAS · ${Math.round(p.speed / KT)} TAS`}
                />
                <Stat k="Altitude" v={`${Math.round(p.pos.z / FT).toLocaleString()} ft`} sub={altSub(p)} />
                <Stat
                  k="Energy"
                  v={`${(Math.round(energyHeightM(p) / FT / 100) * 100).toLocaleString()} ft`}
                  sub={`Ps ${fmtSigned(specificExcessPower(w.params.aircraft, p, p.g) / FT)} ft/s`}
                />
                <Stat
                  k="Load"
                  v={`${p.g.toFixed(1)} g`}
                  sub={`max ${availableG(w.params.aircraft, p, p.effort).toFixed(1)}`}
                />
                <Stat
                  k="Heading"
                  v={`${String(deg(p.hdg)).padStart(3, "0")}°`}
                  sub={session.npc[p.id]?.line ?? (p.steer.mode === "relative" ? p.steer.label : "heading")}
                />
                <Stat k="Missiles" v={`${p.missiles}`} sub={`chaff ${p.chaff} · flare ${p.flares}`} />
                <Stat
                  k="Radar"
                  v={tgt?.alive ? (w.radarTrack.get(p.id) ? "TRACK" : "no track") : "—"}
                  sub={tgt?.alive ? tgt.callsign : "no target"}
                />
              </div>
              <RwrLine world={w} jet={p} />
              {npcControlled ? (
                <NpcBehaviorPanel session={session} jet={p} ai={pAi} tgt={tgt} params={w.params} />
              ) : (
                <>
                  <div className="g-row g-ctl">
                    <span className="g-label">Throttle</span>
                    <div className="g-seg">
                      {(["idle", "mil", "ab"] as Throttle[]).map((t) => (
                        <button
                          type="button"
                          key={t}
                          className={p.throttle === t ? "on" : ""}
                          onClick={(e) => {
                            issue((j) => ({ type: "throttle", jetId: j.id, throttle: t }));
                            e.currentTarget.blur();
                          }}
                        >
                          {t.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="g-row g-ctl">
                    <span className="g-label">Turns</span>
                    <div className="g-seg">
                      {(["sustain", "normal", "max"] as const).map((t) => (
                        <button
                          type="button"
                          key={t}
                          className={p.effort === t ? "on" : ""}
                          title={
                            t === "sustain"
                              ? "Hold Mach (zero energy bleed when thrust allows); climbs on spare power only"
                              : undefined
                          }
                          onClick={(e) => {
                            issue((j) => ({ type: "effort", jetId: j.id, effort: t }));
                            e.currentTarget.blur();
                          }}
                        >
                          {t === "sustain"
                            ? "Hold Spd"
                            : t === "normal"
                              ? `Normal ${w.params.aircraft.normalG} g`
                              : `Max ${w.params.aircraft.gLimit} g`}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="g-row g-ctl">
                    <span className="g-label">Altitude</span>
                    <div className="g-seg g-alt">
                      <button
                        type="button"
                        title="Page Down (Shift+↓)"
                        disabled={p.altCmd <= altLimitsM(w.params.aircraft).min + 1}
                        onClick={(e) => {
                          stepAlt(-ALT_BIG_STEP_FT);
                          e.currentTarget.blur();
                        }}
                      >
                        ⏬
                      </button>
                      <button
                        type="button"
                        title="↓"
                        disabled={p.altCmd <= altLimitsM(w.params.aircraft).min + 1}
                        onClick={(e) => {
                          stepAlt(-ALT_STEP_FT);
                          e.currentTarget.blur();
                        }}
                      >
                        ▼
                      </button>
                      <button
                        type="button"
                        className="g-alt-cmd"
                        title="Ordered altitude. Click (or L) to level off where you are."
                        onClick={(e) => {
                          levelOff();
                          e.currentTarget.blur();
                        }}
                      >
                        {Math.round(p.altCmd / FT).toLocaleString()} ft
                      </button>
                      <button
                        type="button"
                        title="↑"
                        disabled={p.altCmd >= altLimitsM(w.params.aircraft).max - 1}
                        onClick={(e) => {
                          stepAlt(ALT_STEP_FT);
                          e.currentTarget.blur();
                        }}
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        title="Page Up (Shift+↑)"
                        disabled={p.altCmd >= altLimitsM(w.params.aircraft).max - 1}
                        onClick={(e) => {
                          stepAlt(ALT_BIG_STEP_FT);
                          e.currentTarget.blur();
                        }}
                      >
                        ⏫
                      </button>
                    </div>
                  </div>
                  <div className="g-maneuvers">
                    <button type="button" onClick={() => steerRel(CRANK_DEG, -1, "crank left")} title="Q">
                      ↖ Crank L
                    </button>
                    <button type="button" onClick={() => steerRel(0, 1, "hot")} title="H">
                      ↑ Hot
                    </button>
                    <button type="button" onClick={() => steerRel(CRANK_DEG, 1, "crank right")} title="E">
                      Crank R ↗
                    </button>
                    <button type="button" onClick={() => steerRel(90, -1, "notch left", true)} title="A">
                      ← Notch L
                    </button>
                    <button type="button" onClick={() => steerRel(180, 1, "cold", true)} title="C">
                      ↓ Cold
                    </button>
                    <button type="button" onClick={() => steerRel(90, 1, "notch right", true)} title="D">
                      Notch R →
                    </button>
                    <button
                      type="button"
                      onClick={() => issue((j) => ({ type: "chaff", jetId: j.id }))}
                      title="Insert (visual only for now)"
                    >
                      Chaff ({p.chaff})
                    </button>
                    <span />
                    <button
                      type="button"
                      onClick={() => issue((j) => ({ type: "flare", jetId: j.id }))}
                      title="Delete (visual only for now)"
                    >
                      Flare ({p.flares})
                    </button>
                  </div>
                  <ZoneBox session={session} />
                  <button
                    type="button"
                    className="g-fire"
                    disabled={!tgt?.alive || p.missiles <= 0}
                    onClick={() => issue((j) => ({ type: "fire", jetId: j.id }))}
                    title="F"
                  >
                    FOX 3 {tgt?.alive ? `→ ${tgt.callsign}` : ""}
                  </button>
                </>
              )}
            </section>
          )}

          {w && (
            <section className="g-card">
              <h3>Missiles</h3>
              {session && (!session.watch || session.fog) && <OwnMissileTimers session={session} />}
              {!session?.fog && w.missiles.some((m) => !m.end) && (
                <p className="g-muted g-truth">Truth (hidden with fog of war on):</p>
              )}
              {session?.fog && <p className="g-muted">Hostile missiles show only on your RWR once active.</p>}
              <table className="g-table">
                <tbody>
                  {w.missiles
                    .filter((m) => !m.end && !session?.fog)
                    .map((m) => {
                      const t = jetById(w, m.targetId);
                      const r = t
                        ? Math.hypot(t.pos.x - m.pos.x, t.pos.y - m.pos.y, t.pos.z - m.pos.z) / NM
                        : 0;
                      return (
                        <tr key={m.id}>
                          <td style={{ color: sideCol(m.side) }}>{m.id}</td>
                          <td>→ {t?.callsign}</td>
                          <td>
                            <span className={`g-phase g-phase-${m.phase}`}>{PHASE_LABEL[m.phase]}</span>
                          </td>
                          <td>M{missileMach(m).toFixed(1)}</td>
                          <td>{r.toFixed(1)} nm</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </section>
          )}

          {w && (
            <section className="g-card">
              <h3>Events</h3>
              <ol className="g-log">
                {w.events
                  .map((e, i) => ({ e, seq: w.eventOffset + i }))
                  .filter(
                    ({ e }) =>
                      e.type !== "radar-gained" &&
                      e.type !== "radar-lost" &&
                      e.type !== "chaff" &&
                      e.type !== "flare" &&
                      (!session || session.showsEvent(e)),
                  )
                  .slice(-14)
                  .reverse()
                  .map(({ e, seq }) => (
                    <li key={seq}>
                      <span className="g-muted">{fmtTime(e.t)}</span>{" "}
                      <span style={{ color: sideCol(e.side) }}>{e.text}</span>
                    </li>
                  ))}
              </ol>
            </section>
          )}

          <section className="g-card g-help">
            <h3>{session?.watch ? "Watch Controls" : "Controls"}</h3>
            {session?.watch ? (
              <>
                <p>
                  <b>Click</b> any visible jet to inspect its AI · <b>drag</b> to pan · <b>wheel</b> to zoom
                </p>
                <p>
                  <kbd>Space</kbd> pause · <kbd>1</kbd>–<kbd>5</kbd> 1×–16× · <kbd>V</kbd> follow
                </p>
              </>
            ) : (
              <>
                <p>
                  <b>Click</b> your jet to select (Shift adds) · <b>click</b> a bandit to target it ·{" "}
                  <b>right-click</b> map to set heading · <b>drag</b> to pan · <b>wheel</b> to zoom
                </p>
                <p>
                  <kbd>Space</kbd> pause · <kbd>1</kbd>–<kbd>5</kbd> 1×–16× · <kbd>F</kbd> fire · <kbd>H</kbd>{" "}
                  hot · <kbd>Q</kbd>/<kbd>E</kbd> crank · <kbd>A</kbd>/<kbd>D</kbd> notch · <kbd>C</kbd> cold
                  · <kbd>←</kbd>/<kbd>→</kbd> heading ±10° · <kbd>↑</kbd>/<kbd>↓</kbd> altitude ±1,000 ft (
                  <kbd>Shift</kbd> or <kbd>PgUp</kbd>/<kbd>PgDn</kbd> ±5,000) · <kbd>L</kbd> level off ·{" "}
                  <kbd>T</kbd> throttle · <kbd>G</kbd> turn mode · <kbd>Insert</kbd> chaff · <kbd>Delete</kbd>{" "}
                  flare · <kbd>V</kbd> follow
                </p>
              </>
            )}
            <p className="g-muted">
              Energy: a climb trades speed for height and a dive buys it back (Energy shows height plus speed
              as feet; Ps is how fast it grows). The turn mode also sets how steeply you climb: Hold Spd holds
              Mach and climbs only as fast as thrust allows, Normal up to{" "}
              {w?.params.aircraft.normalClimbDeg ?? 20}°, Max up to {w?.params.aircraft.maxClimbDeg ?? 45}°.
              Missiles fly much further from high and fast, and die quickly chasing you down into thick air.
              Hard deck {(w?.params.aircraft.minAltFt ?? 1000).toLocaleString()} ft.
            </p>
            <p className="g-muted">
              Map: radar wedges are ±{w?.params.radar.gimbalDeg ?? 60}°. Shaded out to{" "}
              {w?.params.radar.rangeNm ?? 70} nm is TWS lock range (fire and datalink); the dashed band out to{" "}
              {w?.params.radar.detectRangeNm ?? 80} nm only detects. A dotted line from a missile means
              datalink; dashed with × is where a missile <i>thinks</i> the target is.
            </p>
            <p className="g-muted">
              Fog of war hides enemy jets your radars do not detect (a dashed outline marks where they were
              last seen), and always hides enemy missiles and launches: missiles do not show on radar, only on
              your RWR once their seekers go active.
            </p>
            <p className="g-muted">
              RWR ring around your jets: amber tick = an enemy radar is scanning you (datalink support looks
              the same, so there is no launch warning); red <b>M</b> = an active missile seeker sees you,
              blinking when it is locked on. Notch and Cold fly against that missile. Chaff and flares are
              visual only for now.
            </p>
          </section>

          <SiteFooter product="game" className="g-footer" />
        </aside>
      </div>

      {showStart && (
        <StartDialog
          tab={startTab}
          onTab={setStartTab}
          onClose={session || lobby ? () => setShowStart(false) : null}
          single={
            <SinglePlayerTab
              scenarioId={scenarioId}
              onScenario={(id) => {
                setScenarioId(id);
                if (scenarioById(id).allNpc && options.blueAi === null) {
                  setOptions((o) => ({ ...o, blueAi: o.redSkill }));
                }
              }}
              altFt={altFt}
              onAlt={setAltFt}
              missiles={params.aircraft.missiles}
              onMissiles={(n) => {
                const np: GameParams = { ...params, aircraft: { ...params.aircraft, missiles: n } };
                setParams(np);
                saveParams(np);
              }}
              options={options}
              onOptions={setOptions}
              fog={fog}
              onFog={(on) => {
                setFog(on);
                fogRef.current = on;
              }}
              onStart={() => start()}
            />
          }
          multi={
            lobby ? (
              <LobbyPanel
                lobby={lobby}
                you={you}
                status={net}
                onAction={lobbyAction}
                onLeave={leaveRoom}
                inviteUrl={inviteUrl}
              />
            ) : (
              <MultiplayerTab
                name={mpName}
                onName={setMpName}
                code={joinCode}
                onCode={setJoinCode}
                relayUrl={relayUrl}
                onRelayUrl={setRelayUrl}
                status={net}
                statusMessage={netMsg}
                onHost={hostGame}
                onJoin={joinGame}
              />
            )
          }
        />
      )}
      {showParams && (
        <ParamEditor
          params={params}
          onClose={() => setShowParams(false)}
          onSave={(np) => {
            if (!np) return;
            setParams(np);
            saveParams(np);
            setShowParams(false);
            setFlash("Parameters saved. They apply from the next start or restart.");
          }}
        />
      )}
      {ended && !endSeen && res && !showStart && (
        <div className="g-modal-back">
          <div className="g-modal g-end-dialog" role="dialog" aria-label="Result">
            <h2>{res.title}</h2>
            <p>{res.text}</p>
            <p className="g-muted">Fight time {fmtTime(w?.t ?? 0)}.</p>
            <div className="g-row">
              <span className="g-label">Recording</span>
              <ExportButtons onExport={exportFight} />
            </div>
            <div className="g-row g-end">
              <button type="button" onClick={() => setEndSeen(true)}>
                Look at the map
              </button>
              {mp ? (
                isHost ? (
                  <button type="button" className="g-primary" onClick={() => lobbyAction({ a: "to-lobby" })}>
                    Back to lobby
                  </button>
                ) : (
                  <>
                    <button type="button" onClick={leaveRoom}>
                      Leave room
                    </button>
                    <span className="g-muted">The host takes everyone back to the lobby.</span>
                  </>
                )
              ) : (
                <>
                  <button type="button" onClick={() => setShowStart(true)}>
                    New game
                  </button>
                  <button
                    type="button"
                    className="g-primary"
                    onClick={() => session && start(session.scenarioId, session.altFt)}
                  >
                    Restart
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Multiplayer side-panel card: who is in the room, on which side, and how their connection is. */
function PlayersCard({ lobby, you }: { lobby: LobbyState; you: number }) {
  return (
    <section className="g-card g-players">
      <h3>Players · room {lobby.room}</h3>
      <ul>
        {lobby.players.map((pl) => {
          const slots = lobby.slots.filter((s) => s.peer === pl.id);
          const side = slots[0]?.side;
          return (
            <li key={pl.id}>
              <span className="g-watch-dot" style={{ background: side ? sideCol(side) : "var(--g-muted)" }} />
              <span>
                {pl.name}
                {pl.id === you ? " (you)" : ""}
                {pl.host ? " · host" : ""}
              </span>
              <span className="g-grow" />
              <span className="g-muted">
                {slots.map((s) => s.callsign).join(", ") || "watching"}
                {pl.away ? " · reconnecting" : pl.rttMs !== null && !pl.host ? ` · ${pl.rttMs} ms` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Banner while a fight is waiting to be called. With fog of war it says the same thing whether or
 * not a missile is still coming, and the call itself comes after a random 5–10 s, so neither the
 * text nor the timing tells you what your RWR cannot.
 */
function waitBanner(w: World, fog: boolean, side: Side): string {
  const meAlive = w.jets.some((j) => j.side === side && j.alive);
  if (fog)
    return meAlive
      ? "All known hostiles down. Stay defensive until the fight is called."
      : "You are down. Waiting for the fight to be called.";
  if (waitingOnMissiles(w))
    return meAlive
      ? "All hostiles down, but missiles are still in the air: keep defending."
      : "You are down. Your missiles in the air can still score a trade.";
  return "No missile can still kill anyone. Calling the fight…";
}

type ExportMode = "download" | "viewer" | "both";

function ExportButtons({ onExport }: { onExport: (mode: ExportMode) => void }) {
  return (
    <div className="g-seg">
      <button type="button" onClick={() => onExport("download")} title="Save the .acmi file to your computer">
        Download
      </button>
      <button
        type="button"
        onClick={() => onExport("viewer")}
        title="Open it in this site's ACMI viewer (new tab)"
      >
        Open in viewer
      </button>
      <button type="button" onClick={() => onExport("both")}>
        Both
      </button>
    </div>
  );
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const OUTCOME_TITLE = { win: "Victory", loss: "Defeat", trade: "Trade", draw: "Draw" } as const;

const PHASE_LABEL = {
  datalink: "datalink",
  inertial: "no datalink",
  search: "active, searching",
  tracking: "tracking",
  lost: "lost",
};

function Stat({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="g-stat">
      <span className="g-muted">{k}</span>
      <b>{v}</b>
      {sub && <span className="g-muted">{sub}</span>}
    </div>
  );
}

function ZoneBox({ session }: { session: SessionView }) {
  const z = session.zone?.zone;
  if (!z) return <div className="g-zone g-muted">Target a bandit to see the launch zone.</div>;
  const inMax = z.rangeNm <= z.rmaxNm;
  const inNe = z.rangeNm <= z.rneNm;
  return (
    <div className="g-zone">
      <div>
        Range <b>{z.rangeNm.toFixed(1)}</b> nm · <span className="g-rmax">Rmax {z.rmaxNm.toFixed(1)}</span> ·{" "}
        <span className="g-rne">Rne {z.rneNm.toFixed(1)}</span>
      </div>
      <div className={inNe ? "g-rne" : inMax ? "g-rmax" : "g-muted"}>
        {inNe
          ? "Inside no-escape range: it cannot outrun a shot now."
          : inMax
            ? "In range if it holds course; it can still turn cold and escape."
            : "Out of range."}
        {z.now.hit && ` Shot now: ~${Math.round(z.now.tofS)} s, arriving M${z.now.arrivalMach.toFixed(1)}.`}
      </div>
    </div>
  );
}

/** Nearest active missile on this jet's RWR (locked ones first), or null. */
function nearestRwrMissile(w: World, j: Jet): string | null {
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const c of rwrContacts(w, j)) {
    if (c.kind !== "missile") continue;
    const m = w.missiles.find((x) => x.id === c.sourceId);
    if (!m) continue;
    const d = Math.hypot(m.pos.x - j.pos.x, m.pos.y - j.pos.y) - (c.lock ? 1e7 : 0);
    if (d < bestScore) {
      bestScore = d;
      best = m.id;
    }
  }
  return best;
}

/**
 * Your missiles as the cockpit shows them: onboard estimates only. A bar from launch to predicted
 * impact, a tick at predicted pitbull, and a triangle for "now", with time to pitbull (TTP) and
 * time to impact (TTI). Nothing here reads the real missile.
 */
function OwnMissileTimers({ session }: { session: SessionView }) {
  const t = session.world.t;
  const timers = session.activeTimers();
  if (timers.length === 0) return <p className="g-muted">None of yours in flight.</p>;
  return (
    <div className="g-timers">
      {timers.map((tm) => {
        const end = tm.impactAt ?? tm.firstImpactAt;
        const span = Math.max(1, (end ?? tm.launchT + 60) - tm.launchT);
        const frac = (x: number) => `${Math.max(0, Math.min(100, ((x - tm.launchT) / span) * 100))}%`;
        const ttp = tm.pitbullAt !== null ? tm.pitbullAt - t : null;
        const tti = tm.impactAt !== null ? tm.impactAt - t : null;
        const target = jetById(session.world, tm.targetId);
        const status =
          tti !== null && tti <= 0
            ? "TIME OUT"
            : ttp !== null && ttp > 0
              ? `TTP ${Math.ceil(ttp)} s`
              : tm.pitbull
                ? "ACTIVE"
                : "TTP —";
        return (
          <div key={tm.missileId} className="g-timer">
            <div className="g-timer-head">
              <span className="g-blue">{tm.missileId}</span> → {target?.callsign ?? "?"}
              <span className="g-grow" />
              <b>{status}</b>
              <span className="g-muted">TTI {tti !== null && tti > 0 ? `${Math.ceil(tti)} s` : "—"}</span>
            </div>
            <div className="g-timer-bar">
              {tm.pitbullAt !== null && <span className="g-timer-pb" style={{ left: frac(tm.pitbullAt) }} />}
              <span className="g-timer-now" style={{ left: frac(t) }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** One-line RWR readout for the selected jet: who is painting it, bearings relative to the nose. */
function RwrLine({ world, jet }: { world: World; jet: Jet }) {
  const contacts = rwrContacts(world, jet);
  if (contacts.length === 0) return <div className="g-rwr g-muted">RWR: clean</div>;
  const rel = (b: number) => {
    const d = Math.round(((((b - jet.hdg) * 180) / Math.PI + 540) % 360) - 180);
    return d === 0 ? "nose" : `${Math.abs(d)}° ${d < 0 ? "L" : "R"}`;
  };
  return (
    <div className="g-rwr">
      RWR:{" "}
      {contacts.map((c, i) => (
        <span key={c.sourceId} className={c.kind === "missile" ? "g-rwr-missile" : "g-rwr-radar"}>
          {i > 0 ? " · " : ""}
          {c.kind === "missile" ? `MISSILE ${c.lock ? "LOCK " : ""}` : "radar "}
          {rel(c.bearing)}
        </span>
      ))}
    </div>
  );
}

function NpcBehaviorPanel({
  session,
  jet,
  ai,
  tgt,
  params,
}: {
  session: SessionView;
  jet: Jet;
  ai: NpcStatus | null;
  tgt: Jet | undefined;
  params: GameParams;
}) {
  const turnLabel =
    jet.effort === "sustain"
      ? "Hold Spd"
      : jet.effort === "normal"
        ? `Normal ${params.aircraft.normalG} g`
        : `Max ${params.aircraft.gLimit} g`;
  return (
    <div className="g-npc-panel">
      <div className="g-npc-head">
        <span className="g-muted">{ai ? `NPC (${ai.skill})` : "NPC"}</span>
        {ai && <span className={`g-ai-pill g-ai-pill-${ai.state}`}>{ai.state.toUpperCase()}</span>}
      </div>
      <div className="g-npc-detail">{ai ? ai.detail : "Flown automatically by AI."}</div>
      <div className="g-npc-meta">
        <span>
          Throttle <b>{jet.throttle.toUpperCase()}</b>
        </span>
        <span>
          Turns <b>{turnLabel}</b>
        </span>
        <span>
          Alt order <b>{(Math.round(jet.altCmd / FT / 100) * 100).toLocaleString()} ft</b>
        </span>
        <span>
          Target <b>{tgt?.alive ? tgt.callsign : "—"}</b>
        </span>
      </div>
      {session.zone?.zone && <ZoneBox session={session} />}
    </div>
  );
}

function nearestKnownEnemy(
  s: SessionView,
  j: Jet,
): { id: string; pos: { x: number; y: number; z: number } } | undefined {
  let best: { id: string; pos: { x: number; y: number; z: number } } | undefined;
  let bd = Number.POSITIVE_INFINITY;
  for (const o of s.world.jets) {
    if (o.side === j.side || !o.alive) continue;
    const pos = s.knownEnemyPos(o.id);
    if (!pos) continue;
    const d = Math.hypot(pos.x - j.pos.x, pos.y - j.pos.y);
    if (d < bd) {
      bd = d;
      best = { id: o.id, pos };
    }
  }
  return best;
}

function fightBox(s: SessionView) {
  const pts = s.world.jets.filter((j) => j.alive && s.sees(j.id)).map((j) => j.pos);
  const all = pts.length > 0 ? pts : s.world.jets.filter((j) => s.sees(j.id)).map((j) => j.pos);
  let x0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const p of all) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  return { x0, x1, y0, y1 };
}

function centerOnFight(v: View, s: SessionView) {
  const b = fightBox(s);
  if (!Number.isFinite(b.x0)) return;
  v.cx = (b.x0 + b.x1) / 2;
  v.cy = (b.y0 + b.y1) / 2;
}

function fitView(v: View, s: SessionView) {
  const b = fightBox(s);
  if (!Number.isFinite(b.x0)) return;
  const span = Math.max(b.x1 - b.x0, b.y1 - b.y0, 25 * NM) * 1.5;
  const c = document.querySelector(".g-canvas") as HTMLCanvasElement | null;
  const w = c?.clientWidth || v.w;
  const h = c?.clientHeight || v.h;
  v.scale = Math.min(w, h) / span;
  v.cx = (b.x0 + b.x1) / 2;
  v.cy = (b.y0 + b.y1) / 2;
}
