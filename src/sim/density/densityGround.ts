/**
 * THE GROUND, READ FROM THE DENSITY FIELD — what her feet and her body stand
 * on, and what the mesher draws, from ONE source.
 *
 * This is the file where the staircase dies. The voxel ground answered "the
 * top of this column", which can only be a height per column, so a dug ramp
 * was a run of 5 mm treads and her front foot — which reaches 0.81 mm below
 * her body — could not follow it. A density field is sampled ANYWHERE, so the
 * surface between two cells is an interpolation rather than a step, and a
 * tunnel floor is as smooth as its arithmetic.
 *
 * It implements `Ground` unchanged, which is the point: `LegDrive` and
 * `AntBody` do not learn that the terrain changed underneath them. The brief
 * asked for the terrain implementation to be replaced behind the existing
 * abstraction rather than the leg system rewritten, and this is that.
 *
 * ## Normals come from the GRADIENT, not from triangles
 *
 * A triangle normal is piecewise — it jumps at every edge, and inside a tunnel
 * there may be no triangle under the point being asked about at all. The
 * field's gradient is defined everywhere the field is, costs six samples, and
 * points out of the soil by construction. So the gameplay normal is the
 * gradient's and the rendering normal is the mesher's; they agree because they
 * read the same field.
 */

import * as THREE from 'three';
import type { DensityField } from '../../density/DensityField';
import type { Ground } from '../../anim/legDrive';

/**
 * How finely a surface search walks before it bisects, in world units.
 *
 * A hair under a cell, so a march cannot step over a thin wall between two
 * samples and report the far side of it. The bisections that follow are what
 * actually deliver the precision; the march only has to not miss the crossing.
 */
export const STEP = 0.04;

/** Halvings after the crossing is bracketed. Four gives ~1/16 of a step. */
export const BISECTIONS = 4;

export class DensityGround implements Ground {
  constructor(private readonly field: DensityField) {}

  /** Is this point inside soil? The whole of "solid", in one sample. */
  solidAt = (x: number, y: number, z: number): boolean => (
    this.field.sample(x, y, z) > 0
  );

  /**
   * Where the surface is along a ray from `at`, searching `down` then `rise`.
   *
   * `Ground.nearest`'s contract: the nearest solid point along -up within
   * `down`, or along +up within `rise`, or null. Kept exactly, because
   * `LegDrive` is guarded and must not notice the change.
   */
  nearest(
    at: THREE.Vector3, up: THREE.Vector3, down: number, rise: number,
  ): THREE.Vector3 | null {
    const t = this.crossing(at, up, down, rise);
    if (t === null) return null;
    return new THREE.Vector3(
      at.x + up.x * t, at.y + up.y * t, at.z + up.z * t,
    );
  }

  /**
   * The offset along `up` at which the field crosses zero, or null.
   *
   * Searched DOWN first and then UP, and nearest-to-zero wins, because a foot
   * just above the floor and a foot just inside it both want the same answer:
   * the surface closest to where it already is.
   */
  private crossing(
    at: THREE.Vector3, up: THREE.Vector3, down: number, rise: number,
  ): number | null {
    const here = this.field.sample(at.x, at.y, at.z);
    const inside = here > 0;

    /* Down: looking for the first place the sign flips. */
    let last = here;
    for (let t = STEP; t <= down + 1e-9; t += STEP) {
      const value = this.field.sample(
        at.x - up.x * t, at.y - up.y * t, at.z - up.z * t,
      );
      if ((value > 0) !== (last > 0)) return -this.refine(at, up, -(t - STEP), -t);
      last = value;
    }
    /* Up: the same, for a foot that has ended up buried. */
    last = here;
    for (let t = STEP; t <= rise + 1e-9; t += STEP) {
      const value = this.field.sample(
        at.x + up.x * t, at.y + up.y * t, at.z + up.z * t,
      );
      if ((value > 0) !== (last > 0)) return this.refine(at, up, t - STEP, t);
      last = value;
    }
    /*
     * No crossing. If the point is already inside soil and nothing flipped,
     * she is buried deeper than the search — which is a real answer of "no
     * surface within reach" rather than a failure, and the caller treats it
     * as groping.
     */
    void inside;
    return null;
  }

  /** Bisect a bracketed crossing. `a` and `b` are offsets along `up`. */
  private refine(
    at: THREE.Vector3, up: THREE.Vector3, a: number, b: number,
  ): number {
    let lo = a;
    let hi = b;
    const sign = this.field.sample(
      at.x + up.x * lo, at.y + up.y * lo, at.z + up.z * lo,
    ) > 0;
    for (let i = 0; i < BISECTIONS; i += 1) {
      const mid = (lo + hi) / 2;
      const value = this.field.sample(
        at.x + up.x * mid, at.y + up.y * mid, at.z + up.z * mid,
      ) > 0;
      if (value === sign) lo = mid; else hi = mid;
    }
    return Math.abs((lo + hi) / 2);
  }

  /**
   * The top of the soil in a column, looked for from a height — the question
   * the BODY asks, as opposed to the one a leg asks.
   *
   * Scanned down from `from`, so an ant in a tunnel gets her own floor rather
   * than the roof with the whole tray on top of it. The same argument the
   * voxel version needed, for the same reason.
   */
  surfaceIn(x: number, z: number, from: number): number | null {
    let last = this.field.sample(x, from, z);
    for (let y = from - STEP; y > 0; y -= STEP) {
      const value = this.field.sample(x, y, z);
      if (value > 0 && !(last > 0)) {
        /* Bisect between y and y + STEP for the drawn surface. */
        let lo = y;
        let hi = y + STEP;
        for (let i = 0; i < BISECTIONS; i += 1) {
          const mid = (lo + hi) / 2;
          if (this.field.sample(x, mid, z) > 0) lo = mid; else hi = mid;
        }
        return (lo + hi) / 2;
      }
      last = value;
    }
    return null;
  }

  /**
   * Which way the surface faces here — the gradient, normalised and pointing
   * OUT of the soil.
   *
   * Six samples by central difference. Used for body attitude and for shading
   * a carved face; not yet wired to either, but it belongs with the queries it
   * shares a field with rather than in whichever file first wants it.
   */
  normalAt(x: number, y: number, z: number, into: THREE.Vector3): THREE.Vector3 {
    const h = STEP;
    const dx = this.field.sample(x + h, y, z) - this.field.sample(x - h, y, z);
    const dy = this.field.sample(x, y + h, z) - this.field.sample(x, y - h, z);
    const dz = this.field.sample(x, y, z + h) - this.field.sample(x, y, z - h);
    /* The field grows INTO the soil, so out of it is the negative gradient. */
    into.set(-dx, -dy, -dz);
    if (into.lengthSq() < 1e-12) into.set(0, 1, 0);
    return into.normalize();
  }
}
