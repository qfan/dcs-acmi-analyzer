import type { TFunction } from "i18next";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { LanguageSelector } from "../../i18n/LanguageSelector.tsx";
import { saveLastFile } from "../../ui/lastFile.ts";
import { SiteFooter } from "../../ui/SiteFooter.tsx";
import { acmiFileName } from "../acmi.ts";
import type { NpcStatus } from "../ai/doctrine.ts";
import type { LobbyAction, LobbyState, NetStatus } from "../engine/protocol.ts";
import { TIME_SCALES } from "../engine/session.ts";
import {
  inviteLink,
  knownRelays,
  orderRelays,
  type ProbeResult,
  parseInvite,
  probeRelay,
  relayLabel,
} from "../net/relays.ts";
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
  type GameEvent,
  jetById,
  type Outcome,
  rwrContacts,
  type World,
  waitingOnMissiles,
} from "../sim/world.ts";
import { BGM_TRACKS, type BgmPlayer, createBgmPlayer } from "./bgm.ts";
import {
  type GameView,
  initialMapRotation,
  panView,
  snapRotation,
  stepRotation,
  toggleNorthFlip,
  toWorld,
  zoomViewAt,
} from "./camera.ts";
import { drawScene, type Hit, sideCol } from "./draw.ts";
import { createEngineClient, type EngineClient } from "./engineClient.ts";
import { LobbyPanel, MultiplayerTab } from "./Lobby.tsx";
import { MapCompass } from "./MapCompass.tsx";
import { ParamEditor } from "./ParamEditor.tsx";
import { SinglePlayerTab, StartDialog, type StartTab } from "./StartDialog.tsx";
import {
  type ControlsDock,
  type ControlsDockPrefs,
  loadControlsDock,
  loadLast,
  loadMp,
  loadParams,
  saveControlsDock,
  saveLast,
  saveMp,
  saveParams,
  withRecent,
} from "./storage.ts";
import { SessionView } from "./view.ts";

/** Crank keeps the threat just inside the 60° radar gimbal. */
const CRANK_DEG = 50;
const HUD_MS = 100;
/** Brief lockout after target change or new lock-on so TWS target shifts don't fire on the wrong jet. */
const FOX_LOCK_MS = 180;
/** Altitude order steps (ft): arrow keys / small buttons, Page keys / big buttons. */
const ALT_STEP_FT = 1000;
const ALT_BIG_STEP_FT = 5000;
/** Vertical speeds below this (ft/min) count as level in the readouts. */
const LEVEL_FPM = 300;

const fmtTime = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const deg = (r: number) => Math.round(((r * 180) / Math.PI + 360) % 360);
const fmtSigned = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x))}`;

/** Relays this page knows (the local one first while developing). */
const RELAYS = knownRelays();

/** The invite in the address when the page opened (`#join=CODE&r=…`; never sent to any server). */
const INVITE = parseInvite(location.hash, RELAYS);

/** Altitude readout subline: climbing/diving rate and where to, or level. */
function altSub(j: Jet, t: TFunction): string {
  const fpm = (verticalSpeed(j) / FT) * 60;
  const to = `→ ${(Math.round(j.altCmd / FT / 100) * 100).toLocaleString()}`;
  if (Math.abs(fpm) < LEVEL_FPM) {
    return Math.abs(j.altCmd - j.pos.z) < 100 * FT ? t("game.app.stats.altLevel") : to;
  }
  return `${fpm > 0 ? "↑" : "↓"}${(Math.abs(fpm) / 1000).toFixed(1)}k fpm ${to}`;
}

/** Result title and text from this viewer's side (the sim words its outcomes for blue). */
function result(o: Outcome, side: Side, mp: boolean, t: TFunction): { title: string; text: string } {
  if (o.winner === null) return { title: t(`game.app.outcomes.${o.kind}`), text: o.reason };
  const won = o.winner === side;
  if (!mp && side === "blue") {
    return { title: won ? t("game.app.outcomes.win") : t("game.app.outcomes.loss"), text: o.reason };
  }
  return {
    title: won ? t("game.app.outcomes.win") : t("game.app.outcomes.loss"),
    text: won ? t("game.app.mpWinText") : t("game.app.mpLossText"),
  };
}

