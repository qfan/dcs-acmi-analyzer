import { useCallback, useEffect, useRef, useState } from "react";
import { toWorld, type View } from "../../map/render.ts";
import { saveLastFile } from "../../ui/lastFile.ts";
import { SiteFooter } from "../../ui/SiteFooter.tsx";
import { acmiFileName } from "../acmi.ts";
import { AI_SKILL_CHOICES, DoctrineBot, type NpcStatus, skillChoiceLabel } from "../ai/doctrine.ts";
import { availableG, type Jet, mach, type Throttle } from "../sim/aircraft.ts";
import { FT, KT, NM } from "../sim/atmosphere.ts";
import { missileMach } from "../sim/missile.ts";
import type { GameParams } from "../sim/params.ts";
import {
  ALTITUDES_FT,
  DEFAULT_OPTIONS,
  SCENARIOS,
  type ScenarioOptions,
  scenarioById,
} from "../sim/scenarios.ts";
import { wrap2Pi } from "../sim/vec.ts";
import {
  awaitingCall,
  type Command,
  jetById,
  rwrContacts,
  type World,
  waitingOnMissiles,
} from "../sim/world.ts";
import { BGM_TRACKS, type BgmPlayer, createBgmPlayer } from "./bgm.ts";
import { drawScene, type Hit, sideCol } from "./draw.ts";
import { ParamEditor } from "./ParamEditor.tsx";
import { DEFAULT_AUTOPAUSE, GameSession, PLAYER_SIDE, TIME_SCALES } from "./session.ts";
import { loadLast, loadParams, saveLast, saveParams } from "./storage.ts";

/** Crank keeps the threat just inside the 60° radar gimbal. */
const CRANK_DEG = 50;
const HUD_MS = 100;

const fmtTime = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const deg = (r: number) => Math.round(((r * 180) / Math.PI + 360) % 360);

