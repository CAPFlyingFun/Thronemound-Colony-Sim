/**
 * HOW FULL EACH CELL IS — the difference between a tunnel she can walk down
 * and a staircase she falls off.
 *
 * ## Why a dug cell has to be able to be half a cell
 *
 * A voxel is five millimetres. The queen is about three millimetres tall and
 * her legs have a measured 1.08 mm of spare downward reach (`REACH_DOWN_MM`).
 * So a tunnel floor made of whole cells is a flight of five-millimetre steps
 * taken by an animal that can manage one: she arrives at each riser with
 * nothing under her feet. Measured on the whole-cell version — 1.42 of 6 feet
 * groping along a tunnel she had dug herself, against 0.08 on the surface.
 *
 * The SURFACE does not have this problem, and the reason is instructive: its
 * top cells are partly full, from a continuous height field, so the ground is
 * a smooth sheet that happens to be stored on a lattice. This gives the same
 * thing to soil that has been dug rather than generated — a ramp cut through
 * the tray passes through cells at fractional heights, and those cells end up
 * fractionally full rather than gone.
 *
 * The mesher already supports it and says so: its `fill` hook "draws a half
 * height slab of anything", and its note on `slope` explicitly contemplates
 * that "dug soil can be part full without being surface at all". Nothing here
 * is teaching the renderer a new trick; it is using the one it has.
 *
 * ## And it is what digging LOOKS like
 *
 * Ant Scout's cell pops out of existence when its hit points run out, which
 * is fine at that scale and in that camera. Here the keeper is often a
 * centimetre from the face, and a cube vanishing between two frames reads as
 * a glitch. Draining the cell as the round bar fills means the bar and the
 * soil are the same fact shown twice.
 *
 * ## Sparse on purpose
 *
 * Only cells that have been CHANGED are stored. A formicarium is a hundred
 * thousand cells of generated terrain and a few hundred of dug tunnel, so a
 * map of overrides is a rounding error where a parallel float array would be
 * half a megabyte. The base fill is asked of the terrain, exactly as before,
 * for everything not in the map.
 */

/** Fills within this of full or empty are treated as neither part-dug nor gone. */
export const FILL_EPSILON = 0.02;

export class DugSoil {
  private readonly partial = new Map<number, number>();

  /**
   * @param base what the untouched terrain says a cell's fill is
   */
  constructor(
    private readonly sizeX: number,
    private readonly sizeZ: number,
    private readonly base: (x: number, y: number, z: number) => number,
  ) {}

  private key(x: number, y: number, z: number): number {
    return (y * this.sizeZ + z) * this.sizeX + x;
  }

  /** How full this cell is, 0..1 — the override if there is one. */
  fill(x: number, y: number, z: number): number {
    const found = this.partial.get(this.key(x, y, z));
    return found === undefined ? this.base(x, y, z) : found;
  }

  /** Has this cell been eaten into at all? */
  touched(x: number, y: number, z: number): boolean {
    return this.partial.has(this.key(x, y, z));
  }

  /** Leave a cell partly eaten. */
  setFill(x: number, y: number, z: number, fill: number): void {
    this.partial.set(this.key(x, y, z), Math.max(0, Math.min(1, fill)));
  }

  /**
   * Forget a cell's override — used when the cell is removed outright, so a
   * fill left behind cannot haunt soil that is deposited there later.
   */
  clear(x: number, y: number, z: number): void {
    this.partial.delete(this.key(x, y, z));
  }

  /** How many cells carry an override. The probe's sparseness check. */
  get overrides(): number {
    return this.partial.size;
  }
}
