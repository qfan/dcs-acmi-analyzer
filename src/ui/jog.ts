/**
 * Jog control maths: a spring-loaded "joystick" for playback. Drag sideways from where you pressed:
 * the further, the faster, from slow motion up to JOG_MAX_RATE, backwards to the left. Release to
 * stop, or move up/down past JOG_LATCH_PX before releasing to keep playing at that rate (which then
 * becomes the play button's speed).
 */

/** Pointer travel (CSS px) from the press point to full speed. */
export const JOG_TRAVEL_PX = 120;
/** No movement this close to the press point, so a click or a shaky hand doesn't creep. */
export const JOG_DEAD_PX = 6;
/** Vertical distance that turns release into "latch at this rate". */
export const JOG_LATCH_PX = 20;
/** Slowest and fastest jog rates (× real time). */
export const JOG_MIN_RATE = 0.1;
export const JOG_MAX_RATE = 20;
/** Share of the travel (past the dead zone) given to slow motion, below real time. */
export const JOG_SLOW_SHARE = 0.3;

/** Jog state while the pad is pressed: horizontal and vertical drag offset. */
export interface JogState {
  dx: number;
  dy: number;
}

/**
 * Signed playback rate for a horizontal offset. Exponential in two parts: slow motion (0.1× to 1×)
 * in the first JOG_SLOW_SHARE of the travel, then 1× to the maximum. Equal steps of travel multiply
 * the rate equally within each part, so slow and fast speeds are both easy to set.
 */
export function jogRate(dx: number): number {
  const a = Math.abs(dx);
  if (a <= JOG_DEAD_PX) return 0;
  const f = Math.min(1, (a - JOG_DEAD_PX) / (JOG_TRAVEL_PX - JOG_DEAD_PX));
  const r =
    f <= JOG_SLOW_SHARE
      ? JOG_MIN_RATE * (1 / JOG_MIN_RATE) ** (f / JOG_SLOW_SHARE)
      : JOG_MAX_RATE ** ((f - JOG_SLOW_SHARE) / (1 - JOG_SLOW_SHARE));
  return Math.sign(dx) * r;
}

/** The offset that gives a rate (inverse of jogRate; rates past the maximum pin to the end). */
export function jogOffset(rate: number): number {
  const a = Math.abs(rate);
  if (a < JOG_MIN_RATE) return 0;
  const f =
    a <= 1
      ? (JOG_SLOW_SHARE * Math.log(a / JOG_MIN_RATE)) / Math.log(1 / JOG_MIN_RATE)
      : Math.min(1, JOG_SLOW_SHARE + ((1 - JOG_SLOW_SHARE) * Math.log(a)) / Math.log(JOG_MAX_RATE));
  return Math.sign(rate) * (JOG_DEAD_PX + f * (JOG_TRAVEL_PX - JOG_DEAD_PX));
}

/** Whether releasing now would latch (moved off the line far enough, at a non-zero rate). */
export function wouldLatch(s: JogState): boolean {
  return Math.abs(s.dy) >= JOG_LATCH_PX && jogRate(s.dx) !== 0;
}

/** "0.25×", "3.2×", "1×", "20×". */
export function fmtRate(rate: number): string {
  const a = Math.abs(rate);
  const digits = a < 1 ? 2 : a < 10 ? 1 : 0;
  const s = a.toFixed(digits);
  return `${a >= 1 && s.endsWith(".0") ? s.slice(0, -2) : s}×`;
}

/** Preset play speeds for the speed menus. */
export const SPEED_PRESETS = [1, 2, 4, 8, 16, 32, 64] as const;

/**
 * The play button's rate for a stored play speed: 0 means "not set", which plays in real time.
 * (A jog latched at some rate sets it; double-clicking the jog clears it.)
 */
export const playRateOf = (stored: number) => (stored === 0 ? 1 : stored);

/** Options for a speed menu: the presets, plus the current speed when it's a latched in-between one. */
export function speedChoices(stored: number): { value: number; label: string }[] {
  const rate = playRateOf(stored);
  const list: { value: number; label: string }[] = SPEED_PRESETS.map((v) => ({ value: v, label: `${v}×` }));
  if (!list.some((o) => o.value === rate)) {
    list.push({ value: rate, label: `${rate < 0 ? "◀ " : ""}${fmtRate(rate)}` });
    list.sort((a, b) => a.value - b.value);
  }
  return list;
}
