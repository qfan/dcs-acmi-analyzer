import { type MapData, type MapTrack, pilotAt, sampleAt } from "./mapData.ts";
import { trailSecondsFor } from "./trails.ts";

/** World centre (metres), zoom (CSS pixels per metre), and canvas size in CSS pixels. */
export interface View {
  cx: number;
  cy: number;
  scale: number;
  w: number;
  h: number;
}

export interface Theme {
  bg: string;
  grid: string;
  gridText: string;
  text: string;
  halo: string;
}

export interface DrawOptions {
  trailS: number;
  labels: boolean;
  ground: boolean;
  primaryUid: number | null;
  secondaryUid: number | null;
  /** Range text for the line of sight between primary and secondary. */
  rangeLabel: (metres: number) => string;
  /** Builds an aircraft label from pilot, type, altitude (m) and speed (m/s) in the user's units. */
  labelFor: (pilot: string, name: string, altM: number, speedMs: number) => string;
  /** Grid and scale bar unit: metres per unit and its name. */
  unitM: number;
  unitName: string;
}

export interface ScreenHit {
  uid: number;
  sx: number;
  sy: number;
}

const SIDE_COLORS: Record<string, string> = {
  red: "#e5484d",
  blue: "#3b82f6",
  violet: "#a855f7",
  green: "#22c55e",
  orange: "#f97316",
  yellow: "#eab308",
  cyan: "#06b6d4",
};
export const sideColor = (side: string) => SIDE_COLORS[side.toLowerCase()] ?? "#9ca3af";

export const toScreen = (v: View, x: number, y: number): [number, number] => [
  v.w / 2 + (x - v.cx) * v.scale,
  v.h / 2 - (y - v.cy) * v.scale,
];
export const toWorld = (v: View, sx: number, sy: number): [number, number] => [
  v.cx + (sx - v.w / 2) / v.scale,
  v.cy - (sy - v.h / 2) / v.scale,
];

/** Fit a world rectangle into the view with a margin. */
export function fitView(
  b: { minX: number; minY: number; maxX: number; maxY: number },
  w: number,
  h: number,
): View {
  const spanX = Math.max(b.maxX - b.minX, 2000);
  const spanY = Math.max(b.maxY - b.minY, 2000);
  const scale = Math.min((w * 0.9) / spanX, (h * 0.9) / spanY);
  return { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale, w, h };
}

/** A 1-2-5 step close to `target` metres. */
export function niceStep(target: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(target, 1e-9)));
  for (const m of [1, 2, 5, 10]) if (m * p >= target) return m * p;
  return 10 * p;
}

/** A 1-2-5 step in the user's distance unit, returned in metres. */
export function niceStepIn(targetM: number, unitM: number): number {
  return niceStep(targetM / unitM) * unitM;
}

const fmtUnits = (m: number, unitM: number, name: string) => `${Number((m / unitM).toPrecision(3))} ${name}`;

const KILL_FADE_S = 60;

