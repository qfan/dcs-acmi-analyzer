/** Top-down canvas renderer for the game, in the style of the viewer's 2D map. */
import i18n from "../../i18n/index.ts";
import { niceStep, toScreen, type View } from "../../map/render.ts";
import { type Jet, mach, velocity, verticalSpeed } from "../sim/aircraft.ts";
import { DEG, FT, NM } from "../sim/atmosphere.ts";
import { type Missile, missileMach } from "../sim/missile.ts";
import { desiredSteerHeading, jetById, rwrContacts, type World } from "../sim/world.ts";
import type { SessionView } from "./view.ts";

export const COLORS = {
  bg: "#0a1018",
  grid: "rgba(148, 163, 184, 0.10)",
  gridText: "rgba(148, 163, 184, 0.45)",
  text: "#dbe3ee",
  halo: "rgba(10, 16, 24, 0.85)",
  blue: "#4f9dff",
  red: "#ff5a5f",
  dead: "#6b7280",
  select: "#fbbf24",
  rmax: "#34d399",
  rne: "#f87171",
  rwrRadar: "#fbbf24",
  rwrMissile: "#ff3b3b",
};

export const sideCol = (side: string) => (side === "blue" ? COLORS.blue : COLORS.red);

export interface Hit {
  id: string;
  sx: number;
  sy: number;
}

function label(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  align: CanvasTextAlign = "left",
) {
  ctx.textAlign = align;
  ctx.lineWidth = 3;
  ctx.strokeStyle = COLORS.halo;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function drawGrid(ctx: CanvasRenderingContext2D, v: View) {
  const stepM = niceStep(110 / v.scale / NM) * NM;
  const x0 = v.cx - v.w / 2 / v.scale;
  const x1 = v.cx + v.w / 2 / v.scale;
  const y0 = v.cy - v.h / 2 / v.scale;
  const y1 = v.cy + v.h / 2 / v.scale;
  const hw = v.w / 2;
  const hh = v.h / 2;
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = Math.ceil(x0 / stepM) * stepM; x <= x1; x += stepM) {
    const sx = Math.round(hw + (x - v.cx) * v.scale) + 0.5;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, v.h);
  }
  for (let y = Math.ceil(y0 / stepM) * stepM; y <= y1; y += stepM) {
    const sy = Math.round(hh - (y - v.cy) * v.scale) + 0.5;
    ctx.moveTo(0, sy);
    ctx.lineTo(v.w, sy);
  }
  ctx.stroke();
  // Scale bar
  const barM = stepM;
  const px = barM * v.scale;
  ctx.strokeStyle = COLORS.gridText;
  ctx.beginPath();
  ctx.moveTo(16, v.h - 18);
  ctx.lineTo(16 + px, v.h - 18);
  ctx.moveTo(16, v.h - 23);
  ctx.lineTo(16, v.h - 13);
  ctx.moveTo(16 + px, v.h - 23);
  ctx.lineTo(16 + px, v.h - 13);
  ctx.stroke();
  ctx.font = "11px system-ui, sans-serif";
  label(ctx, `${Number((barM / NM).toPrecision(3))} nm`, 16 + px / 2, v.h - 26, COLORS.gridText, "center");
}

