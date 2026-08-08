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
import {
  burialMm, ForestSolid, plantsIn, solidStand, SPECIES, type GroundProbe,
} from '../src/world/forest';
import { growTree, ringFactor, trunkProfile } from '../src/world/tree';

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

  it('takes its radius from the DRAWN ring, not from the limb inside it', () => {
    /*
     * The limb is a circle; the mesh is a polygon whose flats are TANGENT
     * to that circle, so its corners stand `1/cos(pi/n)` proud of it. A
     * profile taken off the limb therefore describes a thinner plant than
     * the one on screen — and she seats on the profile, so she ends up
     * standing inside the picture. At scrub tessellation, four sides, that
     * gap is 41% of the stem.
     */
    for (const sides of [20, 10, 6, 4]) {
      const profile = trunkProfile(spec, sides);
      const { limbs } = growTree(spec);
      const trunk = limbs.filter((l) => l.order === 0);
      expect(profile.pts.length).toBe(trunk.length + 1);
      const f = ringFactor(sides);
      for (let i = 0; i < trunk.length; i += 1) {
        /* Unit-height space: the profile is the trunk divided by its height. */
        expect(profile.r[i]! * spec.height).toBeCloseTo(trunk[i]!.ra * f, 6);
        expect(profile.pts[i]!.y * spec.height).toBeCloseTo(trunk[i]!.a.y, 6);
        expect(profile.pts[i]!.x * spec.height).toBeCloseTo(trunk[i]!.a.x, 6);
      }
    }
    /* Four sides really is 41% — the number that made this worth doing. */
    expect(ringFactor(4)).toBeCloseTo(Math.SQRT2, 6);
    expect(ringFactor(20)).toBeCloseTo(1.0125, 4);
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

/**
 * A SCATTERED PLANT IS SOLID WHERE IT IS DRAWN.
 *
 * The landmark tree is one mesh at one place, so its collision only has to
 * agree about the shape. A scattered plant is an INSTANCE: one baked shape
 * placed by a matrix, and there are two transforms in play — the one the
 * GPU draws with and the one the query un-does. If they disagree, she
 * stands on a plant that is not where the picture is, which is the whole of
 * the reported hovering.
 *
 * So the test is a round trip, not a re-derivation: take a point on the
 * DRAWN plant, put it through the SAME matrix three.js composes, and ask
 * the collision whether that world point is wood.
 */
describe('a scattered plant is solid where it is drawn', () => {
  const spec = { girth: 40, height: 400, seed: 4242 };
  const profile = trunkProfile(spec);

  /** The instance matrix `growStand` composes: spin about Y, then scale. */
  const draw = (
    local: { x: number; y: number; z: number },
    at: { x: number; y: number; z: number },
    spin: number,
    scale: number,
  ) => {
    const c = Math.cos(spin);
    const s = Math.sin(spin);
    const x = local.x * scale;
    const y = local.y * scale;
    const z = local.z * scale;
    return { x: at.x + (c * x + s * z), y: at.y + y, z: at.z + (-s * x + c * z) };
  };

  it('un-turns a point the same way the instance turns it', () => {
    /* A trunk WANDERS, so its axis is off centre — which is what makes a
     * wrong spin measurable at all. A plumb pole is symmetric and hides it. */
    const mid = Math.floor(profile.pts.length * 0.7);
    const axis = profile.pts[mid]!;
    expect(Math.hypot(axis.x, axis.z)).toBeGreaterThan(profile.r[mid]!);

    const at = { x: 300, y: 20, z: -150 };
    const scale = 80;
    for (const spin of [0, 0.7, 1.9, 3.6, 5.4]) {
      const world = draw(axis, at, spin, scale);
      const solid = new ForestSolid([{
        x: at.x, y: at.y, z: at.z, scale,
        cos: Math.cos(spin), sin: Math.sin(spin),
        profile,
        reach: (Math.max(...profile.r) + 0.05) * scale,
        top: at.y + Math.max(...profile.pts.map((p) => p.y)) * scale,
      }], 400 / 5);
      /* Dead on the drawn axis at that height: the deepest wood there is. */
      expect(solid.solidAt(world.x, world.y, world.z), `spin ${spin}`).toBe(true);
    }
  });

  it('places the stand around her on the same spot the instance draws', () => {
    /* The real path, end to end: `solidStand` builds the same `Standing`
     * the scene collides against, from the same scatter `growStand` draws. */
    const plants = plantsIn(of('canopy'), WHOLE, island);
    expect(plants.length).toBeGreaterThan(3);
    const p = plants.find((q) => Math.abs(Math.sin(q.spin)) > 0.5)!;
    const solid = solidStand(
      { xMm: p.xMm, zMm: p.zMm }, 4000, 5, island, () => profile,
    );
    const scale = p.heightMm / 5;
    const foot = (p.groundMm - burialMm(p.heightMm)) / 5;
    const mid = Math.floor(profile.pts.length * 0.7);
    const world = draw(
      profile.pts[mid]!, { x: p.xMm / 5, y: foot, z: p.zMm / 5 }, p.spin, scale,
    );
    expect(solid.solidAt(world.x, world.y, world.z)).toBe(true);
  });
});
