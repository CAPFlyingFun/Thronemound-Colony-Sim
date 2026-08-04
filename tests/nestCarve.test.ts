import { describe, it, expect } from 'vitest';
import { box, type Field } from '../src/voxel/carve';
import {
    carvePlan, edgeBounds, edgeHollow, moundOf, nodeBounds, nodeHollow,
    planBounds, planHollow, planMounded, ventOf,
} from '../src/nest/nestCarve';
import {
    emptyPlan, MOUND_RISE, MOUND_SPREAD, type NestPlan,
} from '../src/nest/nestPlan';

/** A 64 mm block of soil centred on the origin, the same one the scene builds. */
const HALF = 32;
const soil: Field = box([-HALF, -HALF, -HALF], [HALF, HALF, HALF]);

const solidAt = (f: Field, x: number, y: number, z: number) => f(x, y, z) > 0;

/** A shaft from a surface mouth into a room, which is the rig already proven by ?shape=shaft. */
function shaftPlan(): NestPlan {
    return {
        nodes: [
            { id: 'mouth', kind: 'entrance', x: 0, y: HALF, z: 0, radiusMm: 9 },
            { id: 'room', kind: 'chamber', x: 0, y: 5, z: 0, radiusMm: 10 },
        ],
        edges: [{ id: 'shaft', from: 'mouth', to: 'room', radiusMm: 5, flow: 'both' }],
    };
}

describe('bounding the work', () => {
    it('gives a chamber an oval box matching its carve', () => {
        const b = nodeBounds(shaftPlan().nodes[1]!)!;
        expect(b.min).toEqual([-14, -2, -11]);
        expect(b.max).toEqual([14, 12, 11]);
    });

    it('gives a junction no room of its own', () => {
        expect(nodeBounds({ id: 'j', kind: 'junction', x: 0, y: 0, z: 0, radiusMm: 5 })).toBeNull();
    });

    it('boxes an entrance round its heap, which stands ABOVE the ground', () => {
        const mouth = shaftPlan().nodes[0]!;   // r = 9, sitting on the top face
        const b = nodeBounds(mouth)!;
        expect(b.max[1]).toBeCloseTo(HALF + 9 * (MOUND_RISE + 1), 4);
        expect(b.max[0]).toBeCloseTo(9 * MOUND_SPREAD, 4);
        expect(b.max[1]).toBeGreaterThan(HALF);
    });

    it('boxes a tunnel round its widest bore, not its narrowest', () => {
        const plan = shaftPlan();
        const b = edgeBounds(plan, plan.edges[0]!)!;
        // The mouth flares to 9 and the far end to 10, so the box is 10 wide.
        expect(b.max[0]).toBeCloseTo(10, 1);
        expect(b.min[0]).toBeCloseTo(-10, 1);
        expect(b.max[1]).toBeCloseTo(HALF + 9, 1);
    });

    it('has nothing to bound when the plan is empty', () => {
        expect(planBounds(emptyPlan())).toBeNull();
    });

    it('covers every part of the nest', () => {
        const b = planBounds(shaftPlan())!;
        // Not the oval room's floor (-2): the tunnel FLARES to bore 10 at the
        // room end, and that flare dips below the flattened oval. The bounds
        // must cover the carve, and the carve reaches -5.
        expect(b.min[1]).toBeCloseTo(-5, 1);
        // The top of the heap, not the top of the ground.
        expect(b.max[1]).toBeCloseTo(HALF + 9 * (MOUND_RISE + 1), 1);
    });
});

