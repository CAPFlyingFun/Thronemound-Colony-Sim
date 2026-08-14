/*
 * THE BEETLE STANDS ON THE GROUND — not in it, and not over it.
 *
 * Reported from a phone: the beetle visibly sinks into the terrain, worst
 * once it is dead. The terrain sampler was never the cause — spawn and tick
 * both read `walkGroundAt`, which is the drawn height. The art is: the
 * shell hangs below the root's local origin, and the fallen pose then
 * rotates the whole model 153° about that same origin, swinging most of the
 * beetle underground.
 *
 * `at.y` STAYS ON THE TERRAIN, because combat reach and carry reach read
 * `at`; only the rendered root rises. So these tests measure PIXELS, not
 * gameplay, and there is a separate one below pinning `at` in place so a
 * future lift cannot quietly become a teleport.
 *
 * TWO-SIDED ON PURPOSE. "Not below the ground" alone is the assertion that
 * lets the fix overshoot, and the first version of it did: measuring with
 * `Box3.setFromObject` expands by each geometry's axis-aligned box CORNERS,
 * so a rotated sphere is measured as a rotated CUBE and the fallen beetle
 * was lifted 0.81 mm too high — a carcass hovering instead of one buried,
 * which passes a one-sided test perfectly. Every case here also asserts it
 * is RESTING.
 *
 * And the ruler is vertices rather than `Box3`, or these would be checking
 * the fix with the same instrument that produced the bug.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Beetle } from '../src/scenes/Beetle';
import { MM } from '../src/world/worldScape';

/** The lowest RENDERED point, in world units. Exact — see the header. */
const bottomOf = (beetle: Beetle): number => {
  beetle.root.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  let low = Infinity;
  beetle.root.traverse((n) => {
    const mesh = n as THREE.Mesh;
    const pos = mesh.geometry?.attributes?.position;
    if (!pos) return;
    for (let i = 0; i < pos.count; i += 1) {
      v.fromBufferAttribute(pos as THREE.BufferAttribute, i)
        .applyMatrix4(mesh.matrixWorld);
      if (v.y < low) low = v.y;
    }
  });
  return low;
};

/** How far its lowest point clears the ground, in MILLIMETRES. */
const clearanceMm = (beetle: Beetle, ground: number): number =>
  (bottomOf(beetle) - ground) * MM;

/*
 * A tenth of a millimetre, against a beetle 2.6 mm tall. Tight enough that
 * the 0.81 mm the box-corner measurement added would fail it by eight
 * times over, loose enough not to break on float drift or on where in its
 * wobble the walk cycle happens to be.
 */
const RESTS_MM = 0.1;

const GROUND = 3;

describe('procedural beetle grounding', () => {
  it('stands ON the terrain, neither sunk nor floating', () => {
    const beetle = new Beetle('grounded', 0, GROUND, 0);
    beetle.tick(1 / 60, () => GROUND, false);
    const gap = clearanceMm(beetle, GROUND);
    expect(gap).toBeGreaterThanOrEqual(-1e-4);
    expect(gap).toBeLessThan(RESTS_MM);
  });

  it('stays put through a whole walk wobble', () => {
    /* The lift is one number for the whole cycle, so the pose it was NOT
     * measured at is where an under-lift would show. Walk it round. */
    const beetle = new Beetle('walker', 0, GROUND, 0);
    let worstSunk = 0;
    let worstFloat = 0;
    for (let i = 0; i < 200; i += 1) {
      beetle.tick(1 / 60, () => GROUND, false);
      const gap = clearanceMm(beetle, GROUND);
      worstSunk = Math.min(worstSunk, gap);
      worstFloat = Math.max(worstFloat, gap);
    }
    expect(worstSunk).toBeGreaterThanOrEqual(-1e-4);
    expect(worstFloat).toBeLessThan(RESTS_MM);
  });

  it('lies on the ground when it falls, rather than pivoting through it', () => {
    const beetle = new Beetle('fallen', 0, GROUND, 0);
    beetle.alive = false;
    beetle.tick(1 / 60, () => GROUND, false);
    const gap = clearanceMm(beetle, GROUND);
    /* THE ONE THAT WAS REPORTED. Before the lift this was 3.4 mm under. */
    expect(gap).toBeGreaterThanOrEqual(-1e-4);
    expect(gap).toBeLessThan(RESTS_MM);
  });

  it('still rests while it is being fought', () => {
    const beetle = new Beetle('struggling', 0, GROUND, 0);
    for (let i = 0; i < 120; i += 1) {
      beetle.tick(1 / 60, () => GROUND, true);
      expect(clearanceMm(beetle, GROUND)).toBeGreaterThanOrEqual(-1e-4);
      expect(clearanceMm(beetle, GROUND)).toBeLessThan(RESTS_MM);
    }
  });

  it('LEAVES `at` ON THE TERRAIN — the lift is pixels, not gameplay', () => {
    /* The reason this file is allowed to move anything at all. Reach tests
     * in `islandCombat` and `islandCarry` measure to `at`; a lift that
     * reached it would silently put a dead beetle out of range of the jaws
     * that are supposed to pick it up. */
    const beetle = new Beetle('anchor', 0, GROUND, 0);
    beetle.alive = false;
    beetle.tick(1 / 60, () => GROUND, false);
    expect(beetle.at.y).toBe(GROUND);
    expect(beetle.root.position.y).toBeGreaterThan(GROUND);
  });

  it('does not lift a beetle that is in her jaws', () => {
    /* Carried, `at` is a JAW anchor rather than a terrain contact, so the
     * ground has no say and neither does the lift. */
    const beetle = new Beetle('cargo', 0, GROUND, 0);
    beetle.carried = true;
    beetle.at.set(1, GROUND + 2, 1);
    beetle.tick(1 / 60, () => GROUND, false);
    expect(beetle.root.position.y).toBe(GROUND + 2);
  });
});
