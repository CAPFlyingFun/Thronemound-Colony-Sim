/**
 * The glass box the whole world sits in.
 *
 * One container at the world bounds — four walls and a ceiling — that the ant
 * can crawl up and across, the way an ant in a real formicarium works its way
 * around the tank. She is inside it; there is no outside to reach.
 *
 * This module answers ONE question: is this cell part of the glass. It does not
 * know what glass is made of, how it is drawn, or that three.js exists, so the
 * shape of the box can be argued about and tested before any of that is built.
 * The wiring — a material id, a transparent pass in the mesher, climbing — sits
 * on top of this and reads it.
 *
 * No floor pane. The world already bottoms out in undiggable stone, so a glass
 * base would be a second thing saying the same thing, and the one lesson this
 * project keeps relearning is that two things saying one thing eventually
 * disagree.
 */

export interface BoxOptions {
  /** Width and depth of the world in voxels. The box is the world. */
  size: number;
  /** Height of the underside of the lid. */
  ceilingY: number;
}

/** How thick the panes are. One cell: she climbs the inside face. */
export const PANE = 1;

/**
 * Headroom over the tallest ground before the lid.
 *
 * Enough that standing on the summit does not put her head against the glass —
 * the hill is the one place in the world with a view, and a ceiling sitting on
 * it would waste that. Twelve voxels is 6 cm, about seventeen times her height.
 */
export const LID_CLEARANCE = 12;

/** Where the lid goes, given the highest ground the terrain can reach. */
export function ceilingFor(highestGround: number): number {
  return highestGround + LID_CLEARANCE;
}

/**
 * Is this cell part of the container?
 *
 * Walls run the full height up to and including the lid, so there is no seam at
 * the top corner for her to fall through while crossing from a wall onto the
 * ceiling — that junction is the whole point of being able to climb it.
 */
export function isGlassCell(x: number, y: number, z: number, opts: BoxOptions): boolean {
  const { size, ceilingY } = opts;
  if (x < 0 || z < 0 || x >= size || z >= size) return false;
  if (y > ceilingY || y < 0) return false;
  const onWall = x < PANE || z < PANE || x >= size - PANE || z >= size - PANE;
  const onLid = y > ceilingY - PANE;
  return onWall || onLid;
}

/**
 * Is this cell inside the container — the space she can actually occupy?
 *
 * Deliberately its own function rather than `!isGlassCell`, because everything
 * below the ground is neither glass nor open air, and callers asking "can she
 * be here" want the box's interior, not the complement of its panes.
 */
export function insideBox(x: number, y: number, z: number, opts: BoxOptions): boolean {
  const { size, ceilingY } = opts;
  return x >= PANE && z >= PANE
    && x < size - PANE && z < size - PANE
    && y >= 0 && y <= ceilingY - PANE;
}
