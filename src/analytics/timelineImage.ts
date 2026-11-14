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

/**
 * Which game plan the card is for. "all" is the full 14-row chart; the others are the three basic
 * game plans the squadron briefs before the fight ("Colt, target single group, plan skate"), each
 * showing only the gates that plan flies through, worded as the action to take there.
 */
export type KneeboardPlan = "all" | "skate" | "shortSkate" | "banzai";

export const KNEEBOARD_PLAN_ORDER: KneeboardPlan[] = ["all", "skate", "shortSkate", "banzai"];

interface PlanMeta {
  label: string;
  /** One-line definition printed under the title (omitted for "all"). */
  summary: string;
  rows: BvrTimelineRowKey[];
  /** Gates drawn in the accent color: where this plan gets out or commits. */
  critical: BvrTimelineRowKey[];
  /** Plan-specific wording that replaces CARD_DESCRIPTIONS for these rows. */
  descriptions: Partial<Record<BvrTimelineRowKey, string>>;
  /** Print the "on timeline × targeted" decision box. */
  decisionBox: boolean;
}

/** Gates every plan flies through before the first shot. */
const PRE_SHOT: BvrTimelineRowKey[] = [
  "threatRangeNm",
  "nltCommitNm",
  "pumpNm",
  "tacRangeNm",
  "meldSortNm",
  "nltSrNm",
];

const SHOT_CRANK = "Fox-3, then crank ≥50° ATA — don't gimbal and trash the shot";

export const KNEEBOARD_PLANS: Record<KneeboardPlan, PlanMeta> = {
  all: {
    label: "All gates",
    summary: "",
    rows: BVR_TIMELINE_ROWS.map((r) => r.key),
    critical: ["marNm", "sternWezNm"],
    descriptions: {},
    decisionBox: false,
  },
  skate: {
    label: "Skate",
    summary: "Launch and leave at MOR: shoot, crank, support the missile, then go out. Never inside MOR.",
    rows: [...PRE_SHOT, "morNm", "mrarNm"],
    critical: ["morNm"],
    descriptions: {
      nltSrNm: SHOT_CRANK,
      morNm: "OUT NLT here — threat at 6, drag ≥10 s supersonic, descend to 25,000'",
      mrarNm: "Earliest turn back in — set radar for the reattack while dragging",
    },
    decisionBox: false,
  },
  shortSkate: {
    label: "Short Skate",
    summary: "Launch and leave NLT MAR: shoot, crank, notch if targeted, then abort.",
    rows: [...PRE_SHOT, "morNm", "drNm", "lsrNm", "marNm"],
    critical: ["marNm"],
    descriptions: {
      nltSrNm: SHOT_CRANK,
      morNm: "Assess targeted status — see decision box; losing → out now",
      drNm: "Targeted → notch now; not targeted → keep cranking",
      lsrNm: "Last shot at 45° ATA, then abort",
      marNm: "ABORT NLT here — threat at 6, unload, descend low",
    },
    decisionBox: true,
  },
  banzai: {
    label: "Banzai",
    summary: "Launch and defend, then press to the merge. Inside MAR you are committed.",
    rows: ["threatRangeNm", "ofrNm", "dfrNm", ...PRE_SHOT.slice(1), "drNm", "lsrNm", "marNm", "sternWezNm"],
    critical: ["marNm", "sternWezNm"],
    descriptions: {
      nltSrNm: SHOT_CRANK,
      drNm: "Targeted → notch, set radar for the pitch back in",
      lsrNm: "Last BVR shot at 45° ATA — then go to the merge",
      marNm: "Inside: committed — BANZAI, eyeball / shooter roles",
    },
    decisionBox: true,
  },
};

/** The rows a plan's card shows, in chart order. */
export function planRows(plan: KneeboardPlan): BvrTimelineRowMeta[] {
  const keep = new Set(KNEEBOARD_PLANS[plan].rows);
  return BVR_TIMELINE_ROWS.filter((r) => keep.has(r.key));
}

/** GATE_TIME_CHAIN limited to the gates a plan shows, so times run to the next gate on its card. */
export function planGateChain(plan: KneeboardPlan): BvrTimelineRowKey[] {
  const keep = new Set(KNEEBOARD_PLANS[plan].rows);
  return GATE_TIME_CHAIN.filter((k) => keep.has(k));
}

