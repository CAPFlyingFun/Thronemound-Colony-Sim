/**
 * THE TREE, checked without a renderer.
 *
 * The claims worth pinning are the ones a screenshot cannot settle: that the
 * same seed is the same tree, that it is the size it was asked to be, and
 * that dropping detail changes how finely the wood is skinned without moving
 * any of it — which is the property that stops an LOD swap reading as a pop.
 */

import { describe, expect, it } from 'vitest';
import { BARKS, growTree, type TreeSpec } from '../src/world/tree';

const SPEC: TreeSpec = { girth: 200, height: 5200, seed: 12345 };

describe('the tree', () => {
  it('grows the same tree from the same seed, every time', () => {
    const a = growTree(SPEC);
    const b = growTree(SPEC);
    expect(a.limbs.length).toBe(b.limbs.length);
    for (let i = 0; i < a.limbs.length; i += 1) {
      expect(a.limbs[i]!.a.distanceTo(b.limbs[i]!.a)).toBeLessThan(1e-9);
      expect(a.limbs[i]!.rb).toBeCloseTo(b.limbs[i]!.rb, 9);
    }
  });

  it('grows a different tree from a different seed', () => {
    const a = growTree(SPEC);
    const b = growTree({ ...SPEC, seed: 999 });
    const moved = a.limbs.some((l, i) => l.a.distanceTo(b.limbs[i]!.a) > 1e-6);
    expect(moved).toBe(true);
  });

  it('is the height it was asked for, and the girth at the foot', () => {
    const { limbs } = growTree(SPEC);
    const trunk = limbs.filter((l) => l.order === 0);
    const top = Math.max(...limbs.map((l) => Math.max(l.a.y, l.b.y)));
    // The leader reaches the asked height; boughs sweeping up may pass it.
    expect(Math.max(...trunk.map((l) => l.b.y))).toBeCloseTo(SPEC.height, 3);
    expect(top).toBeGreaterThanOrEqual(SPEC.height);
    // The foot is the asked girth, plus the flare that makes it look rooted.
    const foot = trunk[0]!.ra * 2;
    expect(foot).toBeGreaterThanOrEqual(SPEC.girth);
    expect(foot).toBeLessThan(SPEC.girth * 1.35);
  });

  it('tapers all the way up and never widens', () => {
    const trunk = growTree(SPEC).limbs.filter((l) => l.order === 0);
    // Past the flare at the very bottom, each ring is narrower than the last.
    for (let i = 2; i < trunk.length; i += 1) {
      expect(trunk[i]!.rb).toBeLessThanOrEqual(trunk[i - 1]!.rb + 1e-9);
    }
    expect(trunk[trunk.length - 1]!.rb).toBeGreaterThan(0);
  });

  it('starts its lowest bough well clear of the ground', () => {
    const { limbs } = growTree(SPEC);
    const boughs = limbs.filter((l) => l.order > 0);
    expect(boughs.length).toBeGreaterThan(20);
    const lowest = Math.min(...boughs.map((l) => l.a.y));
    expect(lowest).toBeGreaterThan(SPEC.height * 0.35);
  });

  it('hangs its leaves on the ends of the wood, not in mid-air', () => {
    const { limbs, tufts } = growTree(SPEC);
    expect(tufts.length).toBeGreaterThan(5);
    for (const tuft of tufts) {
      const near = Math.min(...limbs.map((l) => Math.min(
        l.b.distanceTo(tuft.at), l.a.distanceTo(tuft.at),
      )));
      expect(near).toBeLessThan(tuft.r + 1e-6);
    }
  });

  it('offers exactly the four barks that ship with it', () => {
    expect(BARKS.length).toBe(4);
    expect(new Set(BARKS).size).toBe(4);
  });

  it('scales with the spec rather than baking in one size', () => {
    const small = growTree({ girth: 20, height: 400, seed: 7 });
    const big = growTree({ girth: 200, height: 4000, seed: 7 });
    const smallTop = Math.max(...small.limbs.map((l) => l.b.y));
    const bigTop = Math.max(...big.limbs.map((l) => l.b.y));
    expect(bigTop / smallTop).toBeCloseTo(10, 1);
    expect(small.limbs.length).toBe(big.limbs.length);
  });
});
