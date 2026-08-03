import { describe, it, expect } from 'vitest';
import {
    CLOD_GRAVITY, CLOD_LIFETIME_S, CLOD_RADIUS_LIMITS, clodKick, clodMass,
    clodRadius, clodStart, makeClod, stepClods, type Clod,
} from '../src/voxel/clodBurst';

/** A stand-in for randf_range, so the scatter is a number and not a surprise. */
const fixed = (v: number) => () => v;

describe('sizing a clod off the volume the bite removed', () => {
    it('matches Godot: the sphere-volume formula, shown at 72%', () => {
        // A queen's bite in the Godot lab is 1.5 mm radius = 0.3 world units,
        // which scoops (4/3)pi(0.3)^3. The clod is that sphere at 72% linear.
        const volume = (4 / 3) * Math.PI * 0.3 ** 3;
        expect(clodRadius(volume)).toBeCloseTo(0.3 * 0.72, 9);
    });

    it('is held between Godot own limits', () => {
        expect(clodRadius(1000)).toBe(CLOD_RADIUS_LIMITS.max);
        expect(clodRadius(1e-9)).toBe(CLOD_RADIUS_LIMITS.min);
        expect(clodRadius(0)).toBe(CLOD_RADIUS_LIMITS.min);
        expect(clodRadius(-5)).toBe(CLOD_RADIUS_LIMITS.min);
    });

    it('grows with the volume between the limits, so a big bite reads bigger', () => {
        const small = clodRadius(0.01);
        const large = clodRadius(0.2);
        expect(small).toBeGreaterThan(CLOD_RADIUS_LIMITS.min);
        expect(large).toBeLessThan(CLOD_RADIUS_LIMITS.max);
        expect(large).toBeGreaterThan(small);
    });

    it('puts a REAL bite inside that band rather than against a clamp', () => {
        /*
         * The band matters more than the formula. Between the two clamps the
         * clod says how much soil came out; outside them every bite looks the
         * same size, and the whole point of sizing off the removed volume is
         * lost. So this checks the bite this build actually takes, not a
         * convenient number: a queen's mandible is 1.75 mm across, which at
         * 5 mm to the world unit is a brush of 0.175 units.
         */
        const queenBite = (4 / 3) * Math.PI * 0.175 ** 3;
        const r = clodRadius(queenBite);
        expect(r).toBeGreaterThan(CLOD_RADIUS_LIMITS.min);
        expect(r).toBeLessThan(CLOD_RADIUS_LIMITS.max);
        // And a bite that only clipped the edge of an existing tunnel — a
        // tenth of the soil — still makes a visibly smaller lump.
        expect(clodRadius(queenBite * 0.1)).toBeLessThan(r);
    });

    it('floors the mass at Godot 0.02', () => {
        expect(clodMass(1)).toBeCloseTo(0.08, 9);
        expect(clodMass(0.0001)).toBe(0.02);
        expect(clodMass(0)).toBe(0.02);
    });
});