export function GameApp() {
  const [params, setParams] = useState<GameParams>(loadParams);
  const autoPause = DEFAULT_AUTOPAUSE;
  const last = loadLast();
  const [scenarioId, setScenarioId] = useState(last?.scenarioId ?? SCENARIOS[0]?.id ?? "duel");
  const [altFt, setAltFt] = useState<number>(last?.altFt ?? 25000);
  const [options, setOptions] = useState<ScenarioOptions>(last?.options ?? DEFAULT_OPTIONS);
  const [session, setSession] = useState<GameSession | null>(null);
  const [showStart, setShowStart] = useState(true);
  const [showParams, setShowParams] = useState(false);
  const [endSeen, setEndSeen] = useState(false);
  const [labels, setLabels] = useState(true);
  const [radarSectors, setRadarSectors] = useState(true);
  const [follow, setFollow] = useState(true);
  /** Fog of war: off by default each time the page opens. */
  const [fog, setFog] = useState(false);
  const fogRef = useRef(fog);
  fogRef.current = fog;
  const toggleFog = (on: boolean) => {
    setFog(on);
    fogRef.current = on;
    if (session) session.fog = on;
  };
  const [flash, setFlash] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [bgmOn, setBgmOn] = useState(false);
  const bgmRef = useRef<BgmPlayer | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const player = createBgmPlayer();
    bgmRef.current = player;
    return () => {
      player.dispose();
      bgmRef.current = null;
    };
  }, []);

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

  const start = useCallback(
    (id = scenarioId, alt = altFt) => {
      const s = new GameSession(id, alt, params, autoPause, Math.floor(Math.random() * 1e9), options);
      s.fog = fogRef.current;
      setSession(s);
      setShowStart(false);
      setEndSeen(false);
      saveLast(id, alt, s.options);
      fitView(viewRef.current, s);
    },
    [scenarioId, altFt, params, options],
  );

  const issue = useCallback(
    (make: (j: Jet) => Command | null) => {
      if (!session) return;
      if (session.watch) {
        setFlash("Watch mode: the NPC flies blue. Start the scenario with Blue: You fly to give orders.");
        return;
      }
      let err: string | null = null;
      for (const id of session.selected) {
        const j = jetById(session.world, id);
        if (!j?.alive) continue;
        const c = make(j);
        if (c) err = session.applyCommand(c) ?? err;
      }
      if (err) setFlash(err);
      setTick((t) => t + 1);
    },
    [session],
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
    if (session.paused) session.play();
    else session.pause("Paused.");
    setTick((t) => t + 1);
  }, [session]);

  const setScale = useCallback(
    (k: number) => {
      if (!session) return;
      session.timeScale = k;
      setTick((t) => t + 1);
    },
    [session],
  );

  // Main loop: advance the sim, refresh the launch zone, draw.
  useEffect(() => {
    if (!session) return;
    let raf = 0;
    let lastT = performance.now();
    let lastHud = 0;
    const frame = (now: number) => {
      const dt = (now - lastT) / 1000;
      lastT = now;
      session.advance(dt);
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
          hitsRef.current = drawScene(ctx, v, session, labelsRef.current, radarSectorsRef.current);
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
      else if (k === "v") setFollow(true);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [issue, steerRel, togglePause, setScale, showParams, showStart, session]);

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 3000);
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
    if (j.side === PLAYER_SIDE || session.watch) {
      if (!e.shiftKey || session.watch) session.selected.clear();
      if (e.shiftKey && !session.watch && session.selected.has(j.id)) session.selected.delete(j.id);
      else session.selected.add(j.id);
      setTick((t) => t + 1);
    } else if (j.alive) issue((mine) => ({ type: "target", jetId: mine.id, targetId: j.id }));
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
  const pAi = session && p ? npcStatus(session, p.id) : null;
  const npcControlled = !!session?.watch || pAi !== null;
  const watchJets = session?.watch && w ? w.jets.filter((j) => j.alive && session.sees(j.id)) : [];
  const ended = !!w?.outcome;
  const scenario = scenarioById(session?.scenarioId ?? scenarioId);

  return (
    <div className="g-app">
      <header className="g-top">
        <strong className="g-title">BVR Trainer</strong>
        <span className="g-muted g-hide-narrow">
          {scenario.title} · {(session?.altFt ?? altFt).toLocaleString()} ft
        </span>
        {session?.watch && <span className="g-watch-badge">NPC vs NPC · Watch</span>}
        <span className="g-grow" />
        {session && (
          <>
            <span className="g-clock">{fmtTime(w?.t ?? 0)}</span>
            <button
              type="button"
              className="g-primary g-play"
              onClick={togglePause}
              disabled={ended}
              title="Space"
            >
              {session.paused ? "▶ Play" : "❚❚ Pause"}
            </button>
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
          className={`g-fog ${fog ? "on" : ""}`}
          aria-pressed={fog}
          onClick={(e) => {
            toggleFog(!fog);
            e.currentTarget.blur(); // keep Space and the game keys working
          }}
          title="Fog of war: show only what your radar and RWR tell you"
        >
          {fog ? "◐ Fog of war: ON" : "○ Fog of war: OFF"}
        </button>
        <button type="button" onClick={() => setShowStart(true)}>
          Scenarios
        </button>
        <button
          type="button"
          onClick={() => session && start(session.scenarioId, session.altFt)}
          disabled={!session}
        >
          Restart
        </button>
        <button type="button" onClick={() => setShowParams(true)}>
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
              <span>{waitBanner(w, session.fog)}</span>
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
          </div>
        </div>

        <aside className="g-side">
          {session?.watch && watchJets.length > 0 && (
            <section className="g-card g-watch-bar" aria-label="Inspect AI jet">
              <div className="g-watch-head">
                <span className="g-muted">Inspect AI</span>
                <span className="g-watch-mode">No player control</span>
              </div>
              <div className="g-watch-jets">
                {watchJets.map((j) => {
                  const st = npcStatus(session, j.id);
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
                <Stat k="Speed" v={`${Math.round(p.speed / KT)} kt`} sub={`M${mach(p).toFixed(2)}`} />
                <Stat k="Altitude" v={`${Math.round(p.pos.z / FT).toLocaleString()} ft`} />
                <Stat
                  k="Load"
                  v={`${p.g.toFixed(1)} g`}
                  sub={`max ${availableG(w.params.aircraft, p, p.effort).toFixed(1)}`}
                />
                <Stat
                  k="Heading"
                  v={`${String(deg(p.hdg)).padStart(3, "0")}°`}
                  sub={npcState(session, p.id) ?? (p.steer.mode === "relative" ? p.steer.label : "heading")}
                />
                <Stat k="Missiles" v={`${p.missiles}`} sub={`chaff ${p.chaff} · flare ${p.flares}`} />
                <Stat
                  k="Radar"
                  v={tgt?.alive ? (w.radarTrack.get(p.id) ? "TRACK" : "no track") : "—"}
                  sub={tgt?.alive ? tgt.callsign : "no target"}
                />
              </div>
              <RwrLine session={session} jet={p} />
              {npcControlled ? (
                <NpcBehaviorPanel session={session} jet={p} ai={pAi} tgt={tgt} params={w.params} />
              ) : (
                <>
                  <div className="g-row">
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
                  <div className="g-row">
                    <span className="g-label">Turns</span>
                    <div className="g-seg">
                      {(["sustain", "normal", "max"] as const).map((t) => (
                        <button
                          type="button"
                          key={t}
                          className={p.effort === t ? "on" : ""}
                          title={
                            t === "sustain"
                              ? "Hold speed / Mach (zero energy bleed when thrust allows)"
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
                  .map((e, seq) => ({ e, seq }))
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
                  · <kbd>←</kbd>/<kbd>→</kbd> heading ±10° · <kbd>T</kbd> throttle · <kbd>G</kbd> turn mode ·{" "}
                  <kbd>Insert</kbd> chaff · <kbd>Delete</kbd> flare · <kbd>V</kbd> follow
                </p>
              </>
            )}
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
          scenarioId={scenarioId}
          altFt={altFt}
          missiles={params.aircraft.missiles}
          onScenario={(id) => {
            setScenarioId(id);
            if (scenarioById(id).allNpc && options.blueAi === null) {
              setOptions((o) => ({ ...o, blueAi: o.redSkill }));
            }
          }}
          onAlt={setAltFt}
          onMissiles={(n) => {
            const np: GameParams = { ...params, aircraft: { ...params.aircraft, missiles: n } };
            setParams(np);
            saveParams(np);
          }}
          options={options}
          onOptions={setOptions}
          onStart={() => start()}
          onClose={session ? () => setShowStart(false) : null}
          fog={fog}
          onFog={toggleFog}
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
      {ended && !endSeen && w?.outcome && (
        <div className="g-modal-back">
          <div className="g-modal g-end-dialog" role="dialog" aria-label="Result">
            <h2>{OUTCOME_TITLE[w.outcome.kind]}</h2>
            <p>{w.outcome.reason}</p>
            <p className="g-muted">Fight time {fmtTime(w.t)}.</p>
            <div className="g-row">
              <span className="g-label">Recording</span>
              <ExportButtons onExport={exportFight} />
            </div>
            <div className="g-row g-end">
              <button type="button" onClick={() => setEndSeen(true)}>
                Look at the map
              </button>
              <button type="button" onClick={() => setShowStart(true)}>
                Scenarios
              </button>
              <button
                type="button"
                className="g-primary"
                onClick={() => start(session?.scenarioId, session?.altFt)}
              >
                Restart
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Banner while a fight is waiting to be called. With fog of war it says the same thing whether or
 * not a missile is still coming, and the call itself comes after a random 5–10 s, so neither the
 * text nor the timing tells you what your RWR cannot.
 */
function waitBanner(w: World, fog: boolean): string {
  const meAlive = w.jets.some((j) => j.side === PLAYER_SIDE && j.alive);
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

function ZoneBox({ session }: { session: GameSession }) {
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

const LOADOUT_MISSILES = [4, 6, 8, 10] as const;

function StartDialog({
  scenarioId,
  altFt,
  missiles,
  onScenario,
  onAlt,
  onMissiles,
  options,
  onOptions,
  onStart,
  onClose,
  fog,
  onFog,
}: {
  scenarioId: string;
  altFt: number;
  missiles: number;
  onScenario: (id: string) => void;
  onAlt: (a: number) => void;
  onMissiles: (n: number) => void;
  options: ScenarioOptions;
  onOptions: (o: ScenarioOptions) => void;
  onStart: () => void;
  onClose: (() => void) | null;
  fog: boolean;
  onFog: (on: boolean) => void;
}) {
  const sel = scenarioById(scenarioId);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking the backdrop closes the dialog; Escape does too
    <div className="g-modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="g-modal g-start" role="dialog" aria-label="Choose a scenario">
        <h2>BVR Trainer</h2>
        <p className="g-muted">
          F/A-18C with AIM-120C on both sides. Jets hold their altitude for now; missiles loft and dive.
          Numbers are rough estimates you can change under Parameters.
        </p>
        <p className="g-disclaimer">
          A free, unofficial training game. Not affiliated with, endorsed by, or sponsored by Eagle Dynamics
          (DCS World) or Raia Software (Tacview). Simplified game values, not real-world data. Provided as-is,
          without warranty. Full notice at the bottom of the side panel.
        </p>
        <div className="g-scenarios">
          {SCENARIOS.map((s) => (
            <label key={s.id} className={`g-scn ${s.id === scenarioId ? "on" : ""}`}>
              <input
                type="radio"
                name="scn"
                checked={s.id === scenarioId}
                onChange={() => onScenario(s.id)}
              />
              <b>{s.title}</b>
              <span className="g-muted">{s.summary}</span>
            </label>
          ))}
        </div>
        <p className="g-lesson">{sel.lesson}</p>
        <div className="g-row">
          <span className="g-label">Altitude</span>
          <div className="g-seg">
            {ALTITUDES_FT.map((a) => (
              <button type="button" key={a} className={a === altFt ? "on" : ""} onClick={() => onAlt(a)}>
                {(a / 1000).toFixed(0)}k ft
              </button>
            ))}
          </div>
        </div>
        <div className="g-row">
          <span className="g-label">Loadout</span>
          <div className="g-seg">
            {LOADOUT_MISSILES.map((n) => (
              <button
                type="button"
                key={n}
                className={n === missiles ? "on" : ""}
                onClick={() => onMissiles(n)}
                title="Missiles per jet for both sides"
              >
                {n} missiles
              </button>
            ))}
          </div>
        </div>
        {sel.npc && (
          <>
            <div className="g-row">
              <span className="g-label">Bandits</span>
              <div className="g-seg">
                {AI_SKILL_CHOICES.map((k) => (
                  <button
                    type="button"
                    key={k}
                    className={options.redSkill === k ? "on" : ""}
                    onClick={() => onOptions({ ...options, redSkill: k })}
                    title={k === "random" ? "Pick Easy, Normal, or Hard per NPC at spawn time" : undefined}
                  >
                    {skillChoiceLabel(k)}
                  </button>
                ))}
              </div>
            </div>
            <div className="g-row">
              <span className="g-label">Blue</span>
              <div className="g-seg">
                {!sel.allNpc && (
                  <button
                    type="button"
                    className={options.blueAi === null ? "on" : ""}
                    onClick={() => onOptions({ ...options, blueAi: null })}
                  >
                    You fly
                  </button>
                )}
                {AI_SKILL_CHOICES.map((k) => {
                  const activeBlue = sel.allNpc ? (options.blueAi ?? options.redSkill) : options.blueAi;
                  return (
                    <button
                      type="button"
                      key={k}
                      className={activeBlue === k ? "on" : ""}
                      onClick={() => onOptions({ ...options, blueAi: k })}
                      title={
                        k === "random"
                          ? "Pick Easy, Normal, or Hard per Blue NPC at spawn time"
                          : "The NPC flies blue too: watch NPC vs NPC"
                      }
                    >
                      NPC {skillChoiceLabel(k)}
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}
        <div className="g-row">
          <span className="g-label">Fog of war</span>
          <div className="g-seg">
            <button type="button" className={fog ? "" : "on"} onClick={() => onFog(false)}>
              Off: see everything
            </button>
            <button type="button" className={fog ? "on" : ""} onClick={() => onFog(true)}>
              On: radar and RWR only
            </button>
          </div>
        </div>
        <div className="g-row g-end">
          {onClose && (
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          )}
          <button type="button" className="g-primary" onClick={onStart}>
            Start
          </button>
        </div>
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
function OwnMissileTimers({ session }: { session: GameSession }) {
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
              : tm.ghost.pitbull
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
function RwrLine({ session, jet }: { session: GameSession; jet: Jet }) {
  const contacts = rwrContacts(session.world, jet);
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

/** "NPC: support" when an NPC flies this jet, else null. */
function npcState(session: GameSession, jetId: string): string | null {
  const c = session.world.controllers.get(jetId);
  return c instanceof DoctrineBot ? `NPC ${c.skill.label}: ${c.describe()}` : null;
}

function npcStatus(session: GameSession, jetId: string): NpcStatus | null {
  const c = session.world.controllers.get(jetId);
  return c instanceof DoctrineBot ? c.status() : null;
}

function NpcBehaviorPanel({
  session,
  jet,
  ai,
  tgt,
  params,
}: {
  session: GameSession;
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
          Target <b>{tgt?.alive ? tgt.callsign : "—"}</b>
        </span>
      </div>
      {session.zone?.zone && <ZoneBox session={session} />}
    </div>
  );
}

function nearestKnownEnemy(
  s: GameSession,
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

function fightBox(s: GameSession) {
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

function centerOnFight(v: View, s: GameSession) {
  const b = fightBox(s);
  if (!Number.isFinite(b.x0)) return;
  v.cx = (b.x0 + b.x1) / 2;
  v.cy = (b.y0 + b.y1) / 2;
}

function fitView(v: View, s: GameSession) {
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