export function drawMap(
  ctx: CanvasRenderingContext2D,
  d: MapData,
  v: View,
  t: number,
  o: DrawOptions,
  theme: Theme,
): ScreenHit[] {
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, v.w, v.h);
  drawGrid(ctx, v, theme, o.unitM);

  const hits: ScreenHit[] = [];
  const labels: { text: string; x: number; y: number; first: boolean }[] = [];
  const order: Record<string, number> = {
    bullseye: 0,
    ground: 1,
    sea: 2,
    chute: 3,
    air: 4,
    heli: 4,
    weapon: 5,
  };
  const visible = d.tracks
    .filter((tr) => t >= tr.t0 && t <= tr.t1 && (o.ground || (tr.kind !== "ground" && tr.kind !== "sea")))
    .sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));

  // Kill markers under the live objects.
  for (const k of d.kills) {
    if (k.time > t) continue;
    const age = t - k.time;
    const [sx, sy] = toScreen(v, k.x, k.y);
    ctx.globalAlpha = age <= KILL_FADE_S ? 1 - (age / KILL_FADE_S) * 0.7 : 0.3;
    ctx.strokeStyle = k.cause === "weapon" ? "#f97316" : "#9ca3af";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx - 5, sy - 5);
    ctx.lineTo(sx + 5, sy + 5);
    ctx.moveTo(sx + 5, sy - 5);
    ctx.lineTo(sx - 5, sy + 5);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Line of sight between the primary and secondary selection, under the symbols.
  const pairPts: { x: number; y: number; alt: number }[] = [];
  for (const uid of [o.primaryUid, o.secondaryUid]) {
    const tr = uid === null ? undefined : d.tracks.find((x) => x.uid === uid);
    const s = tr ? sampleAt(d, tr, t) : null;
    if (s) pairPts.push(s);
  }
  if (pairPts.length === 2) {
    const [a, b] = pairPts as [(typeof pairPts)[number], (typeof pairPts)[number]];
    const range = Math.hypot(a.x - b.x, a.y - b.y, (a.alt || 0) - (b.alt || 0));
    drawSightLine(ctx, toScreen(v, a.x, a.y), toScreen(v, b.x, b.y), o.rangeLabel(range), theme);
  }

  for (const tr of visible) {
    const s = sampleAt(d, tr, t);
    if (!s) continue;
    const [sx, sy] = toScreen(v, s.x, s.y);
    const color = sideColor(tr.side);
    const role = tr.uid === o.primaryUid ? "primary" : tr.uid === o.secondaryUid ? "secondary" : null;
    const selected = role !== null;
    const moving = tr.kind === "air" || tr.kind === "heli" || tr.kind === "weapon";
    const trailS = moving ? trailSecondsFor(tr.uid, o.trailS, o.primaryUid, o.secondaryUid) : 0;
    if (trailS > 0) drawTrail(ctx, d, v, tr, t, trailS, s, color);
    if (sx < -50 || sy < -50 || sx > v.w + 50 || sy > v.h + 50) continue;
    drawIcon(ctx, tr, sx, sy, s.hdg, color);
    if (role) drawSelectionRing(ctx, sx, sy, role, theme);
    if (tr.kind !== "bullseye") hits.push({ uid: tr.uid, sx, sy });
    if ((o.labels && (tr.kind === "air" || tr.kind === "heli")) || selected) {
      labels.push({
        text: o.labelFor(pilotAt(tr, t), tr.name, s.alt, Math.hypot(s.speed, s.vz)),
        x: sx + 10,
        y: sy - 8,
        first: selected,
      });
    }
  }
  drawLabels(ctx, labels, theme);
  drawScaleBar(ctx, v, theme, o.unitM, o.unitName);
  return hits;
}

export const SECONDARY_COLOR = "#f59e0b";

/** Solid ring for the primary selection, dashed amber ring for the secondary. */
export function drawSelectionRing(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  role: "primary" | "secondary",
  theme: Theme,
) {
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = role === "primary" ? theme.text : SECONDARY_COLOR;
  if (role === "secondary") ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.arc(sx, sy, 13, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** Dashed line of sight between the two selected objects, with the range at its middle. */
export function drawSightLine(
  ctx: CanvasRenderingContext2D,
  a: [number, number],
  b: [number, number],
  text: string,
  theme: Theme,
) {
  ctx.save();
  ctx.strokeStyle = SECONDARY_COLOR;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();
  ctx.restore();
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 40)
    label(ctx, text, (a[0] + b[0]) / 2 + 6, (a[1] + b[1]) / 2 - 6, theme);
}

/** Draw labels, skipping any that would overlap one already placed (the selected one goes first). */
export function drawLabels(
  ctx: CanvasRenderingContext2D,
  labels: { text: string; x: number; y: number; first: boolean }[],
  theme: Theme,
) {
  ctx.font = "12px system-ui, sans-serif";
  const placed: [number, number, number, number][] = [];
  labels.sort((a, b) => Number(b.first) - Number(a.first));
  const overlaps = (b: [number, number, number, number]) =>
    placed.some((p) => b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1]);
  for (const l of labels) {
    const w = ctx.measureText(l.text).width;
    let y = l.y;
    let box: [number, number, number, number] = [l.x - 2, y - 12, l.x + w + 2, y + 4];
    if (overlaps(box)) {
      // Selected objects always get a label: move it down a line or two instead of hiding it.
      if (!l.first) continue;
      for (let step = 1; step <= 3 && overlaps(box); step++) {
        y = l.y + step * 16;
        box = [l.x - 2, y - 12, l.x + w + 2, y + 4];
      }
    }
    placed.push(box);
    label(ctx, l.text, l.x, y, theme);
  }
}

function drawGrid(ctx: CanvasRenderingContext2D, v: View, theme: Theme, unitM: number) {
  const step = niceStepIn(110 / v.scale, unitM);
  const [x0, y1] = [v.cx - v.w / 2 / v.scale, v.cy + v.h / 2 / v.scale];
  const [x1, y0] = [v.cx + v.w / 2 / v.scale, v.cy - v.h / 2 / v.scale];
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gx = Math.ceil(x0 / step) * step; gx <= x1; gx += step) {
    const [sx] = toScreen(v, gx, 0);
    ctx.moveTo(Math.round(sx) + 0.5, 0);
    ctx.lineTo(Math.round(sx) + 0.5, v.h);
  }
  for (let gy = Math.ceil(y0 / step) * step; gy <= y1; gy += step) {
    const [, sy] = toScreen(v, 0, gy);
    ctx.moveTo(0, Math.round(sy) + 0.5);
    ctx.lineTo(v.w, Math.round(sy) + 0.5);
  }
  ctx.stroke();
}