/** Radar coverage: shaded ± gimbal out to the TWS lock range, dashed out to detection range. */
function drawRadar(ctx: CanvasRenderingContext2D, v: View, w: World, j: Jet, strong: boolean) {
  const [sx, sy] = toScreen(v, j.pos.x, j.pos.y);
  const r = w.params.radar.rangeNm * NM * v.scale;
  const g = w.params.radar.gimbalDeg * DEG;
  // Canvas angles: 0 = +x (east), clockwise positive (y down). Heading 0 = north = −π/2.
  const a = j.hdg - Math.PI / 2;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.arc(sx, sy, r, a - g, a + g);
  ctx.closePath();
  ctx.fillStyle =
    j.side === "blue"
      ? `rgba(79,157,255,${strong ? 0.09 : 0.04})`
      : `rgba(255,90,95,${strong ? 0.08 : 0.04})`;
  ctx.fill();
  ctx.strokeStyle =
    j.side === "blue" ? `rgba(79,157,255,${strong ? 0.45 : 0.18})` : `rgba(255,90,95,${strong ? 0.4 : 0.18})`;
  ctx.lineWidth = 1;
  ctx.stroke();
  // Detection reaches further than the TWS lock: a faint dashed outer band.
  const rd = Math.max(w.params.radar.detectRangeNm, w.params.radar.rangeNm) * NM * v.scale;
  if (rd > r + 1) {
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.arc(sx, sy, rd, a - g, a + g);
    ctx.moveTo(sx + Math.cos(a - g) * r, sy + Math.sin(a - g) * r);
    ctx.lineTo(sx + Math.cos(a - g) * rd, sy + Math.sin(a - g) * rd);
    ctx.moveTo(sx + Math.cos(a + g) * r, sy + Math.sin(a + g) * r);
    ctx.lineTo(sx + Math.cos(a + g) * rd, sy + Math.sin(a + g) * rd);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawTrail(
  ctx: CanvasRenderingContext2D,
  v: View,
  pts: { x: number; y: number }[],
  head: { x: number; y: number } | null,
  color: string,
  width: number,
) {
  if (pts.length === 0) return;
  const hw = v.w / 2;
  const hh = v.h / 2;
  const { cx, cy, scale } = v;
  ctx.beginPath();
  const p0 = pts[0] as { x: number; y: number };
  ctx.moveTo(hw + (p0.x - cx) * scale, hh - (p0.y - cy) * scale);
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i] as { x: number; y: number };
    ctx.lineTo(hw + (p.x - cx) * scale, hh - (p.y - cy) * scale);
  }
  if (head) {
    ctx.lineTo(hw + (head.x - cx) * scale, hh - (head.y - cy) * scale);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function drawJet(ctx: CanvasRenderingContext2D, v: View, j: Jet, selected: boolean, targeted: boolean) {
  const [sx, sy] = toScreen(v, j.pos.x, j.pos.y);
  const col = j.alive ? sideCol(j.side) : COLORS.dead;
  if (!j.alive) {
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx - 6, sy - 6);
    ctx.lineTo(sx + 6, sy + 6);
    ctx.moveTo(sx + 6, sy - 6);
    ctx.lineTo(sx - 6, sy + 6);
    ctx.stroke();
    return;
  }
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(j.hdg);
  ctx.beginPath();
  ctx.moveTo(0, -11);
  ctx.lineTo(7, 8);
  ctx.lineTo(0, 4);
  ctx.lineTo(-7, 8);
  ctx.closePath();
  ctx.fillStyle = col;
  ctx.fill();
  ctx.strokeStyle = COLORS.halo;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
  if (selected) {
    ctx.strokeStyle = COLORS.select;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(sx, sy, 16, 0, 2 * Math.PI);
    ctx.stroke();
  }
  if (targeted) {
    ctx.strokeStyle = COLORS.select;
    ctx.lineWidth = 1.5;
    const s = 15;
    ctx.beginPath();
    for (const [dx, dy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      ctx.moveTo(sx + dx * s, sy + dy * (s - 6));
      ctx.lineTo(sx + dx * s, sy + dy * s);
      ctx.lineTo(sx + dx * (s - 6), sy + dy * s);
    }
    ctx.stroke();
  }
}

function drawMissile(ctx: CanvasRenderingContext2D, v: View, w: World, m: Missile, labels: boolean) {
  const [sx, sy] = toScreen(v, m.pos.x, m.pos.y);
  const col = sideCol(m.side);
  const tgt = jetById(w, m.targetId);
  // What the missile knows: a line to where it thinks the target is.
  const [ex, ey] = toScreen(v, m.estPos.x, m.estPos.y);
  ctx.lineWidth = 1;
  if (m.phase === "datalink" || m.phase === "tracking") {
    ctx.setLineDash(m.phase === "tracking" ? [] : [2, 3]);
    ctx.strokeStyle = m.phase === "tracking" ? col : `${col}99`;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  } else if (m.phase === "inertial" || m.phase === "search") {
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = `${col}88`;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = col;
    ctx.beginPath();
    ctx.moveTo(ex - 5, ey - 5);
    ctx.lineTo(ex + 5, ey + 5);
    ctx.moveTo(ex + 5, ey - 5);
    ctx.lineTo(ex - 5, ey + 5);
    ctx.stroke();
    if (m.phase === "search") {
      // Seeker search cone, centred on where the missile expects the target.
      const a = Math.atan2(ey - sy, ex - sx);
      const g = w.params.missile.seekerSearchDeg * DEG;
      const r = w.params.missile.seekerRangeNm * NM * v.scale;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.arc(sx, sy, r, a - g, a + g);
      ctx.closePath();
      ctx.fillStyle = `${col}22`;
      ctx.fill();
    }
  }
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(sx, sy, 3.5, 0, 2 * Math.PI);
  ctx.fillStyle = m.phase === "lost" ? COLORS.dead : col;
  ctx.fill();
  if (labels) {
    const phase = { datalink: "DL", inertial: "NO DL", search: "ACTIVE", tracking: "TRACK", lost: "LOST" }[
      m.phase
    ];
    const rng = tgt ? Math.hypot(tgt.pos.x - m.pos.x, tgt.pos.y - m.pos.y, tgt.pos.z - m.pos.z) / NM : 0;
    ctx.font = "10px system-ui, sans-serif";
    label(
      ctx,
      `${m.id} M${missileMach(m).toFixed(1)} ${phase} ${(m.pos.z / FT / 1000).toFixed(0)}k ${rng.toFixed(1)}nm`,
      sx + 7,
      sy - 6,
      col,
    );
  }
}

/** Released chaff (grey specks) and flares (orange), fading out. */
function drawDecoys(ctx: CanvasRenderingContext2D, v: View, s: SessionView) {
  const w = s.world;
  for (const d of w.decoys) {
    if (!s.sees(d.jetId)) continue;
    const age = w.t - d.t0;
    const a = Math.max(0, 1 - age / 4);
    const [sx, sy] = toScreen(v, d.pos.x, d.pos.y);
    if (d.kind === "flare") {
      ctx.fillStyle = `rgba(251,146,60,${a})`;
      ctx.beginPath();
      ctx.arc(sx, sy, 2.5, 0, 2 * Math.PI);
      ctx.fill();
    } else {
      ctx.fillStyle = `rgba(203,213,225,${a * 0.8})`;
      for (const [dx, dy] of [
        [0, 0],
        [3, 2],
        [-2, 3],
        [2, -3],
      ] as const)
        ctx.fillRect(sx + dx * (1 + age), sy + dy * (1 + age), 1.5, 1.5);
    }
  }
}

const RWR_R = 26;

/**
 * RWR on the map: a ring around each of your jets with a tick on the bearing of each emitter.
 * Short amber tick = an enemy radar scanning you; long red tick = an active missile seeker, blinking
 * when it is locked on you. With fog of war on, missile ticks also get a strobe line, since the
 * missile itself is hidden.
 */
function drawRwr(ctx: CanvasRenderingContext2D, v: View, s: SessionView, j: Jet) {
  const contacts = rwrContacts(s.world, j);
  const [sx, sy] = toScreen(v, j.pos.x, j.pos.y);
  ctx.strokeStyle = contacts.length > 0 ? "rgba(219,227,238,0.35)" : "rgba(219,227,238,0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(sx, sy, RWR_R, 0, 2 * Math.PI);
  ctx.stroke();
  const blink = Math.floor(performance.now() / 250) % 2 === 0;
  for (const c of contacts) {
    const ux = Math.sin(c.bearing);
    const uy = -Math.cos(c.bearing);
    if (c.kind === "radar") {
      ctx.strokeStyle = COLORS.rwrRadar;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(sx + ux * (RWR_R - 4), sy + uy * (RWR_R - 4));
      ctx.lineTo(sx + ux * (RWR_R + 6), sy + uy * (RWR_R + 6));
      ctx.stroke();
      continue;
    }
    if (c.lock && !blink) continue;
    ctx.strokeStyle = COLORS.rwrMissile;
    ctx.lineWidth = c.lock ? 4 : 2.5;
    ctx.beginPath();
    ctx.moveTo(sx + ux * (RWR_R - 6), sy + uy * (RWR_R - 6));
    ctx.lineTo(sx + ux * (RWR_R + 14), sy + uy * (RWR_R + 14));
    ctx.stroke();
    if (s.fog) {
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(sx + ux * (RWR_R + 14), sy + uy * (RWR_R + 14));
      ctx.lineTo(sx + ux * 160, sy + uy * 160);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.font = "bold 10px system-ui, sans-serif";
    label(ctx, "M", sx + ux * (RWR_R + 22), sy + uy * (RWR_R + 22) + 3, COLORS.rwrMissile, "center");
  }
}

/** Last position where your side saw a hidden enemy (fog of war). */
function drawGhost(
  ctx: CanvasRenderingContext2D,
  v: View,
  s: SessionView,
  j: Jet,
  labels: boolean,
): Hit | null {
  const g = s.lastSeen.get(j.id);
  if (!g) return null;
  const [sx, sy] = toScreen(v, g.x, g.y);
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(g.hdg);
  ctx.beginPath();
  ctx.moveTo(0, -11);
  ctx.lineTo(7, 8);
  ctx.lineTo(0, 4);
  ctx.lineTo(-7, 8);
  ctx.closePath();
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = `${sideCol(j.side)}99`;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
  if (labels) {
    ctx.font = "11px system-ui, sans-serif";
    label(ctx, `${j.callsign}?`, sx + 14, sy - 4, `${sideCol(j.side)}aa`);
    label(ctx, `last seen ${Math.round(s.world.t - g.t)} s ago`, sx + 14, sy + 9, COLORS.gridText);
  }
  return { id: j.id, sx, sy };
}

export function drawScene(
  ctx: CanvasRenderingContext2D,
  v: View,
  s: SessionView,
  labels: boolean,
  radarSectors = true,
  sideView = false,
): Hit[] {
  const w = s.world;
  const hits: Hit[] = [];
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, v.w, v.h);
  drawGrid(ctx, v);

  if (radarSectors)
    for (const j of w.jets) if (j.alive && s.sees(j.id)) drawRadar(ctx, v, w, j, s.selected.has(j.id));

  for (const j of w.jets) {
    const tr = s.trails.get(j.id);
    if (tr && (!s.fog || j.side === s.side))
      drawTrail(ctx, v, tr, j.alive ? j.pos : null, `${j.alive ? sideCol(j.side) : COLORS.dead}55`, 1.5);
  }
  for (const m of w.missiles) {
    if (s.fog) continue; // missiles never show on radar, yours included: you only have timers
    const tr = s.trails.get(m.id);
    if (tr) drawTrail(ctx, v, tr, m.end ? null : m.pos, `${sideCol(m.side)}${m.end ? "33" : "99"}`, 1);
  }
  drawDecoys(ctx, v, s);

  // Selected jet: line to its target (or where it was last seen), range, and launch-zone ticks.
  const p = s.primary();
  const tgt = p ? jetById(w, p.targetId) : undefined;
  const tgtPos = tgt?.alive ? (s.sees(tgt.id) ? tgt.pos : (s.lastSeen.get(tgt.id) ?? null)) : null;
  if (p && tgt && tgtPos) {
    const [ax, ay] = toScreen(v, p.pos.x, p.pos.y);
    const [bx, by] = toScreen(v, tgtPos.x, tgtPos.y);
    const track = w.radarTrack.get(p.id) ?? false;
    ctx.setLineDash(track ? [] : [4, 4]);
    ctx.strokeStyle = track ? "rgba(251,191,36,0.55)" : "rgba(251,191,36,0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.setLineDash([]);
    const dist = Math.hypot(tgtPos.x - p.pos.x, tgtPos.y - p.pos.y);
    const ux = dist > 1 ? (tgtPos.x - p.pos.x) / dist : 0;
    const uy = dist > 1 ? (tgtPos.y - p.pos.y) / dist : 1;
    const z = s.zone?.jetId === p.id && s.zone.targetId === tgt.id ? s.zone.zone : null;
    if (z) {
      for (const [nm, col, name] of [
        [z.rmaxNm, COLORS.rmax, "Rmax"],
        [z.rneNm, COLORS.rne, "Rne"],
      ] as const) {
        if (nm <= 0) continue;
        const [tx, ty] = toScreen(v, p.pos.x + ux * nm * NM, p.pos.y + uy * nm * NM);
        const nx = -uy * 7;
        const ny = -ux * 7;
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(tx - nx, ty - ny);
        ctx.lineTo(tx + nx, ty + ny);
        ctx.stroke();
        ctx.font = "10px system-ui, sans-serif";
        label(ctx, name, tx + nx * 1.6, ty + ny * 1.6, col, "center");
      }
    }
    ctx.font = "11px system-ui, sans-serif";
    label(ctx, `${(dist / NM).toFixed(1)} nm`, (ax + bx) / 2 + 8, (ay + by) / 2, COLORS.select);
  }

  // Commanded heading of own jets: where they are turning to.
  for (const j of w.jets) {
    if (!j.alive || j.side !== s.side) continue;
    const hdg = desiredSteerHeading(w, j);
    const [sx, sy] = toScreen(v, j.pos.x, j.pos.y);
    ctx.strokeStyle = "rgba(219,227,238,0.35)";
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + Math.sin(hdg) * 60, sy - Math.cos(hdg) * 60);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (const m of w.missiles) if (!m.end && !s.fog) drawMissile(ctx, v, w, m, labels);

  for (const j of w.jets) if (j.alive && j.side === s.side) drawRwr(ctx, v, s, j);

  const targets = new Set<string>();
  for (const id of s.selected) {
    const t = jetById(w, id)?.targetId;
    if (t) targets.add(t);
  }
  for (const j of w.jets) {
    if (!s.sees(j.id)) {
      const g = j.alive ? drawGhost(ctx, v, s, j, labels) : null;
      if (g) hits.push(g);
      continue;
    }
    drawJet(ctx, v, j, s.selected.has(j.id), targets.has(j.id));
    const [sx, sy] = toScreen(v, j.pos.x, j.pos.y);
    hits.push({ id: j.id, sx, sy });
    if (labels) {
      ctx.font = "11px system-ui, sans-serif";
      const col = j.alive ? sideCol(j.side) : COLORS.dead;
      label(ctx, j.callsign, sx + 14, sy - 4, col);
      if (j.alive)
        label(
          ctx,
          `M${mach(j).toFixed(2)} ${altText(j, j.side === s.side)} ${j.g.toFixed(1)}g ×${j.missiles}`,
          sx + 14,
          sy + 9,
          `${col}cc`,
        );
    }
  }
  if (sideView) drawSideView(ctx, v, s);
  return hits;
}

/** Climbing or diving faster than this (m/s, ≈1,000 ft/min) shows an arrow next to the altitude. */
const CLIMB_ARROW_MS = 5;

/** "25k", "25k↑" while climbing, and for your own jets the ordered altitude when it differs: "18k↑30". */
function altText(j: Jet, own: boolean): string {
  const vz = verticalSpeed(j);
  const arrow = vz > CLIMB_ARROW_MS ? "↑" : vz < -CLIMB_ARROW_MS ? "↓" : "";
  const to = own && Math.abs(j.altCmd - j.pos.z) > 500 * FT ? `${Math.round(j.altCmd / FT / 1000)}` : "";
  return `${(j.pos.z / FT / 1000).toFixed(0)}k${arrow || (to ? "→" : "")}${to}`;
}

const SIDE_W = 340;
const SIDE_H = 150;

/**
 * Side view (inset, bottom left): altitude against distance along the line from the selected jet
 * to its target (or south → north when nothing is targeted). Shows what fog of war allows: your
 * jets, detected or last-seen bandits, and missiles only when fog is off.
 */
function drawSideView(ctx: CanvasRenderingContext2D, v: View, s: SessionView) {
  const w = s.world;
  const pw = Math.min(SIDE_W, v.w * 0.45);
  const ph = SIDE_H;
  if (pw < 160 || v.h < ph + 110) return;
  const x0 = 10;
  // Clear of the map toggles along the bottom edge.
  const y0 = v.h - ph - 40;
  const pad = { l: 34, r: 10, t: 16, b: 18 };

  // Projection axis.
  const p = s.primary();
  const tgtPos = p?.targetId ? s.knownEnemyPos(p.targetId) : null;
  let origin = { x: 0, y: 0 };
  let ux = 0;
  let uy = 1;
  let axisLabel = "nm north";
  if (p && tgtPos) {
    const dx = tgtPos.x - p.pos.x;
    const dy = tgtPos.y - p.pos.y;
    const d = Math.hypot(dx, dy);
    if (d > 1) {
      ux = dx / d;
      uy = dy / d;
      origin = { x: p.pos.x, y: p.pos.y };
      axisLabel = `nm from ${p.callsign} toward target`;
    }
  }

  interface Pt {
    along: number;
    z: number;
    col: string;
    kind: "jet" | "ghost" | "missile";
    vAlong: number;
    vz: number;
    altCmd?: number;
  }
  const pts: Pt[] = [];
  const along = (x: number, y: number) => (x - origin.x) * ux + (y - origin.y) * uy;
  for (const j of w.jets) {
    if (!j.alive) continue;
    if (s.sees(j.id)) {
      const vel = velocity(j);
      pts.push({
        along: along(j.pos.x, j.pos.y),
        z: j.pos.z,
        col: sideCol(j.side),
        kind: "jet",
        vAlong: vel.x * ux + vel.y * uy,
        vz: vel.z,
        altCmd: j.side === s.side && s.selected.has(j.id) ? j.altCmd : undefined,
      });
    } else {
      const g = s.lastSeen.get(j.id);
      if (g)
        pts.push({ along: along(g.x, g.y), z: g.z, col: sideCol(j.side), kind: "ghost", vAlong: 0, vz: 0 });
    }
  }
  if (!s.fog)
    for (const m of w.missiles) {
      if (m.end) continue;
      pts.push({
        along: along(m.pos.x, m.pos.y),
        z: m.pos.z,
        col: sideCol(m.side),
        kind: "missile",
        vAlong: m.vel.x * ux + m.vel.y * uy,
        vz: m.vel.z,
      });
    }
  if (pts.length === 0) return;

  let aMin = Math.min(...pts.map((q) => q.along));
  let aMax = Math.max(...pts.map((q) => q.along));
  const span = Math.max(10 * NM, (aMax - aMin) * 1.15);
  const mid = (aMin + aMax) / 2;
  aMin = mid - span / 2;
  aMax = mid + span / 2;
  const topFt = Math.max(40000, Math.ceil((Math.max(...pts.map((q) => q.z)) / FT + 5000) / 10000) * 10000);

  const ix = x0 + pad.l;
  const iw = pw - pad.l - pad.r;
  const iy = y0 + pad.t;
  const ih = ph - pad.t - pad.b;
  const sx = (a: number) => ix + ((a - aMin) / (aMax - aMin)) * iw;
  const sy = (z: number) => iy + ih - (Math.max(0, z) / FT / topFt) * ih;

  ctx.save();
  ctx.fillStyle = "rgba(10, 16, 24, 0.82)";
  ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
  ctx.lineWidth = 1;
  ctx.fillRect(x0, y0, pw, ph);
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, pw - 1, ph - 1);
  ctx.font = "10px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillStyle = COLORS.gridText;
  ctx.textAlign = "left";
  ctx.fillText(i18n.t("game.draw.sideView", { axis: axisLabel }), x0 + 6, y0 + 9);
  for (let ft = 0; ft <= topFt; ft += 10000) {
    const y = Math.round(sy(ft * FT)) + 0.5;
    ctx.strokeStyle = ft === 0 ? "rgba(148, 163, 184, 0.45)" : COLORS.grid;
    ctx.beginPath();
    ctx.moveTo(ix, y);
    ctx.lineTo(ix + iw, y);
    ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillStyle = COLORS.gridText;
    ctx.fillText(`${ft / 1000}k`, ix - 4, y);
  }
  // Distance ticks.
  const stepM = niceStep((aMax - aMin) / NM / 4) * NM;
  ctx.textAlign = "center";
  for (let a = Math.ceil(aMin / stepM) * stepM; a <= aMax; a += stepM) {
    const x = sx(a);
    ctx.fillStyle = COLORS.gridText;
    ctx.fillText(`${Math.round(a / NM)}`, x, iy + ih + 9);
  }

  for (const q of pts) {
    const x = sx(q.along);
    const y = sy(q.z);
    if (q.altCmd !== undefined && Math.abs(q.altCmd - q.z) > 300 * FT) {
      const yc = sy(q.altCmd);
      ctx.strokeStyle = `${q.col}88`;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, yc);
      ctx.moveTo(x - 6, yc);
      ctx.lineTo(x + 6, yc);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (q.kind === "ghost") {
      ctx.strokeStyle = `${q.col}aa`;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.setLineDash([]);
      continue;
    }
    // Velocity tick: the direction it flies in this view (screen x is distance, y is height, so the
    // tick shows climb and dive at the scale of the panel, not the true angle).
    const sp = Math.hypot(q.vAlong, q.vz);
    if (sp > 1) {
      const vxS = (q.vAlong / (aMax - aMin)) * iw;
      const vyS = -(q.vz / FT / topFt) * ih;
      const k = (q.kind === "missile" ? 8 : 12) / Math.max(1e-6, Math.hypot(vxS, vyS));
      ctx.strokeStyle = q.col;
      ctx.lineWidth = q.kind === "missile" ? 1 : 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + vxS * k, y + vyS * k);
      ctx.stroke();
    }
    ctx.fillStyle = q.col;
    ctx.beginPath();
    ctx.arc(x, y, q.kind === "missile" ? 1.8 : 3.5, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.restore();
}
