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
    it('gives a chamber a box its own size', () => {
        const b = nodeBounds(shaftPlan().nodes[1]!)!;
        expect(b.min).toEqual([-10, -5, -10]);
        expect(b.max).toEqual([10, 15, 10]);
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
        expect(b.min[1]).toBeCloseTo(-5, 1);       // the bottom of the room
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
    it('is a ball of the radius asked for', () => {
        const hollow = nodeHollow(shaftPlan().nodes[1]!)!;
        expect(hollow(0, 5, 0)).toBeCloseTo(10, 6);
        expect(hollow(0, 5, 9.5)).toBeGreaterThan(0);
        expect(hollow(0, 5, 10.5)).toBeLessThan(0);
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
        // not be there in the morning.
        const slope = Math.atan((9 * MOUND_RISE) / (9 * MOUND_SPREAD)) * 180 / Math.PI;
        expect(slope).toBeLessThan(34);
    });

    it('belongs to entrances only — a room does not pile spoil on the surface', () => {
        expect(moundOf(shaftPlan().nodes[1]!)).toBeNull();
        expect(moundOf({ id: 'j', kind: 'junction', x: 0, y: 0, z: 0, radiusMm: 5 })).toBeNull();
        expect(ventOf(shaftPlan().nodes[1]!)).toBeNull();
    });

    it('is vented right through, from above the apex to below the ground', () => {
        const vent = ventOf(mouth())!;
        expect(vent(0, HALF + 9 * MOUND_RISE + 0.5, 0)).toBeGreaterThan(0);
        expect(vent(0, HALF, 0)).toBeGreaterThan(0);
        expect(vent(0, HALF - 5, 0)).toBeGreaterThan(0);
        // Narrow, not a general excavation: out past its own radius it stops.
        // (Height is the wrong axis to bound it on — `bore` is a capsule, so it
        // reaches its own radius beyond each end, which above the apex is air
        // anyway and costs nothing.)
        expect(vent(9.5, HALF, 0)).toBeLessThan(0);
        expect(vent(0, HALF, 9.5)).toBeLessThan(0);
    });

    it('piles the heap onto the ground without a seam', () => {
        const mounded = planMounded(soil, shaftPlan());
        // Continuous across the old surface: the heap's lower half is already
        // inside the soil, so there is no join to get wrong.
        for (let y = HALF - 3; y <= HALF + 9 * MOUND_RISE - 0.5; y += 0.25) {
            expect(mounded(4, y, 0)).toBeGreaterThan(0);
        }
    });

    it('leaves the ground alone away from the mouth', () => {
        const mounded = planMounded(soil, shaftPlan());
        expect(mounded(28, HALF + 1, 28)).toBeLessThan(0);
        expect(mounded(28, HALF - 1, 28)).toBeGreaterThan(0);
    });
});