describe('a tunnel as a void', () => {
    it('is hollow on its centreline and solid a bore away', () => {
        const plan = shaftPlan();
        const hollow = edgeHollow(plan, plan.edges[0]!)!;
        expect(hollow(0, 20, 0)).toBeGreaterThan(0);
        expect(hollow(20, 20, 0)).toBeLessThan(0);
    });

    it('is the width it was asked for, measured across', () => {
        const plan = shaftPlan();
        const hollow = edgeHollow(plan, plan.edges[0]!)!;
        // Midway down the shaft, clear of both flares.
        expect(hollow(4.5, 20, 0)).toBeGreaterThan(0);
        expect(hollow(5.5, 20, 0)).toBeLessThan(0);
    });

    it('is wider at the room end than in the middle', () => {
        const plan = shaftPlan();
        const hollow = edgeHollow(plan, plan.edges[0]!)!;
        expect(hollow(8, 6, 0)).toBeGreaterThan(0);    // just above the room, in the funnel
        expect(hollow(8, 20, 0)).toBeLessThan(0);      // the same offset mid-shaft is soil
    });

    it('has no gaps along it — every millimetre of centreline is open', () => {
        const plan = shaftPlan();
        const hollow = edgeHollow(plan, plan.edges[0]!)!;
        for (let y = 5; y <= HALF; y += 0.25) {
            expect(hollow(0, y, 0)).toBeGreaterThan(0);
        }
    });

    it('follows a bend rather than cutting the chord', () => {
        const plan = shaftPlan();
        plan.edges[0]!.bow = { x: 20, y: 0, z: 0 };
        const hollow = edgeHollow(plan, plan.edges[0]!)!;
        // The middle of the curve has moved 10 mm out; the chord it left behind
        // is now soil.
        expect(hollow(10, 18.5, 0)).toBeGreaterThan(0);
        expect(hollow(0, 18.5, 0)).toBeLessThan(0);
    });

    it('refuses an edge whose ends do not exist', () => {
        const plan = shaftPlan();
        expect(edgeHollow(plan, { id: 'x', from: 'mouth', to: 'ghost', radiusMm: 5, flow: 'both' }))
            .toBeNull();
    });
});

describe('a chamber as a void', () => {
    it('is an oval room with 1.4 x 0.7 x 1.1 proportions', () => {
        const hollow = nodeHollow(shaftPlan().nodes[1]!)!;
        expect(hollow(0, 5, 0)).toBeCloseTo(7, 6);
        expect(hollow(13.5, 5, 0)).toBeGreaterThan(0);
        expect(hollow(14.5, 5, 0)).toBeLessThan(0);
        expect(hollow(0, 11.5, 0)).toBeGreaterThan(0);
        expect(hollow(0, 12.5, 0)).toBeLessThan(0);
        expect(hollow(0, 5, 10.5)).toBeGreaterThan(0);
        expect(hollow(0, 5, 11.5)).toBeLessThan(0);
    });

    it('is nothing at all for an entrance or a junction', () => {
        expect(nodeHollow(shaftPlan().nodes[0]!)).toBeNull();
        expect(nodeHollow({ id: 'j', kind: 'junction', x: 0, y: 0, z: 0, radiusMm: 5 })).toBeNull();
    });
});

describe('the anthill', () => {
    const mouth = () => shaftPlan().nodes[0]!;

    it('is soil that stands ABOVE the ground, not a hole cut into it', () => {
        const heap = moundOf(mouth())!;
        // Just above the surface, out at half the spread: inside the heap.
        expect(heap(9, HALF + 1, 0)).toBeGreaterThan(0);
        // Well clear of it: not.
        expect(heap(9 * MOUND_SPREAD + 2, HALF + 1, 0)).toBeLessThan(0);
        expect(heap(0, HALF + 9 * MOUND_RISE + 2, 0)).toBeLessThan(0);
    });

    it('rises to the height it claims, and no further', () => {
        const heap = moundOf(mouth())!;
        const rise = 9 * MOUND_RISE;
        expect(heap(0, HALF + rise * 0.9, 0)).toBeGreaterThan(0);
        expect(heap(0, HALF + rise * 1.1, 0)).toBeLessThan(0);
    });

    it('is wide and low, so the slope is one loose soil would hold', () => {
        // Dry sand slumps at about 34 degrees. A heap steeper than that would
        // look like a clay cone rather than loose spoil.
        const heap = moundOf(mouth())!;
        expect(heap(9 * MOUND_SPREAD * 0.8, HALF + 1, 0)).toBeGreaterThan(0);
        expect(heap(9 * MOUND_SPREAD * 1.1, HALF + 1, 0)).toBeLessThan(0);
    });

    it('belongs to entrances only — a room does not pile spoil on the surface', () => {
        expect(moundOf(shaftPlan().nodes[1]!)).toBeNull();
    });

    it('is vented right through, from above the apex to below the ground', () => {
        const vent = ventOf(mouth())!;
        const rise = 9 * MOUND_RISE;
        expect(vent(0, HALF + rise + 8, 0)).toBeGreaterThan(0);
        expect(vent(0, HALF - 8, 0)).toBeGreaterThan(0);
    });

    it('piles the heap onto the ground without a seam', () => {
        const flat: Field = (_x, y, _z) => -y;
        const mounded = planMounded(flat, shaftPlan());
        expect(mounded(0, HALF + 2, 0)).toBeGreaterThan(0);
    });

    it('leaves the ground alone away from the mouth', () => {
        const flat: Field = (_x, y, _z) => -y;
        const mounded = planMounded(flat, shaftPlan());
        expect(mounded(30, 1, 30)).toBeLessThan(0);
    });
});

