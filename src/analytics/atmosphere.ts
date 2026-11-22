const STRAT_SOUND_MS = Math.sqrt(1.4 * 287.05 * 216.65);

/** Speed of sound (m/s) at altitude h (m MSL) using the International Standard Atmosphere. */
export function speedOfSoundMs(altM: number | null): number {
  const h = altM !== null && Number.isFinite(altM) ? Math.max(0, Math.min(30000, altM)) : 0;
  // Troposphere up to 11 km: T = 288.15 - 0.0065 * h; lower stratosphere 11–20 km: T = 216.65 K
  return h <= 11000 ? Math.sqrt(1.4 * 287.05 * (288.15 - 0.0065 * h)) : STRAT_SOUND_MS;
}
