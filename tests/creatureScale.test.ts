import { describe, expect, it } from 'vitest';
import { CREATURES, QUEEN_MM, inQueens } from '../src/scenes/creatureScale';

describe('how big each creature is', () => {
  it('gets every model to the size it is meant to be', () => {
    /* The whole of what `fit` is for: the model's own body length times
     * the scale is the real animal. If a re-export moves `modelMm` and
     * nobody re-runs `probe:scale`, this is what says so. */
    for (const [id, c] of Object.entries(CREATURES)) {
      expect({ id, mm: +(c.modelMm * c.fit).toFixed(2) })
        .toEqual({ id, mm: +c.mm.toFixed(2) });
    }
  });

  it('keeps every one inside the range its source gives', () => {
    /* Cited biology, so the numbers have to sit in the cited range rather
     * than merely near it. */
    expect(CREATURES.housefly!.mm).toBeGreaterThanOrEqual(4);
    expect(CREATURES.housefly!.mm).toBeLessThanOrEqual(8);
    expect(CREATURES.aphid!.mm).toBeGreaterThanOrEqual(1.5);
    expect(CREATURES.aphid!.mm).toBeLessThanOrEqual(4);
    expect(CREATURES.earthworm!.mm).toBeGreaterThanOrEqual(120);
    expect(CREATURES.earthworm!.mm).toBeLessThanOrEqual(250);
  });

  it('puts them in the order a player would expect beside the queen', () => {
    /* An aphid is smaller than she is, a fly is about her size, and a worm
     * is not in the same conversation. That ordering is the design, and it
     * is what makes a worm terrain rather than an enemy. */
    expect(inQueens('aphid')).toBeLessThan(0.5);
    expect(inQueens('housefly')).toBeGreaterThan(0.5);
    expect(inQueens('housefly')).toBeLessThan(1);
    expect(inQueens('earthworm')).toBeGreaterThan(10);
  });

  it('shrinks the two insects and GROWS the worm', () => {
    /* Worth pinning because it is the surprise: the fly and the aphid were
     * both authored larger than life and the worm slightly smaller. A
     * pipeline that assumed everything needed shrinking would have been
     * wrong about exactly one of the three. */
    expect(CREATURES.housefly!.fit).toBeLessThan(1);
    expect(CREATURES.aphid!.fit).toBeLessThan(1);
    expect(CREATURES.earthworm!.fit).toBeGreaterThan(1);
  });

  it('cites every measured number', () => {
    /* The file's own rule: `mm` is biology and biology gets a source.
     * `fit` is arithmetic and gets none. */
    for (const c of Object.values(CREATURES)) {
      expect(c.source.length).toBeGreaterThan(20);
    }
  });

  it('answers nothing for a creature it does not have', () => {
    expect(inQueens('spider')).toBe(0);
  });

  it('reads the queen from one place', () => {
    expect(QUEEN_MM).toBe(9);
    expect(inQueens('housefly')).toBeCloseTo(CREATURES.housefly!.mm / QUEEN_MM, 9);
  });
});
