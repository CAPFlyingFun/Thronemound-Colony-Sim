import { describe, expect, it } from 'vitest';
import { nodeHollow } from './nestCarve';


describe('oval chamber carve', () => {
  it('makes chambers longer and wider than they are tall', () => {
    const chamber = nodeHollow({
      id: 'room1', kind: 'chamber', x: 0, y: 0, z: 0, radiusMm: 8,
    });
    expect(chamber).not.toBeNull();
    const f = chamber!;

    // 8 mm is the design radius. The room should extend farther sideways
    // than vertically, matching the standardized 1.4 x 1.1 x 0.7 oval.
    expect(f(10.5, 0, 0)).toBeGreaterThan(0);
    expect(f(0, 0, 8.5)).toBeGreaterThan(0);
    expect(f(0, 6, 0)).toBeLessThan(0);
  });
});
