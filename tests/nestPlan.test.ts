import { describe, it, expect } from 'vitest';
import {
    emptyPlan, findNode, edgesAt, junctionArity, chordLength, pointOnEdge,
    sampleEdge, totalLengthMm, spoilVolumeMm3, validatePlan, routeBetween,
    MIN_ENTRANCE_RADIUS_MM,
    type NestPlan, type NestNode, type NestEdge,
} from '../src/nest/nestPlan';

function node(id: string, kind: NestNode['kind'], x: number, y: number, z: number, r = 5): NestNode {
    return { id, kind, x, y, z, radiusMm: r };
}

function edge(id: string, from: string, to: string, r = 5, flow: NestEdge['flow'] = 'both'): NestEdge {
    return { id, from, to, radiusMm: r, flow };
}

/** A shaft down from a surface mouth into a room, which is the shape already proven by ?shape=shaft. */
function shaftPlan(): NestPlan {
    return {
        nodes: [
            node('mouth', 'entrance', 0, 0, 0, 9),
            node('room', 'chamber', 0, -20, 0, 10),
        ],
        edges: [edge('shaft', 'mouth', 'room', 5)],
    };
}

describe('the graph itself', () => {
    it('starts with nothing in it', () => {
        const plan = emptyPlan();
        expect(plan.nodes).toHaveLength(0);
        expect(plan.edges).toHaveLength(0);
    });

    it('finds a node by id and admits when there is none', () => {
        const plan = shaftPlan();
        expect(findNode(plan, 'room')?.kind).toBe('chamber');
        expect(findNode(plan, 'nowhere')).toBeNull();
    });

    it('counts the tunnels at a node from both ends', () => {
        const plan: NestPlan = {
            nodes: [node('a', 'entrance', 0, 0, 0), node('b', 'junction', 0, -10, 0),
                node('c', 'chamber', 10, -10, 0), node('d', 'chamber', -10, -10, 0)],
            edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'd', 'b')],
        };
        // 'b' is the far end of e1 and e3 and the near end of e2 — a T-junction
        // nobody chose, which is the point of letting the shape fall out.
        expect(junctionArity(plan, 'b')).toBe(3);
        expect(junctionArity(plan, 'a')).toBe(1);
        expect(edgesAt(plan, 'b').map(e => e.id)).toEqual(['e1', 'e2', 'e3']);
    });

    it('measures a chord and shrugs at a dangling one', () => {
        expect(chordLength(shaftPlan(), edge('x', 'mouth', 'room'))).toBeCloseTo(20, 6);
        expect(chordLength(shaftPlan(), edge('x', 'mouth', 'ghost'))).toBe(0);
    });
});

describe('a tunnel as a curve', () => {
    it('runs from end to end and clamps outside', () => {
        const plan = shaftPlan();
        const e = plan.edges[0]!;
        expect(pointOnEdge(plan, e, 0)).toEqual({ x: 0, y: 0, z: 0 });
        expect(pointOnEdge(plan, e, 1).y).toBeCloseTo(-20, 6);
        expect(pointOnEdge(plan, e, -3).y).toBeCloseTo(0, 6);
        expect(pointOnEdge(plan, e, 9).y).toBeCloseTo(-20, 6);
    });

    it('collapses to the straight line when there is no bow', () => {
        const plan = shaftPlan();
        const mid = pointOnEdge(plan, plan.edges[0]!, 0.5);
        expect(mid.x).toBeCloseTo(0, 9);
        expect(mid.y).toBeCloseTo(-10, 9);
        expect(mid.z).toBeCloseTo(0, 9);
    });

    it('bends toward the bow, by the bow, at the middle', () => {
        const plan = shaftPlan();
        plan.edges[0]!.bow = { x: 4, y: 0, z: 0 };
        // A quadratic at t=0.5 sits halfway between the chord and the control
        // point, so a 4 mm push moves the middle 2 mm. That factor is the whole
        // reason to test it rather than assume it.
        expect(pointOnEdge(plan, plan.edges[0]!, 0.5).x).toBeCloseTo(2, 9);
        expect(pointOnEdge(plan, plan.edges[0]!, 0).x).toBeCloseTo(0, 9);
        expect(pointOnEdge(plan, plan.edges[0]!, 1).x).toBeCloseTo(0, 9);
    });

    it('points along itself on a bend, not at its own end', () => {
        const plan = shaftPlan();
        plan.edges[0]!.bow = { x: 10, y: 0, z: 0 };
        const at = sampleEdge(plan, plan.edges[0]!, 1);
        const start = at[0]!.along;
        // The chord is straight down. A bowed start leans sideways.
        expect(start.x).toBeGreaterThan(0.3);
        for (const s of at) {
            expect(Math.hypot(s.along.x, s.along.y, s.along.z)).toBeCloseTo(1, 6);
        }
    });

    it('measures arc length along the curve, and a bow makes it longer', () => {
        const plan = shaftPlan();
        const straight = totalLengthMm(plan);
        expect(straight).toBeCloseTo(20, 1);
        plan.edges[0]!.bow = { x: 10, y: 0, z: 0 };
        expect(totalLengthMm(plan)).toBeGreaterThan(straight + 1);
    });

    it('steps finely enough that consecutive spheres overlap', () => {
        const plan = shaftPlan();
        const samples = sampleEdge(plan, plan.edges[0]!, 1);
        for (let i = 1; i < samples.length; i += 1) {
            const gap = samples[i]!.s - samples[i - 1]!.s;
            // A gap wider than the bore would leave beads on a string instead
            // of a tunnel.
            expect(gap).toBeLessThan(samples[i]!.radiusMm);
        }
    });

    it('returns nothing for an edge whose ends do not exist', () => {
        expect(sampleEdge(shaftPlan(), edge('x', 'mouth', 'ghost'))).toEqual([]);
    });
});

