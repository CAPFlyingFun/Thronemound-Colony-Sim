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
