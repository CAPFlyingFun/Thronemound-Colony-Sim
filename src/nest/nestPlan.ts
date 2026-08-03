/**
 * THE NEST, as a graph of nodes and the tunnels between them.
 *
 * One representation, and it is the authority. The mesh is carved FROM this,
 * the ant walks ALONG this, and the pathfinding runs OVER this — so there is
 * never a second description of the same tunnel that can drift out of step
 * with the first.
 *
 * That is not a stylistic preference, it is the bug that cost the most time in
 * this project. The dug-tunnel code kept two views of one track: `nearest()`
 * measured the raw polyline while `sample()` returned a smoothed one, they
 * disagreed by six millimetres on a bend, and the ant boarded a tunnel she was
 * within four millimetres of and was set down outside it. Any design where the
 * soil and the route are computed separately has that failure waiting in it.
 *
 * Geometry is millimetres throughout, and millimetres are what the player and
 * the design conversation are in — a ten-millimetre bore, a ten-by-twenty room.
 * The density field is in world units, where one unit is five millimetres, and
 * the conversion happens in exactly one place: `inWorldUnits` in `nestCarve`.
 * Nothing here knows about THREE, the renderer or the ant, which is what lets
 * it be tested as arithmetic.
 */

export type NodeKind = 'entrance' | 'junction' | 'chamber';

export interface NestNode {
    id: string;
    kind: NodeKind;
    x: number;
    y: number;
    z: number;
    /**
     * How big the space AT this node is, in millimetres.
     *
     * A junction is just a tunnel's width — it is a place two tunnels meet,
     * not a room. A chamber is however big the player made it. An entrance is
     * the mouth, and it wants to be generous: measured, the ant strides
     * straight over a hole narrower than her own reach, so a mouth cut to the
     * width of the tunnel below it is a hole she will never find.
     */
    radiusMm: number;
}

/** Which way traffic may run along a tunnel. */
export type EdgeFlow = 'both' | 'forward' | 'backward';

export interface NestEdge {
    id: string;
    from: string;
    to: string;
    /** How wide the bore is, in millimetres. */
    radiusMm: number;
    flow: EdgeFlow;
    /**
     * How much the tunnel bows, as a fraction of its own length, and which way.
     *
     * Zero is a straight run. This is what makes an elbow an elbow without the
     * player ever choosing a fitting from a list: they drag the middle of a
     * tunnel and it bends. Positive bows toward the bend vector.
     */
    bow?: { x: number; y: number; z: number };
}

export interface NestPlan {
    nodes: NestNode[];
    edges: NestEdge[];
}

/**
 * The narrowest entrance worth cutting, in millimetres.
 *
 * Measured, not chosen: with a ten-millimetre hole in the surface she stayed on
 * top of it for 2942 of 3000 frames — she strides over it. The opening a mouth
 * makes is roughly twice its radius, so eight millimetres puts a sixteen
 * millimetre hole in the ground, which is wider than her stride and therefore
 * findable. Anything less is a nest with a door she walks past.
 */
export const MIN_ENTRANCE_RADIUS_MM = 8;

export interface Vec3 { x: number; y: number; z: number }