describe('the mouth flare', () => {
    it('leaves a plain tunnel between plain junctions alone', () => {
        const plan: NestPlan = {
            nodes: [node('a', 'junction', 0, -10, 0, 5), node('b', 'junction', 30, -10, 0, 5)],
            edges: [edge('drift', 'a', 'b', 5)],
        };
        for (const s of sampleEdge(plan, plan.edges[0]!, 1)) {
            expect(s.radiusMm).toBeCloseTo(5, 9);
        }
    });

    it('funnels into a chamber instead of leaving a lip', () => {
        const samples = sampleEdge(shaftPlan(), shaftPlan().edges[0]!, 0.5);
        const atRoom = samples[samples.length - 1]!;
        const middle = samples[Math.floor(samples.length / 2)]!;
        expect(atRoom.radiusMm).toBeCloseTo(10, 6);
        expect(middle.radiusMm).toBeCloseTo(5, 6);
    });

    it('opens a generous mouth at the entrance, which she can otherwise stride over', () => {
        const first = sampleEdge(shaftPlan(), shaftPlan().edges[0]!, 0.5)[0]!;
        expect(first.radiusMm).toBeCloseTo(9, 6);
    });

    it('never pinches the bore below the tunnel it was asked for', () => {
        const plan: NestPlan = {
            nodes: [node('a', 'entrance', 0, 0, 0, 1), node('b', 'chamber', 0, -25, 0, 2)],
            edges: [edge('t', 'a', 'b', 5)],
        };
        for (const s of sampleEdge(plan, plan.edges[0]!, 1)) {
            expect(s.radiusMm).toBeGreaterThanOrEqual(5 - 1e-9);
        }
    });
});

describe('pricing the dig', () => {
    it('counts a plain tunnel as its own tube', () => {
        const plan: NestPlan = {
            nodes: [node('a', 'junction', 0, -10, 0, 4), node('b', 'junction', 40, -10, 0, 4)],
            edges: [edge('drift', 'a', 'b', 4)],
        };
        expect(spoilVolumeMm3(plan)).toBeCloseTo(Math.PI * 16 * 40, 0);
    });

    it('adds a chamber as a sphere', () => {
        const plan: NestPlan = { nodes: [node('r', 'chamber', 0, -20, 0, 3)], edges: [] };
        expect(spoilVolumeMm3(plan)).toBeCloseTo((4 / 3) * Math.PI * 27, 6);
    });

    it('charges nothing for an entrance or a junction on its own', () => {
        const plan: NestPlan = {
            nodes: [node('m', 'entrance', 0, 0, 0, 6), node('j', 'junction', 0, -5, 0, 5)],
            edges: [],
        };
        expect(spoilVolumeMm3(plan)).toBe(0);
    });
});

