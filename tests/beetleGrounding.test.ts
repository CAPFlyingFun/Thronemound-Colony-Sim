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
import type { PropGround } from '../src/scenes/islandProps';
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

/**
 * A FLOOR AT `GROUND`, EVERYWHERE — the shape `Beetle.tick` now asks for.
 *
 * It used to take `(x, z) => height`, the surface heightfield, which is the
 * bug this replaced: that field knows nothing about digging, so a beetle
 * walked over the mouth of a shaft on terrain that was no longer there.
 * `PropGround` answers "what is the floor under this POINT", which a carve
 * does change.
 */
const flat: PropGround = {
  floorUnder: () => GROUND,
  soilNormal: (_x, _y, _z, into) => { into.set(0, 1, 0); },
  insideBy: (_x, y) => GROUND - y,
};

describe('procedural beetle grounding', () => {
  it('stands ON the terrain, neither sunk nor floating', () => {
    const beetle = new Beetle('grounded', 0, GROUND, 0);
    beetle.tick(1 / 60, flat, false);
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
      beetle.tick(1 / 60, flat, false);
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
    beetle.tick(1 / 60, flat, false);
    const gap = clearanceMm(beetle, GROUND);
    /* THE ONE THAT WAS REPORTED. Before the lift this was 3.4 mm under. */
    expect(gap).toBeGreaterThanOrEqual(-1e-4);
    expect(gap).toBeLessThan(RESTS_MM);
  });

  it('still rests while it is being fought', () => {
    const beetle = new Beetle('struggling', 0, GROUND, 0);
    for (let i = 0; i < 120; i += 1) {
      beetle.tick(1 / 60, flat, true);
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
    beetle.tick(1 / 60, flat, false);
    expect(beetle.at.y).toBe(GROUND);
    expect(beetle.root.position.y).toBeGreaterThan(GROUND);
  });

  it('does not lift a beetle that is in her jaws', () => {
    /* Carried, `at` is a JAW anchor rather than a terrain contact, so the
     * ground has no say and neither does the lift. */
    const beetle = new Beetle('cargo', 0, GROUND, 0);
    beetle.carried = true;
    beetle.at.set(1, GROUND + 2, 1);
    beetle.tick(1 / 60, flat, false);
    expect(beetle.root.position.y).toBe(GROUND + 2);
  });
});

describe('it does not walk over an opening', () => {
  /*
   * Reported from the device: "the ladybug just walked over the opening".
   *
   * Two faults in one line. `tick` took the SURFACE HEIGHTFIELD, which
   * knows nothing about digging, so it strolled across the mouth of a shaft
   * at the height the hill used to be. And fixing only the height would
   * have swapped one wrong behaviour for another — it would have dropped
   * down the shaft instead, and a ladybug in the queen's chamber is a worse
   * surprise than one on the lawn.
   */
  /** Solid at `GROUND`, except a shaft past x = 0 that falls away. */
  const shaft = (depth: number): PropGround => ({
    floorUnder: (x) => (x > 0 ? GROUND - depth : GROUND),
    soilNormal: (_x, _y, _z, into) => { into.set(0, 1, 0); },
    insideBy: (x, y) => (x > 0 ? GROUND - depth : GROUND) - y,
  });

  /*
   * THE HEADING IS RE-ASSERTED EVERY FRAME, and that is the point.
   *
   * `turnIn` starts at zero, so the wander re-rolls the heading on the very
   * first tick and a heading set once is gone before the beetle takes a
   * step. Holding it pins the test to the STEP DECISION — does it move onto
   * that spot or not — instead of measuring where the wander happened to
   * send it, which is what the first version of this test did.
   *
   * A beetle that refuses the step still cannot advance while the heading
   * is held, so a refusal shows up as staying put rather than as turning.
   */
  const walkAt = (b: Beetle, ground: PropGround, seconds: number): void => {
    for (let i = 0; i < seconds * 60; i += 1) {
      b.headingForTest = Math.PI / 2;
      b.tick(1 / 60, ground, false);
    }
  };

  it('turns away from a drop instead of crossing it', () => {
    const b = new Beetle('edge', -0.4, GROUND, 0);
    walkAt(b, shaft(20 / 5), 6);
    expect(b.at.x).toBeLessThanOrEqual(0.02);
    /* And it is still on the solid side's floor, not in the hole. */
    expect(b.at.y).toBeCloseTo(GROUND, 3);
  });

  it('walks down a lip it can manage', () => {
    /* The rule is "not into a hole", not "never descends" — a step it could
     * take without thinking must not become a wall. */
    const lip = 0.6 / 5;
    const b = new Beetle('lip', -0.4, GROUND, 0);
    walkAt(b, shaft(lip), 6);
    expect(b.at.x).toBeGreaterThan(0.05);
    expect(b.at.y).toBeCloseTo(GROUND - lip, 3);
  });

  it('does not stall where there is no floor at all', () => {
    /* Over a void `floorUnder` reports -Infinity. It must refuse the step
     * and keep its position finite rather than being handed a NaN. */
    const none: PropGround = {
      floorUnder: (x) => (x > 0 ? -Infinity : GROUND),
      soilNormal: (_x, _y, _z, into) => { into.set(0, 1, 0); },
      insideBy: () => -1,
    };
    const b = new Beetle('void', -0.4, GROUND, 0);
    walkAt(b, none, 6);
    expect(Number.isFinite(b.at.x)).toBe(true);
    expect(Number.isFinite(b.at.y)).toBe(true);
    expect(b.at.x).toBeLessThanOrEqual(0.02);
  });
});
