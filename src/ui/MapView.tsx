import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { firstActivity, type MapData, pilotAt, sampleAt } from "../map/mapData.ts";
import { sideColor } from "../map/render.ts";
import { Map2D } from "./Map2D.tsx";
import { fmtAlt, fmtSpeed } from "./records.ts";
import { hasWebGL2, type MapFocus, type ViewProps } from "./viewTypes.ts";

export type { MapFocus } from "./viewTypes.ts";

// three.js is only downloaded when the 3D view is first opened.
const Scene3D = lazy(() => import("./Scene3D.tsx"));

type Mode = "2d" | "3d";
const MODE_KEY = "acmi-viewer.mapMode";
const SPEEDS = [1, 2, 4, 8, 16, 32, 64];
const TRAILS = [
  { s: 0, label: "No trails" },
  { s: 15, label: "15 s trails" },
  { s: 60, label: "1 min trails" },
  { s: 300, label: "5 min trails" },
];

function loadMode(webgl: boolean): Mode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    if (m === "2d" || (m === "3d" && webgl)) return m;
  } catch {
    // storage unavailable: fall through to the default
  }
  return "2d";
}

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
  const [mode, setModeState] = useState<Mode>(() => loadMode(webgl));
  const [t, setT] = useState(() => firstActivity(data));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(8);
  const [trailS, setTrailS] = useState(60);
  const [labels, setLabels] = useState(true);
  const [ground, setGround] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  const [follow, setFollow] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const trackByUid = useMemo(() => new Map(data.tracks.map((tr) => [tr.uid, tr])), [data]);

  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // not remembered; fine
    }
  };

  // Playback. The current time is mirrored in a ref so the animation loop reads it synchronously.
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    if (tRef.current >= data.timeEnd) setT(data.timeStart); // replay from the start
    const step = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.25);
      last = now;
      const next = tRef.current + dt * speed;
      if (next >= data.timeEnd) {
        setT(data.timeEnd);
        setPlaying(false);
        return;
      }
      tRef.current = next;
      setT(next);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, data.timeEnd, data.timeStart]);

  // Jump to a kill requested from the tables; the active view frames it.
  useEffect(() => {
    if (!focus) return;
    setPlaying(false);
    setT(Math.max(data.timeStart, focus.time - 8));
    setSelected(focus.uid);
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focus, data.timeStart]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === " ") {
      e.preventDefault();
      setPlaying((p) => !p);
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
          setT(Math.max(data.timeStart, k.time - 8));
          setSelected(k.victimUid);
        }}
      />
    ));
  }, [data, fmt]);

  const sel = selected !== null ? trackByUid.get(selected) : undefined;
  const selSample = sel ? sampleAt(data, sel, t) : null;
  const viewProps: ViewProps = {
    data,
    t,
    trailS,
    labels,
    ground,
    selected,
    follow,
    onSelect: setSelected,
    onUserMove: () => setFollow(false),
    focus,
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
            onClick={() => setMode("2d")}
          >
            2D
          </button>
          <button
            type="button"
            className={mode === "3d" ? "on" : ""}
            aria-pressed={mode === "3d"}
            disabled={!webgl}
            title={webgl ? "3D view (GPU)" : "3D needs WebGL 2, which this browser or device doesn't provide"}
            onClick={() => setMode("3d")}
          >
            3D
          </button>
        </fieldset>
        <div className="head-actions map-options">
          <select
            value={trailS}
            onChange={(e) => setTrailS(Number(e.target.value))}
            aria-label="Trail length"
          >
            {TRAILS.map((x) => (
              <option key={x.s} value={x.s}>
                {x.label}
              </option>
            ))}
          </select>
          <label className="toggle">
            <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /> Labels
          </label>
          <label className="toggle">
            <input type="checkbox" checked={ground} onChange={(e) => setGround(e.target.checked)} /> Ground
            and sea units
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
        {sel && selSample && (
          <div className="map-info">
            <div className="map-info-title">
              <span className="dot" style={{ background: sideColor(sel.side) }} />
              {pilotAt(sel, t) ? `${pilotAt(sel, t)} · ` : ""}
              {sel.name}
            </div>
            <div>
              {fmtAlt(Number.isFinite(selSample.alt) ? selSample.alt : null)}
              {Math.abs(selSample.vz) >= 2
                ? ` · ${selSample.vz > 0 ? "climbing" : "descending"} ${Math.round(Math.abs(selSample.vz))} m/s`
                : ""}
            </div>
            <div>
              {fmtSpeed(selSample.speed)} ground speed · heading {Math.round(selSample.hdg)}°
            </div>
            <label className="toggle">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
            </label>
            <button
              type="button"
              className="link close"
              aria-label="Deselect"
              onClick={() => setSelected(null)}
            >
              ×
            </button>
          </div>
        )}
      </div>
      <div className="timeline">
        <button type="button" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play"}>
          {playing ? "❚❚" : "▶"}
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
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}
