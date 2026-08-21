/**
 * PUTTING A HOLE IN THE SOIL — the one place the field is written.
 *
 * `carve.ts` composes FIELDS: `carve(solid, hollow)` returns a new function
 * that answers "what would the soil be if this were taken out of it". That is
 * the right shape for terrain that is generated on demand, and the wrong shape
 * for terrain a colony is going to dig for an hour. Composed that way, every
 * bite adds a closure to a chain that every later sample has to walk, so the
 * thousandth tunnel costs a thousand times the first.
 *
 * A stored field has somewhere to put the answer. This applies the hollow ONCE
 * to the samples it actually touches and forgets it — the cost is the size of
 * the bite, not the length of the history.
 *
 * ## What it returns, and why that is the interesting part
 *
 * The `CellRegion` covering everything that changed, GROWN BY ONE CELL. The
 * mesher emits a quad per cell from that cell's own corner samples, so a
 * sample on the boundary of the edit is a corner of quads in the cell next
 * door too. Remeshing only the cells whose samples changed leaves those
 * neighbours drawn from stale geometry, which is a seam. One cell of margin
 * is what makes the redraw honest.
 */

import type { DensityField } from '../../density/DensityField';
import type { CellRegion } from '../../density/SurfaceNets';
import type { Field } from '../../voxel/carve';

/** A world-space box, in the same units the field is addressed in. */
export interface Bounds {
  x0: number; y0: number; z0: number;
  x1: number; y1: number; z1: number;
}

/**
 * Remove `hollow` from `field`, over `bounds`, and say what changed.
 *
 * `bounds` is the caller's promise about where the hollow can possibly be
 * inside — passing one that is too small silently leaves soil behind, which
 * is why the bore's own bounds are computed by `boreBounds` rather than by
 * whoever is calling. Returns null when nothing actually moved, so a bite
 * that hit air does not schedule a remesh.
 */
export function carveInto(
  field: DensityField, hollow: Field, bounds: Bounds,
): CellRegion | null {
  const size = field.cellSize;
  /* Sample indices, clamped to the lattice. A sample at index i sits at
   * i * cellSize, so the range is a floor and a ceil rather than a round. */
  const i0 = Math.max(0, Math.floor(bounds.x0 / size));
  const j0 = Math.max(0, Math.floor(bounds.y0 / size));
  const k0 = Math.max(0, Math.floor(bounds.z0 / size));
  const i1 = Math.min(field.samplesX - 1, Math.ceil(bounds.x1 / size));
  const j1 = Math.min(field.samplesY - 1, Math.ceil(bounds.y1 / size));
  const k1 = Math.min(field.samplesZ - 1, Math.ceil(bounds.z1 / size));
  if (i0 > i1 || j0 > j1 || k0 > k1) return null;

  let hitI0 = Infinity; let hitJ0 = Infinity; let hitK0 = Infinity;
  let hitI1 = -Infinity; let hitJ1 = -Infinity; let hitK1 = -Infinity;

  for (let k = k0; k <= k1; k += 1) {
    const z = k * size;
    for (let j = j0; j <= j1; j += 1) {
      const y = j * size;
      for (let i = i0; i <= i1; i += 1) {
        const x = i * size;
        /*
         * DIFFERENCE, for a positive-inside field: `min(solid, -hollow)`.
         * Inside the hollow, `-hollow` is negative and wins, so the point
         * becomes air. Outside it, `-hollow` is a positive distance to the
         * cut and only wins near it, which is the rounding a real excavation
         * has anyway. Exactly what `carve()` composes, applied in place.
         */
        const was = field.get(i, j, k);
        /*
         * ROUNDED TO WHAT THE FIELD CAN ACTUALLY HOLD before comparing.
         *
         * The samples live in a `Float32Array` and the arithmetic above is
         * float64, so `min(was, -hollow)` returns a number the field cannot
         * store exactly — it is rounded on the way in. Comparing the
         * unrounded result against the stored value therefore finds a
         * difference every single time, and a carve of a hole that has
         * already been dug reported itself as an edit, scheduled a remesh,
         * and would have done so once a frame for as long as an ant stood
         * there. Measured: a second identical bore "changed" the field.
         */
        const now = Math.fround(Math.min(was, -hollow(x, y, z)));
        if (now === was) continue;
        field.set(i, j, k, now);
        if (i < hitI0) hitI0 = i;
        if (j < hitJ0) hitJ0 = j;
        if (k < hitK0) hitK0 = k;
        if (i > hitI1) hitI1 = i;
        if (j > hitJ1) hitJ1 = j;
        if (k > hitK1) hitK1 = k;
      }
    }
  }
  if (hitI1 < hitI0) return null;

  /* One cell of margin — see the note at the head of the file. */
  return {
    x0: hitI0 - 1, y0: hitJ0 - 1, z0: hitK0 - 1,
    x1: hitI1 + 1, y1: hitJ1 + 1, z1: hitK1 + 1,
  };
}

/**
 * Where a `boreFrom` can possibly be inside, as a world box.
 *
 * The capsule reaches `radius` beyond the far cap and `radius` sideways along
 * the whole length; behind the origin it reaches nothing, because the bore is
 * cut flat at the thorax plane — but the box is axis-aligned and the aim is
 * not, so the honest conservative answer pads every side.
 */
export function boreBounds(
  origin: readonly [number, number, number],
  aim: readonly [number, number, number],
  length: number, radius: number,
): Bounds {
  const len = Math.hypot(aim[0], aim[1], aim[2]);
  const ux = len > 1e-9 ? aim[0] / len : 0;
  const uy = len > 1e-9 ? aim[1] / len : 0;
  const uz = len > 1e-9 ? aim[2] / len : 0;
  const ex = origin[0] + ux * length;
  const ey = origin[1] + uy * length;
  const ez = origin[2] + uz * length;
  return {
    x0: Math.min(origin[0], ex) - radius, x1: Math.max(origin[0], ex) + radius,
    y0: Math.min(origin[1], ey) - radius, y1: Math.max(origin[1], ey) + radius,
    z0: Math.min(origin[2], ez) - radius, z1: Math.max(origin[2], ez) + radius,
  };
}
