import { describe, expect, it } from 'vitest';
import { bankOf } from '../src/scenes/bodyPosture';

/*
 * THE ROLL INSTRUMENT'S ARITHMETIC, pinned at the four attitudes a player
 * actually meets in a bore: level floor, a wall, the ceiling of a loop,
 * and the plumb shaft where the question has no answer.
 *
 * Convention under test: positive drops her RIGHT side (the posture rig's
 * own sign), zero is feet-down level, ±180° is upside down, and a vertical
 * forward returns null so the readout can hold rather than spin.
 */

const deg = (r: number | null): number | null => (
  r === null ? null : Math.round((r * 180) / Math.PI)
);

describe('bankOf, the roll behind the readout', () => {
  it('reads level when her up agrees with the world', () => {
    expect(deg(bankOf({ x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }))).toBe(0);
  });

  it('reads a right-side drop as positive', () => {
    /* Facing north (+z), right is +x; up leaning toward +x is her right
     * side going down. */
    const s = Math.SQRT1_2;
    expect(deg(bankOf({ x: 0, y: 0, z: 1 }, { x: s, y: s, z: 0 }))).toBe(45);
  });

  it('reads a left-side drop as negative', () => {
    const s = Math.SQRT1_2;
    expect(deg(bankOf({ x: 0, y: 0, z: 1 }, { x: -s, y: s, z: 0 }))).toBe(-45);
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
    for (const [x, z] of [[1, 0], [-1, 0], [0, -1], [0.6, 0.8]]) {
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
});
