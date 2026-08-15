import { describe, expect, it } from 'vitest';

import { loadColour } from '../src/scenes/islandQuest';

/**
 * THE CARRY BAR IS ONE COLOUR, and the load picks it.
 *
 * Asked for in these words: "instead of a gradient fill, I wanted it to
 * change color 3 times but be smooth so the whole thing was a solid color."
 * Both halves are testable — that it IS one colour (a single `rgb()`, never
 * a gradient) and that it moves smoothly through three stages.
 */
const rgb = (s: string): [number, number, number] => {
  const m = s.match(/rgb\((\d+) (\d+) (\d+)\)/);
  if (!m) throw new Error(`not a solid colour: ${s}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

describe('the load colour', () => {
  it('is always ONE solid colour, never a ramp', () => {
    for (let i = 0; i <= 20; i += 1) {
      const out = loadColour(i / 20);
      expect(out).toMatch(/^rgb\(\d+ \d+ \d+\)$/);
      expect(out).not.toContain('gradient');
    }
  });

  it('lands exactly on its three stops', () => {
    expect(rgb(loadColour(0))).toEqual([0x5f, 0x9e, 0x33]);
    expect(rgb(loadColour(0.5))).toEqual([0xe0, 0xb9, 0x3c]);
    expect(rgb(loadColour(1))).toEqual([0xb8, 0x40, 0x2c]);
  });

  it('moves smoothly — no step bigger than a stage is wide', () => {
    /*
     * The point of interpolating rather than switching at thresholds. A
     * banded bar would show one big jump here and zeros everywhere else;
     * this asserts every neighbouring pair is a small move, which is what
     * "but be smooth" means.
     */
    let worst = 0;
    let prev = rgb(loadColour(0));
    for (let i = 1; i <= 100; i += 1) {
      const now = rgb(loadColour(i / 100));
      worst = Math.max(worst, ...now.map((c, k) => Math.abs(c - prev[k]!)));
      prev = now;
    }
    expect(worst).toBeLessThan(6);
  });

  it('runs green to red, so a full jaw reads as full', () => {
    /*
     * NOT a monotonic red channel, which is what this asserted first and is
     * simply wrong about colour: amber is BRIGHTER in red than red is
     * (0xe0 against 0xb8), so red rises then falls and so does green. Every
     * green-amber-red ramp does that, and a test that forbids it forbids
     * the ramp being asked for.
     *
     * What does hold, and is what "green to red" actually means, is that
     * red gains on green the whole way: green sits above red at empty,
     * below it at full, and the ratio never doubles back.
     */
    let prev = -1;
    for (let i = 0; i <= 20; i += 1) {
      const [r, g] = rgb(loadColour(i / 20));
      const ratio = r / (g + 1);
      expect(ratio).toBeGreaterThan(prev);
      prev = ratio;
    }
    const [r0, g0] = rgb(loadColour(0));
    const [r1, g1] = rgb(loadColour(1));
    expect(g0).toBeGreaterThan(r0);
    expect(r1).toBeGreaterThan(g1);
  });

  it('clamps rather than extrapolating past its ends', () => {
    expect(loadColour(-5)).toBe(loadColour(0));
    expect(loadColour(9)).toBe(loadColour(1));
  });
});
