/**
 * How much room she has, sampled as a fixed spray of directions in WORLD
 * space — the one measurement that decides whether she is on the surface, in
 * a tunnel, or in a chamber.
 *
 * One primitive for all three because they are the same question asked with
 * different thresholds, and because the alternative was three answers that
 * could disagree. The scene already had one of those: `buriedDepth` marched
 * along HER OWN UP, so the reading swung with her orientation rather than her
 * position, and it reported her going from nine millimetres deep to nought
 * while her actual height fell by 0.8 mm. She was descending the whole time
 * the instrument said she was surfacing.
 *
 * World directions have no such problem. Roll her upside down in a tunnel and
 * the soil around her is exactly where it was, so the numbers do not move.
 */

/**
 * Fourteen directions: the six axes and the eight corners. Enough to tell a
 * bore from a chamber and cheap enough to run every few frames — a finer
 * spray costs marches without changing which side of a threshold anything
 * lands on.
 */
export const ROOM_DIRS: ReadonlyArray<readonly [number, number, number]> = (() => {
  const out: Array<[number, number, number]> = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  const k = 1 / Math.sqrt(3);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) out.push([sx * k, sy * k, sz * k]);
    }
  }
  return out;
})();

export interface RoomSense {
  /**
   * What fraction of the spray met soil within reach — how BOXED IN she is.
   * Nought on an open plain, one deep inside the block.
   */
  enclosed: number;
  /**
   * The middle distance to soil across the whole spray, in millimetres: how
   * WIDE the space is. A median rather than a mean so that one direction
   * happening to look down a corridor does not turn a bore into a chamber.
   */
  boreMm: number;
  /** The closest soil in any direction, in millimetres. */
  nearestMm: number;
  /**
   * What fraction of the UPWARD directions meet soil — is there a roof?
   *
   * The discriminator that actually separates being under the ground from
   * standing on it, and enclosure is not. Measured, the two overlap: on the
   * surface she reads 0.64 to 0.71 enclosed and in her own bore 0.64 to 1.00,
   * because most of the spray points at the ground either way. What differs is
   * what is over her head — on the surface, nothing.
   */
  roofed: number;
}

export interface RoomOptions {
  /** How far to look, in millimetres. Misses count as this. */
  reachMm: number;
  /** March resolution, in millimetres. */
  stepMm: number;
}

/**
 * March the spray and describe the space.
 *
 * `solidAt` is passed in rather than imported so this can be tested against a
 * shape written down in the test, instead of against a voxel field that would
 * have to be built to ask a question about a corridor.
 */
export function senseRoom(
  solidAt: (x: number, y: number, z: number) => boolean,
  x: number, y: number, z: number,
  opts: RoomOptions,
): RoomSense {
  const { reachMm, stepMm } = opts;
  const distances: number[] = [];
  let hits = 0;
  let sky = 0;
  let roof = 0;
  for (const [dx, dy, dz] of ROOM_DIRS) {
    let found = reachMm;
    let met = false;
    for (let d = stepMm; d <= reachMm; d += stepMm) {
      if (solidAt(x + dx * d, y + dy * d, z + dz * d)) {
        found = d;
        hits += 1;
        met = true;
        break;
      }
    }
    distances.push(found);
    // Upward in WORLD terms, so it means the same thing whichever way up she
    // has ended up. The pure +Y ray and the four rising corners.
    if (dy > 0.1) {
      sky += 1;
      if (met) roof += 1;
    }
  }
  distances.sort((a, b) => a - b);
  const mid = distances.length >> 1;
  const boreMm = distances.length % 2
    ? distances[mid]!
    : (distances[mid - 1]! + distances[mid]!) / 2;
  return {
    enclosed: hits / ROOM_DIRS.length,
    boreMm,
    nearestMm: distances[0]!,
    roofed: sky > 0 ? roof / sky : 0,
  };
}
