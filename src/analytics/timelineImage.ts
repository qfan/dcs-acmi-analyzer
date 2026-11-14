import {
  BVR_TIMELINE_ROWS,
  type BvrTimelineRowKey,
  type BvrTimelineRowMeta,
  type BvrTimelineTable,
  THREAT_TIER_META,
  THREAT_TIER_ORDER,
} from "./timeline.ts";

/**
 * Renders the BVR timeline table as a clean, printable "kneeboard card" PNG — just the gates and
 * numbers, none of the ACMI statistics — so players can drop it into their in-game kneeboard
 * (e.g. DCS `Saved Games/DCS/Kneeboard/`). Logical size is 768x1024 (the usual kneeboard aspect),
 * rendered at `scale`x for crisp text.
 */

export type KneeboardTheme = "day" | "night";

export interface KneeboardOptions {
  theme?: KneeboardTheme;
  /** Bake the +2 nm strike-fighter adjustment into the starred rows (NLT SR, MOR). */
  strikeFighterAdd2Nm?: boolean;
  /** Short provenance line, e.g. "Chart baseline" or "Custom / ACMI-fitted". */
  sourceLabel?: string;
  scale?: number;
}

/** Plain-language gate descriptions for the card (the analytics descriptions mention ACMI stats). */
const CARD_DESCRIPTIONS: Record<BvrTimelineRowKey, string> = {
  threatRangeNm: "Max aero range of threat",
  ofrNm: "Offensive factor — merge, kill, on timeline for 2nd group",
  dfrNm: "Defensive factor — merge, kill, abort safely from 2nd group",
  nltCommitNm: "No later than commit",
  pumpNm: "Pump / deploy range (>M0.95 at 35,000')",
  tacRangeNm: "Tactical range call — everyone sees the same picture",
  meldSortNm: "Meld & sort — TWS / targeting / sort tree",
  nltSrNm: "First shot — employ on timeline regardless",
  morNm: "Min out range — 10 s cold drag defeats missile",
  mrarNm: "Min reattack / recommit — set radar for reacquisition",
  drNm: "Min defend range — notch; inside: commit or abort",
  lsrNm: "Last shot — 45° ATA crank, then abort or banzai",
  marNm: "Min abort range — inside: BANZAI",
  sternWezNm: "Min stern WEZ — staggerback or die",
};

const SECTION_LABELS: Record<BvrTimelineRowMeta["section"], string> = {
  factors: "FACTOR RANGES",
  commit: "COMMIT",
  combat: "COMBAT",
};

const PALETTES: Record<
  KneeboardTheme,
  {
    bg: string;
    fg: string;
    muted: string;
    rule: string;
    stripe: string;
    band: string;
    bandFg: string;
    headerBg: string;
    headerFg: string;
    accent: string;
  }
> = {
  day: {
    bg: "#ffffff",
    fg: "#111418",
    muted: "#4b5563",
    rule: "#c7cdd4",
    stripe: "#f1f4f7",
    band: "#1f2937",
    bandFg: "#ffffff",
    headerBg: "#e5e9ee",
    headerFg: "#111418",
    accent: "#b91c1c",
  },
  night: {
    bg: "#0a0d10",
    fg: "#d6dde4",
    muted: "#8592a0",
    rule: "#2a323b",
    stripe: "#11161b",
    band: "#1c2630",
    bandFg: "#c9d3dc",
    headerBg: "#151c23",
    headerFg: "#d6dde4",
    accent: "#e07a5f",
  },
};

const FONT = `"Segoe UI", "Helvetica Neue", Arial, sans-serif`;

