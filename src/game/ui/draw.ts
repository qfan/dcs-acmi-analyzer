/** Top-down canvas renderer for the game, in the style of the viewer's 2D map. */
import { niceStep, toScreen, type View } from "../../map/render.ts";
import { desiredHeading, type Jet, mach } from "../sim/aircraft.ts";
import { DEG, FT, NM } from "../sim/atmosphere.ts";
import { type Missile, missileMach } from "../sim/missile.ts";
import { jetById, rwrContacts, steerThreatPos, type World } from "../sim/world.ts";
import { type GameSession, PLAYER_SIDE } from "./session.ts";

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
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = Math.ceil(x0 / stepM) * stepM; x <= x1; x += stepM) {
    const [sx] = toScreen(v, x, 0);
    ctx.moveTo(Math.round(sx) + 0.5, 0);
    ctx.lineTo(Math.round(sx) + 0.5, v.h);
  }
  for (let y = Math.ceil(y0 / stepM) * stepM; y <= y1; y += stepM) {
    const [, sy] = toScreen(v, 0, y);
    ctx.moveTo(0, Math.round(sy) + 0.5);
    ctx.lineTo(v.w, Math.round(sy) + 0.5);
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

/** Wedge of a jet's radar coverage: ± gimbal limit out to tracking range. */
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
  ctx.beginPath();
  pts.forEach((p, i) => {
    const [sx, sy] = toScreen(v, p.x, p.y);
    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  });
  if (head) {
    const [sx, sy] = toScreen(v, head.x, head.y);
    ctx.lineTo(sx, sy);
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
function drawDecoys(ctx: CanvasRenderingContext2D, v: View, s: GameSession) {
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
function drawRwr(ctx: CanvasRenderingContext2D, v: View, s: GameSession, j: Jet) {
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
  s: GameSession,
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

export function drawScene(ctx: CanvasRenderingContext2D, v: View, s: GameSession, labels: boolean): Hit[] {
  const w = s.world;
  const hits: Hit[] = [];
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, v.w, v.h);
  drawGrid(ctx, v);

  for (const j of w.jets) if (j.alive && s.sees(j.id)) drawRadar(ctx, v, w, j, s.selected.has(j.id));

  for (const j of w.jets) {
    const tr = s.trails.get(j.id);
    if (tr && (!s.fog || j.side === PLAYER_SIDE))
      drawTrail(ctx, v, tr, j.alive ? j.pos : null, `${j.alive ? sideCol(j.side) : COLORS.dead}55`, 1.5);
  }
  for (const m of w.missiles) {
    if (s.fog && m.side !== PLAYER_SIDE) continue;
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
    const ux = (tgtPos.x - p.pos.x) / dist;
    const uy = (tgtPos.y - p.pos.y) / dist;
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
    if (!j.alive || j.side !== PLAYER_SIDE) continue;
    const hdg = desiredHeading(j, steerThreatPos(w, j));
    const [sx, sy] = toScreen(v, j.pos.x, j.pos.y);
    ctx.strokeStyle = "rgba(219,227,238,0.35)";
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + Math.sin(hdg) * 60, sy - Math.cos(hdg) * 60);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (const m of w.missiles)
    if (!m.end && (!s.fog || m.side === PLAYER_SIDE)) drawMissile(ctx, v, w, m, labels);

  for (const j of w.jets) if (j.alive && j.side === PLAYER_SIDE) drawRwr(ctx, v, s, j);

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
          `M${mach(j).toFixed(2)} ${(j.pos.z / FT / 1000).toFixed(0)}k ${j.g.toFixed(1)}g ×${j.missiles}`,
          sx + 14,
          sy + 9,
          `${col}cc`,
        );
    }
  }
  return hits;
}