function drawScaleBar(ctx: CanvasRenderingContext2D, v: View, theme: Theme, unitM: number, unitName: string) {
  const m = niceStepIn(120 / v.scale, unitM);
  const px = m * v.scale;
  const x = 12;
  const y = v.h - 14;
  ctx.strokeStyle = theme.gridText;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y - 4);
  ctx.lineTo(x, y);
  ctx.lineTo(x + px, y);
  ctx.lineTo(x + px, y - 4);
  ctx.stroke();
  ctx.fillStyle = theme.gridText;
  ctx.font = "12px system-ui, sans-serif";
  const grid = niceStepIn(110 / v.scale, unitM);
  ctx.fillText(`${fmtUnits(m, unitM, unitName)} · grid ${fmtUnits(grid, unitM, unitName)}`, x + px + 8, y);
}

function drawTrail(
  ctx: CanvasRenderingContext2D,
  d: MapData,
  v: View,
  tr: MapTrack,
  t: number,
  seconds: number,
  head: { x: number; y: number },
  color: string,
) {
  const from = t - seconds;
  ctx.strokeStyle = color;
  ctx.globalAlpha = tr.kind === "weapon" ? 0.8 : 0.5;
  ctx.lineWidth = tr.kind === "weapon" ? 1.5 : 1.2;
  ctx.beginPath();
  let started = false;
  // Binary search for the first sample at or after `from`: tracks can hold tens of thousands of samples.
  let lo = 0;
  let hi = tr.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((d.times[tr.start + mid] as number) < from) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < tr.count; i++) {
    const k = tr.start + i;
    const tk = d.times[k] as number;
    if (tk > t) break;
    const [sx, sy] = toScreen(v, d.x[k] as number, d.y[k] as number);
    if (started) ctx.lineTo(sx, sy);
    else {
      ctx.moveTo(sx, sy);
      started = true;
    }
  }
  if (started) {
    const [hx, hy] = toScreen(v, head.x, head.y);
    ctx.lineTo(hx, hy);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawIcon(
  ctx: CanvasRenderingContext2D,
  tr: MapTrack,
  sx: number,
  sy: number,
  hdg: number,
  color: string,
) {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  switch (tr.kind) {
    case "air": {
      const a = (hdg * Math.PI) / 180;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(0, -8);
      ctx.lineTo(5.5, 6);
      ctx.lineTo(0, 3);
      ctx.lineTo(-5.5, 6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      break;
    }
    case "heli": {
      const a = (hdg * Math.PI) / 180;
      ctx.beginPath();
      ctx.arc(sx, sy, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + Math.sin(a) * 9, sy - Math.cos(a) * 9);
      ctx.stroke();
      break;
    }
    case "sea":
      ctx.beginPath();
      ctx.moveTo(sx, sy - 6);
      ctx.lineTo(sx + 6, sy);
      ctx.lineTo(sx, sy + 6);
      ctx.lineTo(sx - 6, sy);
      ctx.closePath();
      ctx.fill();
      break;
    case "ground":
      ctx.globalAlpha = 0.85;
      ctx.fillRect(sx - 2.5, sy - 2.5, 5, 5);
      ctx.globalAlpha = 1;
      break;
    case "weapon":
      ctx.beginPath();
      ctx.arc(sx, sy, 2.5, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "chute":
      ctx.beginPath();
      ctx.arc(sx, sy - 2, 4, Math.PI, 0);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(sx - 4, sy - 2);
      ctx.lineTo(sx, sy + 4);
      ctx.lineTo(sx + 4, sy - 2);
      ctx.stroke();
      break;
    case "bullseye":
      ctx.globalAlpha = 0.6;
      for (const r of [6, 12]) {
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      break;
  }
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, theme: Theme) {
  ctx.font = "12px system-ui, sans-serif";
  ctx.lineWidth = 3;
  ctx.strokeStyle = theme.halo;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = theme.text;
  ctx.fillText(text, x, y);
}

/** Nearest hit within `radius` CSS pixels. */
export function pick(hits: ScreenHit[], sx: number, sy: number, radius = 12): number | null {
  let best: number | null = null;
  let bestD = radius;
  for (const h of hits) {
    const dd = Math.hypot(h.sx - sx, h.sy - sy);
    if (dd <= bestD) {
      bestD = dd;
      best = h.uid;
    }
  }
  return best;
}
