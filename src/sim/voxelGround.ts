/**
 * THE BRIDGE: voxel soil, answered in the shape the leg solver asks in.
 *
 * `LegDrive` has one question about the world — "where is the nearest solid
 * surface along this leg's up axis" — and it has always been answered by the
 * island's signed density field. The colony simulator's ground is voxels
 * instead: hard cells, axis-aligned faces, no gradient anywhere. This file
 * is the whole of the difference between the two.
 *
 * IT IS AN ADAPTER AND NOTHING ELSE. `src/anim/*` is shared with the frozen
 * island build, so the rule is that the new simulation bends to the body
 * rather than the body to the simulation. Nothing here reaches back into
 * `LegDrive`; it only implements `Ground`.
 *
 * THE MATHS IS SEPARATE FROM THREE AND FROM THE VOXEL WORLD, deliberately.
 * `surfaceAlong` takes a "is this point solid" predicate and three plain
 * numbers, which means the search can be tested against a hand-written
 * shelf — a floor at 4.0, a step, a ceiling — with no renderer and no world
 * to allocate. That is where the bugs in a search like this actually live.
 *
 * WHY A MARCH AND A BISECTION rather than an exact plane intersection.
 * Exact would be tempting: voxel faces are axis-aligned planes at integer
 * boundaries, so the crossing has a closed form for an axis-aligned search.
 * But the leg's up is NOT axis-aligned in general — she stands on a slope,
 * she leans — and the closed form for an arbitrary ray through a cell grid
 * is a DDA that has to handle every degenerate case a leg can produce. The
 * march is a dozen lines, has no special cases, and its error is bounded by
 * a number this file chooses. Precision is bought with bisections, which
 * are three lines and cost four samples.
 */

import * as THREE from 'three';
import { isSolid, type VoxelId } from '../voxel/VoxelWorld';

/** What the search needs of a world: whether a point is inside solid. */
export type SolidAt = (x: number, y: number, z: number) => boolean;

/**
 * The world as both the mesher and the ant read it.
 *
 * `fill` is the mesher's own partial-cell fraction — how much of a top cell
 * is drawn, 0..1 — and honouring it here is not an optimisation, it is the
 * whole reason this interface has three members instead of two.
 *
 * MEASURED, on the first run of `probe:habitat`: with the ant standing on
 * whole cells, two of her six feet were planted and the rest were groping.
 * A voxel is five millimetres and the queen stands 3.2 mm tall, so a
 * one-cell step in the lattice is a cliff HALF AGAIN her own height — every
 * gentle slope in the terrain is a staircase she cannot climb, while the
 * mesher was drawing it as the smooth bank it is meant to be. She was
 * walking on a surface nobody could see.
 *
 * So the ant reads the fill the renderer reads. This project's oldest rule,
 * arrived at from the other end: she stands on the ground the player sees.
 */
export interface SoilSampler {
  get(x: number, y: number, z: number): VoxelId;
  inBounds(x: number, y: number, z: number): boolean;
  /** How much of this cell is drawn, 0..1. Absent means whole. */
  fill?(x: number, y: number, z: number): number;
}

/**
 * How finely the band is walked, in voxels.
 *
 * An eighth of a cell. The face it is looking for is a whole cell wide, so
 * anything under half a cell cannot step over one; an eighth leaves room for
 * the search to start inside a cell and still see its far face. Smaller
 * would be wasted — the bisection below is what buys the precision, and it
 * buys it far more cheaply than more marching does.
 */
export const STEP_VOXELS = 0.125;

/**
 * How many times the crossing is halved once it is bracketed.
 *
 * Four. Each halving quarters nothing and halves the error, so four takes an
 * eighth-cell bracket to 1/128 of a cell — 0.04 mm at five millimetres a
 * voxel, which is a fifth of the leg solver's own foot clearance and
 * therefore invisible to it. A fifth bisection would be measuring the
 * lattice rather than the ground.
 */
export const BISECTIONS = 4;

/**
 * How far along `up` from `at` the nearest solid surface is, or null.
 *
 * Positive is along `+up`, negative is below her. The band searched is
 * `[-down, +rise]`, and the answer is the crossing NEAREST TO ZERO rather
 * than the lowest or the highest — a foot reaches for the surface closest to
 * where it already is, and picking the deepest one would have it dive
 * through a floor to a lower one whenever both were in range.
 *
 * A point that starts INSIDE solid is a real case, not an error: she settles
 * a fraction into the ground every frame. The surface is then found by
 * walking UP out of it, which is what the `rise` half of the band is for.
 */
