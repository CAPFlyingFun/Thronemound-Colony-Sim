/**
 * WHAT GROWS, AND HOW MUCH OF IT.
 *
 * The numbers here are the design: the island is 1,525 m² of land and a
 * twenty-six metre tree needs a hundred and fifty of them to itself, so the
 * giants have to be rare and the forest has to be scrub. These check that
 * the scatter actually produces that, and that it produces the SAME thing
 * every time — a landmark you navigate by cannot move between loads, and a
 * window of the island has to come back identical after she walks away and
 * returns.
 */

import { describe, expect, it } from 'vitest';
import { burialMm, plantsIn, SPECIES, type GroundProbe } from '../src/world/forest';
import { growTree, trunkProfile } from '../src/world/tree';

const SPAN = 56000;
const WHOLE = { x0: 0, z0: 0, x1: SPAN, z1: SPAN };

/** A hill: a cone of land in the middle of the map, sea all round it. */
const island = (xMm: number, zMm: number): GroundProbe | null => {
  const dx = xMm - SPAN / 2;
  const dz = zMm - SPAN / 2;
  const r = Math.hypot(dx, dz);
  const elevMm = 1400 * (1 - r / 20000);
  if (elevMm <= 0) return null;
  return { elevMm, flat: 0.9 };
};

const of = (name: string) => SPECIES.find((s) => s.name === name)!;

describe('the scatter', () => {
  it('grows the same island twice', () => {
    const a = plantsIn(of('canopy'), WHOLE, island);
    const b = plantsIn(of('canopy'), WHOLE, island);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i += 1) {
      expect(a[i]!.xMm).toBe(b[i]!.xMm);
      expect(a[i]!.heightMm).toBe(b[i]!.heightMm);
      expect(a[i]!.seed).toBe(b[i]!.seed);
    }
  });

  it('grows a window identical to that part of the whole', () => {
    /* This is the property the streaming rests on: a plant depends on its
     * own cell and nothing else, so walking away and back cannot rearrange
     * the scrub. */
    const box = { x0: 26000, z0: 26000, x1: 30000, z1: 30000 };
    const whole = plantsIn(of('bush'), WHOLE, island)
      .filter((p) => p.xMm >= box.x0 && p.xMm <= box.x1
        && p.zMm >= box.z0 && p.zMm <= box.z1);
    const window = plantsIn(of('bush'), box, island);
    expect(window.length).toBe(whole.length);
    expect(window.length).toBeGreaterThan(10);
    const key = (p: { xMm: number; zMm: number }) => `${p.xMm.toFixed(3)},${p.zMm.toFixed(3)}`;
    expect(new Set(window.map(key))).toEqual(new Set(whole.map(key)));
  });

  it('keeps the giants rare and the scrub thick', () => {
    const count = (n: string) => plantsIn(of(n), WHOLE, island).length;
    const landmark = count('landmark');
    const canopy = count('canopy');
    const sapling = count('sapling');
    const bush = count('bush');
    /* Each tier is many times the one above it — that shape is the whole
     * point, not the exact numbers. */
    expect(landmark).toBeGreaterThan(0);
    expect(canopy).toBeGreaterThan(landmark * 3);
    expect(sapling).toBeGreaterThan(canopy * 2);
    expect(bush).toBeGreaterThan(sapling * 2);
  });

  it('plants nothing in the sea', () => {
    for (const species of SPECIES) {
      for (const p of plantsIn(species, WHOLE, island)) {
        expect(island(p.xMm, p.zMm)).not.toBeNull();
        expect(p.groundMm).toBeGreaterThan(0);
      }
    }
  });

  it('keeps big trees off ground too steep for them', () => {
    const steep = (): GroundProbe => ({ elevMm: 200, flat: 0.5 });
    /* Half-level ground: scrub takes it, the big tiers refuse it. */
    expect(plantsIn(of('landmark'), WHOLE, steep).length).toBe(0);
    expect(plantsIn(of('canopy'), WHOLE, steep).length).toBe(0);
    expect(plantsIn(of('bush'), WHOLE, steep).length).toBeGreaterThan(0);
  });

  it('respects the elevation band of each tier', () => {
    const high = (): GroundProbe => ({ elevMm: 1420, flat: 0.95 });
    expect(plantsIn(of('landmark'), WHOLE, high).length).toBe(0);
    expect(plantsIn(of('bush'), WHOLE, high).length).toBeGreaterThan(0);
  });

  it('spreads heights across the tier rather than cloning one', () => {
    const all = plantsIn(of('canopy'), WHOLE, island);
    const hs = all.map((p) => p.heightMm);
    const lo = Math.min(...hs);
    const hi = Math.max(...hs);
    expect(hi - lo).toBeGreaterThan(of('canopy').maxHeight * 0.3);
    /* Squared distribution: most of a stand is on the short side. */
    const mid = (of('canopy').minHeight + of('canopy').maxHeight) / 2;
    expect(hs.filter((h) => h < mid).length).toBeGreaterThan(hs.length * 0.55);
  });

  it('buries a bush like a bush and a giant like a giant', () => {
    expect(burialMm(400)).toBeLessThan(burialMm(26000));
    expect(burialMm(400)).toBeLessThan(400 * 0.5);
    expect(burialMm(26000)).toBeLessThanOrEqual(150);
  });
});