export function GameApp() {
  const { t } = useTranslation();
  const [params, setParams] = useState<GameParams>(loadParams);

  useEffect(() => {
    document.title = t("game.pageTitle");
  }, [t]);
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
  const [startTab, setStartTab] = useState<StartTab>(INVITE ? "multi" : "single");
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
  const [dockPrefs, setDockPrefs] = useState<ControlsDockPrefs>(loadControlsDock);
  const updateDockPrefs = useCallback((patch: Partial<ControlsDockPrefs>) => {
    setDockPrefs((prev) => {
      const next = { ...prev, ...patch };
      saveControlsDock(next);
      return next;
    });
  }, []);
  const [, setTick] = useState(0);

  // Multiplayer
  const [mpPrefs, setMpPrefs] = useState(loadMp);
  const [mpName, setMpName] = useState(mpPrefs.name);
  const [joinCode, setJoinCode] = useState(INVITE?.room ?? "");
  /** The invite's relay applies while its code is still in the box. */
  const inviteRelay = INVITE?.relayUrl && joinCode === INVITE.room ? INVITE.relayUrl : null;
  const [probes, setProbes] = useState<ReadonlyMap<string, ProbeResult>>(new Map());
  const [probeRound, setProbeRound] = useState(0);
  /** The relay the current room is on. */
  const [activeRelay, setActiveRelay] = useState<string | null>(null);
  const updatePrefs = (p: Partial<typeof mpPrefs>) => {
    const next = { ...mpPrefs, ...p };
    setMpPrefs(next);
    saveMp(next);
  };
  const [lobby, setLobby] = useState<LobbyState | null>(null);
  const [you, setYou] = useState(-1);
  const [net, setNet] = useState<NetStatus>("idle");
  const [netMsg, setNetMsg] = useState<string | null>(null);

  const engineRef = useRef<EngineClient | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<GameView>({ cx: 0, cy: 0, scale: 0.01, w: 800, h: 600, rot: 0 });
  const [mapRot, setMapRot] = useState(0);
  const hitsRef = useRef<Hit[]>([]);
  const followRef = useRef(follow);
  followRef.current = follow;
  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const radarSectorsRef = useRef(radarSectors);
  radarSectorsRef.current = radarSectors;
  const sideViewRef = useRef(sideView);
  sideViewRef.current = sideView;
  const foxLockedRef = useRef(false);

  const setViewRot = useCallback((next: number) => {
    const rot = wrap2Pi(next);
    viewRef.current.rot = rot;
    setMapRot(rot);
  }, []);
  const stepViewRot = useCallback(
    (deltaDeg: number) => setViewRot(stepRotation(viewRef.current.rot, deltaDeg)),
    [setViewRot],
  );
  const toggleViewNorth = useCallback(() => setViewRot(toggleNorthFlip(viewRef.current.rot)), [setViewRot]);

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
          if (m.meta.mode !== "sp" && m.meta.roomFog === false && fogRef.current)
            engine.send({ t: "fog", on: true });
          sessionRef.current = v;
          setSession(v);
          setShowStart(false);
          setEndSeen(false);
          fitView(viewRef.current, v);
          setMapRot(viewRef.current.rot);
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
          if (m.relay) setActiveRelay(m.relay);
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
    if (INVITE) history.replaceState(null, "", location.pathname + location.search);
  }, []);

  // Check the relays while the Multiplayer tab is open (never for single-player use).
  const pickingServer = showStart && startTab === "multi" && !lobby;
  const selection = mpPrefs.relay;
  // biome-ignore lint/correctness/useExhaustiveDependencies: probeRound is the "check again" trigger
  useEffect(() => {
    if (!pickingServer) return;
    const urls = [...new Set([...RELAYS.map((r) => r.url), ...(selection ? [selection] : [])])];
    let live = true;
    setProbes(new Map(urls.map((u) => [u, { state: "checking", ms: null } as ProbeResult])));
    for (const u of urls)
      void probeRelay(u).then((res) => {
        if (live) setProbes((prev) => new Map(prev).set(u, res));
      });
    return () => {
      live = false;
    };
  }, [pickingServer, selection, probeRound]);

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
        if (!c) continue;
        send({ t: "cmd", cmd: c });
        session.markCommanded(id, performance.now());
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

  /**
   * Periodic continuous notch steering: locks in a 90° beam heading against the highest-priority
   * sensor threat (RWR missile > radar/RWR enemy > RWR radar strobe), re-aligning every
   * `autoNotchAlignS`. Falls back to a one-shot heading turn if only a ghost is known.
   */
  const steerNotch = useCallback(
    (dir: 1 | -1, label: string) =>
      issue((j) => {
        if (!session) return null;
        const w = session.world;
        const rwr = rwrContacts(w, j);
        const missile = nearestRwrMissile(w, j);
        if (missile) {
          const c = rwr.find((x) => x.kind === "missile" && x.sourceId === missile);
          const fallbackHdg = c ? wrap2Pi(c.bearing + (dir * 90 * Math.PI) / 180) : j.hdg;
          return {
            type: "steer",
            jetId: j.id,
            steer: {
              mode: "notch",
              threatId: missile,
              dir,
              label: `${label} vs ${missile}`,
              hdg: fallbackHdg,
              nextAlignAt: 0,
            },
          };
        }
        const enemy = nearestKnownEnemy(session, j);
        if (enemy && (session.known.has(enemy.id) || rwr.some((c) => c.sourceId === enemy.id))) {
          const brg = Math.atan2(enemy.pos.x - j.pos.x, enemy.pos.y - j.pos.y);
          return {
            type: "steer",
            jetId: j.id,
            steer: {
              mode: "notch",
              threatId: enemy.id,
              dir,
              label,
              hdg: wrap2Pi(brg + (dir * 90 * Math.PI) / 180),
              nextAlignAt: 0,
            },
          };
        }
        const rwrRadars = rwr.filter((c) => c.kind === "radar");
        if (rwrRadars.length > 0) {
          let bestRadar = rwrRadars[0] as (typeof rwrRadars)[number];
          let bestDist = Number.POSITIVE_INFINITY;
          for (const rc of rwrRadars) {
            const e = w.jets.find((x) => x.id === rc.sourceId);
            const d = e ? Math.hypot(e.pos.x - j.pos.x, e.pos.y - j.pos.y) : 1e9;
            if (d < bestDist) {
              bestDist = d;
              bestRadar = rc;
            }
          }
          return {
            type: "steer",
            jetId: j.id,
            steer: {
              mode: "notch",
              threatId: bestRadar.sourceId,
              dir,
              label,
              hdg: wrap2Pi(bestRadar.bearing + (dir * 90 * Math.PI) / 180),
              nextAlignAt: 0,
            },
          };
        }
        if (!enemy) return null;
        const brg = Math.atan2(enemy.pos.x - j.pos.x, enemy.pos.y - j.pos.y);
        return {
          type: "steer",
          jetId: j.id,
          steer: { mode: "heading", hdg: wrap2Pi(brg + (dir * 90 * Math.PI) / 180) },
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

  /** A custom relay goes to the top of the recent list (built-in ones never do). */
  const rememberRelay = (url: string, extra: Partial<typeof mpPrefs> = {}) =>
    updatePrefs({
      name: mpName.trim(),
      ...extra,
      recent: RELAYS.some((r) => r.url === url) ? mpPrefs.recent : withRecent(mpPrefs.recent, url),
    });

  const hostGame = () => {
    const urls = selection ? [selection] : orderRelays(RELAYS, probes, "host");
    if (selection) rememberRelay(selection);
    else updatePrefs({ name: mpName.trim() });
    setNetMsg(null);
    setActiveRelay(null);
    clearView();
    send({ t: "mp-host", relayUrls: urls, name: mpName.trim(), params });
  };
  const joinGame = () => {
    // An invite names its relay; otherwise the chosen one, or every known relay in turn.
    const urls = inviteRelay ? [inviteRelay] : selection ? [selection] : orderRelays(RELAYS, probes, "join");
    if (inviteRelay ?? selection) rememberRelay(inviteRelay ?? selection);
    else updatePrefs({ name: mpName.trim() });
    setNetMsg(null);
    setActiveRelay(null);
    clearView();
    send({ t: "mp-join", relayUrls: urls, room: joinCode, name: mpName.trim() });
  };
  const leaveRoom = () => {
    send({ t: "mp-leave" });
    setLobby(null);
    if (sessionRef.current?.multiplayer) clearView();
  };

  // Track canvas CSS size via ResizeObserver instead of reading clientWidth/clientHeight every rAF frame.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    canvasSizeRef.current = { w: c.clientWidth, h: c.clientHeight };
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) {
        canvasSizeRef.current = { w: Math.round(rect.width), h: Math.round(rect.height) };
      }
    });
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

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
        let { w, h } = canvasSizeRef.current;
        if (w <= 0 || h <= 0) {
          w = c.clientWidth;
          h = c.clientHeight;
          canvasSizeRef.current = { w, h };
        }
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
      // A held key repeats about 30 times a second: one shot, one bundle or one pause per press.
      if (e.repeat && (k === " " || k === "f" || k === "insert" || k === "delete")) {
        e.preventDefault();
        return;
      }
      if (k === " ") togglePause();
      else if (k >= "1" && k <= "5") setScale(TIME_SCALES[Number(k) - 1] ?? 1);
      else if (k === "f") {
        if (!foxLockedRef.current) issue((j) => ({ type: "fire", jetId: j.id }));
      } else if (k === "h") steerRel(0, 1, "hot");
      else if (k === "q") steerRel(CRANK_DEG, -1, "crank left");
      else if (k === "e") steerRel(CRANK_DEG, 1, "crank right");
      else if (k === "a") steerNotch(-1, "notch left");
      else if (k === "d") steerNotch(1, "notch right");
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
      else if (k === "[" || k === "{" || k === "]" || k === "}")
        stepViewRot((k === "[" || k === "{" ? 1 : -1) * (e.shiftKey ? 45 : 15));
      else if (k === "n") setViewRot(e.shiftKey ? Math.PI : 0);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    issue,
    steerRel,
    steerNotch,
    stepAlt,
    levelOff,
    togglePause,
    setScale,
    setViewRot,
    stepViewRot,
    showParams,
    showStart,
    session,
  ]);

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

  // Mouse: left click selects / designates, left drag pans, Alt+drag / middle-drag rotates, right click sets heading, wheel zooms (Shift+wheel rotates).
  type CanvasDrag =
    | { kind: "pan"; x: number; y: number; moved: boolean }
    | { kind: "rotate"; startRot: number; startAngle: number; lastX: number; moved: boolean };
  const drag = useRef<CanvasDrag | null>(null);
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
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      e.preventDefault();
      const v = viewRef.current;
      const [sx, sy] = local(e);
      drag.current = {
        kind: "rotate",
        startRot: v.rot,
        startAngle: Math.atan2((sx ?? 0) - v.w / 2, -((sy ?? 0) - v.h / 2)),
        lastX: e.clientX,
        moved: false,
      };
      return;
    }
    if (e.button !== 0) return;
    drag.current = { kind: "pan", x: e.clientX, y: e.clientY, moved: false };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "rotate") {
      const v = viewRef.current;
      const [sx, sy] = local(e);
      const dxCenter = (sx ?? 0) - v.w / 2;
      const dyCenter = (sy ?? 0) - v.h / 2;
      const dx = e.clientX - d.lastX;
      d.lastX = e.clientX;
      if (Math.hypot(dxCenter, dyCenter) >= 24) {
        const curAngle = Math.atan2(dxCenter, -dyCenter);
        if (!d.moved && Math.abs(curAngle - d.startAngle) < 0.02) return;
        d.moved = true;
        setViewRot(snapRotation(wrap2Pi(d.startRot - (curAngle - d.startAngle)), e.shiftKey));
      } else {
        if (!d.moved && Math.abs(dx) < 2) return;
        d.moved = true;
        setViewRot(snapRotation(wrap2Pi(v.rot + dx * 0.01), e.shiftKey));
      }
      return;
    }
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    setFollow(false);
    panView(viewRef.current, dx, dy);
    d.x = e.clientX;
    d.y = e.clientY;
  };
  const onMouseUp = (e: React.MouseEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind !== "pan" || d.moved || !session || e.button !== 0) return;
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
      if (e.shiftKey) {
        const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        if (delta !== 0) stepViewRot((delta > 0 ? 1 : -1) * 15);
        return;
      }
      const v = viewRef.current;
      const r = c.getBoundingClientRect();
      zoomViewAt(v, e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015), !followRef.current);
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  }, [stepViewRot]);

  const w = session?.world;
  const p = session?.primary();
  const tgt = p ? jetById(w ?? null, p.targetId) : undefined;
  const activeTargetId = tgt?.alive ? tgt.id : null;
  const targetKey = p ? `${p.id}:${activeTargetId ?? ""}` : "";
  const [prevTargetKey, setPrevTargetKey] = useState(targetKey);
  const [foxLockSeq, setFoxLockSeq] = useState(0);
  if (targetKey !== prevTargetKey) {
    setPrevTargetKey(targetKey);
    setFoxLockSeq((n) => (activeTargetId !== null ? n + 1 : 0));
  }
  const foxLocked = foxLockSeq > 0;
  foxLockedRef.current = foxLocked;
  useEffect(() => {
    if (foxLockSeq === 0) return;
    const id = window.setTimeout(() => setFoxLockSeq(0), FOX_LOCK_MS);
    return () => window.clearTimeout(id);
  }, [foxLockSeq]);
  const pAi = session && p ? (session.npc[p.id]?.status ?? null) : null;
  const npcControlled = !!session?.watch || pAi !== null || (!!p && !!session && !session.ownsJet(p.id));
  const watchJets = session?.watch && w ? w.jets.filter((j) => j.alive && session.sees(j.id)) : [];
  const ended = !!w?.outcome;
  const scenario = scenarioById(session?.scenarioId ?? scenarioId);
  const roomFog = session?.meta.roomFog === true;
  const fogOn = session ? session.fog : fog;
  const inviteUrl =
    lobby && activeRelay
      ? inviteLink(`${location.origin}${location.pathname}`, lobby.room, activeRelay, RELAYS)
      : "";
  const res = w?.outcome && session ? result(w.outcome, session.side, mp, t) : null;
  const fox3Label = t("game.app.fox3Btn", { target: tgt?.alive ? ` → ${tgt.callsign}` : "" });

  return (
    <div className="g-app">
      <header className="g-top">
        <strong className="g-title">{t("game.title")}</strong>
        <span className="g-muted g-hide-narrow">
          {t(`game.scenarios.${scenario.id}.title`, { defaultValue: scenario.title })} ·{" "}
          {(session?.altFt ?? altFt).toLocaleString()} ft
        </span>
        {session?.watch && <span className="g-watch-badge">{t("game.app.watchBadge")}</span>}
        {mp && lobby && (
          <span className={`g-net g-net-${net}`} title={t("game.lobby.relayTitle", { status: net })}>
            {t("game.app.roomLabel", { room: lobby.room })}
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
                    ? t("game.app.resumeTitle")
                    : t("game.app.pauseTitle", { left: session.meta.pausesLeft ?? 0 })
                  : "Space"
              }
            >
              {session.paused ? t("game.app.playBtn") : t("game.app.pauseBtn")}
              {mp && !session.paused ? ` (${session.meta.pausesLeft ?? 0})` : ""}
            </button>
            {session.meta.canScale && (
              <div className="g-seg" title={t("game.app.timeCompTitle")}>
                {TIME_SCALES.map((k, i) => (
                  <button
                    type="button"
                    key={k}
                    className={session.timeScale === k ? "on" : ""}
                    onClick={(e) => {
                      setScale(k);
                      e.currentTarget.blur();
                    }}
                    title={t("game.app.keyTitle", { n: i + 1 })}
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
          aria-label={bgmOn ? t("game.app.bgmDisableAria") : t("game.app.bgmEnableAria")}
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
                ? t("game.app.bgmOnTitle")
                : t("game.app.bgmOffTitle")
              : t("game.app.bgmNoneTitle")
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
          title={roomFog ? t("game.app.fogRoomTitle") : t("game.app.fogTitle")}
        >
          {fogOn ? t("game.app.fogOn") : t("game.app.fogOff")}
          {roomFog ? " 🔒" : ""}
        </button>
        <button type="button" onClick={() => setShowStart(true)}>
          {t("game.app.newGameBtn")}
        </button>
        {!mp && (
          <button
            type="button"
            onClick={() => session && start(session.scenarioId, session.altFt)}
            disabled={!session}
          >
            {t("game.app.restartBtn")}
          </button>
        )}
        {mp && isHost && lobby?.phase === "playing" && (
          <button
            type="button"
            onClick={() => lobbyAction({ a: "to-lobby" })}
            title={t("game.app.endMatchTitle")}
          >
            {t("game.app.endMatchBtn")}
          </button>
        )}
        <button type="button" onClick={() => setShowParams(true)} disabled={mp}>
          {t("game.app.parametersBtn")}
        </button>
        <div className="g-menu" ref={exportMenuRef}>
          <button
            type="button"
            disabled={!session?.recorder}
            aria-haspopup="menu"
            aria-expanded={showExport}
            onClick={() => setShowExport((v) => !v)}
            title={
              session && !session.recorder ? t("game.app.exportDisabledTitle") : t("game.app.exportTitle")
            }
          >
            {t("game.app.exportAcmiBtn")}
          </button>
          {showExport && session?.recorder && (
            <div className="g-menu-list" role="menu">
              <ExportButtons onExport={exportFight} />
            </div>
          )}
        </div>
        <LanguageSelector />
        <a className="g-link g-hide-narrow" href="./index.html">
          {t("game.app.acmiViewerLink")}
        </a>
      </header>

      <div className="g-body">
        <div className="g-stage" ref={stageRef}>
          <canvas
            ref={canvasRef}
            className="g-canvas"
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onAuxClick={(e) => {
              if (e.button === 1) e.preventDefault();
            }}
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
              <span>{waitBanner(w, session.fog, session.side, t)}</span>
            </div>
          )}
          {mp && net === "reconnecting" && (
            <div className="g-banner g-banner-wait">
              <span>{t("game.app.reconnectingBanner")}</span>
            </div>
          )}
          {flash && <div className="g-flash">{flash}</div>}
          {session && p && w && !npcControlled && dockPrefs.dock !== "right" && (
            <MapControlsOverlay
              stageRef={stageRef}
              dockPrefs={dockPrefs}
              sideView={sideView}
              onChangeDock={(dock) => updateDockPrefs({ dock })}
              onFinishDrag={updateDockPrefs}
              jet={p}
              world={w}
              target={tgt}
              foxLocked={foxLocked}
              fox3Label={fox3Label}
              issue={issue}
              steerRel={steerRel}
              steerNotch={steerNotch}
              stepAlt={stepAlt}
              levelOff={levelOff}
            />
          )}
          {session && (
            <MapCompass
              rot={mapRot}
              onSetRot={setViewRot}
              onStepRot={stepViewRot}
              onToggleNorth={toggleViewNorth}
            />
          )}
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
              {t("game.app.followFight")}
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
              {t("game.app.labels")}
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
              {t("game.app.radarSectors")}
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
              {t("game.app.sideView")}
            </label>
          </div>
        </div>

        <aside className="g-side">
          {session?.watch && watchJets.length > 0 && (
            <section className="g-card g-watch-bar" aria-label={t("game.app.inspectAiAria")}>
              <div className="g-watch-head">
                <span className="g-muted">{t("game.app.inspectAi")}</span>
                <span className="g-watch-mode">{t("game.app.noPlayerControl")}</span>
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
                        setTick((tick) => tick + 1);
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
              <div className="g-card-head">
                <h3 style={{ color: sideCol(p.side) }}>{p.callsign}</h3>
                {!npcControlled && dockPrefs.dock === "right" && (
                  <ControlsDockSelect dock={dockPrefs.dock} onChange={(dock) => updateDockPrefs({ dock })} />
                )}
              </div>
              {!npcControlled && dockPrefs.dock === "right" && (
                <FlightControls
                  jet={p}
                  world={w}
                  target={tgt}
                  foxLocked={foxLocked}
                  fox3Label={fox3Label}
                  issue={issue}
                  steerRel={steerRel}
                  steerNotch={steerNotch}
                  stepAlt={stepAlt}
                  levelOff={levelOff}
                />
              )}
              {!npcControlled && <ZoneBox session={session} />}
              <RwrLine world={w} jet={p} />
              <div className="g-stats">
                <Stat
                  k={t("game.app.stats.speed")}
                  v={`M${mach(p).toFixed(2)}`}
                  sub={t("game.app.stats.speedSub", {
                    kcas: Math.round(casFromTas(p.speed, p.pos.z) / KT),
                    tas: Math.round(p.speed / KT),
                  })}
                />
                <Stat
                  k={t("game.app.stats.altitude")}
                  v={`${Math.round(p.pos.z / FT).toLocaleString()} ft`}
                  sub={altSub(p, t)}
                />
                <Stat
                  k={t("game.app.stats.energy")}
                  v={`${(Math.round(energyHeightM(p) / FT / 100) * 100).toLocaleString()} ft`}
                  sub={t("game.app.stats.energySub", {
                    ps: fmtSigned(specificExcessPower(w.params.aircraft, p, p.g) / FT),
                  })}
                />
                <Stat
                  k={t("game.app.stats.load")}
                  v={`${p.g.toFixed(1)} g`}
                  sub={t("game.app.stats.loadSub", {
                    max: availableG(w.params.aircraft, p, p.effort).toFixed(1),
                  })}
                />
                <Stat
                  k={t("game.app.stats.heading")}
                  v={`${String(deg(p.hdg)).padStart(3, "0")}°`}
                  flashSubFor={npcControlled ? undefined : p.id}
                  sub={
                    session.npc[p.id]?.line ??
                    (p.steer.mode === "relative" || p.steer.mode === "notch"
                      ? p.steer.label
                      : t("game.app.stats.headingDefault"))
                  }
                />
                <OrdnanceStat jet={p} />
                <Stat
                  k={t("game.app.stats.radar")}
                  v={
                    tgt?.alive
                      ? w.radarTrack.get(p.id)
                        ? t("game.app.stats.radarTrack")
                        : t("game.app.stats.radarNoTrack")
                      : "—"
                  }
                  sub={tgt?.alive ? tgt.callsign : t("game.app.stats.radarNoTarget")}
                />
              </div>
              {npcControlled && (
                <NpcBehaviorPanel session={session} jet={p} ai={pAi} tgt={tgt} params={w.params} />
              )}
            </section>
          )}
          {mp && lobby && <PlayersCard lobby={lobby} you={you} />}

          {w && (
            <section className="g-card">
              <h3>{t("game.app.missilesTitle")}</h3>
              {session && (!session.watch || session.fog) && <OwnMissileTimers session={session} />}
              {!session?.fog && w.missiles.some((m) => !m.end) && (
                <p className="g-muted g-truth">{t("game.app.truthHiddenNote")}</p>
              )}
              {session?.fog && <p className="g-muted">{t("game.app.fogMissilesNote")}</p>}
              <table className="g-table">
                <tbody>
                  {w.missiles
                    .filter((m) => !m.end && !session?.fog)
                    .map((m) => {
                      const tgtJet = jetById(w, m.targetId);
                      const r = tgtJet
                        ? Math.hypot(tgtJet.pos.x - m.pos.x, tgtJet.pos.y - m.pos.y, tgtJet.pos.z - m.pos.z) /
                          NM
                        : 0;
                      return (
                        <tr key={m.id}>
                          <td style={{ color: sideCol(m.side) }}>{m.id}</td>
                          <td>→ {tgtJet?.callsign}</td>
                          <td>
                            <span className={`g-phase g-phase-${m.phase}`}>
                              {t(`game.app.phases.${m.phase}`)}
                            </span>
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
              <h3>{t("game.app.eventsTitle")}</h3>
              <ol className="g-log">
                {recentLogEvents(w, session).map(({ e, seq }) => (
                  <li key={seq}>
                    <span className="g-muted">{fmtTime(e.t)}</span>{" "}
                    <span style={{ color: sideCol(e.side) }}>{e.text}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <HelpCard
            watch={!!session?.watch}
            normalDeg={w?.params.aircraft.normalClimbDeg ?? 20}
            maxDeg={w?.params.aircraft.maxClimbDeg ?? 45}
            minAlt={w?.params.aircraft.minAltFt ?? 1000}
            gimbal={w?.params.radar.gimbalDeg ?? 60}
            tws={w?.params.radar.rangeNm ?? 70}
            detect={w?.params.radar.detectRangeNm ?? 80}
          />

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
                serverName={activeRelay ? relayLabel(activeRelay, RELAYS) : t("game.app.theRelay")}
              />
            ) : (
              <MultiplayerTab
                name={mpName}
                onName={setMpName}
                code={joinCode}
                onCode={setJoinCode}
                status={net}
                statusMessage={netMsg}
                onHost={hostGame}
                onJoin={joinGame}
                server={{
                  relays: RELAYS,
                  recent: mpPrefs.recent,
                  selection,
                  onSelection: (url) => updatePrefs({ relay: url }),
                  onUseCustom: (url) => updatePrefs({ relay: url, recent: withRecent(mpPrefs.recent, url) }),
                  onForget: (url) =>
                    updatePrefs({ relay: "", recent: mpPrefs.recent.filter((u) => u !== url) }),
                  probes,
                  onRefresh: () => setProbeRound((n) => n + 1),
                  invite: inviteRelay && INVITE ? INVITE : null,
                }}
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
            setFlash(t("game.app.paramsSavedFlash"));
          }}
        />
      )}
      {ended && !endSeen && res && !showStart && (
        <EndDialog
          res={res}
          fightTimeSec={w?.t ?? 0}
          mp={mp}
          isHost={isHost}
          onExport={exportFight}
          onLookAtMap={() => setEndSeen(true)}
          onBackToLobby={() => lobbyAction({ a: "to-lobby" })}
          onLeaveRoom={leaveRoom}
          onNewGame={() => setShowStart(true)}
          onRestart={() => session && start(session.scenarioId, session.altFt)}
        />
      )}
    </div>
  );
}

const END_DIALOG_BUTTON_DELAY_MS = 600;

/** Match-complete modal; action buttons stay hidden and non-clickable briefly so sudden popups aren't misclicked. */
function EndDialog({
  res,
  fightTimeSec,
  mp,
  isHost,
  onExport,
  onLookAtMap,
  onBackToLobby,
  onLeaveRoom,
  onNewGame,
  onRestart,
}: {
  res: { title: string; text: string };
  fightTimeSec: number;
  mp: boolean;
  isHost: boolean;
  onExport: (mode: ExportMode) => void;
  onLookAtMap: () => void;
  onBackToLobby: () => void;
  onLeaveRoom: () => void;
  onNewGame: () => void;
  onRestart: () => void;
}) {
  const { t } = useTranslation();
  const [buttonsReady, setButtonsReady] = useState(false);

  useEffect(() => {
    const id = window.setTimeout(() => setButtonsReady(true), END_DIALOG_BUTTON_DELAY_MS);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <div className="g-modal-back">
      <div
        className={buttonsReady ? "g-modal g-end-dialog" : "g-modal g-end-dialog g-end-locked"}
        role="dialog"
        aria-label={t("game.app.resultAria")}
      >
        <h2>{res.title}</h2>
        <p>{res.text}</p>
        <p className="g-muted">{t("game.app.fightTime", { time: fmtTime(fightTimeSec) })}</p>
        <div className="g-row">
          <span className="g-label">{t("game.app.recordingLabel")}</span>
          <ExportButtons onExport={onExport} />
        </div>
        <div className="g-row g-end">
          <button type="button" disabled={!buttonsReady} onClick={onLookAtMap}>
            {t("game.app.lookAtMapBtn")}
          </button>
          {mp ? (
            isHost ? (
              <button type="button" className="g-primary" disabled={!buttonsReady} onClick={onBackToLobby}>
                {t("game.app.backToLobbyBtn")}
              </button>
            ) : (
              <>
                <button type="button" disabled={!buttonsReady} onClick={onLeaveRoom}>
                  {t("game.app.leaveRoomBtn")}
                </button>
                <span className="g-muted">{t("game.app.guestLobbyNote")}</span>
              </>
            )
          ) : (
            <>
              <button type="button" disabled={!buttonsReady} onClick={onNewGame}>
                {t("game.app.newGameBtn")}
              </button>
              <button type="button" className="g-primary" disabled={!buttonsReady} onClick={onRestart}>
                {t("game.app.restartBtn")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Multiplayer side-panel card: who is in the room, on which side, and how their connection is. */
function PlayersCard({ lobby, you }: { lobby: LobbyState; you: number }) {
  const { t } = useTranslation();
  return (
    <section className="g-card g-players">
      <h3>{t("game.app.playersTitle", { room: lobby.room })}</h3>
      <ul>
        {lobby.players.map((pl) => {
          const slots = lobby.slots.filter((s) => s.peer === pl.id);
          const side = slots[0]?.side;
          return (
            <li key={pl.id}>
              <span className="g-watch-dot" style={{ background: side ? sideCol(side) : "var(--g-muted)" }} />
              <span>
                {pl.name}
                {pl.id === you ? t("game.lobby.youTag") : ""}
                {pl.host ? t("game.lobby.hostTag") : ""}
              </span>
              <span className="g-grow" />
              <span className="g-muted">
                {slots.map((s) => s.callsign).join(", ") || t("game.app.watchingSlot")}
                {pl.away
                  ? t("game.lobby.reconnectingTag")
                  : pl.rttMs !== null && !pl.host
                    ? ` · ${pl.rttMs} ms`
                    : ""}
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
function waitBanner(w: World, fog: boolean, side: Side, t: TFunction): string {
  const meAlive = w.jets.some((j) => j.side === side && j.alive);
  if (fog) return meAlive ? t("game.app.waitFogAlive") : t("game.app.waitFogDead");
  if (waitingOnMissiles(w)) {
    return meAlive ? t("game.app.waitMissilesAlive") : t("game.app.waitMissilesDead");
  }
  return t("game.app.waitCalling");
}

type ExportMode = "download" | "viewer" | "both";

function ExportButtons({ onExport }: { onExport: (mode: ExportMode) => void }) {
  const { t } = useTranslation();
  return (
    <div className="g-seg">
      <button type="button" onClick={() => onExport("download")} title={t("game.app.downloadTitle")}>
        {t("game.app.downloadBtn")}
      </button>
      <button type="button" onClick={() => onExport("viewer")} title={t("game.app.openInViewerTitle")}>
        {t("game.app.openInViewerBtn")}
      </button>
      <button type="button" onClick={() => onExport("both")}>
        {t("game.app.bothBtn")}
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

interface FlightControlsProps {
  jet: Jet;
  world: World;
  target: Jet | undefined;
  foxLocked: boolean;
  fox3Label: string;
  issue: (make: (j: Jet) => Command | null) => void;
  steerRel: (offsetDeg: number, dir: 1 | -1, label: string, vsMissile?: boolean) => void;
  steerNotch: (dir: 1 | -1, label: string) => void;
  stepAlt: (deltaFt: number) => void;
  levelOff: () => void;
}

function ControlsDockSelect({
  dock,
  onChange,
}: {
  dock: ControlsDock;
  onChange: (dock: ControlsDock) => void;
}) {
  const { t } = useTranslation();
  return (
    <select
      className="g-dock-sel"
      aria-label={t("game.app.controlsDockAria")}
      value={dock}
      onMouseDown={(e) => e.stopPropagation()}
      onChange={(e) => {
        onChange(e.target.value as ControlsDock);
        e.currentTarget.blur();
      }}
    >
      <option value="right">{t("game.app.controlsDock.right")}</option>
      <option value="bottom">{t("game.app.controlsDock.bottom")}</option>
      <option value="top-left">{t("game.app.controlsDock.topLeft")}</option>
      <option value="bottom-left">{t("game.app.controlsDock.bottomLeft")}</option>
      <option value="float">{t("game.app.controlsDock.float")}</option>
    </select>
  );
}

type Maneuver = "crankL" | "hot" | "crankR" | "notchL" | "cold" | "notchR";

/** The continuous maneuver the jet is flying. A plain heading order (or a lapsed maneuver) is none. */
function activeManeuver(j: Jet): Maneuver | null {
  const s = j.steer;
  if (s.mode === "notch") return s.dir < 0 ? "notchL" : "notchR";
  if (s.mode !== "relative") return null;
  if (s.offsetDeg === 0) return "hot";
  if (s.offsetDeg === 180) return "cold";
  if (s.offsetDeg === CRANK_DEG) return s.dir < 0 ? "crankL" : "crankR";
  return null;
}

/** Yellow overlay for a release button: plays when the count drops. Key it by jet so a switch resets it. */
function ReleaseFlash({ count }: { count: number }) {
  const prevRef = useRef(count);
  const [flash, setFlash] = useState(0);

  useEffect(() => {
    if (count < prevRef.current) setFlash((n) => n + 1);
    prevRef.current = count;
  }, [count]);

  if (flash === 0) return null;
  return <span key={flash} className="g-release-flash" aria-hidden="true" />;
}

/** Launch button with the jet's remaining missiles; flashes yellow when one leaves the rail. */
function FireButton({
  jet,
  target,
  foxLocked,
  label,
  onFire,
}: {
  jet: Jet;
  target: Jet | undefined;
  foxLocked: boolean;
  label: string;
  onFire: () => void;
}) {
  const { t } = useTranslation();
  const left = t("game.app.missilesLeft", { n: jet.missiles });
  return (
    <button
      type="button"
      className="g-fire"
      disabled={!target?.alive || jet.missiles <= 0 || foxLocked}
      onClick={onFire}
      title={`${label} (F) · ${left}`}
    >
      <ReleaseFlash key={jet.id} count={jet.missiles} />
      <span className="g-fire-label">{label}</span>
      <span className="g-fire-count">{left}</span>
    </button>
  );
}

function FlightControls({
  jet,
  world,
  target,
  foxLocked,
  fox3Label,
  issue,
  steerRel,
  steerNotch,
  stepAlt,
  levelOff,
}: FlightControlsProps) {
  const { t } = useTranslation();
  const limits = altLimitsM(world.params.aircraft);
  const maneuver = activeManeuver(jet);
  const maneuverCls = (m: Maneuver) => (maneuver === m ? "on" : undefined);
  return (
    <div className="g-ctl-body">
      <div className="g-ctl-sliders">
        <div className="g-row g-ctl">
          <span className="g-label">{t("game.app.throttle")}</span>
          <div className="g-seg">
            {(["idle", "mil", "ab"] as Throttle[]).map((th) => (
              <button
                type="button"
                key={th}
                className={jet.throttle === th ? "on" : ""}
                onClick={(e) => {
                  issue((j) => ({ type: "throttle", jetId: j.id, throttle: th }));
                  e.currentTarget.blur();
                }}
              >
                {th.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <div className="g-row g-ctl">
          <span className="g-label">{t("game.app.turns")}</span>
          <div className="g-seg">
            {(["sustain", "normal", "max"] as const).map((ef) => (
              <button
                type="button"
                key={ef}
                className={jet.effort === ef ? "on" : ""}
                title={ef === "sustain" ? t("game.app.sustainTitle") : undefined}
                onClick={(e) => {
                  issue((j) => ({ type: "effort", jetId: j.id, effort: ef }));
                  e.currentTarget.blur();
                }}
              >
                {ef === "sustain"
                  ? t("game.app.holdSpd")
                  : ef === "normal"
                    ? t("game.app.normalG", { g: world.params.aircraft.normalG })
                    : t("game.app.maxG", { g: world.params.aircraft.gLimit })}
              </button>
            ))}
          </div>
        </div>
        <div className="g-row g-ctl">
          <span className="g-label">{t("game.app.altitudeLabel")}</span>
          <div className="g-seg g-alt">
            <button
              type="button"
              title={t("game.app.pageDownTitle")}
              disabled={jet.altCmd <= limits.min + 1}
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
              disabled={jet.altCmd <= limits.min + 1}
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
              title={t("game.app.altCmdTitle")}
              onClick={(e) => {
                levelOff();
                e.currentTarget.blur();
              }}
            >
              {Math.round(jet.altCmd / FT).toLocaleString()} ft
            </button>
            <button
              type="button"
              title="↑"
              disabled={jet.altCmd >= limits.max - 1}
              onClick={(e) => {
                stepAlt(ALT_STEP_FT);
                e.currentTarget.blur();
              }}
            >
              ▲
            </button>
            <button
              type="button"
              title={t("game.app.pageUpTitle")}
              disabled={jet.altCmd >= limits.max - 1}
              onClick={(e) => {
                stepAlt(ALT_BIG_STEP_FT);
                e.currentTarget.blur();
              }}
            >
              ⏫
            </button>
          </div>
        </div>
      </div>
      <div className="g-maneuvers">
        <button
          type="button"
          className={maneuverCls("crankL")}
          onClick={() => steerRel(CRANK_DEG, -1, "crank left")}
          title={`${t("game.app.crankL")} (Q)`}
        >
          {t("game.app.crankL")}
        </button>
        <button
          type="button"
          className={maneuverCls("hot")}
          onClick={() => steerRel(0, 1, "hot")}
          title={`${t("game.app.hot")} (H)`}
        >
          {t("game.app.hot")}
        </button>
        <button
          type="button"
          className={maneuverCls("crankR")}
          onClick={() => steerRel(CRANK_DEG, 1, "crank right")}
          title={`${t("game.app.crankR")} (E)`}
        >
          {t("game.app.crankR")}
        </button>
        <button
          type="button"
          className={maneuverCls("notchL")}
          onClick={() => steerNotch(-1, "notch left")}
          title={`${t("game.app.notchL")} (A)`}
        >
          {t("game.app.notchL")}
        </button>
        <button
          type="button"
          className={maneuverCls("cold")}
          onClick={() => steerRel(180, 1, "cold", true)}
          title={`${t("game.app.cold")} (C)`}
        >
          {t("game.app.cold")}
        </button>
        <button
          type="button"
          className={maneuverCls("notchR")}
          onClick={() => steerNotch(1, "notch right")}
          title={`${t("game.app.notchR")} (D)`}
        >
          {t("game.app.notchR")}
        </button>
        <button
          type="button"
          className="g-release"
          onClick={() => issue((j) => ({ type: "chaff", jetId: j.id }))}
          title={`${t("game.app.chaffBtn", { count: jet.chaff })} — ${t("game.app.chaffTitle")}`}
        >
          <ReleaseFlash key={jet.id} count={jet.chaff} />
          <span className="g-release-text">{t("game.app.chaffBtn", { count: jet.chaff })}</span>
        </button>
        <span />
        <button
          type="button"
          className="g-release"
          onClick={() => issue((j) => ({ type: "flare", jetId: j.id }))}
          title={`${t("game.app.flareBtn", { count: jet.flares })} — ${t("game.app.flareTitle")}`}
        >
          <ReleaseFlash key={jet.id} count={jet.flares} />
          <span className="g-release-text">{t("game.app.flareBtn", { count: jet.flares })}</span>
        </button>
      </div>
      <FireButton
        jet={jet}
        target={target}
        foxLocked={foxLocked}
        label={fox3Label}
        onFire={() => issue((j) => ({ type: "fire", jetId: j.id }))}
      />
    </div>
  );
}

/** Map-docked or floating overlay keeping all flight controls together closer to the tactical view. */
function MapControlsOverlay({
  stageRef,
  dockPrefs,
  sideView,
  onChangeDock,
  onFinishDrag,
  ...ctlProps
}: FlightControlsProps & {
  stageRef: React.RefObject<HTMLDivElement | null>;
  dockPrefs: ControlsDockPrefs;
  sideView: boolean;
  onChangeDock: (dock: ControlsDock) => void;
  onFinishDrag: (patch: Partial<ControlsDockPrefs>) => void;
}) {
  const { t } = useTranslation();
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const [floatPos, setFloatPos] = useState({ x: dockPrefs.x, y: dockPrefs.y });
  const [dragging, setDragging] = useState(false);

  const clampPos = useCallback(
    (x: number, y: number) => {
      const stage = stageRef.current;
      const el = overlayRef.current;
      if (!stage || !el) return { x, y };
      const maxX = Math.max(8, stage.clientWidth - el.offsetWidth - 8);
      const maxY = Math.max(8, stage.clientHeight - el.offsetHeight - 8);
      return {
        x: Math.min(maxX, Math.max(8, Math.round(x))),
        y: Math.min(maxY, Math.max(8, Math.round(y))),
      };
    },
    [stageRef],
  );

  useEffect(() => {
    if (dockPrefs.dock !== "float") return;
    const sync = () => setFloatPos(clampPos(dockPrefs.x, dockPrefs.y));
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [dockPrefs.dock, dockPrefs.x, dockPrefs.y, clampPos]);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  const isFloat = dockPrefs.dock === "float";
  const isHorizontal = dockPrefs.dock === "bottom" || (isFloat && dockPrefs.floatLayout === "horizontal");

  const onHeadMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest("select, option, button")) return;
    const stage = stageRef.current;
    const el = overlayRef.current;
    if (!stage || !el) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const sr = stage.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const origin = clampPos(er.left - sr.left, er.top - sr.top);
    let latest = origin;
    let moved = false;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      if (!moved) {
        moved = true;
        setDragging(true);
      }
      latest = clampPos(origin.x + dx, origin.y + dy);
      setFloatPos(latest);
    };
    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      dragCleanupRef.current = null;
    };
    const onUp = () => {
      cleanup();
      if (!moved) return;
      setDragging(false);
      onFinishDrag({
        dock: "float",
        x: latest.x,
        y: latest.y,
        floatLayout: isHorizontal ? "horizontal" : "vertical",
      });
    };
    dragCleanupRef.current?.();
    dragCleanupRef.current = cleanup;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const clearSide = sideView && dockPrefs.dock === "bottom-left";
  const cls = [
    "g-ctl-overlay",
    `g-ctl-dock-${dockPrefs.dock}`,
    isHorizontal ? "g-ctl-horizontal" : "",
    clearSide ? "g-ctl-clear-side" : "",
    dragging ? "g-ctl-dragging" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: stop pointer/wheel events from reaching the map canvas underneath
    <div
      ref={overlayRef}
      className={cls}
      style={isFloat || dragging ? { left: floatPos.x, top: floatPos.y } : undefined}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onWheel={(e) => e.stopPropagation()}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: mouse drag handle for map-docked overlay; preset positions work via select */}
      <div className="g-ctl-head" onMouseDown={onHeadMouseDown} title={t("game.app.controlsDragHint")}>
        <span style={{ color: sideCol(ctlProps.jet.side), fontWeight: 700 }}>
          <span className="g-ctl-grip" aria-hidden="true">
            ⠿
          </span>
          {ctlProps.jet.callsign}
        </span>
        <ControlsDockSelect dock={dockPrefs.dock} onChange={onChangeDock} />
      </div>
      <FlightControls {...ctlProps} />
    </div>
  );
}

/** `flashSubFor`: the jet whose sub line should flash when it changes; omit for values that drift constantly. */
function Stat({ k, v, sub, flashSubFor }: { k: string; v: string; sub?: string; flashSubFor?: string }) {
  const prevRef = useRef({ flashSubFor, sub });
  const [subFlash, setSubFlash] = useState(0);

  useEffect(() => {
    const prev = prevRef.current;
    if (flashSubFor && prev.flashSubFor === flashSubFor && prev.sub !== sub) setSubFlash((n) => n + 1);
    prevRef.current = { flashSubFor, sub };
  }, [flashSubFor, sub]);

  return (
    <div className="g-stat">
      <span className="g-muted" title={k}>
        {k}
      </span>
      <b title={v}>{v}</b>
      {sub && (
        <span key={subFlash} className={subFlash > 0 ? "g-muted g-stat-flash" : "g-muted"} title={sub}>
          {sub}
        </span>
      )}
    </div>
  );
}

/** Missile/chaff/flare readout that briefly highlights whichever count changed so launches are obvious in fog of war. */
function OrdnanceStat({ jet }: { jet: Jet }) {
  const { t } = useTranslation();
  const prevRef = useRef({ id: jet.id, missiles: jet.missiles, chaff: jet.chaff, flares: jet.flares });
  const [missileFlash, setMissileFlash] = useState(0);
  const [cmFlash, setCmFlash] = useState(0);

  useEffect(() => {
    const prev = prevRef.current;
    if (prev.id === jet.id) {
      if (jet.missiles !== prev.missiles) setMissileFlash((n) => n + 1);
      if (jet.chaff !== prev.chaff || jet.flares !== prev.flares) setCmFlash((n) => n + 1);
    }
    prevRef.current = { id: jet.id, missiles: jet.missiles, chaff: jet.chaff, flares: jet.flares };
  }, [jet.id, jet.missiles, jet.chaff, jet.flares]);

  const label = t("game.app.stats.missiles");
  const sub = t("game.app.stats.missilesSub", { chaff: jet.chaff, flares: jet.flares });
  return (
    <div className="g-stat">
      <span className="g-muted" title={label}>
        {label}
      </span>
      <b
        key={`m-${missileFlash}`}
        className={missileFlash > 0 ? "g-stat-flash" : undefined}
        title={String(jet.missiles)}
      >
        {jet.missiles}
      </b>
      <span key={`c-${cmFlash}`} className={cmFlash > 0 ? "g-muted g-stat-flash" : "g-muted"} title={sub}>
        {sub}
      </span>
    </div>
  );
}

function ZoneBox({ session }: { session: SessionView }) {
  const { t } = useTranslation();
  const z = session.zone?.zone;
  if (!z) {
    const needTarget = t("game.app.zoneNeedTarget");
    return (
      <div className="g-zone g-muted">
        <div className="g-zone-line" title={needTarget}>
          {needTarget}
        </div>
        <div className="g-zone-line" aria-hidden="true">
          &nbsp;
        </div>
      </div>
    );
  }
  const inMax = z.rangeNm <= z.rmaxNm;
  const inNe = z.rangeNm <= z.rneNm;
  const zoneValues = {
    range: z.rangeNm.toFixed(1),
    rmax: z.rmaxNm.toFixed(1),
    rne: z.rneNm.toFixed(1),
  };
  const zoneLineText = t("game.app.zoneLine", zoneValues).replace(/<\/?\d+>/g, "");
  const statusText = `${inNe ? t("game.app.zoneInNe") : inMax ? t("game.app.zoneInMax") : t("game.app.zoneOutOfRange")}${
    z.now.hit
      ? t("game.app.zoneShotNow", {
          tof: Math.round(z.now.tofS),
          mach: z.now.arrivalMach.toFixed(1),
        })
      : ""
  }`;
  return (
    <div className="g-zone">
      <div className="g-zone-line" title={zoneLineText}>
        <Trans
          i18nKey="game.app.zoneLine"
          values={zoneValues}
          components={[
            <b key="0" />,
            <span key="1" className="g-rmax" />,
            <span key="2" className="g-rne" />,
          ]}
        />
      </div>
      <div className={`g-zone-line ${inNe ? "g-rne" : inMax ? "g-rmax" : "g-muted"}`} title={statusText}>
        {statusText}
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
    const dist = m ? Math.hypot(m.pos.x - j.pos.x, m.pos.y - j.pos.y) : 1e6;
    const score = dist - (c.lock ? 1e7 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = c.sourceId;
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
  const { t: tr } = useTranslation();
  const t = session.world.t;
  const timers = session.activeTimers();
  if (timers.length === 0) return <p className="g-muted">{tr("game.app.ownTimersNone")}</p>;
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
            ? tr("game.app.timerTimeout")
            : ttp !== null && ttp > 0
              ? `TTP ${Math.ceil(ttp)} s`
              : tm.pitbull
                ? tr("game.app.timerActive")
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

const MAX_RWR_CONTACTS = 3;

/** One-line RWR readout for the selected jet: highest-priority emitters painting it, bearings relative to the nose. */
function RwrLine({ world, jet }: { world: World; jet: Jet }) {
  const { t } = useTranslation();
  const contacts = rwrContacts(world, jet);
  if (contacts.length === 0) {
    const clean = t("game.app.rwrClean");
    return (
      <div className="g-rwr g-muted" title={clean}>
        {clean}
      </div>
    );
  }
  const rel = (b: number) => {
    const d = Math.round(((((b - jet.hdg) * 180) / Math.PI + 540) % 360) - 180);
    if (d === 0) return t("game.app.rwrNose");
    if (Math.abs(d) === 180) return "180°";
    return `${Math.abs(d)}° ${d < 0 ? "L" : "R"}`;
  };
  const ranked = contacts.map((c) => {
    const prio = c.kind === "missile" ? (c.lock ? 0 : 1) : 2;
    const pos =
      c.kind === "missile"
        ? world.missiles.find((m) => m.id === c.sourceId)?.pos
        : world.jets.find((j) => j.id === c.sourceId)?.pos;
    let d2 = Number.POSITIVE_INFINITY;
    if (pos) {
      const dx = pos.x - jet.pos.x;
      const dy = pos.y - jet.pos.y;
      const dz = pos.z - jet.pos.z;
      d2 = dx * dx + dy * dy + dz * dz;
    }
    return { c, prio, d2 };
  });
  ranked.sort((a, b) => a.prio - b.prio || a.d2 - b.d2);
  const sorted = ranked.map((x) => x.c);
  const labelOf = (c: (typeof contacts)[number]) =>
    `${
      c.kind === "missile"
        ? `${t("game.app.rwrMissile")}${c.lock ? t("game.app.rwrLock") : ""}`
        : t("game.app.rwrRadar")
    }${rel(c.bearing)}`;
  const visible = sorted.slice(0, MAX_RWR_CONTACTS);
  const hiddenCount = sorted.length - visible.length;
  const fullText = sorted.map(labelOf).join(" · ");
  return (
    <div className="g-rwr" title={`${t("game.app.rwrPrefix")} ${fullText}`}>
      {t("game.app.rwrPrefix")}{" "}
      {visible.map((c, i) => (
        <span key={c.sourceId} className={c.kind === "missile" ? "g-rwr-missile" : "g-rwr-radar"}>
          {i > 0 ? " · " : ""}
          {labelOf(c)}
        </span>
      ))}
      {hiddenCount > 0 && <span className="g-muted"> +{hiddenCount}</span>}
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
  const { t } = useTranslation();
  const turnLabel =
    jet.effort === "sustain"
      ? t("game.app.holdSpd")
      : jet.effort === "normal"
        ? t("game.app.normalG", { g: params.aircraft.normalG })
        : t("game.app.maxG", { g: params.aircraft.gLimit });
  return (
    <div className="g-npc-panel">
      <div className="g-npc-head">
        <span className="g-muted">{ai ? `NPC (${ai.skill})` : "NPC"}</span>
        {ai && <span className={`g-ai-pill g-ai-pill-${ai.state}`}>{ai.state.toUpperCase()}</span>}
      </div>
      <div className="g-npc-detail">{ai ? ai.detail : t("game.app.npcDefaultDetail")}</div>
      <div className="g-npc-meta">
        <span>
          {t("game.app.npcThrottle")} <b>{jet.throttle.toUpperCase()}</b>
        </span>
        <span>
          {t("game.app.npcTurns")} <b>{turnLabel}</b>
        </span>
        <span>
          {t("game.app.npcAltOrder")} <b>{(Math.round(jet.altCmd / FT / 100) * 100).toLocaleString()} ft</b>
        </span>
        <span>
          {t("game.app.npcTarget")} <b>{tgt?.alive ? tgt.callsign : "—"}</b>
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

function centerOnFight(v: GameView, s: SessionView) {
  const b = fightBox(s);
  if (!Number.isFinite(b.x0)) return;
  v.cx = (b.x0 + b.x1) / 2;
  v.cy = (b.y0 + b.y1) / 2;
}

function recentLogEvents(w: World, session: SessionView | null): { e: GameEvent; seq: number }[] {
  const out: { e: GameEvent; seq: number }[] = [];
  for (let i = w.events.length - 1; i >= 0 && out.length < 14; i--) {
    const e = w.events[i] as GameEvent;
    if (
      e.type !== "radar-gained" &&
      e.type !== "radar-lost" &&
      e.type !== "chaff" &&
      e.type !== "flare" &&
      (!session || session.showsEvent(e))
    ) {
      out.push({ e, seq: w.eventOffset + i });
    }
  }
  return out;
}

const HelpCard = memo(function HelpCard({
  watch,
  normalDeg,
  maxDeg,
  minAlt,
  gimbal,
  tws,
  detect,
}: {
  watch: boolean;
  normalDeg: number;
  maxDeg: number;
  minAlt: number;
  gimbal: number;
  tws: number;
  detect: number;
}) {
  const { t } = useTranslation();
  return (
    <section className="g-card g-help">
      <h3>{watch ? t("game.app.watchControlsTitle") : t("game.app.controlsTitle")}</h3>
      {watch ? (
        <>
          <p>
            <Trans
              i18nKey="game.app.watchControlsP1"
              components={[<b key="0" />, <b key="1" />, <b key="2" />, <b key="3" />, <b key="4" />]}
            />
          </p>
          <p>
            <Trans
              i18nKey="game.app.watchControlsP2"
              components={[
                <kbd key="0" />,
                <kbd key="1" />,
                <kbd key="2" />,
                <kbd key="3" />,
                <kbd key="4" />,
                <kbd key="5" />,
                <kbd key="6" />,
              ]}
            />
          </p>
        </>
      ) : (
        <>
          <p>
            <Trans
              i18nKey="game.app.playerControlsP1"
              components={[
                <b key="0" />,
                <b key="1" />,
                <b key="2" />,
                <b key="3" />,
                <b key="4" />,
                <b key="5" />,
                <b key="6" />,
              ]}
            />
          </p>
          <p>
            <Trans
              i18nKey="game.app.playerControlsP2"
              components={[
                <kbd key="0" />,
                <kbd key="1" />,
                <kbd key="2" />,
                <kbd key="3" />,
                <kbd key="4" />,
                <kbd key="5" />,
                <kbd key="6" />,
                <kbd key="7" />,
                <kbd key="8" />,
                <kbd key="9" />,
                <kbd key="10" />,
                <kbd key="11" />,
                <kbd key="12" />,
                <kbd key="13" />,
                <kbd key="14" />,
                <kbd key="15" />,
                <kbd key="16" />,
                <kbd key="17" />,
                <kbd key="18" />,
                <kbd key="19" />,
                <kbd key="20" />,
                <kbd key="21" />,
                <kbd key="22" />,
                <kbd key="23" />,
                <kbd key="24" />,
                <kbd key="25" />,
              ]}
            />
          </p>
        </>
      )}
      <p className="g-muted">
        {t("game.app.helpEnergy", {
          normalDeg,
          maxDeg,
          minAlt: minAlt.toLocaleString(),
        })}
      </p>
      <p className="g-muted">
        <Trans i18nKey="game.app.helpMap" values={{ gimbal, tws, detect }} components={[<i key="0" />]} />
      </p>
      <p className="g-muted">{t("game.app.helpFog")}</p>
      <p className="g-muted">
        <Trans i18nKey="game.app.helpRwr" components={[<b key="0" />]} />
      </p>
    </section>
  );
});

function fitView(v: GameView, s: SessionView) {
  v.rot = initialMapRotation(s.side);
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
