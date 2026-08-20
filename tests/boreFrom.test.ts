import { describe, expect, it } from 'vitest';
import { bore } from '../src/voxel/carve';
import { boreFrom } from '../src/sim/density/boreFrom';
import { CASTE_DIG, boreRadiusMm, segmentBeyondJawMm } from '../src/sim/density/casteDig';

/**
 * The bore is positive INSIDE, so "inside" reads as `> 0`.
 *
 * These tests are about ONE claim: the directional bore removes what the
 * capsule removes in front of the ant, and nothing behind her.
 */
const inside = (f: (x: number, y: number, z: number) => number,
  x: number, y: number, z: number): boolean => f(x, y, z) > 0;

describe('boreFrom', () => {
  /* Aimed down +z from the origin, 9 mm long, 3 mm radius — the Queen. */
  const queen = boreFrom([0, 0, 0], [0, 0, 1], 9, 3);

  it('is inside along the length it was given', () => {
    expect(inside(queen, 0, 0, 0.1)).toBe(true);
    expect(inside(queen, 0, 0, 4.5)).toBe(true);
    expect(inside(queen, 0, 0, 8.9)).toBe(true);
  });

  it('is the radius it was given, across the bore', () => {
    expect(inside(queen, 2.9, 0, 4.5)).toBe(true);
    expect(inside(queen, 3.1, 0, 4.5)).toBe(false);
    expect(inside(queen, 0, 2.9, 4.5)).toBe(true);
    expect(inside(queen, 0, 3.1, 4.5)).toBe(false);
  });

  it('keeps a ROUNDED work face at the far end', () => {
    /* Past the end on the centreline, but within the cap. */
    expect(inside(queen, 0, 0, 11.9)).toBe(true);
    expect(inside(queen, 0, 0, 12.1)).toBe(false);
    /* Off-axis at the tip the cap curves in, which is what round means. */
    expect(inside(queen, 2.5, 0, 11)).toBe(false);
  });

  /*
   * THE WHOLE POINT OF THE FILE. A capsule anchored at the thorax scoops a
   * hemisphere out behind her; this must not.
   */
  it('takes NOTHING behind the origin, where a capsule would', () => {
    const capsule = bore([0, 0, 0], [0, 0, 9], 3);
    /* A capsule is inside here — 2 mm behind the start, on the centreline. */
    expect(inside(capsule, 0, 0, -2)).toBe(true);
    /* The directional bore is not. */
    expect(inside(queen, 0, 0, -2)).toBe(false);
    /* Nor anywhere else behind the thorax plane. */
    expect(inside(queen, 1, 1, -0.1)).toBe(false);
    expect(inside(queen, 0, 0, -0.001)).toBe(false);
  });

  it('agrees with the capsule everywhere in FRONT of the origin', () => {
    const capsule = bore([0, 0, 0], [0, 0, 9], 3);
    for (let z = 0.2; z < 12; z += 0.4) {
      for (let x = -4; x <= 4; x += 0.5) {
        expect(inside(queen, x, 0, z)).toBe(inside(capsule, x, 0, z));
      }
    }
  });

  it('works off-axis, not only down +z', () => {
    const diagonal = boreFrom([10, 5, 10], [1, -1, 0], 9, 3);
    const s = Math.SQRT1_2;
    /* Four millimetres along the aim is inside; four the other way is not. */
    expect(inside(diagonal, 10 + 4 * s, 5 - 4 * s, 10)).toBe(true);
    expect(inside(diagonal, 10 - 4 * s, 5 + 4 * s, 10)).toBe(false);
  });

  it('refuses to produce NaN from a zero-length aim', () => {
    const nowhere = boreFrom([0, 0, 0], [0, 0, 0], 9, 3);
    expect(Number.isNaN(nowhere(0, 0, 0))).toBe(false);
    expect(inside(nowhere, 0, 0, 0)).toBe(false);
  });
});

describe('CASTE_DIG', () => {
  it('gives every caste a round bore, because width equals height', () => {
    expect(boreRadiusMm('queen')).toBe(3);
    expect(boreRadiusMm('worker')).toBe(1.5);
    expect(boreRadiusMm('major')).toBe(2);
  });

  /*
   * A planned segment must extend well past her jaws, or "bore defines the
   * tunnel, reach gates the bite" would be a distinction with no difference —
   * she would simply reach the whole segment and the repositioning that makes
   * digging legible would never happen.
   */
  it('plans further than she can reach, so a segment takes several bites', () => {
    expect(segmentBeyondJawMm('queen')).toBeCloseTo(7.57, 2);
    expect(segmentBeyondJawMm('worker')).toBeCloseTo(5.05, 2);
    expect(segmentBeyondJawMm('major')).toBeCloseTo(5.0, 2);
    for (const caste of ['queen', 'worker', 'major'] as const) {
      expect(segmentBeyondJawMm(caste)).toBeGreaterThan(2);
    }
  });

  it('keeps the NOMINAL design diameters, not the measured stance widths', () => {
    /* Stance is wider than the bore for every caste — 7.22 / 3.37 / 4.62 mm.
     * That is a measured traversal question for phases 2 and 3, and must not
     * be silently resolved by enlarging the design. */
    expect(CASTE_DIG.queen.diameterMm).toBe(6);
    expect(CASTE_DIG.worker.diameterMm).toBe(3);
    expect(CASTE_DIG.major.diameterMm).toBe(4);
  });
});