describe('the pop', () => {
    it('is a VELOCITY, so it does not scale with the mass floor', () => {
        // Godot found this the hard way: a flat impulse divided by a mass that
        // floors at 0.02 sent small bites' clods off like rockets. The kick has
        // to be the same however light the lump is.
        const light = makeClod({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 1e-6, fixed(0.5));
        const heavy = makeClod({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 5, fixed(0.5));
        expect(light.mass).toBe(0.02);
        expect(heavy.mass).toBeGreaterThan(light.mass);
        expect(light.velocity).toEqual(heavy.velocity);
    });

    it('goes out of the face and up, at Godot 2.4 and 1.8', () => {
        const flat = clodKick({ x: 0, y: 1, z: 0 }, fixed(0.5));
        expect(flat.y).toBeCloseTo(2.4 + 1.8, 9);
        expect(flat.x).toBeCloseTo(0, 9);

        // Out of a wall, the 2.4 goes sideways and the 1.8 still goes up.
        const wall = clodKick({ x: 1, y: 0, z: 0 }, fixed(0.5));
        expect(wall.x).toBeCloseTo(2.4, 9);
        expect(wall.y).toBeCloseTo(1.8, 9);
    });

    it('scatters sideways by up to Godot 0.8, in world horizontal', () => {
        const low = clodKick({ x: 0, y: 1, z: 0 }, fixed(0));
        const high = clodKick({ x: 0, y: 1, z: 0 }, fixed(1));
        expect(low.x).toBeCloseTo(-0.8, 9);
        expect(high.x).toBeCloseTo(0.8, 9);
        // Scatter is horizontal only — the vertical term is the 1.8, untouched.
        expect(low.y).toBeCloseTo(high.y, 9);
    });

    it('starts clear of the face it came out of, by Godot radius + 0.06', () => {
        const at = { x: 4, y: 9, z: 2 };
        const normal = { x: 0, y: 1, z: 0 };
        expect(clodStart(at, normal, 0.2).y).toBeCloseTo(9 + 0.26, 9);
        // And on a wall it steps out along the wall's normal, not upward.
        expect(clodStart(at, { x: -1, y: 0, z: 0 }, 0.2)).toMatchObject({ x: 4 - 0.26, y: 9 });
    });

    it('is not born inside the soil it was cut from', () => {
        // A face at y = 9: soil below, air above.
        const solidAt = (_x: number, y: number) => y < 9;
        const clod = makeClod({ x: 0, y: 9, z: 0 }, { x: 0, y: 1, z: 0 }, 0.02, fixed(0.5));
        expect(solidAt(clod.at.x, clod.at.y)).toBe(false);
    });
});

describe('falling', () => {
    const floorAt = (h: number) => (_x: number, y: number) => y < h;

    function drop(volume = 0.02): Clod[] {
        return [makeClod({ x: 0, y: 9, z: 0 }, { x: 0, y: 1, z: 0 }, volume, fixed(0.5))];
    }

    it('is pulled down by the world, not by her own down', () => {
        // She has adhesion — on a wall her "down" is into the wall. A lump of
        // dirt that has let go falls the way the world falls.
        const clods = drop();
        const before = clods[0]!.velocity.y;
        stepClods(clods, 0.1, () => false);
        expect(clods[0]!.velocity.y).toBeCloseTo(before - CLOD_GRAVITY * 0.1, 9);
    });

    it('rises, turns over and comes back down', () => {
        const clods = drop();
        let top = clods[0]!.at.y;
        for (let i = 0; i < 30; i += 1) {
            stepClods(clods, 1 / 60, () => false);
            top = Math.max(top, clods[0]!.at.y);
        }
        expect(top).toBeGreaterThan(9.2);
        expect(clods[0]!.at.y).toBeLessThan(top);
    });

    it('comes to rest on the ground and stays there', () => {
        const clods = drop();
        for (let i = 0; i < 600; i += 1) stepClods(clods, 1 / 60, floorAt(9));
        const clod = clods[0]!;
        expect(clod.resting).toBe(true);
        expect(clod.velocity).toEqual({ x: 0, y: 0, z: 0 });
        const where = { ...clod.at };
        for (let i = 0; i < 60; i += 1) stepClods(clods, 1 / 60, floorAt(9));
        expect(clods[0]!.at).toEqual(where);
    });

    it('never ends up inside the soil', () => {
        const clods = drop();
        for (let i = 0; i < 600; i += 1) {
            stepClods(clods, 1 / 60, floorAt(9));
            expect(floorAt(9)(clods[0]!.at.x, clods[0]!.at.y)).toBe(false);
        }
    });

    it('falls out of a wall rather than sticking to it', () => {
        // Soil at x < 0; she bit the face and the clod came out sideways.
        const solidAt = (x: number) => x < 0;
        const clods = [makeClod({ x: 0, y: 20, z: 0 }, { x: 1, y: 0, z: 0 }, 0.02, fixed(0.5))];
        for (let i = 0; i < 60; i += 1) stepClods(clods, 1 / 60, solidAt);
        expect(clods[0]!.at.x).toBeGreaterThan(0);
        expect(clods[0]!.at.y).toBeLessThan(20);
    });

    it('is taken away after Godot twelve seconds, and not before', () => {
        let clods = drop();
        for (let i = 0; i < Math.floor(CLOD_LIFETIME_S * 60) - 6; i += 1) {
            clods = stepClods(clods, 1 / 60, floorAt(9));
        }
        expect(clods).toHaveLength(1);
        for (let i = 0; i < 12; i += 1) clods = stepClods(clods, 1 / 60, floorAt(9));
        expect(clods).toHaveLength(0);
    });

    it('keeps one clod fate from touching another', () => {
        const clods = [
            makeClod({ x: 0, y: 9, z: 0 }, { x: 0, y: 1, z: 0 }, 0.02, fixed(0.5)),
            makeClod({ x: 20, y: 40, z: 0 }, { x: 0, y: 1, z: 0 }, 0.02, fixed(0.5)),
        ];
        for (let i = 0; i < 120; i += 1) stepClods(clods, 1 / 60, floorAt(9));
        expect(clods[0]!.resting).toBe(true);
        expect(clods[1]!.resting).toBe(false);
        expect(clods[1]!.at.y).toBeLessThan(40);
    });

    it('gives each clod a shape that never changes under it', () => {
        const a = makeClod({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 0.02, fixed(0.25));
        const b = makeClod({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 0.02, fixed(0.75));
        expect(a.seed).not.toBe(b.seed);
        const was = a.seed;
        stepClods([a], 1 / 60, () => false);
        expect(a.seed).toBe(was);
    });
});
