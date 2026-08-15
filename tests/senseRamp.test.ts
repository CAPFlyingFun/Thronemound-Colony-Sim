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
import { ROOF_OPEN_MM, ROOF_TIGHT_MM, roofShare } from '../src/scenes/undergroundSense';

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

/*
 * AND DEPTH IS ONLY HALF OF IT.
 *
 * Reported: "whenever going underground, the sky looks nighttime and
 * everything goes dark." The ramp above is full by five millimetres — about
 * her own height — and the sky is blended to near-black by the same number,
 * so a shallow scoop with open sky over it lit the world like midnight. The
 * depth is measured against the ORIGINAL heightfield too, which knows
 * nothing about digging, so any hollow she made counted.
 *
 * The other half is whether anything is actually between her and the sky.
 */
describe('whether there is a roof over her', () => {
  it('is nothing at all when the sky is open', () => {
    expect(roofShare(null)).toBe(0);
  });

  it('is full when the roof is close, the way a tunnel is', () => {
    expect(roofShare(0)).toBe(1);
    expect(roofShare(3)).toBe(1);
    expect(roofShare(ROOF_TIGHT_MM)).toBe(1);
  });

  it('counts a buried ROOM as inside, not as a third of the way', () => {
    /*
     * The question is whether there is SKY over her, not how low the
     * ceiling is. A first cut at 8 and 30 mm read a 22 mm queen chamber
     * eighty millimetres down as 0.341 — a buried room lit like an
     * overcast afternoon, with the whole hill on top of it. Measured in
     * the live scene, which is the only place it showed.
     */
    expect(roofShare(22)).toBe(1);
    expect(roofShare(10)).toBe(1);
  });

  it('fades out rather than switching, so a tunnel mouth is a crossing', () => {
    const at30 = roofShare(30);
    const at50 = roofShare(50);
    expect(at30).toBeGreaterThan(at50);
    expect(at50).toBeGreaterThan(0);
    expect(roofShare(ROOF_OPEN_MM)).toBe(0);
    expect(roofShare(ROOF_OPEN_MM + 40)).toBe(0);
  });

  it('leaves a shallow open scoop in daylight — the reported bug', () => {
    /* Five millimetres down, which the depth ramp calls fully underground,
     * with nothing overhead. The product of the two is what is used, and it
     * has to be zero. */
    expect(senseAt(5) * roofShare(null)).toBe(0);
    /* The same depth in a real tunnel is still fully sensed. */
    expect(senseAt(5) * roofShare(3)).toBe(1);
  });
});
