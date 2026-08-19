import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  BISECTIONS, STEP_VOXELS, VoxelGround, surfaceAlong, type SolidAt,
} from '../src/sim/voxelGround';
import { AIR, TOPSOIL, STONE } from '../src/voxel/VoxelWorld';

/** A world that is solid below `top` and air above it. */
const shelf = (top: number): SolidAt => (_x, y) => y < top;

/** Straight down, the axis a standing ant searches along. */
const DOWN = { ux: 0, uy: 1, uz: 0 };

const find = (
  solid: SolidAt, y: number, down = 4, rise = 4,
) => surfaceAlong(solid, 0, y, 0, DOWN.ux, DOWN.uy, DOWN.uz, down, rise);

/*
 * The precision the bisection buys, and the tolerance every position
 * expectation below is held to.
 *
 * Written as the formula rather than as a number on purpose. A first draft
 * asserted `toBeCloseTo(x, 2)` — tighter than the contract — and failed at
 * 0.00625 off, which is the search working exactly as documented. A test
 * that demands more precision than the thing promises is a test that breaks
 * on correct code, so this reads the promise from the constants.
 */
const TOL = STEP_VOXELS / 2 ** BISECTIONS;

/*
 * THE ONE QUESTION THE LEG SOLVER ASKS THE WORLD.
 *
 * `LegDrive` has always had it answered by the island's density field, where
 * the ground is a smooth signed function. Voxels are the opposite — hard
 * cells with axis-aligned faces and no gradient — so this search is the
 * whole of the difference between the two builds, and it is exactly the kind
 * of code whose bugs only show up as an ant standing a millimetre inside a
 * floor two hours later.
 *
 * Tested against hand-written shelves rather than a real world: a floor at a
 * known height, a step, a ceiling. If the search is right about those it is
 * right about soil, and if it is wrong the test says which shape broke it.
 */
describe('finding the surface along a leg axis', () => {
  it('finds a floor below her, and reports it as a negative offset', () => {
    /* Standing at 6 over a floor whose top face is at 4: two voxels down. */
    expect(Math.abs(find(shelf(4), 6)! - -2)).toBeLessThanOrEqual(TOL + 1e-9);
  });

  it('finds it from any height in the band, always at the same place', () => {
    for (const y of [4.1, 4.5, 5, 6, 7.9]) {
      const t = find(shelf(4), y, 8, 8);
      expect(t).not.toBeNull();
      expect(Math.abs(y + t! - 4)).toBeLessThanOrEqual(TOL + 1e-9);
    }
  });

  it('answers null when the band holds no surface at all', () => {
    /* High above the floor with a short reach — nothing to stand on, which
     * is a real answer: the leg stays up. See `Ground.nearest`. */
    expect(find(shelf(4), 20, 1, 1)).toBeNull();
    /* And in a world with no ground whatsoever. */
    expect(find(() => false, 6)).toBeNull();
  });

  it('walks her UP out of soil she has settled into', () => {
    /*
     * Not an error case — she seats a fraction into the ground every frame,
     * so the search starts inside solid and the surface is above her. This
     * is what the `rise` half of the band is for.
     */
    const t = find(shelf(4), 3.4);
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThan(0);
    expect(Math.abs(3.4 + t! - 4)).toBeLessThanOrEqual(TOL + 1e-9);
  });

  it('takes the surface NEAREST her, not the lowest one in reach', () => {
    /*
     * A lip: solid from 6 to 7, air under it, floor again below 4. Standing
     * at 7.2 both are inside the band, and a foot reaches for the one it is
     * nearly touching. Picking the deepest would drop her through the lip.
     */
    const lip: SolidAt = (_x, y) => (y >= 6 && y < 7) || y < 4;
    const t = find(lip, 7.2, 6, 2);
    expect(t).not.toBeNull();
    expect(Math.abs(7.2 + t! - 7)).toBeLessThanOrEqual(TOL + 1e-9);
  });

  it('lands on the AIR side of the face, never inside the soil', () => {
    /* A foot stands ON the ground. Half a bisection of slack inside would
     * be a foot buried, which the leg solver then tries to lift out of. */
    for (const top of [3, 4.0, 9]) {
      const t = find(shelf(top), top + 2.5);
      expect(t).not.toBeNull();
      expect(top + 2.5 + t!).toBeGreaterThanOrEqual(top - TOL);
    }
  });

  it('is as precise as the bisection promises', () => {
    /* The comment on BISECTIONS claims 1/128 of a cell. Hold it to that,
     * so nobody trims the loop without noticing what it cost. */
    const t = find(shelf(4.5), 7);
    expect(Math.abs(7 + t! - 4.5)).toBeLessThanOrEqual(TOL + 1e-9);
  });

  it('searches along a TILTED axis, not just straight down', () => {
    /*
     * Her up is not world up on a slope, and the leg asks along HER axis.
     * A 45-degree axis over a floor at 4 from a body at 6 has to travel
     * sqrt(2) times as far to cover the same two voxels of height.
     */
    const s = Math.SQRT1_2;
    const t = surfaceAlong(shelf(4), 0, 6, 0, s, s, 0, 8, 8);
    expect(t).not.toBeNull();
    expect(6 + s * t!).toBeCloseTo(4, 1);
  });
});

