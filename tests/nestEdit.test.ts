import { describe, it, expect } from 'vitest';
import {
    addNode, bowEdge, clonePlan, cycleFlow, deleteEdge, deleteNode, freshId,
    linkNodes, moveNode, PlanHistory, RADIUS_LIMITS, resizeEdge, resizeNode,
    TUNNEL_LIMITS, wouldOrphan,
} from '../src/nest/nestEdit';
import { emptyPlan, findNode, MIN_ENTRANCE_RADIUS_MM, validatePlan, type NestPlan } from '../src/nest/nestPlan';

function twoNodes(): NestPlan {
    return {
        nodes: [
            { id: 'mouth1', kind: 'entrance', x: 32, y: 52, z: 32, radiusMm: 8 },
            { id: 'node1', kind: 'junction', x: 32, y: 30, z: 32, radiusMm: 4 },
        ],
        edges: [],
    };
}

describe('naming', () => {
    it('does not hand out a name already taken', () => {
        const plan = twoNodes();
        expect(freshId(plan, 'node')).toBe('node2');
        expect(freshId(plan, 'mouth')).toBe('mouth2');
    });

    it('skips a gap rather than colliding after a delete', () => {
        // Make three, delete the middle, make another. Counting from the node
        // count would name the new one after the one still there.
        let plan = emptyPlan();
        for (let i = 0; i < 3; i += 1) plan = addNode(plan, 'junction', { x: i, y: 0, z: 0 }).plan;
        plan = deleteNode(plan, 'node2');
        const made = addNode(plan, 'junction', { x: 9, y: 0, z: 0 });
        expect(made.id).toBe('node2');
        expect(validatePlan(made.plan).filter(f => f.kind === 'duplicate-id')).toEqual([]);
    });

    it('names nodes and tunnels out of the same pool', () => {
        const plan = linkNodes(twoNodes(), 'mouth1', 'node1');
        expect(plan.edges[0]!.id).toBe('tunnel1');
    });
});

describe('placing and shaping', () => {
    it('gives each kind a sensible starting width', () => {
        const plan = emptyPlan();
        expect(addNode(plan, 'entrance', { x: 0, y: 0, z: 0 }).plan.nodes[0]!.radiusMm)
            .toBe(MIN_ENTRANCE_RADIUS_MM);
        expect(addNode(plan, 'chamber', { x: 0, y: 0, z: 0 }).plan.nodes[0]!.radiusMm).toBe(8);
        expect(addNode(plan, 'junction', { x: 0, y: 0, z: 0 }).plan.nodes[0]!.radiusMm).toBe(4);
    });

    it('moves a node without touching anything else', () => {
        const plan = moveNode(linkNodes(twoNodes(), 'mouth1', 'node1'), 'node1', { x: 5, y: 6, z: 7 });
        expect(findNode(plan, 'node1')).toMatchObject({ x: 5, y: 6, z: 7, radiusMm: 4 });
        expect(plan.edges).toHaveLength(1);
        expect(findNode(plan, 'mouth1')).toMatchObject({ x: 32, y: 52, z: 32 });
    });

    it('will not let an entrance be dragged narrower than she can find', () => {
        // The one limit here that is a measurement rather than a taste: she
        // strides straight over a 10 mm hole.
        const plan = resizeNode(twoNodes(), 'mouth1', 1);
        expect(findNode(plan, 'mouth1')!.radiusMm).toBe(MIN_ENTRANCE_RADIUS_MM);
        expect(validatePlan(plan).filter(f => f.kind === 'narrow-entrance')).toEqual([]);
    });

    it('holds every kind inside its own limits', () => {
        const plan = twoNodes();
        for (const [id, kind] of [['mouth1', 'entrance'], ['node1', 'junction']] as const) {
            expect(findNode(resizeNode(plan, id, -99), id)!.radiusMm).toBe(RADIUS_LIMITS[kind].min);
            expect(findNode(resizeNode(plan, id, 999), id)!.radiusMm).toBe(RADIUS_LIMITS[kind].max);
        }
    });

    it('holds a tunnel inside its limits too', () => {
        const plan = linkNodes(twoNodes(), 'mouth1', 'node1');
        expect(resizeEdge(plan, 'tunnel1', 999).edges[0]!.radiusMm).toBe(TUNNEL_LIMITS.max);
        expect(resizeEdge(plan, 'tunnel1', 0).edges[0]!.radiusMm).toBe(TUNNEL_LIMITS.min);
    });
});