export interface EdgeSample {
    /** Where on the tunnel's centreline. */
    at: Vec3;
    /** Which way the tunnel runs here, unit length. */
    along: Vec3;
    /** How wide the bore is here, in millimetres. */
    radiusMm: number;
    /** Distance from the `from` node, in millimetres. */
    s: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = (v: Vec3): number => Math.hypot(v.x, v.y, v.z);

function norm(v: Vec3): Vec3 {
    const n = len(v);
    return n < 1e-9 ? { x: 0, y: 1, z: 0 } : { x: v.x / n, y: v.y / n, z: v.z / n };
}

export function emptyPlan(): NestPlan {
    return { nodes: [], edges: [] };
}

export function findNode(plan: NestPlan, id: string): NestNode | null {
    return plan.nodes.find(n => n.id === id) ?? null;
}

/**
 * Every tunnel touching a node. The basis of both the junction geometry and
 * the pathfinding, which is the point of keeping one graph.
 */
export function edgesAt(plan: NestPlan, nodeId: string): NestEdge[] {
    return plan.edges.filter(e => e.from === nodeId || e.to === nodeId);
}

/**
 * What a node IS, structurally, rather than what it was labelled.
 *
 * A T-junction is not a fitting anybody chose — it is what three tunnels
 * meeting looks like. Letting the shape fall out of the graph is what keeps
 * the player dragging nodes instead of picking parts off a list.
 */
export function junctionArity(plan: NestPlan, nodeId: string): number {
    return edgesAt(plan, nodeId).length;
}

/**
 * The straight-line length of a tunnel, in millimetres. Bowed edges are longer
 * than this; `edgeLength` measures the curve.
 */
export function chordLength(plan: NestPlan, edge: NestEdge): number {
    const a = findNode(plan, edge.from);
    const b = findNode(plan, edge.to);
    if (!a || !b) return 0;
    return len(sub(b, a));
}

/**
 * A point along a tunnel, from 0 at `from` to 1 at `to`.
 *
 * A quadratic bend, because one control point is all a dragged middle gives
 * you and it is enough: an elbow, a shaft that leans, a tunnel that curves
 * round an obstacle. Straight is the same maths with no bow, so there is one
 * code path rather than a special case that can disagree with the general one.
 */
export function pointOnEdge(plan: NestPlan, edge: NestEdge, t: number): Vec3 {
    const a = findNode(plan, edge.from);
    const b = findNode(plan, edge.to);
    if (!a || !b) return { x: 0, y: 0, z: 0 };
    const u = Math.min(1, Math.max(0, t));
    const bow = edge.bow ?? { x: 0, y: 0, z: 0 };
    // The control point is the midpoint pushed out by the bow, so a bow of
    // zero collapses to the straight line exactly.
    const cx = (a.x + b.x) / 2 + bow.x;
    const cy = (a.y + b.y) / 2 + bow.y;
    const cz = (a.z + b.z) / 2 + bow.z;
    const m = 1 - u;
    return {
        x: m * m * a.x + 2 * m * u * cx + u * u * b.x,
        y: m * m * a.y + 2 * m * u * cy + u * u * b.y,
        z: m * m * a.z + 2 * m * u * cz + u * u * b.z,
    };
}

/**
 * The fastest the curve ever moves, in millimetres per unit of its parameter.
 *
 * This is what sizes the sampling, and it has to be the fastest rather than the
 * average. Samples are evenly spaced in the PARAMETER, and on a bowed edge the
 * curve covers more ground in some of it than others — so a count sized off any
 * kind of length only fixes the average, and the worst gap still runs over. The
 * chord under-samples worst of all: a tunnel asked for at one-millimetre steps
 * came back at 2.93 mm, a gap wider than a narrow bore's radius and therefore a
 * carve with holes in it. The control polygon got that to 1.10 mm. This is the
 * bound that actually holds.
 *
 * For a quadratic, B'(t) = 2[(1-t)(C-P0) + t(P1-C)] — a straight interpolation
 * between two vectors, so its length never exceeds twice the longer of them. On
 * a straight edge both are half the chord and this returns exactly the chord,
 * which is why the ordinary case costs nothing.
 */
function fastestSpeed(plan: NestPlan, edge: NestEdge): number {
    const a = findNode(plan, edge.from);
    const b = findNode(plan, edge.to);
    if (!a || !b) return 0;
    const bow = edge.bow ?? { x: 0, y: 0, z: 0 };
    const c = { x: (a.x + b.x) / 2 + bow.x, y: (a.y + b.y) / 2 + bow.y, z: (a.z + b.z) / 2 + bow.z };
    return 2 * Math.max(len(sub(c, a)), len(sub(b, c)));
}

/**
 * Walk a tunnel at roughly `stepMm` intervals.
 *
 * The step is a ceiling, not an exact spacing: the samples are evenly spaced in
 * the curve's own parameter, which on a bowed edge is uneven in distance, and
 * the count is sized off the curve's fastest speed so the unevenness can only
 * ever make them CLOSER than asked. The carver needs them close enough together
 * that consecutive spheres overlap, and the ant reads `s` for real distance, so
 * neither minds the surplus.
 */
export function sampleEdge(plan: NestPlan, edge: NestEdge, stepMm = 1): EdgeSample[] {
    const a = findNode(plan, edge.from);
    const b = findNode(plan, edge.to);
    if (!a || !b) return [];
    const rough = Math.max(chordLength(plan, edge), 1e-6);
    const bound = Math.max(fastestSpeed(plan, edge), rough);
    const steps = Math.max(2, Math.ceil(bound / Math.max(stepMm, 0.05)));
    const out: EdgeSample[] = [];
    let travelled = 0;
    let previous = pointOnEdge(plan, edge, 0);
    for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        const at = pointOnEdge(plan, edge, t);
        if (i > 0) travelled += len(sub(at, previous));
        previous = at;
        // The heading is taken from the curve either side rather than from the
        // chord, so a bowed tunnel points along itself and not at its own end.
        const ahead = pointOnEdge(plan, edge, Math.min(1, t + 0.01));
        const behind = pointOnEdge(plan, edge, Math.max(0, t - 0.01));
        out.push({
            at,
            along: norm(sub(ahead, behind)),
            /*
             * The bore widens into whatever it meets. A tunnel running into a
             * chamber that is simply cut at its own width leaves a lip the
             * width of the room, and an ant walking out of a chamber finds a
             * wall with a hole in it. Blending across the last stretch makes
             * the mouth a funnel instead.
             */
            radiusMm: mouthRadius(edge.radiusMm, a.radiusMm, b.radiusMm, t, rough),
            s: travelled,
        });
    }
    return out;
}

