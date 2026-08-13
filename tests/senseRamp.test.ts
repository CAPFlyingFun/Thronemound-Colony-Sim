/*
 * THE SENSED VIEW COMES UP AS SHE SINKS.
 *
 * It used to be a switch at sixteen millimetres, which meant the wireframe
 * stayed off through the entire entrance dig and snapped on near the
 * bottom of it — reported from the phone at seventeen millimetres down.
 * The fade is the fix, so the shape of the fade is what gets pinned.
 */
import { describe, expect, it } from 'vitest';
import { SENSE_FULL_MM, SENSE_ON_MM, senseAt } from '../src/scenes/islandTuning';

describe('how deep the sensed view comes up', () => {
  it('is off at the surface and above it', () => {
    expect(senseAt(0)).toBe(0);
    expect(senseAt(-4)).toBe(0);
    expect(senseAt(SENSE_ON_MM)).toBe(0);
  });

  it('is fully up by five millimetres, and stays up below that', () => {
    expect(senseAt(SENSE_FULL_MM)).toBe(1);
    expect(senseAt(17)).toBe(1);
    expect(senseAt(500)).toBe(1);
  });

  /* The bug in one assertion: at the depth it was REPORTED at, the old
   * threshold was still off and this is long since full. */
  it('is already full at the depth the switch used to fire', () => {
    expect(senseAt(16)).toBe(1);
  });

  it('rises smoothly across the band rather than stepping', () => {
    const band = [1.5, 2, 2.5, 3, 3.5, 4, 4.5].map(senseAt);
    band.forEach((v, i) => {
      if (i === 0) return;
      const prev = band[i - 1] as number;
      expect(v).toBeGreaterThan(prev);
      /* No single step may carry more than its share — that would be a
       * switch wearing a ramp's clothes. */
      expect(v - prev).toBeLessThan(0.2);
    });
    expect(senseAt(3)).toBeCloseTo(0.5, 6);
  });
});
