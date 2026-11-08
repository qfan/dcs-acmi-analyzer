/**
 * Jog control maths: a spring-loaded "joystick" for playback. Drag sideways from where you pressed:
 * the further, the faster, from slow motion up to JOG_MAX_RATE, backwards to the left. Release to
 * stop, or move up/down past JOG_LATCH_PX before releasing to keep playing at that rate.
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

/** Jog state: horizontal and vertical drag offset, and whether the button is still held. */
export interface JogState {
  dx: number;
  dy: number;
  /** False when latched: playing on at this rate after release. */
  holding: boolean;
}

/**
 * Signed playback rate for a horizontal offset. Exponential, so equal steps of travel multiply the
 * rate equally: fine control in slow motion and at speed alike (1× is a bit before the middle).
 */
export function jogRate(dx: number): number {
  const a = Math.abs(dx);
  if (a <= JOG_DEAD_PX) return 0;
  const f = Math.min(1, (a - JOG_DEAD_PX) / (JOG_TRAVEL_PX - JOG_DEAD_PX));
  return Math.sign(dx) * JOG_MIN_RATE * (JOG_MAX_RATE / JOG_MIN_RATE) ** f;
}

/** The offset that gives a rate (inverse of jogRate), for keyboard steps and tests. */
export function jogOffset(rate: number): number {
  const a = Math.abs(rate);
  if (a < JOG_MIN_RATE) return 0;
  const f = Math.min(1, Math.log(a / JOG_MIN_RATE) / Math.log(JOG_MAX_RATE / JOG_MIN_RATE));
  return Math.sign(rate) * (JOG_DEAD_PX + f * (JOG_TRAVEL_PX - JOG_DEAD_PX));
}

/** Whether releasing now would latch (moved off the line far enough, at a non-zero rate). */
export function wouldLatch(s: JogState): boolean {
  return s.holding && Math.abs(s.dy) >= JOG_LATCH_PX && jogRate(s.dx) !== 0;
}

/** "0.25×", "3.2×", "20×". */
export function fmtRate(rate: number): string {
  const a = Math.abs(rate);
  const digits = a < 1 ? 2 : a < 10 ? 1 : 0;
  return `${a.toFixed(digits)}×`;
}