describe('the adapter over a real voxel world', () => {
  /** The smallest world that can have a floor: solid under 4, air over. */
  const world = {
    get: (_x: number, y: number, _z: number) => (y < 4 ? TOPSOIL : AIR),
    inBounds: (x: number, y: number, z: number) => (
      x >= 0 && x < 8 && y >= 0 && y < 8 && z >= 0 && z < 8
    ),
  };

  it('reads a cell as solid from its own floor upward', () => {
    const g = new VoxelGround(world);
    /* The voxel at y=3 owns 3.0 to 4.0, so 3.9 is inside it and 4.0 is not. */
    expect(g.solidAt(1, 3.9, 1)).toBe(true);
    expect(g.solidAt(1, 4.0, 1)).toBe(false);
  });

  it('treats outside the tank as AIR, not as solid', () => {
    /*
     * The formicarium's walls are cells INSIDE the world (see
     * `formicarium.isGlassCell`), so past the edge is outside the tank and
     * there is nothing out there to stand on. Reading it as solid would
     * give her an invisible ledge all the way round.
     */
    const g = new VoxelGround(world);
    expect(g.solidAt(-1, 2, 1)).toBe(false);
    expect(g.solidAt(99, 2, 1)).toBe(false);
  });

  it('hands the leg solver a world-space point on the floor', () => {
    const g = new VoxelGround(world);
    const hit = g.nearest(
      new THREE.Vector3(2.5, 6, 2.5), new THREE.Vector3(0, 1, 0), 4, 1,
    );
    expect(hit).not.toBeNull();
    expect(Math.abs(hit!.y - 4)).toBeLessThanOrEqual(TOL + 1e-9);
    /* Straight down: it must not wander in x or z. */
    expect(hit!.x).toBeCloseTo(2.5, 6);
    expect(hit!.z).toBeCloseTo(2.5, 6);
  });

  it('returns null rather than a guess when nothing is under her', () => {
    const g = new VoxelGround(world);
    expect(g.nearest(
      new THREE.Vector3(2.5, 7.5, 2.5), new THREE.Vector3(0, 1, 0), 0.5, 0.5,
    )).toBeNull();
  });

  it('stands on stone as readily as on soil — solid is solid', () => {
    const stony = { ...world, get: (_x: number, y: number) => (y < 2 ? STONE : AIR) };
    const g = new VoxelGround(stony);
    const hit = g.nearest(
      new THREE.Vector3(1.5, 5, 1.5), new THREE.Vector3(0, 1, 0), 5, 1,
    );
    expect(Math.abs(hit!.y - 2)).toBeLessThanOrEqual(TOL + 1e-9);
  });
});
