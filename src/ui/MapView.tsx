import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { firstActivity, type MapData, pilotAt, sampleAt } from "../map/mapData.ts";
import {
  type DrawOptions,
  drawMap,
  fitView,
  pick,
  type ScreenHit,
  sideColor,
  type Theme,
  toWorld,
  type View,
} from "../map/render.ts";
import { fmtAlt, fmtSpeed } from "./records.ts";

export interface MapFocus {
  time: number;
  uid: number;
  /** Increments on every request so the same kill can be shown twice. */
  seq: number;
}

const SPEEDS = [1, 2, 4, 8, 16, 32, 64];
const TRAILS = [
  { s: 0, label: "No trails" },
  { s: 15, label: "15 s trails" },
  { s: 60, label: "1 min trails" },
  { s: 300, label: "5 min trails" },
];

export function MapView({
  data,
  fmt,
  focus,
}: {
  data: MapData;
  fmt: (t: number) => string;
  focus: MapFocus | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hitsRef = useRef<ScreenHit[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View | null>(null);
  const [t, setT] = useState(() => firstActivity(data));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(8);
  const [trailS, setTrailS] = useState(60);
  const [labels, setLabels] = useState(true);
  const [ground, setGround] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  const [follow, setFollow] = useState(false);
  const trackByUid = useMemo(() => new Map(data.tracks.map((tr) => [tr.uid, tr])), [data]);

  // Canvas size follows its container.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // First fit, and keep the view's size in sync.
  useEffect(() => {
    if (size.w === 0 || size.h === 0) return;
    setView((v) => (v ? { ...v, w: size.w, h: size.h } : fitView(data.focus, size.w, size.h)));
  }, [size, data]);

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

  // Follow the selected object.
  useEffect(() => {
    if (!follow || selected === null) return;
    const tr = trackByUid.get(selected);
    const s = tr ? sampleAt(data, tr, t) : null;
    if (s) setView((v) => (v ? { ...v, cx: s.x, cy: s.y } : v));
  }, [follow, selected, t, data, trackByUid]);

  // Jump to a kill requested from the tables.
  useEffect(() => {
    if (!focus) return;
    setPlaying(false);
    setT(Math.max(data.timeStart, focus.time - 8));
    setSelected(focus.uid);
    const tr = trackByUid.get(focus.uid);
    const s = tr ? sampleAt(data, tr, Math.min(focus.time, tr.t1)) : null;
    if (s)
      setView((v) => {
        if (!v) return v;
        // Show about 40 km across unless already zoomed in closer.
        const scale = Math.max(v.scale, Math.min(v.w, v.h) / 40000);
        return { ...v, cx: s.x, cy: s.y, scale };
      });
    wrapRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focus, data, trackByUid]);

  // Draw.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !view || view.w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(view.w * dpr) || canvas.height !== Math.round(view.h * dpr)) {
      canvas.width = Math.round(view.w * dpr);
      canvas.height = Math.round(view.h * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const opts: DrawOptions = { trailS, labels, ground, selectedUid: selected };
    hitsRef.current = drawMap(ctx, data, view, t, opts, readTheme());
  }, [data, view, t, trailS, labels, ground, selected]);

  // Wheel zoom around the cursor (non-passive so the page doesn't scroll).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  });

  const zoomAt = useCallback((sx: number, sy: number, factor: number) => {
    setView((v) => {
      if (!v) return v;
      const [wx, wy] = toWorld(v, sx, sy);
      const scale = Math.min(Math.max(v.scale * factor, 1e-5), 2);
      // Keep the world point under the cursor fixed.
      return { ...v, scale, cx: wx - (sx - v.w / 2) / scale, cy: wy + (sy - v.h / 2) / scale };
    });
  }, []);

  // Drag to pan; a click without movement selects.
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    setFollow(false);
    setView((v) => (v ? { ...v, cx: v.cx - dx / v.scale, cy: v.cy + dy / v.scale } : v));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    const r = e.currentTarget.getBoundingClientRect();
    setSelected(pick(hitsRef.current, e.clientX - r.left, e.clientY - r.top));
  };

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

  return (
    <section className="card map-card">
      <div className="card-head">
        <h3>Map</h3>
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
      <div className="map-wrap" ref={wrapRef} onKeyDown={onKeyDown}>
        <canvas
          ref={canvasRef}
          className="map-canvas"
          style={{ width: size.w, height: size.h }}
          tabIndex={0}
          aria-label="Map of the recording. Drag to pan, scroll to zoom, click an aircraft to select it. Space plays or pauses."
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
        <div className="map-zoom">
          <button
            type="button"
            className="secondary"
            aria-label="Zoom in"
            onClick={() => view && zoomAt(view.w / 2, view.h / 2, 1.6)}
          >
            +
          </button>
          <button
            type="button"
            className="secondary"
            aria-label="Zoom out"
            onClick={() => view && zoomAt(view.w / 2, view.h / 2, 1 / 1.6)}
          >
            −
          </button>
          <button
            type="button"
            className="secondary"
            title="Fit the action"
            onClick={() => {
              setFollow(false);
              if (size.w) setView(fitView(data.focus, size.w, size.h));
            }}
          >
            Fit
          </button>
        </div>
        {sel && selSample && (
          <div className="map-info">
            <div className="map-info-title">
              <span className="dot" style={{ background: sideColor(sel.side) }} />
              {pilotAt(sel, t) ? `${pilotAt(sel, t)} · ` : ""}
              {sel.name}
            </div>
            <div>{fmtAlt(Number.isFinite(selSample.alt) ? selSample.alt : null)}</div>
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

function readTheme(): Theme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: v("--map-bg", "#0f172a"),
    grid: v("--map-grid", "rgba(148,163,184,0.18)"),
    gridText: v("--muted", "#94a3b8"),
    text: v("--text", "#e5e7eb"),
    halo: v("--map-bg", "#0f172a"),
  };
}