/**
 * How wide the bore is at `t`, flaring toward whatever sits at each end.
 *
 * Only flares where the node is WIDER than the tunnel — a chamber or an
 * entrance. A plain junction is the same width as its tunnels, so this returns
 * the tunnel's own radius and nothing happens.
 */
function mouthRadius(
    tunnel: number, fromR: number, toR: number, t: number, lengthMm: number,
): number {
    // The flare runs over roughly the radius of the thing being joined, so a
    // big chamber gets a long funnel and a small one barely a chamfer.
    const flareFrom = Math.min(0.5, Math.max(fromR, tunnel) / Math.max(lengthMm, 1e-6));
    const flareTo = Math.min(0.5, Math.max(toR, tunnel) / Math.max(lengthMm, 1e-6));
    let r = tunnel;
    if (fromR > tunnel && t < flareFrom) {
        const k = 1 - t / flareFrom;
        r = Math.max(r, tunnel + (fromR - tunnel) * k * k);
    }
    if (toR > tunnel && t > 1 - flareTo) {
        const k = 1 - (1 - t) / flareTo;
        r = Math.max(r, tunnel + (toR - tunnel) * k * k);
    }
    return r;
}

/** Total dug length of the network, in millimetres. */
export function totalLengthMm(plan: NestPlan): number {
    let total = 0;
    for (const edge of plan.edges) {
        const samples = sampleEdge(plan, edge, 1);
        total += samples.length ? samples[samples.length - 1]!.s : 0;
    }
    return total;
}

/**
 * Roughly how much soil the nest removes, in cubic millimetres.
 *
 * Tunnels as tubes plus chambers as spheres, and deliberately WITHOUT
 * subtracting the overlaps where they meet. The number exists to price a dig —
 * how many pellets have to be hauled out — and over-counting a junction by a
 * few cubic millimetres matters far less than the arithmetic being something
 * anyone can check by hand.
 */
export function spoilVolumeMm3(plan: NestPlan): number {
    let total = 0;
    for (const edge of plan.edges) {
        const samples = sampleEdge(plan, edge, 1);
        for (let i = 1; i < samples.length; i += 1) {
            const seg = samples[i]!.s - samples[i - 1]!.s;
            const r = (samples[i]!.radiusMm + samples[i - 1]!.radiusMm) / 2;
            total += Math.PI * r * r * seg;
        }
    }
    for (const node of plan.nodes) {
        if (node.kind !== 'chamber') continue;
        total += (4 / 3) * Math.PI * node.radiusMm ** 3;
    }
    return total;
}

export interface PlanFault {
    kind: 'dangling-edge' | 'duplicate-id' | 'narrow-entrance' | 'no-entrance'
        | 'orphan-node' | 'zero-length';
    detail: string;
}