describe('the nest cut out of the soil', () => {
    it('makes a hill with a hole in it, not a funnel sunk into flat ground', () => {
        const cut = carvePlan(soil, shaftPlan());
        expect(solidAt(cut, 0, HALF + 2, 15)).toBe(true);
        expect(solidAt(cut, 0, HALF + 2, 0)).toBe(false);
    });

    it('stands the crater rim proud of the ground all the way round', () => {
        const cut = carvePlan(soil, shaftPlan());
        for (const [x, z] of [[12, 0], [-12, 0], [0, 12], [0, -12]]) {
            expect(solidAt(cut, x!, HALF + 1, z!)).toBe(true);
        }
    });

    it('leaves the block alone where the nest is not', () => {
        const cut = carvePlan(soil, shaftPlan());
        expect(solidAt(cut, 25, 0, 25)).toBe(true);
    });

    it('opens the shaft and the room', () => {
        const cut = carvePlan(soil, shaftPlan());
        expect(solidAt(cut, 0, 20, 0)).toBe(false);
        expect(solidAt(cut, 0, 5, 0)).toBe(false);
    });

    it('breaks the surface, so the mouth is a hole and not a blister', () => {
        const cut = carvePlan(soil, shaftPlan());
        expect(solidAt(cut, 0, HALF + 1, 0)).toBe(false);
    });

    it('opens a mouth wide enough that she cannot stride over it', () => {
        const cut = carvePlan(soil, shaftPlan());
        expect(solidAt(cut, 8.5, HALF, 0)).toBe(false);
        expect(solidAt(cut, 10, HALF, 0)).toBe(true);
    });

    it('changes nothing when the plan is empty', () => {
        const cut = carvePlan(soil, emptyPlan());
        expect(cut(0, 0, 0)).toBe(soil(0, 0, 0));
    });

    it('is negative everywhere for an empty plan, so nothing is ever inside it', () => {
        const hollow = planHollow(emptyPlan());
        expect(hollow(0, 0, 0)).toBeLessThan(0);
    });

    it('joins two tunnels at a junction with no plug between them', () => {
        const plan: NestPlan = {
            nodes: [
                { id: 'a', kind: 'entrance', x: 0, y: 20, z: 0, radiusMm: 6 },
                { id: 'j', kind: 'junction', x: 0, y: 0, z: 0, radiusMm: 5 },
                { id: 'b', kind: 'chamber', x: 20, y: 0, z: 0, radiusMm: 8 },
            ],
            edges: [
                { id: 'one', from: 'a', to: 'j', radiusMm: 5, flow: 'both' },
                { id: 'two', from: 'j', to: 'b', radiusMm: 5, flow: 'both' },
            ],
        };
        const hollow = planHollow(plan);
        expect(hollow(0, 0, 0)).toBeGreaterThan(0);
        expect(hollow(1, 0, 0)).toBeGreaterThan(0);
    });

    it('costs a bounded amount to evaluate far from the nest', () => {
        const hollow = planHollow(shaftPlan());
        const started = performance.now();
        for (let i = 0; i < 10_000; i += 1) hollow(1000, 1000, 1000);
        expect(performance.now() - started).toBeLessThan(1000);
    });
});