describe('the nest cut out of the soil', () => {
    it('makes a hill with a hole in it, not a funnel sunk into flat ground', () => {
        const dug = carvePlan(soil, shaftPlan());
        const rim = 9 * (MOUND_SPREAD + 1) / 2;   // out on the flank of the heap
        // Soil ABOVE the old ground line, out on the flank — this is the whole
        // point of the change, and the funnel version had nothing here.
        expect(solidAt(dug, rim, HALF + 0.5, 0)).toBe(true);
        // And open air straight down the middle, right through the apex.
        for (let y = HALF + 9 * MOUND_RISE + 1; y >= HALF - 4; y -= 0.5) {
            expect(solidAt(dug, 0, y, 0)).toBe(false);
        }
    });

    it('stands the crater rim proud of the ground all the way round', () => {
        const dug = carvePlan(soil, shaftPlan());
        const rim = 9 * (MOUND_SPREAD + 1) / 2;
        for (const [x, z] of [[rim, 0], [-rim, 0], [0, rim], [0, -rim]] as const) {
            expect(solidAt(dug, x, HALF + 0.5, z)).toBe(true);
        }
    });


    it('leaves the block alone where the nest is not', () => {
        const dug = carvePlan(soil, shaftPlan());
        expect(solidAt(dug, 25, 0, 25)).toBe(true);
        expect(solidAt(dug, -20, -20, 0)).toBe(true);
        expect(solidAt(dug, 0, 40, 0)).toBe(false);   // still outside the block
    });

    it('opens the shaft and the room', () => {
        const dug = carvePlan(soil, shaftPlan());
        expect(solidAt(dug, 0, 30, 0)).toBe(false);   // in the shaft
        expect(solidAt(dug, 0, 20, 0)).toBe(false);
        expect(solidAt(dug, 0, 5, 0)).toBe(false);    // in the room
        expect(solidAt(dug, 8, 5, 0)).toBe(false);    // still in the room, off-axis
        expect(solidAt(dug, 0, -8, 0)).toBe(true);    // below the room's floor
    });

    it('breaks the surface, so the mouth is a hole and not a blister', () => {
        const dug = carvePlan(soil, shaftPlan());
        // The block's top face is y = 32. A mouth that stops short leaves a
        // roof over the nest, which is a nest with no way in.
        expect(solidAt(dug, 0, HALF - 0.5, 0)).toBe(false);
        expect(solidAt(dug, 0, HALF - 3, 0)).toBe(false);
    });

    it('opens a mouth wide enough that she cannot stride over it', () => {
        // Measured, she walks straight over a 10 mm hole — 2942 frames of 3000
        // spent on the surface. So the bar is not "there is an opening", it is
        // "the opening is wider than the bore below it by enough to matter",
        // and the unflared case has to be measured too or the test passes on a
        // mouth she would miss.
        const openWidth = (mouthR: number) => {
            const plan = shaftPlan();
            plan.nodes[0]!.radiusMm = mouthR;
            const dug = carvePlan(soil, plan);
            let open = 0;
            for (let x = -16; x <= 16; x += 0.25) {
                if (!solidAt(dug, x, HALF - 0.5, 0)) open += 0.25;
            }
            return open;
        };
        const bore = openWidth(5);              // no flare: the tunnel's own width
        const flared = openWidth(9);
        expect(bore).toBeLessThan(11);          // this is the hole she strides over
        expect(flared).toBeGreaterThan(16);     // roughly twice the mouth radius
        expect(flared - bore).toBeGreaterThan(6);
    });

    it('changes nothing when the plan is empty', () => {
        const dug = carvePlan(soil, emptyPlan());
        for (const p of [[0, 0, 0], [31, 31, 31], [-31, 0, 12], [0, 40, 0]] as const) {
            expect(solidAt(dug, p[0], p[1], p[2])).toBe(solidAt(soil, p[0], p[1], p[2]));
        }
    });

    it('is negative everywhere for an empty plan, so nothing is ever inside it', () => {
        const hollow = planHollow(emptyPlan());
        expect(hollow(0, 0, 0)).toBeLessThan(0);
        expect(hollow(999, -999, 12)).toBeLessThan(0);
    });

    it('joins two tunnels at a junction with no plug between them', () => {
        const plan: NestPlan = {
            nodes: [
                { id: 'mouth', kind: 'entrance', x: 0, y: HALF, z: 0, radiusMm: 6 },
                { id: 'knee', kind: 'junction', x: 0, y: 0, z: 0, radiusMm: 4 },
                { id: 'end', kind: 'chamber', x: 20, y: 0, z: 0, radiusMm: 6 },
            ],
            edges: [
                { id: 'down', from: 'mouth', to: 'knee', radiusMm: 4, flow: 'both' },
                { id: 'along', from: 'knee', to: 'end', radiusMm: 4, flow: 'both' },
            ],
        };
        const dug = carvePlan(soil, plan);
        // Walk the corner: down the shaft, through the junction, along the drift.
        for (let y = HALF - 0.5; y >= 0; y -= 0.5) expect(solidAt(dug, 0, y, 0)).toBe(false);
        for (let x = 0; x <= 20; x += 0.5) expect(solidAt(dug, x, 0, 0)).toBe(false);
    });

    it('costs a bounded amount to evaluate far from the nest', () => {
        // The box reject is not a nicety: without it every segment answers
        // every cell of a 134-cubed field. This asserts the shape of the field
        // it returns out there, which is what makes the reject safe to take.
        const hollow = planHollow(shaftPlan());
        expect(hollow(1000, 1000, 1000)).toBeLessThan(0);
        expect(hollow(-500, 0, 0)).toBeLessThan(0);
    });
});