export function surfaceAlong(
  solid: SolidAt,
  ox: number, oy: number, oz: number,
  ux: number, uy: number, uz: number,
  down: number,
  rise: number,
  step = STEP_VOXELS,
): number | null {
  const at = (t: number): boolean => solid(ox + ux * t, oy + uy * t, oz + uz * t);

  /*
   * Walked from the TOP of the band downward, so the first crossing found is
   * the highest solid under her rather than the first cell the march happens
   * to clip. Then the nearest-to-zero rule picks between the two halves.
   */
  let best: number | null = null;
  let prevT = rise;
  let prevSolid = at(rise);
  for (let t = rise - step; t >= -down - 1e-9; t -= step) {
    const nowSolid = at(t);
    if (nowSolid !== prevSolid) {
      /* Bracketed: air on one side, solid on the other. The surface is the
       * boundary, so halve toward it and keep the AIR side as the answer —
       * a foot stands ON the ground, not a hair inside it. */
      let lo = t;            // the lower sample
      let hi = prevT;        // the upper sample
      let loSolid = nowSolid;
      for (let i = 0; i < BISECTIONS; i += 1) {
        const mid = (lo + hi) / 2;
        if (at(mid) === loSolid) lo = mid; else hi = mid;
      }
      /* `loSolid` says which end is solid; the surface is the air-side edge. */
      const hit = loSolid ? hi : lo;
      if (best === null || Math.abs(hit) < Math.abs(best)) best = hit;
      /* Keep walking: a lower crossing can still be nearer to zero when she
       * is standing inside a lip with air below her. */
    }
    prevT = t;
    prevSolid = nowSolid;
  }
  return best;
}

/**
 * `LegDrive`'s ground, backed by voxels.
 *
 * One unit is one voxel is five millimetres — the same scale the ant's rig
 * is built at — so nothing here converts anything, and there is no factor to
 * get wrong. See `VOXEL_MM`.
 */
export class VoxelGround {
  constructor(private readonly world: SoilSampler) {}

  /**
   * Is this POINT inside solid soil?
   *
   * The cell it lands in, filled from its own floor upward by `fill` — so a
   * top cell drawn seven tenths full is solid for the first seven tenths of
   * its height and air above that, exactly as it is rendered. A whole cell
   * is the ordinary case and costs one comparison.
   *
   * Out of bounds is AIR rather than solid: the formicarium's walls are
   * cells INSIDE the world, so past the edge is outside the tank and there
   * is nothing out there to stand on.
   */
  readonly solidAt: SolidAt = (x, y, z) => {
    const vx = Math.floor(x);
    const vy = Math.floor(y);
    const vz = Math.floor(z);
    if (!this.world.inBounds(vx, vy, vz)) return false;
    if (!isSolid(this.world.get(vx, vy, vz))) return false;
    const fill = this.world.fill?.(vx, vy, vz) ?? 1;
    return fill >= 1 ? true : (y - vy) < fill;
  };

  /**
   * The top of the soil in a column, or null for a column with nothing in
   * it — the question a body asks, as opposed to the one a leg asks.
   *
   * Scanned down from `from`, and the answer carries the top cell's fill, so
   * it lands on the drawn surface rather than on a cell boundary.
   */
  surfaceIn(x: number, z: number, from: number): number | null {
    const vx = Math.floor(x);
    const vz = Math.floor(z);
    for (let vy = Math.floor(from); vy >= 0; vy -= 1) {
      if (!this.world.inBounds(vx, vy, vz)) continue;
      if (!isSolid(this.world.get(vx, vy, vz))) continue;
      const fill = this.world.fill?.(vx, vy, vz) ?? 1;
      /* An empty cell is not ground even when its id is solid — see the note
       * on `solidAt`, which already agrees: `(y - vy) < 0` is never true. */
      if (fill <= 0) continue;
      return vy + fill;
    }
    return null;
  }

  /** See `Ground.nearest` in `legDrive`. */
  nearest(
    at: THREE.Vector3, up: THREE.Vector3, down: number, rise: number,
  ): THREE.Vector3 | null {
    const t = surfaceAlong(
      this.solidAt, at.x, at.y, at.z, up.x, up.y, up.z, down, rise,
    );
    if (t === null) return null;
    return new THREE.Vector3(
      at.x + up.x * t, at.y + up.y * t, at.z + up.z * t,
    );
  }
}
