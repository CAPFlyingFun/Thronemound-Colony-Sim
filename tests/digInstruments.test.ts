import { describe, expect, it } from 'vitest';
import { bankOf } from '../src/scenes/bodyPosture';

/*
 * THE ROLL INSTRUMENT'S ARITHMETIC, pinned at the four attitudes a player
 * actually meets in a bore: level floor, a wall, the ceiling of a loop,
 * and the plumb shaft where the question has no answer.
 *
 * Convention under test: POSITIVE IS A POSITIVE ROTATION ABOUT HER
 * FORWARD, which drops her LEFT side — the same sign the scene applies to
 * `bodyBank + posture.roll`, where a LEFT turn banks positive, into the
 * turn. Zero is feet-down level, ±180° is upside down, and a vertical
 * forward returns null so the readout can hold rather than spin. The
 * first contract test below is the one that settles arguments: it rolls
 * a real up vector about a real forward, exactly as the scene does.
 */

const deg = (r: number | null): number | null => (
  r === null ? null : Math.round((r * 180) / Math.PI)
);

/** Her up after the scene's own roll: rotate world-up about forward +z. */
const rolledUp = (radians: number) => (
  { x: -Math.sin(radians), y: Math.cos(radians), z: 0 }
);

describe('bankOf, the roll behind the readout', () => {
  it('agrees with the rotation the scene actually applies', () => {
    /* The contract: feed it an up vector rolled about forward by the
     * rig's own positive rotation, and the same angle must come back
     * with the same sign — at a gentle bank and most of the way round. */
    const fwd = { x: 0, y: 0, z: 1 };
    for (const a of [0.3, -0.3, 1.2, -1.2, 2.8, -2.8]) {
      expect(deg(bankOf(fwd, rolledUp(a)))).toBe(Math.round((a * 180) / Math.PI));
    }
  });

  it('reads level when her up agrees with the world', () => {
    expect(deg(bankOf({ x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }))).toBe(0);
  });

  it('reads a left-side drop as positive', () => {
    /* Facing north (+z), a positive roll carries her right flank toward
     * her up — the left side is the one going down. */
    expect(deg(bankOf({ x: 0, y: 0, z: 1 }, rolledUp(Math.PI / 4)))).toBe(45);
  });

  it('reads a right-side drop as negative', () => {
    expect(deg(bankOf({ x: 0, y: 0, z: 1 }, rolledUp(-Math.PI / 4)))).toBe(-45);
  });

  it('calls the ceiling of a loop upside down', () => {
    /* Feet on the roof: her up points at the earth's core. The atan2 pair
     * is what keeps this honest — a dot-product-only version would fold
     * 170° and 10° together, which is exactly the difference between
     * "fine" and "on her back". */
    expect(Math.abs(deg(bankOf({ x: 0, y: 0, z: 1 }, { x: 0, y: -1, z: 0 }))!)).toBe(180);
  });

  it('is world-referenced, whatever the heading', () => {
    /* The same level attitude must read level facing any compass point. */
    const headings: Array<[number, number]> = [[1, 0], [-1, 0], [0, -1], [0.6, 0.8]];
    for (const [x, z] of headings) {
      expect(deg(bankOf({ x, y: 0, z }, { x: 0, y: 1, z: 0 }))).toBe(0);
    }
  });

  it('stays honest on a slope — pitch is not roll', () => {
    /* Nose 45° down a bank, body square to it: pitched, not banked. */
    const s = Math.SQRT1_2;
    expect(deg(bankOf({ x: 0, y: -s, z: s }, { x: 0, y: s, z: s }))).toBe(0);
  });

  it('declines to answer when she is plumb', () => {
    /* Straight down a shaft there is no horizon to bank against; the
     * readout holds its last value, like the bearing through the same
     * degeneracy. */
    expect(bankOf({ x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 })).toBeNull();
    expect(bankOf({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 })).toBeNull();
  });

  it('holds rather than display garbage', () => {
    /* An instrument fed a NaN frame — mid-teleport, mid-fall, whatever —
     * must go quiet, not spin. */
    expect(bankOf({ x: NaN, y: 0, z: 1 }, { x: 0, y: 1, z: 0 })).toBeNull();
    expect(bankOf({ x: 0, y: 0, z: 1 }, { x: 0, y: NaN, z: 0 })).toBeNull();
  });
});
