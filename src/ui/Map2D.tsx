import { useCallback, useEffect, useRef, useState } from "react";
import { type FitTarget, fitAt } from "../map/fit.ts";
import {
  type DrawOptions,
  drawMap,
  pick,
  type ScreenHit,
  type Theme,
  toWorld,
  type View,
} from "../map/render.ts";
import { distanceUnitM, distanceUnitName, fmtDist, labelText } from "../settings/units.ts";
import { followTarget } from "./follow.ts";
import { useCtrlPick } from "./useCtrlPick.ts";
import type { ViewProps } from "./viewTypes.ts";

/** Top-down 2D canvas map: light enough for any device. */
export function Map2D({
  data,
  t,
  trailS,
  labels,
  ground,
  primary,
  secondary,
  follow,
  onPick,
  onUserMove,
  focus,
  settings,
}: ViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hitsRef = useRef<ScreenHit[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View | null>(null);
  useCtrlPick(wrapRef, hitsRef, onPick);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // The current time and options, readable from effects without re-running them.
  const nowRef = useRef({ t, ground });
  nowRef.current = { t, ground };

  // First view: what's alive at the starting time. Then keep the view's size in sync.
  useEffect(() => {
    if (size.w === 0 || size.h === 0) return;
    setView((v) => {
      if (v) return { ...v, w: size.w, h: size.h };
      const now = nowRef.current;
      return viewForFit(fitAt(data, now.t, NO_SELECTION, now.ground), size.w, size.h, null);
    });
  }, [size, data]);

  // Camera follow: primary, secondary, or the pair. For the pair, keep the zoom the user chose and
  // zoom out beyond it only while the two would otherwise leave the view.
  const followScale = useRef<{ set: number | null; preferred: number | null }>({
    set: null,
    preferred: null,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new follow mode or selection starts from the current zoom
  useEffect(() => {
    followScale.current = { set: null, preferred: null };
  }, [follow, primary, secondary]);
  useEffect(() => {
    const f = followTarget(data, t, follow, { primary, secondary });
    if (!f) return;
    setView((v) => {
      if (!v) return v;
      if (f.basis !== "pair") return { ...v, cx: f.x, cy: f.y };
      const s = followScale.current;
      // A zoom other than the one follow last set means the user zoomed: that's the new preference.
      if (s.set === null || Math.abs(v.scale - s.set) > v.scale * 1e-6) s.preferred = v.scale;
      const fitScale = (Math.min(v.w, v.h) * 0.9) / (2 * f.radius);
      const scale = Math.min(s.preferred ?? v.scale, fitScale);
      s.set = scale;
      return { ...v, cx: f.x, cy: f.y, scale };
    });
  }, [follow, primary, secondary, t, data]);

  // Frame what the tables asked for (about 40 km across unless already closer), or the pair.
  useEffect(() => {
    if (!focus) return;
    const f = fitAt(data, focus.time, { primary: focus.primary, secondary: focus.secondary });
    const one = fitAt(data, focus.time, { primary: focus.uid, secondary: null });
    const target = f.basis === "pair" ? f : one;
    if (target.basis === "alive" || target.basis === "recording") return;
    setView((v) => {
      if (!v) return v;
      const fitScale = (Math.min(v.w, v.h) * 0.9) / (2 * Math.max(target.radius, 20000));
      return { ...v, cx: target.x, cy: target.y, scale: Math.max(v.scale, fitScale) };
    });
  }, [focus, data]);

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
      primaryUid: primary,
      secondaryUid: secondary,
      rangeLabel: (m) => fmtDist(m, settings.units.distance),
      labelFor: (pilot, name, alt, speed) => labelText(pilot, name, alt, speed, settings),
      unitM: distanceUnitM(settings.units.distance),
      unitName: distanceUnitName(settings.units.distance),
    };
    hitsRef.current = drawMap(ctx, data, view, t, opts, readTheme());
  }, [data, view, t, trailS, labels, ground, primary, secondary, settings]);

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

  // Drag to pan; a plain click without movement picks (Ctrl clicks are handled by useCtrlPick).
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
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
    onPick(pick(hitsRef.current, e.clientX - r.left, e.clientY - r.top), "primary", false);
  };

  const fitTitle =
    primary !== null && secondary !== null
      ? "Fit the selected pair"
      : primary !== null || secondary !== null
        ? "Centre on the selected object"
        : "Fit everything in the air now";

  return (
    <div className="map-view" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="map-canvas"
        style={{ width: size.w, height: size.h }}
        tabIndex={0}
        aria-label="Top-down map. Drag to pan, scroll to zoom. Click or Ctrl+click an aircraft for the primary selection, Ctrl+right-click for the secondary. Space plays or pauses."
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
          title={fitTitle}
          onClick={() => {
            onUserMove();
            if (!size.w) return;
            setView((v) => viewForFit(fitAt(data, t, { primary, secondary }, ground), size.w, size.h, v));
          }}
        >
          Fit
        </button>
      </div>
    </div>
  );
}

const NO_SELECTION = { primary: null, secondary: null };

/**
 * A 2D view showing a fit target. For a single selected object the zoom only ever increases, so
 * pressing Fit while already zoomed in close re-centres without pulling the view back out.
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
