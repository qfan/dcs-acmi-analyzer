import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { firstActivity, type MapData } from "../map/mapData.ts";
import { settingsStore, useSettings } from "../settings/react.ts";
import { type MapMode, PLAYBACK_SPEEDS, TRAIL_CHOICES } from "../settings/schema.ts";
import { Jog } from "./Jog.tsx";
import { type JogState, jogRate } from "./jog.ts";
import { Map2D } from "./Map2D.tsx";
import { SelectionPanel } from "./SelectionPanel.tsx";
import { type FollowMode, hasWebGL2, type MapFocus, type PickRole, type ViewProps } from "./viewTypes.ts";

export type { MapFocus } from "./viewTypes.ts";

// three.js is only downloaded when the 3D view is first opened.
const Scene3D = lazy(() => import("./Scene3D.tsx"));

const TRAIL_LABEL: Record<number, string> = {
  0: "No trails",
  15: "15 s trails",
  60: "1 min trails",
  300: "5 min trails",
};

/** The map panel: shared time, playback, selection and options, with a 2D or 3D view inside. */
export function MapView({
  data,
  fmt,
  focus,
}: {
  data: MapData;
  fmt: (t: number) => string;
  focus: MapFocus | null;
}) {
  const webgl = useMemo(hasWebGL2, []);
  const { settings } = useSettings();
  const update = settingsStore.update;
  // Remembered choices come from the settings store; 3D falls back to 2D without WebGL 2.
  const mode: MapMode = settings.map.mode === "3d" && webgl ? "3d" : "2d";
  const speed = settings.map.playbackSpeed;
  const trailS = settings.map.trailS;
  const labels = settings.labels.show;
  const ground = settings.map.groundUnits;

  const [t, setT] = useState(() => firstActivity(data));
  const [playing, setPlaying] = useState(false);
  const [primary, setPrimary] = useState<number | null>(null);
  const [secondary, setSecondary] = useState<number | null>(null);
  const [follow, setFollow] = useState<FollowMode>("off");
  const [armSecondary, setArmSecondary] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const trackByUid = useMemo(() => new Map(data.tracks.map((tr) => [tr.uid, tr])), [data]);

  /**
   * Make an object the primary. A free camera starts following it; following the secondary or the
   * pair carries on as it was (and "follow primary" simply moves to the new primary). Promoting the
   * secondary clears it, so a camera following it or the pair keeps following the same object as primary.
   */
  const selectPrimary = (uid: number) => {
    setPrimary(uid);
    const wasSecondary = uid === secondary;
    if (wasSecondary) setSecondary(null);
    setFollow((f) => (f === "off" || wasSecondary ? "primary" : f));
  };

  /**
   * Selection rules: Ctrl+left = primary, Ctrl+right = secondary; a plain click = primary (or the
   * secondary when "Pick secondary" is armed). Clicking the object already in that role clears it.
   * An object can't hold both roles. A click on empty map changes nothing.
   */
  const onPick = (uid: number | null, role: PickRole, explicit: boolean) => {
    if (uid === null) return;
    const r: PickRole = !explicit && armSecondary ? "secondary" : role;
    setArmSecondary(false);
    if (r === "primary") {
      if (uid === primary) setPrimary(null);
      else selectPrimary(uid);
    } else if (uid === secondary) setSecondary(null);
    else {
      setSecondary(uid);
      if (uid === primary) setPrimary(null);
    }
  };

  // Stop following a role that has been cleared.
  useEffect(() => {
    if (
      (follow === "primary" && primary === null) ||
      (follow === "secondary" && secondary === null) ||
      (follow === "pair" && (primary === null || secondary === null))
    )
      setFollow("off");
  }, [follow, primary, secondary]);

  // Playback: normal play at the chosen speed, or the jog control's rate (negative = backwards) while
  // it's held or latched. Time and rate are mirrored in refs so the animation loop reads them
  // synchronously; the loop runs only while the rate is non-zero.
  const [jog, setJog] = useState<JogState | null>(null);
  const rate = jog ? jogRate(jog.dx) : playing ? speed : 0;
  const tRef = useRef(t);
  tRef.current = t;
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const jogRef = useRef(jog);
  jogRef.current = jog;
  const running = rate !== 0;
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      // rAF timestamps can be slightly older than the performance.now() taken when scheduling.
      const dt = Math.max(0, Math.min((now - last) / 1000, 0.25));
      last = now;
      const r = rateRef.current;
      const next = tRef.current + dt * r;
      const j = jogRef.current;
      const atEnd = r > 0 && next >= data.timeEnd;
      if (atEnd || (r < 0 && next <= data.timeStart)) {
        const end = atEnd ? data.timeEnd : data.timeStart;
        tRef.current = end;
        setT(end);
        // Normal play and a latched jog stop at either end; a held jog waits there (drag back to leave).
        if (!j) return setPlaying(false);
        if (!j.holding) return setJog(null);
      } else {
        tRef.current = next;
        setT(next);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [running, data.timeEnd, data.timeStart]);

  /** Stop all motion: normal play and the jog. */
  const stop = () => {
    setPlaying(false);
    setJog(null);
  };
  /** Play/pause button and Space: a latched jog counts as playing, so this stops it. */
  const togglePlay = () => {
    if (jog || playing) return stop();
    if (tRef.current >= data.timeEnd) setT(data.timeStart); // replay from the start
    setPlaying(true);
  };
  const onJog = (s: JogState | null) => {
    if (s) setPlaying(false);
    setJog(s);
  };

  // Jump to a kill requested from the tables; the active view frames it.
  useEffect(() => {
    if (!focus) return;
    setPlaying(false);
    setJog(null);
    setT(Math.max(data.timeStart, focus.time - 8));
    setPrimary(focus.primary);
    setSecondary(focus.secondary);
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focus, data.timeStart]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === " ") {
      e.preventDefault();
      togglePlay();
    } else if (e.key === "ArrowRight") setT((x) => Math.min(data.timeEnd, x + 10));
    else if (e.key === "ArrowLeft") setT((x) => Math.max(data.timeStart, x - 10));
  };

  // Kill ticks never change during playback; build them once (there can be hundreds).
  const ticks = useMemo(() => {
    const span = Math.max(data.timeEnd - data.timeStart, 1e-6);
    return data.kills.map((k) => (
      <button
        type="button"
        tabIndex={-1}
        key={`${k.victimUid}:${k.time}`}
        className="tick"
        title={`Kill at ${fmt(k.time)}`}
        style={{ left: `${((k.time - data.timeStart) / span) * 100}%` }}
        onClick={() => {
          setPlaying(false);
          setJog(null);
          setT(Math.max(data.timeStart, k.time - 8));
          setPrimary(k.victimUid);
          setSecondary(null);
          // The pair is gone, so following the secondary or the pair would end anyway.
          setFollow("primary");
        }}
      />
    ));
  }, [data, fmt]);

  const primaryTrack = primary !== null ? trackByUid.get(primary) : undefined;
  const secondaryTrack = secondary !== null ? trackByUid.get(secondary) : undefined;
  const viewProps: ViewProps = {
    data,
    t,
    trailS,
    labels,
    ground,
    primary,
    secondary,
    follow,
    onPick,
    onUserMove: () => setFollow("off"),
    focus,
    settings,
  };

  return (
    <section className="card map-card" ref={panelRef}>
      <div className="card-head">
        <fieldset className="mode-switch">
          <legend className="sr-only">Map view</legend>
          <button
            type="button"
            className={mode === "2d" ? "on" : ""}
            aria-pressed={mode === "2d"}
            onClick={() => update({ map: { mode: "2d" } })}
          >
            2D
          </button>
          <button
            type="button"
            className={mode === "3d" ? "on" : ""}
            aria-pressed={mode === "3d"}
            disabled={!webgl}
            title={webgl ? "3D view (GPU)" : "3D needs WebGL 2, which this browser or device doesn't provide"}
            onClick={() => update({ map: { mode: "3d" } })}
          >
            3D
          </button>
        </fieldset>
        <div className="head-actions map-options">
          <select
            value={trailS}
            onChange={(e) => update({ map: { trailS: Number(e.target.value) } })}
            aria-label="Trail length"
          >
            {TRAIL_CHOICES.map((s) => (
              <option key={s} value={s}>
                {TRAIL_LABEL[s]}
              </option>
            ))}
          </select>
          <label className="toggle">
            <input
              type="checkbox"
              checked={labels}
              onChange={(e) => update({ labels: { show: e.target.checked } })}
            />{" "}
            Labels
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={ground}
              onChange={(e) => update({ map: { groundUnits: e.target.checked } })}
            />{" "}
            Ground and sea units
          </label>
        </div>
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: keyboard shortcuts for the map; all actions also have buttons */}
      <div className="map-wrap" onKeyDown={onKeyDown}>
        {mode === "3d" ? (
          <Suspense fallback={<p className="map-loading muted">Loading 3D view…</p>}>
            <Scene3D {...viewProps} />
          </Suspense>
        ) : (
          <Map2D {...viewProps} />
        )}
        {(primaryTrack || secondaryTrack) && (
          <SelectionPanel
            data={data}
            t={t}
            primary={primaryTrack}
            secondary={secondaryTrack}
            follow={follow}
            setFollow={setFollow}
            onClear={(role) => (role === "primary" ? setPrimary(null) : setSecondary(null))}
            onSwap={() => {
              setPrimary(secondary);
              setSecondary(primary);
            }}
            armSecondary={armSecondary}
            setArmSecondary={setArmSecondary}
            expanded={settings.map.infoPanel}
            setExpanded={(v) => update({ map: { infoPanel: v } })}
            settings={settings}
          />
        )}
      </div>
      <p className="muted small map-hint">
        Click or Ctrl+click: primary (the camera follows it) · Ctrl+right-click: secondary · click a selected
        object again to clear it
      </p>
      <div className="timeline">
        <button type="button" onClick={togglePlay} aria-label={playing || jog ? "Pause" : "Play"}>
          {playing || jog ? "❚❚" : "▶"}
        </button>
        <button
          type="button"
          className="secondary"
          aria-label="Back 10 seconds"
          onClick={() => setT((x) => Math.max(data.timeStart, x - 10))}
        >
          −10s
        </button>
        <button
          type="button"
          className="secondary"
          aria-label="Forward 10 seconds"
          onClick={() => setT((x) => Math.min(data.timeEnd, x + 10))}
        >
          +10s
        </button>
        <Jog value={jog} onChange={onJog} />
        <span className="time-now">{fmt(t)}</span>
        <div className="slider">
          <input
            type="range"
            min={data.timeStart}
            max={data.timeEnd}
            step={0.1}
            value={t}
            aria-label="Time"
            onChange={(e) => setT(Number(e.target.value))}
          />
          <div className="ticks" aria-hidden="true">
            {ticks}
          </div>
        </div>
        <select
          value={speed}
          onChange={(e) => update({ map: { playbackSpeed: Number(e.target.value) } })}
          aria-label="Playback speed"
        >
          {PLAYBACK_SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}