/**
 * THE INVISIBLE TREE.
 *
 * A stand's collision used to be a straight vertical cone from base radius
 * to a fraction of it. The drawn trunk is neither straight nor a cone: it
 * flares at the foot, tapers on a curve, and leans. Measured, the cone ran
 * up to 33% fatter than the wood at mid-height and modelled none of the
 * lean — so she stood on the invisible one and floated over the visible
 * one, which is exactly how it was reported.
 *
 * The fix is not a better approximation, it is the SAME LINE: the collision
 * reads the polyline the mesh is skinned onto. These check that it really
 * is the same line, because a second one that merely looks similar is how
 * this happened in the first place.
 */
describe('the solid stand matches the wood you can see', () => {
  const spec = { girth: 20, height: 400, seed: 0x5eed, rings: 8, boughs: 7, twigs: false };

  it('takes its radius from the drawn trunk, not from a cone through it', () => {
    const profile = trunkProfile(spec);
    const { limbs } = growTree(spec);
    const trunk = limbs.filter((l) => l.order === 0);
    expect(profile.pts.length).toBe(trunk.length + 1);
    for (let i = 0; i < trunk.length; i += 1) {
      /* Unit-height space: the profile is the trunk divided by its height. */
      expect(profile.r[i]! * spec.height).toBeCloseTo(trunk[i]!.ra, 6);
      expect(profile.pts[i]!.y * spec.height).toBeCloseTo(trunk[i]!.a.y, 6);
      expect(profile.pts[i]!.x * spec.height).toBeCloseTo(trunk[i]!.a.x, 6);
    }
  });

  it('carries the trunk’s lean, which a vertical post cannot', () => {
    const profile = trunkProfile(spec);
    const foot = profile.pts[0]!;
    const top = profile.pts[profile.pts.length - 1]!;
    const drift = Math.hypot(top.x - foot.x, top.z - foot.z);
    /* If this is zero the trunk is a plumb pole and the old straight post
     * would have been fine. It is not — which is why it was not. */
    expect(drift).toBeGreaterThan(0);
  });

  it('flares at the foot and narrows all the way up', () => {
    const profile = trunkProfile(spec);
    /* The shape a straight cone gets wrong: widest at the very bottom, then
     * losing most of its girth early and holding. */
    expect(profile.r[0]!).toBeGreaterThan(profile.r[1]!);
    for (let i = 2; i < profile.r.length; i += 1) {
      expect(profile.r[i]!).toBeLessThanOrEqual(profile.r[i - 1]! + 1e-9);
    }
    const straight = (t: number) => profile.r[0]! * (1 + (0.18 - 1) * t);
    const half = Math.floor(profile.r.length / 2);
    const t = half / (profile.r.length - 1);
    /* The old post at mid-height, against the wood actually there. */
    expect(straight(t)).toBeGreaterThan(profile.r[half]! * 1.15);
  });
});
