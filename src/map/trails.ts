/**
 * Trail length (seconds) for one object, shared by the 2D map and the 3D view.
 *
 * Every object, selected or not, gets the chosen trail length. With both a primary and a secondary
 * selected, only those two keep a trail: the pair's geometry is what matters then, and other trails
 * are clutter.
 */
export function trailSecondsFor(
  uid: number,
  trailS: number,
  primaryUid: number | null,
  secondaryUid: number | null,
): number {
  const pair = primaryUid !== null && secondaryUid !== null;
  if (pair && uid !== primaryUid && uid !== secondaryUid) return 0;
  return trailS;
}