export interface KneeboardOptions {
  theme?: KneeboardTheme;
  /** Game plan to print; defaults to "all". */
  plan?: KneeboardPlan;
  /** Bake the +2 nm strike-fighter adjustment into the starred rows (NLT SR, MOR). */
  strikeFighterAdd2Nm?: boolean;
  /** Short provenance line, e.g. "Chart baseline" or "Custom / ACMI-fitted". */
  sourceLabel?: string;
  /**
   * When set, print the seconds between consecutive gates of the head-on flow (see GATE_TIME_CHAIN)
   * at this closure speed (knots). Omit or null to leave them off.
   */
  gateTimesClosureKt?: number | null;
  /** Round every gate up to a whole nm (see roundUpTable); gate times then use the rounded values. */
  roundUpNm?: boolean;
  scale?: number;
}

/** Default closure for gate times: hot-on-hot BVR closure in the sample recordings is ~1,100–1,250 kt. */
export const DEFAULT_GATE_CLOSURE_KT = 1200;

/**
 * Gates flown in sequence while pressing hot on one group: commit → sort → shoot → the successive
 * last-chance defensive decisions. Factor ranges, threat range, PUMP / MRAR (branches off the flow)
 * and STERN WEZ (tail-chase geometry) are not steps on this line, so they get no time.
 */
export const GATE_TIME_CHAIN: BvrTimelineRowKey[] = [
  "nltCommitNm",
  "tacRangeNm",
  "meldSortNm",
  "nltSrNm",
  "morNm",
  "drNm",
  "lsrNm",
  "marNm",
];

/**
 * Seconds from `from` to the next gate of GATE_TIME_CHAIN for one tier column, or null when `from`
 * is not on the chain, is last, or the next gate is not closer (no positive time to fly).
 */
export function secondsToNextGate(
  column: Record<BvrTimelineRowKey, number>,
  from: BvrTimelineRowKey,
  closureKt: number,
  strikeBonusNm = 0,
  /** Gates to step through; a plan's card passes planGateChain(plan). */
  chain: BvrTimelineRowKey[] = GATE_TIME_CHAIN,
): number | null {
  const i = chain.indexOf(from);
  const to = chain[i + 1];
  if (i < 0 || !to || !(closureKt > 0)) return null;
  const eff = (k: BvrTimelineRowKey) =>
    column[k] + (BVR_TIMELINE_ROWS.find((r) => r.key === k)?.hasStrikeFighterStar ? strikeBonusNm : 0);
  const dNm = eff(from) - eff(to);
  if (!(dNm > 0)) return null;
  return (dNm / closureKt) * 3600;
}

