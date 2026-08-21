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
 * How finely a surface search walks, as a fraction of the field's OWN cell.
 *
 * A hair under a cell, so a march cannot step over a thin wall between two
 * samples and report the far side of it. The bisections that follow are what
 * actually deliver the precision; the march only has to not miss the crossing.
 *
 * A FRACTION, and derived from the field rather than written down, because
 * this used to be the absolute 0.04 that suited a 0.05-unit cell — and the
 * moment the tray was rebuilt at a different resolution that constant meant
 * something else. A step finer than a cell only costs time; a step coarser
 * than a cell walks through walls. Tying it to the cell is the difference
 * between a number that stays true and one that was true once.
 */
export const STEP_PER_CELL = 0.8;

/**
 * How precisely a bracketed crossing is resolved, in world units.
 *
 * A TARGET rather than a count of halvings, and the difference showed the
 * first time the tray was rebuilt at a coarser cell. Four halvings of a
 * 0.05-unit cell resolves the surface to 0.0125 mm; four halvings of a
 * 0.1-unit cell resolves it to 0.025 mm — and her belly rides 0.02 mm above
 * the soil, so the ground had become less precise than the clearance it was
 * being asked to hold. A fixed count of halvings is a precision that changes
 * when nobody meant it to.
 *
 * 0.002 units is 0.01 mm, comfortably under the smallest gap the body model
 * cares about, and each extra halving it costs is one more sample.
 */
export const PRECISION = 0.002;

export class DensityGround implements Ground {
  /** This field's march step, in world units. See `STEP_PER_CELL`. */
  readonly step: number;

  /** Halvings needed to bring one step down to `PRECISION`. */
  readonly bisections: number;

  constructor(private readonly field: DensityField) {
    this.step = field.cellSize * STEP_PER_CELL;
    this.bisections = Math.max(
      1, Math.ceil(Math.log2(this.step / PRECISION)),
    );
  }

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
    for (let t = this.step; t <= down + 1e-9; t += this.step) {
      const value = this.field.sample(
        at.x - up.x * t, at.y - up.y * t, at.z - up.z * t,
      );
      if ((value > 0) !== (last > 0)) return -this.refine(at, up, -(t - this.step), -t);
      last = value;
    }
    /* Up: the same, for a foot that has ended up buried. */
    last = here;
    for (let t = this.step; t <= rise + 1e-9; t += this.step) {
      const value = this.field.sample(
        at.x + up.x * t, at.y + up.y * t, at.z + up.z * t,
      );
      if ((value > 0) !== (last > 0)) return this.refine(at, up, t - this.step, t);
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
    for (let i = 0; i < this.bisections; i += 1) {
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
    for (let y = from - this.step; y > 0; y -= this.step) {
      const value = this.field.sample(x, y, z);
      if (value > 0 && !(last > 0)) {
        /* Bisect between y and y + one step for the drawn surface. */
        let lo = y;
        let hi = y + this.step;
        for (let i = 0; i < this.bisections; i += 1) {
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
    const h = this.step;
    const dx = this.field.sample(x + h, y, z) - this.field.sample(x - h, y, z);
    const dy = this.field.sample(x, y + h, z) - this.field.sample(x, y - h, z);
    const dz = this.field.sample(x, y, z + h) - this.field.sample(x, y, z - h);
    /* The field grows INTO the soil, so out of it is the negative gradient. */
    into.set(-dx, -dy, -dz);
    if (into.lengthSq() < 1e-12) into.set(0, 1, 0);
    return into.normalize();
  }
}