describe('what is wrong with a plan', () => {
    it('is happy with a nest that works', () => {
        expect(validatePlan(shaftPlan())).toEqual([]);
    });

    it('says nothing about an empty plan, which is a plan not yet drawn', () => {
        expect(validatePlan(emptyPlan())).toEqual([]);
    });

    it('names a tunnel that goes nowhere', () => {
        const plan = shaftPlan();
        plan.edges.push(edge('lost', 'room', 'ghost'));
        const faults = validatePlan(plan);
        expect(faults.some(f => f.kind === 'dangling-edge' && f.detail.includes('ghost'))).toBe(true);
    });

    it('catches repeated ids in both nodes and edges', () => {
        const plan = shaftPlan();
        plan.nodes.push(node('room', 'chamber', 5, -20, 0));
        plan.edges.push(edge('shaft', 'mouth', 'room'));
        const dupes = validatePlan(plan).filter(f => f.kind === 'duplicate-id');
        expect(dupes.map(f => f.detail).sort()).toEqual(['edge shaft', 'node room']);
    });

    it('notices a nest with no way in', () => {
        const plan: NestPlan = {
            nodes: [node('a', 'junction', 0, -10, 0), node('b', 'chamber', 20, -10, 0)],
            edges: [edge('e', 'a', 'b')],
        };
        expect(validatePlan(plan).some(f => f.kind === 'no-entrance')).toBe(true);
    });

    it('notices a mouth she would walk straight over', () => {
        const plan = shaftPlan();
        plan.nodes[0]!.radiusMm = MIN_ENTRANCE_RADIUS_MM - 1;
        expect(validatePlan(plan).map(f => f.kind)).toEqual(['narrow-entrance']);
        plan.nodes[0]!.radiusMm = MIN_ENTRANCE_RADIUS_MM;
        expect(validatePlan(plan)).toEqual([]);
    });

    it('does not police the width of anything but an entrance', () => {
        const plan = shaftPlan();
        plan.nodes[1]!.radiusMm = 1;
        expect(validatePlan(plan)).toEqual([]);
    });

    it('notices a room nothing connects to, but lets a lone entrance be', () => {
        const plan = shaftPlan();
        plan.nodes.push(node('sealed', 'chamber', 30, -20, 0));
        const faults = validatePlan(plan);
        expect(faults.filter(f => f.kind === 'orphan-node').map(f => f.detail)).toEqual(['sealed']);
    });

    it('notices a tunnel with both ends in the same place', () => {
        const plan: NestPlan = {
            nodes: [node('a', 'entrance', 0, 0, 0), node('b', 'chamber', 0, -0.2, 0)],
            edges: [edge('nub', 'a', 'b')],
        };
        expect(validatePlan(plan).some(f => f.kind === 'zero-length')).toBe(true);
    });

    it('reports every fault at once rather than the first', () => {
        const plan: NestPlan = {
            nodes: [node('a', 'junction', 0, -10, 0), node('a', 'chamber', 20, -10, 0)],
            edges: [edge('e', 'a', 'ghost')],
        };
        const kinds = new Set(validatePlan(plan).map(f => f.kind));
        expect(kinds.has('duplicate-id')).toBe(true);
        expect(kinds.has('dangling-edge')).toBe(true);
        expect(kinds.has('no-entrance')).toBe(true);
    });
});

describe('finding the way', () => {
    /**
     * Two ways down to the same room: a short one and a long detour. The
     * pathfinding must prefer the short one, and must take the detour when the
     * short one is arrowed against it.
     */
    function twoWays(shortFlow: NestEdge['flow'] = 'both'): NestPlan {
        return {
            nodes: [
                node('mouth', 'entrance', 0, 0, 0, 6),
                node('mid', 'junction', 0, -20, 0),
                node('long', 'junction', 40, -20, 0),
                node('room', 'chamber', 0, -40, 0, 8),
            ],
            edges: [
                edge('down', 'mouth', 'mid'),
                edge('short', 'mid', 'room', 5, shortFlow),
                edge('outA', 'mid', 'long'),
                edge('outB', 'long', 'room'),
            ],
        };
    }

    it('takes the short way', () => {
        expect(routeBetween(twoWays(), 'mouth', 'room')).toEqual(['mouth', 'mid', 'room']);
    });

    it('walks a one-way tunnel the way the arrow points', () => {
        expect(routeBetween(twoWays('forward'), 'mouth', 'room')).toEqual(['mouth', 'mid', 'room']);
    });

    it('takes the detour when the short way is arrowed against it', () => {
        expect(routeBetween(twoWays('backward'), 'mouth', 'room'))
            .toEqual(['mouth', 'mid', 'long', 'room']);
    });

    it('comes back up the other way when the arrows make a loop', () => {
        const plan = twoWays('forward');
        // Down through 'short', back up through the detour.
        plan.edges[2]!.flow = 'backward';   // outA: long -> mid only
        plan.edges[3]!.flow = 'backward';   // outB: room -> long only
        expect(routeBetween(plan, 'room', 'mouth')).toEqual(['room', 'long', 'mid', 'mouth']);
    });

    it('is a trip of no distance to where you already are', () => {
        expect(routeBetween(shaftPlan(), 'room', 'room')).toEqual(['room']);
    });

    it('gives up on a room nothing reaches', () => {
        const plan = shaftPlan();
        plan.nodes.push(node('sealed', 'chamber', 30, -20, 0));
        expect(routeBetween(plan, 'mouth', 'sealed')).toBeNull();
    });

    it('gives up when every route out is arrowed the wrong way', () => {
        const plan = twoWays('backward');
        plan.edges[2]!.flow = 'backward';   // outA: long -> mid only
        expect(routeBetween(plan, 'mouth', 'room')).toBeNull();
    });

    it('gives up on a node that is not in the plan', () => {
        expect(routeBetween(shaftPlan(), 'mouth', 'ghost')).toBeNull();
        expect(routeBetween(shaftPlan(), 'ghost', 'room')).toBeNull();
    });

    it('prefers the shorter route even when it has more hops', () => {
        const plan: NestPlan = {
            nodes: [
                node('a', 'entrance', 0, 0, 0),
                node('b', 'junction', 5, -5, 0),
                node('c', 'junction', 10, -10, 0),
                node('d', 'chamber', 15, -15, 0),
                node('far', 'junction', 200, -100, 0),
            ],
            edges: [
                edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('cd', 'c', 'd'),
                edge('afar', 'a', 'far'), edge('fard', 'far', 'd'),
            ],
        };
        expect(routeBetween(plan, 'a', 'd')).toEqual(['a', 'b', 'c', 'd']);
    });
});
