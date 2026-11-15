export type Rng = () => number;

/** Mulberry32: a tiny seeded PRNG, so a fight replays identically from the same seed. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample N(0, 1) via Box-Muller, hard-capped to [-cap, cap]. */
export function randNormal(rng: Rng, cap = 2): number {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(-cap, Math.min(cap, z));
}
