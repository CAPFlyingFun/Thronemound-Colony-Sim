/**
 * THE ISLAND'S CUT, ON THE TRAY'S SOIL.
 *
 * Joshua, 2026-08-21: "port over the digging mechanics from the island in
 * the current map if different and try again."
 *
 * They were different, and the island's are better in three ways the tray had
 * been failing at one at a time:
 *
 * 1. A STROKE IS A SWEEP, NOT A SCOOP. The tray carved one capsule the
 *    instant a bar filled, so a tunnel was a row of discrete pockets and the
 *    walls remembered every one — the scalloping visible in every screenshot.
 *    The island learned this already: "popcorn tunnel as each bite" was the
 *    same complaint, and the answer was `DigJob`, which chips the SAME
 *    cylinder away as a run of heavily overlapping spheres on a steady beat.
 *    At half a radius apart the waist between two spheres is under 4% of the
 *    radius, which is no waist at all.
 *
 * 2. THE CUT TAKES TIME BECAUSE IT IS BEING EATEN, not because a timer is
 *    counting. `digDurationS` is volume over a colony-wide rate, so a bigger
 *    ant digs a bigger tunnel more slowly with nothing per-caste written
 *    anywhere — and that duration doubles as the cooldown.
 *
 * 3. THE BORE IS SEATED ON THE FIRST SOIL THE AIM MEETS. This is the one the
 *    tray could not do at all. Its gate asked whether soil lay within a
 *    couple of millimetres of her MANDIBLES, so on flat ground — where her
 *    dipped jaw still sits 1.89 mm up — she armed thirteen sites and bit
 *    none of them. The island walks the aim ray out to her nose reach and
 *    starts the bore wherever it lands, which is why it can open an entrance
 *    on level ground and the tray could not.
 *
 * `DigJob` itself is reused rather than reimplemented: it imports nothing but
 * `MM` and two tuning constants, and it deliberately leaves "what a chip does
 * to the soil" to its caller. This file is that caller for a density field.
 */

import * as THREE from 'three';
import type { DensityField } from '../../density/DensityField';
import type { CellRegion } from '../../density/SurfaceNets';
import { anyOf, bore } from '../../voxel/carve';
import { carveInto, type Bounds } from './carveInto';

/**
 * Take a beat's worth of spheres out of the soil, in ONE pass.
 *
 * A sphere at a time would be a remesh at a time — a dozen rebuilds a beat
 * for a cut that is one shape. `anyOf` unions them into a single field and
 * the whole beat is carved over one set of bounds, so the mesher runs once
 * however many slices the job handed over.
 *
 * Returns the dirty region, or null when the beat hit nothing but air.
 */
export function carveSweep(
  field: DensityField,
  points: readonly THREE.Vector3[],
  radius: number,
): CellRegion | null {
  if (points.length === 0 || !(radius > 0)) return null;
  const balls = points.map((p) => bore([p.x, p.y, p.z], [p.x, p.y, p.z], radius));
  return carveInto(field, anyOf(balls), sweepBounds(points, radius));
}

/** The box every sphere in the sweep fits inside. */
export function sweepBounds(
  points: readonly THREE.Vector3[], radius: number,
): Bounds {
  let x0 = Infinity; let y0 = Infinity; let z0 = Infinity;
  let x1 = -Infinity; let y1 = -Infinity; let z1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
  }
  return {
    x0: x0 - radius, y0: y0 - radius, z0: z0 - radius,
    x1: x1 + radius, y1: y1 + radius, z1: z1 + radius,
  };
}

/**
 * WALK THE AIM UNTIL IT MEETS SOIL — the island's `biteCentre`, for a field.
 *
 * From `origin` along `aim`, out to `reach`, in steps fine enough not to
 * pass through a wall. Returns the first solid point, or null if the whole
 * ray is air — which is a miss, and a miss is a real answer: she is aiming
 * at nothing and should not be told she dug.
 */
export function seatOnSoil(
  solidAt: (x: number, y: number, z: number) => boolean,
  origin: THREE.Vector3,
  aim: THREE.Vector3,
  reach: number,
  step: number,
  into: THREE.Vector3,
): boolean {
  for (let t = 0; t <= reach + 1e-9; t += step) {
    into.copy(origin).addScaledVector(aim, t);
    if (solidAt(into.x, into.y, into.z)) return true;
  }
  return false;
}