describe('joining', () => {
    it('joins two nodes both ways by default', () => {
        const plan = linkNodes(twoNodes(), 'mouth1', 'node1');
        expect(plan.edges).toHaveLength(1);
        expect(plan.edges[0]).toMatchObject({ from: 'mouth1', to: 'node1', flow: 'both' });
    });

    it('refuses a node to itself, quietly', () => {
        expect(linkNodes(twoNodes(), 'node1', 'node1').edges).toHaveLength(0);
    });

    it('refuses a second tunnel between the same pair, either way round', () => {
        // A duplicate carves exactly the same soil as the first — all it adds
        // is a second chevron stack and an edge nobody can select.
        let plan = linkNodes(twoNodes(), 'mouth1', 'node1');
        plan = linkNodes(plan, 'mouth1', 'node1');
        plan = linkNodes(plan, 'node1', 'mouth1');
        expect(plan.edges).toHaveLength(1);
    });

    it('refuses to join something that is not there', () => {
        expect(linkNodes(twoNodes(), 'mouth1', 'ghost').edges).toHaveLength(0);
    });
});

describe('arrows', () => {
    it('cycles both, forward, backward, both', () => {
        let plan = linkNodes(twoNodes(), 'mouth1', 'node1');
        const seen = [plan.edges[0]!.flow];
        for (let i = 0; i < 3; i += 1) {
            plan = cycleFlow(plan, 'tunnel1');
            seen.push(plan.edges[0]!.flow);
        }
        expect(seen).toEqual(['both', 'forward', 'backward', 'both']);
    });
});

describe('bending', () => {
    it('bends a tunnel and straightens it again', () => {
        let plan = linkNodes(twoNodes(), 'mouth1', 'node1');
        plan = bowEdge(plan, 'tunnel1', { x: 4, y: 0, z: 0 });
        expect(plan.edges[0]!.bow).toEqual({ x: 4, y: 0, z: 0 });
        plan = bowEdge(plan, 'tunnel1', null);
        // Removed, not zeroed — a bow of zero and no bow at all must not be two
        // different states of the same tunnel.
        expect('bow' in plan.edges[0]!).toBe(false);
    });
});

describe('removing', () => {
    it('takes a node and every tunnel that ran to it', () => {
        let plan = linkNodes(twoNodes(), 'mouth1', 'node1');
        plan = addNode(plan, 'chamber', { x: 10, y: 20, z: 10 }).plan;
        plan = linkNodes(plan, 'node1', 'room1');
        expect(plan.edges).toHaveLength(2);

        const after = deleteNode(plan, 'node1');
        expect(after.nodes.map(n => n.id)).toEqual(['mouth1', 'room1']);
        // Leaving them would fill the plan with rubbish nobody can select.
        expect(after.edges).toHaveLength(0);
        expect(validatePlan(after).filter(f => f.kind === 'dangling-edge')).toEqual([]);
    });

    it('says in advance what a delete will take with it', () => {
        let plan = linkNodes(twoNodes(), 'mouth1', 'node1');
        plan = addNode(plan, 'chamber', { x: 10, y: 20, z: 10 }).plan;
        plan = linkNodes(plan, 'node1', 'room1');
        expect(wouldOrphan(plan, 'node1').sort()).toEqual(['tunnel1', 'tunnel2']);
        expect(wouldOrphan(plan, 'room1')).toEqual(['tunnel2']);
    });

    it('takes a tunnel without touching the nodes it joined', () => {
        const plan = deleteEdge(linkNodes(twoNodes(), 'mouth1', 'node1'), 'tunnel1');
        expect(plan.nodes).toHaveLength(2);
        expect(plan.edges).toHaveLength(0);
    });
});