export function fmtNm(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width <= maxWidth || !cur) {
      cur = next;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1] ?? "";
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last.trimEnd()}…`;
    return kept;
  }
  return lines;
}

export function renderKneeboardCanvas(
  table: BvrTimelineTable,
  opts: KneeboardOptions = {},
): HTMLCanvasElement {
  const theme = opts.theme ?? "day";
  const pal = PALETTES[theme];
  const scale = opts.scale ?? 2;
  const W = 768;
  const H = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.scale(scale, scale);
  ctx.textBaseline = "alphabetic";

  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, W, H);

  const M = 22;
  const innerW = W - M * 2;
  const gateColW = 300;
  const tierColW = (innerW - gateColW) / THREAT_TIER_ORDER.length;
  const tierX = (i: number) => M + gateColW + i * tierColW;
  const bonus = opts.strikeFighterAdd2Nm ? 2 : 0;

  // ── Title block ──
  let y = M + 30;
  ctx.fillStyle = pal.fg;
  ctx.font = `800 32px ${FONT}`;
  ctx.textAlign = "left";
  ctx.fillText("BVR TIMELINE", M, y);
  ctx.font = `600 14px ${FONT}`;
  ctx.fillStyle = pal.muted;
  ctx.textAlign = "right";
  ctx.fillText("ALL RANGES IN NM", W - M, y - 14);
  if (opts.sourceLabel) ctx.fillText(opts.sourceLabel.toUpperCase(), W - M, y + 4);
  y += 14;
  ctx.fillStyle = pal.fg;
  ctx.fillRect(M, y, innerW, 3);
  y += 3;

  // ── Tier header ──
  const headerH = 74;
  ctx.fillStyle = pal.headerBg;
  ctx.fillRect(M, y, innerW, headerH);
  ctx.fillStyle = pal.headerFg;
  ctx.textAlign = "left";
  ctx.font = `700 15px ${FONT}`;
  ctx.fillText("GATE", M + 10, y + 26);
  ctx.font = `500 11px ${FONT}`;
  ctx.fillStyle = pal.muted;
  ctx.fillText("Threat tier →", M + 10, y + 44);
  THREAT_TIER_ORDER.forEach((tier, i) => {
    const meta = THREAT_TIER_META[tier];
    const cx = tierX(i) + tierColW / 2;
    ctx.textAlign = "center";
    ctx.fillStyle = pal.headerFg;
    ctx.font = `800 18px ${FONT}`;
    ctx.fillText(meta.title, cx, y + 24);
    ctx.font = `500 10px ${FONT}`;
    ctx.fillStyle = pal.muted;
    const lines = wrapLines(ctx, meta.chartAircraft, tierColW - 10, 3);
    lines.forEach((ln, li) => {
      ctx.fillText(ln, cx, y + 40 + li * 12);
    });
  });
  y += headerH;

  // ── Rows ──
  const bandH = 22;
  const footerH = 54;
  const sections = BVR_TIMELINE_ROWS.reduce<BvrTimelineRowMeta["section"][]>((acc, r) => {
    if (acc[acc.length - 1] !== r.section) acc.push(r.section);
    return acc;
  }, []);
  const rowsAvail = H - M - footerH - y - sections.length * bandH;
  const rowH = Math.floor(rowsAvail / BVR_TIMELINE_ROWS.length);

  let prevSection: BvrTimelineRowMeta["section"] | null = null;
  let stripe = false;
  for (const row of BVR_TIMELINE_ROWS) {
    if (row.section !== prevSection) {
      ctx.fillStyle = pal.band;
      ctx.fillRect(M, y, innerW, bandH);
      ctx.fillStyle = pal.bandFg;
      ctx.font = `700 12px ${FONT}`;
      ctx.textAlign = "left";
      ctx.fillText(SECTION_LABELS[row.section], M + 10, y + 15);
      y += bandH;
      prevSection = row.section;
      stripe = false;
    }

    if (stripe) {
      ctx.fillStyle = pal.stripe;
      ctx.fillRect(M, y, innerW, rowH);
    }
    stripe = !stripe;

    const isCritical = row.key === "marNm" || row.key === "sternWezNm";
    ctx.textAlign = "left";
    ctx.fillStyle = isCritical ? pal.accent : pal.fg;
    ctx.font = `800 16px ${FONT}`;
    ctx.fillText(`${row.code}${row.hasStrikeFighterStar ? "*" : ""}`, M + 10, y + 21);
    ctx.fillStyle = pal.muted;
    ctx.font = `500 11px ${FONT}`;
    wrapLines(ctx, CARD_DESCRIPTIONS[row.key], gateColW - 18, 2).forEach((ln, li) => {
      ctx.fillText(ln, M + 10, y + 36 + li * 12);
    });

    THREAT_TIER_ORDER.forEach((tier, i) => {
      const v = table[tier][row.key] + (row.hasStrikeFighterStar ? bonus : 0);
      ctx.textAlign = "center";
      ctx.fillStyle = isCritical ? pal.accent : pal.fg;
      ctx.font = `800 26px ${FONT}`;
      ctx.fillText(fmtNm(v), tierX(i) + tierColW / 2, y + rowH / 2 + 9);
    });

    // row + column rules
    ctx.fillStyle = pal.rule;
    ctx.fillRect(M, y + rowH - 1, innerW, 1);
    y += rowH;
  }

  // vertical column rules across header + body
  const tableTop = M + 30 + 14 + 3;
  ctx.fillStyle = pal.rule;
  for (let i = 0; i < THREAT_TIER_ORDER.length; i++) {
    ctx.fillRect(Math.round(tierX(i)), tableTop, 1, y - tableTop);
  }
  ctx.strokeStyle = pal.fg;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(M, tableTop, innerW, y - tableTop);

  // ── Footer ──
  ctx.textAlign = "left";
  ctx.fillStyle = pal.muted;
  ctx.font = `500 11px ${FONT}`;
  const footNote = bonus
    ? "*Strike-fighter tactics: +2 nm already applied to NLT SR and MOR."
    : "*Strike-fighter tactics: add 2 nm to NLT SR and MOR.";
  ctx.fillText(footNote, M, y + 20);
  ctx.fillText(
    "Tiers by threat missile: IR/SAR-1 gen-1 SARH/IR · SAR-2 long-range Fox-1 · AR-1 early Fox-3 · AR-2 modern Fox-3.",
    M,
    y + 36,
  );

  return canvas;
}

export async function downloadKneeboardPng(
  table: BvrTimelineTable,
  opts: KneeboardOptions = {},
  filename = `bvr-timeline-${opts.theme ?? "day"}.png`,
): Promise<void> {
  const canvas = renderKneeboardCanvas(table, opts);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  if (!blob) throw new Error("PNG encoding failed");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