/** Short names for the gate-time footer line. */
const CHAIN_SHORT: Partial<Record<BvrTimelineRowKey, string>> = {
  nltCommitNm: "Commit",
  tacRangeNm: "Tac",
  meldSortNm: "Meld",
  nltSrNm: "SR",
  morNm: "MOR",
  drNm: "DR",
  lsrNm: "LSR",
  marNm: "MAR",
};

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
  // Brightest text is #bbbbbb, not white: full white is glaring in a dark room.
  night: {
    bg: "#0a0d10",
    fg: "#bbbbbb",
    muted: "#8592a0",
    rule: "#2a323b",
    stripe: "#11161b",
    band: "#1c2630",
    bandFg: "#bbbbbb",
    headerBg: "#151c23",
    headerFg: "#bbbbbb",
    // red for MAR / STERN WEZ, capped at the same 0xbb channel so it is no brighter than the text
    accent: "#bb6a55",
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

/**
 * Every gate rounded up to a whole nm. Up is the safe direction for every row: threat range and
 * WEZ grow, and each decision (commit, shoot, out, defend, abort) happens earlier, never later.
 */
export function roundUpTable(table: BvrTimelineTable): BvrTimelineTable {
  const out = {} as BvrTimelineTable;
  for (const tier of THREAT_TIER_ORDER) {
    const col = { ...table[tier] };
    for (const k of Object.keys(col) as BvrTimelineRowKey[]) {
      // tolerance so 13.0000001 from float math stays 13
      col[k] = Math.ceil(col[k] - 1e-6);
    }
    out[tier] = col;
  }
  return out;
}

export function renderKneeboardCanvas(
  sourceTable: BvrTimelineTable,
  opts: KneeboardOptions = {},
  /** Draw into this canvas (e.g. a live preview) instead of a new one; it is resized and cleared. */
  target?: HTMLCanvasElement,
): HTMLCanvasElement {
  // Rounding happens before anything is drawn, so gate times use the rounded values too.
  const table = opts.roundUpNm ? roundUpTable(sourceTable) : sourceTable;
  const plan = opts.plan ?? "all";
  const planMeta = KNEEBOARD_PLANS[plan];
  const rows = planRows(plan);
  const chain = planGateChain(plan);
  const theme = opts.theme ?? "day";
  const pal = PALETTES[theme];
  const scale = opts.scale ?? 2;
  const W = 768;
  const H = 1024;
  const canvas = target ?? document.createElement("canvas");
  // Setting the size also resets the context transform and clears the old drawing.
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
  ctx.textAlign = "left";
  const title = "BVR TIMELINE";
  const planTitle = plan === "all" ? "" : `  PLAN ${planMeta.label.toUpperCase()}`;
  // Shrink the title if a long plan name would run into the right-hand labels.
  let titlePx = 32;
  for (; titlePx > 20; titlePx -= 2) {
    ctx.font = `800 ${titlePx}px ${FONT}`;
    if (ctx.measureText(title + planTitle).width <= innerW - 190) break;
  }
  ctx.fillStyle = pal.fg;
  ctx.fillText(title, M, y);
  if (planTitle) {
    const tw = ctx.measureText(title).width;
    ctx.fillStyle = pal.accent;
    ctx.fillText(planTitle, M + tw, y);
  }
  ctx.font = `600 14px ${FONT}`;
  ctx.fillStyle = pal.muted;
  ctx.textAlign = "right";
  ctx.fillText("ALL RANGES IN NM", W - M, y - 14);
  if (opts.sourceLabel) ctx.fillText(opts.sourceLabel.toUpperCase(), W - M, y + 4);
  y += 14;
  ctx.fillStyle = pal.fg;
  ctx.fillRect(M, y, innerW, 3);
  y += 3;

  if (planMeta.summary) {
    ctx.textAlign = "left";
    ctx.fillStyle = pal.fg;
    ctx.font = `600 13px ${FONT}`;
    ctx.fillText(wrapLines(ctx, planMeta.summary, innerW, 1)[0] ?? "", M, y + 19);
    y += 28;
  }
  const tableTop = y;

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
  const closureKt = opts.gateTimesClosureKt ?? null;
  const decisionH = planMeta.decisionBox ? 66 : 0;
  const footerH = (closureKt ? 70 : 54) + decisionH;
  const sections = rows.reduce<BvrTimelineRowMeta["section"][]>((acc, r) => {
    if (acc[acc.length - 1] !== r.section) acc.push(r.section);
    return acc;
  }, []);
  const rowsAvail = H - M - footerH - y - sections.length * bandH;
  // Plan cards have fewer rows; cap the height so they stay a table rather than stretching to fill.
  const rowH = Math.min(64, Math.floor(rowsAvail / rows.length));
  const critical = new Set(planMeta.critical);

  let prevSection: BvrTimelineRowMeta["section"] | null = null;
  let stripe = false;
  for (const row of rows) {
    if (row.section !== prevSection) {
      ctx.fillStyle = pal.band;
      ctx.fillRect(M, y, innerW, bandH);
      ctx.fillStyle = pal.bandFg;
      ctx.font = `700 12px ${FONT}`;
      ctx.textAlign = "left";
      // A plan card without OFR/DFR has only THREAT RANGE in the first band.
      const onlyThreat =
        row.section === "factors" && !rows.some((r) => r.key === "ofrNm" || r.key === "dfrNm");
      ctx.fillText(onlyThreat ? "THREAT" : SECTION_LABELS[row.section], M + 10, y + 15);
      y += bandH;
      prevSection = row.section;
      stripe = false;
    }

    if (stripe) {
      ctx.fillStyle = pal.stripe;
      ctx.fillRect(M, y, innerW, rowH);
    }
    stripe = !stripe;

    const isCritical = critical.has(row.key);
    ctx.textAlign = "left";
    ctx.fillStyle = isCritical ? pal.accent : pal.fg;
    ctx.font = `800 16px ${FONT}`;
    ctx.fillText(`${row.code}${row.hasStrikeFighterStar ? "*" : ""}`, M + 10, y + 21);
    ctx.fillStyle = pal.muted;
    ctx.font = `500 11px ${FONT}`;
    const desc = planMeta.descriptions[row.key] ?? CARD_DESCRIPTIONS[row.key];
    wrapLines(ctx, desc, gateColW - 18, 2).forEach((ln, li) => {
      ctx.fillText(ln, M + 10, y + 36 + li * 12);
    });

    THREAT_TIER_ORDER.forEach((tier, i) => {
      const v = table[tier][row.key] + (row.hasStrikeFighterStar ? bonus : 0);
      ctx.textAlign = "center";
      ctx.fillStyle = isCritical ? pal.accent : pal.fg;
      ctx.font = `800 26px ${FONT}`;
      ctx.fillText(fmtNm(v), tierX(i) + tierColW / 2, y + rowH / 2 + 9);

      if (closureKt) {
        const s = secondsToNextGate(table[tier], row.key, closureKt, bonus, chain);
        if (s !== null) {
          ctx.textAlign = "right";
          ctx.fillStyle = pal.muted;
          ctx.font = `600 10px ${FONT}`;
          ctx.fillText(`↓ ${Math.round(s)}s`, tierX(i) + tierColW - 5, y + rowH - 5);
        }
      }
    });

    // row + column rules
    ctx.fillStyle = pal.rule;
    ctx.fillRect(M, y + rowH - 1, innerW, 1);
    y += rowH;
  }

  // vertical column rules across header + body
  ctx.fillStyle = pal.rule;
  for (let i = 0; i < THREAT_TIER_ORDER.length; i++) {
    ctx.fillRect(Math.round(tierX(i)), tableTop, 1, y - tableTop);
  }
  ctx.strokeStyle = pal.fg;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(M, tableTop, innerW, y - tableTop);

  // ── Decision box (slide "Decision Range": on timeline × targeted) ──
  if (planMeta.decisionBox) {
    y += 14;
    const boxH = decisionH - 14;
    ctx.strokeStyle = pal.accent;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(M, y, innerW, boxH);
    ctx.textAlign = "left";
    ctx.fillStyle = pal.accent;
    ctx.font = `800 13px ${FONT}`;
    ctx.fillText("DECISION", M + 10, y + 20);
    ctx.fillStyle = pal.fg;
    ctx.font = `600 12px ${FONT}`;
    ctx.fillText(
      "Behind timeline AND bandit pointing at you (TA ≤ 30°) or spiked → LOSING: defend, then out.",
      M + 92,
      y + 20,
    );
    ctx.fillStyle = pal.muted;
    ctx.font = `500 12px ${FONT}`;
    ctx.fillText("Any other case → winning: continue the plan.", M + 92, y + 38);
    y += boxH;
  }

  // ── Footer ──
  ctx.textAlign = "left";
  ctx.fillStyle = pal.muted;
  ctx.font = `500 11px ${FONT}`;
  const starred = rows.filter((r) => r.hasStrikeFighterStar).map((r) => r.code);
  const starredText = starred.join(" and ");
  const footNote = bonus
    ? `*Strike-fighter tactics: +2 nm already applied to ${starredText}.`
    : `*Strike-fighter tactics: add 2 nm to ${starredText}.`;
  if (starred.length) ctx.fillText(footNote, M, y + 20);
  ctx.fillText(
    "Tiers by threat missile: IR/SAR-1 gen-1 SARH/IR · SAR-2 long-range Fox-1 · AR-1 early Fox-3 · AR-2 modern Fox-3.",
    M,
    y + 36,
  );
  if (closureKt) {
    const flow = chain.map((k) => CHAIN_SHORT[k] ?? k).join(" → ");
    ctx.fillText(
      `↓ Ns = seconds to the next gate (${flow}) at ${Math.round(closureKt)} kt closure, both hot.`,
      M,
      y + 52,
    );
  }

  return canvas;
}

/** Save a rendered kneeboard canvas as a PNG download. */
export async function saveCanvasPng(canvas: HTMLCanvasElement, filename: string): Promise<void> {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  if (!blob) throw new Error("PNG encoding failed");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
