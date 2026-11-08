import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type FitTarget, fitAt } from "../map/fit.ts";
import { sampleAt } from "../map/mapData.ts";
import {
  type DrawOptions,
  drawMap,
  pick,
  type ScreenHit,
  type Theme,
  toWorld,
  type View,
} from "../map/render.ts";
import { distanceUnitM, distanceUnitName, labelText } from "../settings/units.ts";
import type { ViewProps } from "./viewTypes.ts";

/** Top-down 2D canvas map: light enough for any device. */
export function Map2D({
  data,
  t,
  trailS,
  labels,
  ground,
  selected,
  follow,
  onSelect,
  onUserMove,
  focus,
  settings,
}: ViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hitsRef = useRef<ScreenHit[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View | null>(null);
  const trackByUid = useMemo(() => new Map(data.tracks.map((tr) => [tr.uid, tr])), [data]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // The current time and selection, readable from effects without re-running them.
  const nowRef = useRef({ t, selected, ground });
  nowRef.current = { t, selected, ground };

  // First view: what's alive at the starting time. Then keep the view's size in sync.
  useEffect(() => {
    if (size.w === 0 || size.h === 0) return;
    setView((v) => {
      if (v) return { ...v, w: size.w, h: size.h };
      const now = nowRef.current;
      return viewForFit(fitAt(data, now.t, null, now.ground), size.w, size.h, null);
    });
  }, [size, data]);

  // Follow the selected object.
  useEffect(() => {
    if (!follow || selected === null) return;
    const tr = trackByUid.get(selected);
    const s = tr ? sampleAt(data, tr, t) : null;
    if (s) setView((v) => (v ? { ...v, cx: s.x, cy: s.y } : v));
  }, [follow, selected, t, data, trackByUid]);

  // Frame an object requested from the tables (about 40 km across unless already closer).
  useEffect(() => {
    if (!focus) return;
    const tr = trackByUid.get(focus.uid);
    const s = tr ? sampleAt(data, tr, Math.min(focus.time, tr.t1)) : null;
    if (s)
      setView((v) =>
        v ? { ...v, cx: s.x, cy: s.y, scale: Math.max(v.scale, Math.min(v.w, v.h) / 40000) } : v,
      );
  }, [focus, data, trackByUid]);

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
    const opts: DrawOptions = {
      trailS,
      labels,
      ground,
      selectedUid: selected,
      labelFor: (pilot, name, alt, speed) => labelText(pilot, name, alt, speed, settings),
      unitM: distanceUnitM(settings.units.distance),
      unitName: distanceUnitName(settings.units.distance),
    };
    hitsRef.current = drawMap(ctx, data, view, t, opts, readTheme());
  }, [data, view, t, trailS, labels, ground, selected, settings]);

  const zoomAt = useCallback((sx: number, sy: number, factor: number) => {
    setView((v) => {
      if (!v) return v;
      const [wx, wy] = toWorld(v, sx, sy);
      const scale = Math.min(Math.max(v.scale * factor, 1e-5), 2);
      // Keep the world point under the cursor fixed.
      return { ...v, scale, cx: wx - (sx - v.w / 2) / scale, cy: wy + (sy - v.h / 2) / scale };
    });
  }, []);

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
  }, [zoomAt]);

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
    onUserMove();
    setView((v) => (v ? { ...v, cx: v.cx - dx / v.scale, cy: v.cy + dy / v.scale } : v));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    const r = e.currentTarget.getBoundingClientRect();
    onSelect(pick(hitsRef.current, e.clientX - r.left, e.clientY - r.top));
  };

  return (
    <div className="map-view" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="map-canvas"
        style={{ width: size.w, height: size.h }}
        tabIndex={0}
        aria-label="Top-down map. Drag to pan, scroll to zoom, click an aircraft to select it. Space plays or pauses."
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
          title={selected !== null ? "Centre on the selected object" : "Fit everything in the air now"}
          onClick={() => {
            onUserMove();
            if (!size.w) return;
            setView((v) => viewForFit(fitAt(data, t, selected, ground), size.w, size.h, v));
          }}
        >
          Fit
        </button>
      </div>
    </div>
  );
}

/**
 * A 2D view showing a fit target. For a selected object the zoom only ever increases, so pressing
 * Fit while already zoomed in close re-centres without pulling the view back out.
 */
function viewForFit(f: FitTarget, w: number, h: number, current: View | null): View {
  const scale = (Math.min(w, h) * 0.9) / (2 * f.radius);
  return {
    cx: f.x,
    cy: f.y,
    scale: f.basis === "selected" && current ? Math.max(current.scale, scale) : scale,
    w,
    h,
  };
}

export function readTheme(): Theme {
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