describe('an edit never reaches back into the plan it came from', () => {
    it('leaves the original alone', () => {
        const before = linkNodes(twoNodes(), 'mouth1', 'node1');
        const snapshot = JSON.stringify(before);
        moveNode(before, 'node1', { x: 99, y: 99, z: 99 });
        resizeNode(before, 'node1', 7);
        cycleFlow(before, 'tunnel1');
        bowEdge(before, 'tunnel1', { x: 1, y: 2, z: 3 });
        deleteNode(before, 'node1');
        expect(JSON.stringify(before)).toBe(snapshot);
    });

    it('clones deeply enough that a bow cannot be shared', () => {
        const plan = bowEdge(linkNodes(twoNodes(), 'mouth1', 'node1'), 'tunnel1', { x: 1, y: 2, z: 3 });
        const copy = clonePlan(plan);
        copy.edges[0]!.bow!.x = 99;
        copy.nodes[0]!.x = 99;
        expect(plan.edges[0]!.bow!.x).toBe(1);
        expect(plan.nodes[0]!.x).toBe(32);
    });
});

describe('undo', () => {
    it('steps back and forward through whole plans', () => {
        const history = new PlanHistory();
        let plan = twoNodes();
        expect(history.canUndo).toBe(false);

        history.remember(plan);
        plan = moveNode(plan, 'node1', { x: 1, y: 1, z: 1 });
        history.remember(plan);
        plan = moveNode(plan, 'node1', { x: 2, y: 2, z: 2 });

        plan = history.undo(plan)!;
        expect(findNode(plan, 'node1')).toMatchObject({ x: 1, y: 1, z: 1 });
        plan = history.undo(plan)!;
        expect(findNode(plan, 'node1')).toMatchObject({ x: 32, y: 30, z: 32 });
        expect(history.canUndo).toBe(false);

        plan = history.redo(plan)!;
        expect(findNode(plan, 'node1')).toMatchObject({ x: 1, y: 1, z: 1 });
    });

    it('has nothing to give when nothing has happened', () => {
        const history = new PlanHistory();
        expect(history.undo(twoNodes())).toBeNull();
        expect(history.redo(twoNodes())).toBeNull();
    });

    it('abandons the future once a new edit lands', () => {
        const history = new PlanHistory();
        let plan = twoNodes();
        history.remember(plan);
        plan = moveNode(plan, 'node1', { x: 1, y: 1, z: 1 });
        plan = history.undo(plan)!;
        expect(history.canRedo).toBe(true);

        history.remember(plan);
        plan = moveNode(plan, 'node1', { x: 5, y: 5, z: 5 });
        expect(history.canRedo).toBe(false);
    });

    it('keeps a bounded amount of it', () => {
        const history = new PlanHistory(3);
        let plan = twoNodes();
        for (let i = 0; i < 10; i += 1) {
            history.remember(plan);
            plan = moveNode(plan, 'node1', { x: i, y: 0, z: 0 });
        }
        let steps = 0;
        while (history.canUndo) { plan = history.undo(plan)!; steps += 1; }
        expect(steps).toBe(3);
    });

    it('holds a snapshot, not a reference to a plan that keeps changing', () => {
        const history = new PlanHistory();
        const plan = twoNodes();
        history.remember(plan);
        // Mutating the live plan afterwards must not rewrite history.
        plan.nodes[1]!.x = 999;
        expect(findNode(history.undo(plan)!, 'node1')!.x).toBe(32);
    });
});
