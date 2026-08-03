/**
 * EDITING A NEST, as arithmetic.
 *
 * Every change the designer can make lives here, away from the pointer events
 * and the meshes, so the rules can be tested without a browser: what happens to
 * the tunnels when you delete the junction they meet at, whether an entrance
 * can be dragged below ground, what a new node is called.
 *
 * Everything returns a NEW plan rather than mutating the old one. That is what
 * makes undo one line — keep the last plan — rather than a log of inverse
 * operations that has to be right for every case including the ones nobody
 * thought of.
 */

import {
    edgesAt, findNode, MIN_ENTRANCE_RADIUS_MM,
    type EdgeFlow, type NestEdge, type NestNode, type NestPlan, type NodeKind,
} from './nestPlan';

/** How wide each kind of thing starts out, in millimetres. */
export const DEFAULT_RADIUS_MM: Record<NodeKind, number> = {
    entrance: MIN_ENTRANCE_RADIUS_MM,
    junction: 4,
    chamber: 8,
};

/** The narrowest and widest anything may be dragged to, in millimetres. */
export const RADIUS_LIMITS: Record<NodeKind, { min: number; max: number }> = {
    // An entrance may not go below the width she can find. That is the one
    // limit here that is a measurement rather than a taste.
    entrance: { min: MIN_ENTRANCE_RADIUS_MM, max: 16 },
    junction: { min: 2, max: 8 },
    chamber: { min: 3, max: 16 },
};

export const TUNNEL_LIMITS = { min: 2, max: 10 };

/**
 * A name for a new thing that is not already taken.
 *
 * Counting from the number of existing nodes would hand out a duplicate the
 * moment anything is deleted — make three, delete the second, make another,
 * and the new one collides with the third.
 */