/**
 * Everything wrong with a plan, rather than the first thing wrong with it.
 *
 * A designer wants the whole list at once: fixing one fault and being told
 * about the next is how a build step becomes a chore. Nothing here throws —
 * an invalid plan still carves, it just carves something the player can see is
 * wrong, which is friendlier than an empty screen.
 */
export function validatePlan(plan: NestPlan): PlanFault[] {
    const faults: PlanFault[] = [];
    const seen = new Set<string>();
    for (const n of plan.nodes) {
        if (seen.has(n.id)) faults.push({ kind: 'duplicate-id', detail: `node ${n.id}` });
        seen.add(n.id);
    }
    const edgeIds = new Set<string>();
    for (const e of plan.edges) {
        if (edgeIds.has(e.id)) faults.push({ kind: 'duplicate-id', detail: `edge ${e.id}` });
        edgeIds.add(e.id);
        if (!findNode(plan, e.from)) {
            faults.push({ kind: 'dangling-edge', detail: `${e.id} from ${e.from}` });
        }
        if (!findNode(plan, e.to)) {
            faults.push({ kind: 'dangling-edge', detail: `${e.id} to ${e.to}` });
        }
        if (findNode(plan, e.from) && findNode(plan, e.to) && chordLength(plan, e) < 0.5) {
            faults.push({ kind: 'zero-length', detail: e.id });
        }
    }
    if (plan.nodes.length && !plan.nodes.some(n => n.kind === 'entrance')) {
        faults.push({ kind: 'no-entrance', detail: 'a nest with no way in' });
    }
    for (const n of plan.nodes) {
        if (n.kind !== 'entrance' && !edgesAt(plan, n.id).length) {
            faults.push({ kind: 'orphan-node', detail: n.id });
        }
        if (n.kind === 'entrance' && n.radiusMm < MIN_ENTRANCE_RADIUS_MM) {
            faults.push({
                kind: 'narrow-entrance',
                detail: `${n.id} is ${n.radiusMm} mm, under ${MIN_ENTRANCE_RADIUS_MM} — she will walk over it`,
            });
        }
    }
    return faults;
}

/**
 * The cheapest route between two nodes, by dug distance.
 *
 * Dijkstra over the graph rather than A* over the terrain, which is the whole
 * reason for the graph existing: a colony asking "where is the food" should
 * cost a handful of node visits, not a search through a density field. One-way
 * tunnels are honoured, so a designed traffic system actually constrains it.
 *
 * Returns the node ids in order, or null when there is no legal route.
 */
export function routeBetween(plan: NestPlan, fromId: string, toId: string): string[] | null {
    if (!findNode(plan, fromId) || !findNode(plan, toId)) return null;
    if (fromId === toId) return [fromId];
    const best = new Map<string, number>([[fromId, 0]]);
    const cameFrom = new Map<string, string>();
    const unvisited = new Set(plan.nodes.map(n => n.id));
    while (unvisited.size) {
        let here: string | null = null;
        let hereCost = Infinity;
        for (const id of unvisited) {
            const c = best.get(id);
            if (c !== undefined && c < hereCost) { hereCost = c; here = id; }
        }
        if (here === null) break;
        if (here === toId) break;
        unvisited.delete(here);
        for (const e of edgesAt(plan, here)) {
            // Respect the arrows: a one-way tunnel is only walkable its way.
            const forward = e.from === here;
            if (forward && e.flow === 'backward') continue;
            if (!forward && e.flow === 'forward') continue;
            const next = forward ? e.to : e.from;
            if (!unvisited.has(next)) continue;
            const samples = sampleEdge(plan, e, 1);
            const cost = hereCost + (samples.length ? samples[samples.length - 1]!.s : 0);
            if (cost < (best.get(next) ?? Infinity)) {
                best.set(next, cost);
                cameFrom.set(next, here);
            }
        }
    }
    if (!best.has(toId)) return null;
    const route = [toId];
    let cursor = toId;
    while (cursor !== fromId) {
        const prev = cameFrom.get(cursor);
        if (prev === undefined) return null;
        route.unshift(prev);
        cursor = prev;
    }
    return route;
}