export function freshId(plan: NestPlan, stem: string): string {
    const taken = new Set<string>([
        ...plan.nodes.map(n => n.id), ...plan.edges.map(e => e.id),
    ]);
    for (let i = 1; ; i += 1) {
        const id = `${stem}${i}`;
        if (!taken.has(id)) return id;
    }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function addNode(
    plan: NestPlan, kind: NodeKind, at: { x: number; y: number; z: number },
): { plan: NestPlan; id: string } {
    const id = freshId(plan, kind === 'entrance' ? 'mouth' : kind === 'chamber' ? 'room' : 'node');
    const node: NestNode = { id, kind, x: at.x, y: at.y, z: at.z, radiusMm: DEFAULT_RADIUS_MM[kind] };
    return { plan: { nodes: [...plan.nodes, node], edges: plan.edges }, id };
}

/** Move a node. The caller decides where; this only records it. */
export function moveNode(
    plan: NestPlan, id: string, to: { x: number; y: number; z: number },
): NestPlan {
    return {
        nodes: plan.nodes.map(n => (n.id === id ? { ...n, x: to.x, y: to.y, z: to.z } : n)),
        edges: plan.edges,
    };
}

/** Widen or narrow a node, within what its kind allows. */
export function resizeNode(plan: NestPlan, id: string, radiusMm: number): NestPlan {
    return {
        nodes: plan.nodes.map((n) => {
            if (n.id !== id) return n;
            const limit = RADIUS_LIMITS[n.kind];
            return { ...n, radiusMm: clamp(radiusMm, limit.min, limit.max) };
        }),
        edges: plan.edges,
    };
}

/**
 * Join two nodes with a tunnel.
 *
 * Refuses a node to itself and refuses a second tunnel between the same pair —
 * both carve to exactly the same soil as the first, so the only thing a
 * duplicate adds is a second chevron stack and an edge nobody can select.
 * Returns the plan unchanged rather than throwing: a designer dragging quickly
 * will ask for this by accident, and it is not an error, it is a no-op.
 */
export function linkNodes(plan: NestPlan, fromId: string, toId: string): NestPlan {
    if (fromId === toId) return plan;
    if (!findNode(plan, fromId) || !findNode(plan, toId)) return plan;
    const already = plan.edges.some(e => (
        (e.from === fromId && e.to === toId) || (e.from === toId && e.to === fromId)
    ));
    if (already) return plan;
    const edge: NestEdge = {
        id: freshId(plan, 'tunnel'),
        from: fromId,
        to: toId,
        radiusMm: DEFAULT_RADIUS_MM.junction,
        flow: 'both',
    };
    return { nodes: plan.nodes, edges: [...plan.edges, edge] };
}

/** Widen or narrow a tunnel. */
export function resizeEdge(plan: NestPlan, id: string, radiusMm: number): NestPlan {
    return {
        nodes: plan.nodes,
        edges: plan.edges.map(e => (e.id === id
            ? { ...e, radiusMm: clamp(radiusMm, TUNNEL_LIMITS.min, TUNNEL_LIMITS.max) }
            : e)),
    };
}

/**
 * Turn a tunnel's arrows: both ways, one way, the other way, back to both.
 *
 * A cycle rather than three buttons. There are only three states and they have
 * an obvious order, and one control that shows what it will do next costs a
 * third of the screen space on a phone.
 */
export function cycleFlow(plan: NestPlan, id: string): NestPlan {
    const next: Record<EdgeFlow, EdgeFlow> = { both: 'forward', forward: 'backward', backward: 'both' };
    return {
        nodes: plan.nodes,
        edges: plan.edges.map(e => (e.id === id ? { ...e, flow: next[e.flow] } : e)),
    };
}

/** Bend a tunnel, or straighten it. */
export function bowEdge(
    plan: NestPlan, id: string, bow: { x: number; y: number; z: number } | null,
): NestPlan {
    return {
        nodes: plan.nodes,
        edges: plan.edges.map((e) => {
            if (e.id !== id) return e;
            const { bow: _drop, ...rest } = e;
            return bow ? { ...rest, bow } : rest;
        }),
    };
}

/**
 * Remove a node, and every tunnel that ran to it.
 *
 * The tunnels have to go. An edge whose end no longer exists is a
 * `dangling-edge` fault, it carves nothing, and it draws nothing — so leaving
 * them would quietly fill the plan with rubbish the designer cannot see or
 * select in order to delete.
 */
export function deleteNode(plan: NestPlan, id: string): NestPlan {
    return {
        nodes: plan.nodes.filter(n => n.id !== id),
        edges: plan.edges.filter(e => e.from !== id && e.to !== id),
    };
}

export function deleteEdge(plan: NestPlan, id: string): NestPlan {
    return { nodes: plan.nodes, edges: plan.edges.filter(e => e.id !== id) };
}

/**
 * Everything a node's removal would take with it, for a designer about to be
 * asked whether they meant it.
 */
export function wouldOrphan(plan: NestPlan, id: string): string[] {
    return edgesAt(plan, id).map(e => e.id);
}

/** A copy, so an edit cannot reach back into the plan it came from. */
export function clonePlan(plan: NestPlan): NestPlan {
    return {
        nodes: plan.nodes.map(n => ({ ...n })),
        edges: plan.edges.map(e => ({ ...e, ...(e.bow ? { bow: { ...e.bow } } : {}) })),
    };
}

/**
 * Undo, as a stack of whole plans.
 *
 * Whole plans rather than inverse operations. A nest is a few dozen small
 * objects — keeping thirty of them costs less than a single mesh — and the
 * alternative is an inverse for every operation, each of which has to be right
 * for cases nobody thought of, which is how undo corrupts a document.
 */
export class PlanHistory {
    private readonly past: NestPlan[] = [];

    private readonly future: NestPlan[] = [];

    constructor(private readonly limit = 40) {}

    /** Record where the plan was BEFORE a change. */
    remember(plan: NestPlan): void {
        this.past.push(clonePlan(plan));
        if (this.past.length > this.limit) this.past.shift();
        // A new edit abandons anything that was undone — the usual rule, and
        // the only one that keeps the future a single line rather than a tree.
        this.future.length = 0;
    }

    undo(current: NestPlan): NestPlan | null {
        const back = this.past.pop();
        if (!back) return null;
        this.future.push(clonePlan(current));
        return back;
    }

    redo(current: NestPlan): NestPlan | null {
        const forward = this.future.pop();
        if (!forward) return null;
        this.past.push(clonePlan(current));
        return forward;
    }

    get canUndo(): boolean { return this.past.length > 0; }

    get canRedo(): boolean { return this.future.length > 0; }
}
