/**
 * THE NEST, cut out of the soil.
 *
 * This is the only place the plan becomes geometry, and it does it by reading
 * the same `sampleEdge` the ant walks and the pathfinding costs. That is the
 * whole point of `nestPlan` being the authority: a tunnel cannot be carved one
 * width and walked another, because there is one function that says how wide it
 * is and everybody calls it.
 *
 * Everything keeps `voxel/carve.ts`'s convention — positive inside, negative
 * outside, roughly a distance either way — so the result drops straight into
 * `carve(solid, planHollow(plan))`.
 */

import { anyOf, bore, carve, type Field, type Point } from '../voxel/carve';
import {
    MOUND_RISE, MOUND_SPREAD, sampleEdge,
    type NestEdge, type NestNode, type NestPlan,
} from './nestPlan';

export interface CarveOptions {
    /**
     * How finely the curve is walked, in millimetres. Smaller is rounder and
     * slower. It must stay below the narrowest bore or the tunnel becomes beads
     * on a string, which is what `sampleEdge`'s overlap test guards.
     */
    stepMm?: number;
    /**
     * How far outside a part's own bounds the field is still computed, in
     * millimetres. Surface Nets reads the field either side of a crossing, so
     * the box has to be loose enough that the cells straddling a wall see the
     * real distance and not the box's.
     */
    marginMm?: number;
}

const DEFAULT_STEP_MM = 1;
const DEFAULT_MARGIN_MM = 2;

/** Standard ant-room proportions: long, broad and vertically compressed. */
export const CHAMBER_SCALE = { x: 1.4, y: 0.7, z: 1.1 } as const;

export interface Bounds { min: Point; max: Point }

/**
 * A segment of tunnel whose bore changes along it.
 *
 * `voxel/carve.ts`'s `bore` is one width end to end, which cannot describe the
 * flare into a chamber. This projects onto the axis and asks how wide the bore
 * is THERE, which is exact when the two ends match — the ordinary case — and a
 * hair conservative across a taper, where consecutive segments overlap anyway.
 */
function taper(from: Point, to: Point, r0: number, r1: number): Field {
    const ax = to[0] - from[0];
    const ay = to[1] - from[1];
    const az = to[2] - from[2];
    const len2 = ax * ax + ay * ay + az * az;
    return (x, y, z) => {
        const px = x - from[0];
        const py = y - from[1];
        const pz = z - from[2];
        let t = len2 > 1e-12 ? (px * ax + py * ay + pz * az) / len2 : 0;
        t = Math.min(1, Math.max(0, t));
        const r = r0 + (r1 - r0) * t;
        return r - Math.hypot(px - ax * t, py - ay * t, pz - az * t);
    };
}

/** A round tunnel sample. */
function ball(at: Point, radius: number): Field {
    return (x, y, z) => radius - Math.hypot(x - at[0], y - at[1], z - at[2]);
}

/** A standardized oval room, wider/longer than it is tall. */
function chamberEllipsoid(at: Point, radius: number): Field {
    const rx = radius * CHAMBER_SCALE.x;
    const ry = radius * CHAMBER_SCALE.y;
    const rz = radius * CHAMBER_SCALE.z;
    const scale = Math.min(rx, ry, rz);
    return (x, y, z) => {
        const u = Math.hypot((x - at[0]) / rx, (y - at[1]) / ry, (z - at[2]) / rz);
        return (1 - u) * scale;
    };
}

/**
 * A field that is only computed where it can matter.
 *
 * A nest of any size is hundreds of segments and the density field is
 * evaluated at every cell, so asking every segment about every cell is the
 * difference between a carve that happens and one that hangs. Outside the box
 * it returns the distance to the box, which is negative and never larger than
 * the true value — so a union built from these is still correct, just cheap.
 */
function within(bounds: Bounds, inner: Field): Field {
    const { min, max } = bounds;
    return (x, y, z) => {
        const dx = Math.max(min[0] - x, x - max[0], 0);
        const dy = Math.max(min[1] - y, y - max[1], 0);
        const dz = Math.max(min[2] - z, z - max[2], 0);
        if (dx > 0 || dy > 0 || dz > 0) return -Math.hypot(dx, dy, dz);
        return inner(x, y, z);
    };
}

function grow(bounds: Bounds, by: number): Bounds {
    return {
        min: [bounds.min[0] - by, bounds.min[1] - by, bounds.min[2] - by],
        max: [bounds.max[0] + by, bounds.max[1] + by, bounds.max[2] + by],
    };
}

function union(a: Bounds, b: Bounds): Bounds {
    return {
        min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
        max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
    };
}

/**
 * The box a node occupies — a chamber's room, or an entrance's heap and vent.
 * A junction is only ever the width of the tunnels meeting at it, so it has no
 * box of its own.
 */
export function nodeBounds(node: NestNode): Bounds | null {
    if (node.kind === 'chamber') {
        const rx = node.radiusMm * CHAMBER_SCALE.x;
        const ry = node.radiusMm * CHAMBER_SCALE.y;
        const rz = node.radiusMm * CHAMBER_SCALE.z;
        return {
            min: [node.x - rx, node.y - ry, node.z - rz],
            max: [node.x + rx, node.y + ry, node.z + rz],
        };
    }
    if (node.kind === 'entrance') {
        const spread = node.radiusMm * MOUND_SPREAD;
        const rise = node.radiusMm * (MOUND_RISE + 1);
        return {
            min: [node.x - spread, node.y - node.radiusMm, node.z - spread],
            max: [node.x + spread, node.y + rise, node.z + spread],
        };
    }
    return null;
}

/** The box a tunnel occupies, bore included. */
export function edgeBounds(plan: NestPlan, edge: NestEdge, stepMm = DEFAULT_STEP_MM): Bounds | null {
    const samples = sampleEdge(plan, edge, stepMm);
    if (!samples.length) return null;
    let bounds: Bounds | null = null;
    for (const s of samples) {
        const r = s.radiusMm;
        const one: Bounds = {
            min: [s.at.x - r, s.at.y - r, s.at.z - r],
            max: [s.at.x + r, s.at.y + r, s.at.z + r],
        };
        bounds = bounds ? union(bounds, one) : one;
    }
    return bounds;
}

/** Everything the nest occupies, or null when there is nothing to carve. */
export function planBounds(plan: NestPlan, stepMm = DEFAULT_STEP_MM): Bounds | null {
    let bounds: Bounds | null = null;
    for (const edge of plan.edges) {
        const one = edgeBounds(plan, edge, stepMm);
        if (one) bounds = bounds ? union(bounds, one) : one;
    }
    for (const node of plan.nodes) {
        const one = nodeBounds(node);
        if (one) bounds = bounds ? union(bounds, one) : one;
    }
    return bounds;
}

/**
 * One tunnel as a void.
 *
 * A ball at every sample as well as a segment between each pair: the balls are
 * what make a bend round rather than faceted, and they cost nothing next to the
 * segments because the box reject has already thrown away everywhere else.
 */
export function edgeHollow(plan: NestPlan, edge: NestEdge, opts: CarveOptions = {}): Field | null {
    const stepMm = opts.stepMm ?? DEFAULT_STEP_MM;
    const samples = sampleEdge(plan, edge, stepMm);
    if (samples.length < 2) return null;
    const parts: Field[] = [];
    for (let i = 0; i < samples.length; i += 1) {
        const s = samples[i]!;
        parts.push(ball([s.at.x, s.at.y, s.at.z], s.radiusMm));
        if (i > 0) {
            const p = samples[i - 1]!;
            parts.push(taper(
                [p.at.x, p.at.y, p.at.z], [s.at.x, s.at.y, s.at.z], p.radiusMm, s.radiusMm,
            ));
        }
    }
    const bounds = edgeBounds(plan, edge, stepMm);
    const inner = anyOf(parts);
    return bounds ? within(grow(bounds, opts.marginMm ?? DEFAULT_MARGIN_MM), inner) : inner;
}

/**
 * The spoil heap around an entrance — the anthill itself.
 */
export function moundOf(node: NestNode): Field | null {
    if (node.kind !== 'entrance' || node.radiusMm <= 0) return null;
    const spread = node.radiusMm * MOUND_SPREAD;
    const rise = node.radiusMm * MOUND_RISE;
    const scale = Math.min(spread, rise);
    return (x, y, z) => {
        const u = Math.hypot((x - node.x) / spread, (y - node.y) / rise, (z - node.z) / spread);
        return (1 - u) * scale;
    };
}

/** The hole through the entrance mound. */
export function ventOf(node: NestNode): Field | null {
    if (node.kind !== 'entrance' || node.radiusMm <= 0) return null;
    const rise = node.radiusMm * MOUND_RISE;
    return bore(
        [node.x, node.y + rise + node.radiusMm, node.z],
        [node.x, node.y - node.radiusMm, node.z],
        node.radiusMm,
    );
}

/** One oval chamber as a void, or null for a node that is not a room. */
export function nodeHollow(node: NestNode): Field | null {
    if (node.kind !== 'chamber' || node.radiusMm <= 0) return null;
    return chamberEllipsoid([node.x, node.y, node.z], node.radiusMm);
}

/** The whole nest as one void. */
export function planHollow(plan: NestPlan, opts: CarveOptions = {}): Field {
    const parts: Field[] = [];
    for (const edge of plan.edges) {
        const one = edgeHollow(plan, edge, opts);
        if (one) parts.push(one);
    }
    for (const node of plan.nodes) {
        const room = nodeHollow(node);
        if (room) parts.push(room);
        const vent = ventOf(node);
        if (vent) parts.push(vent);
    }
    if (!parts.length) return () => -Infinity;
    return anyOf(parts);
}

/** The ground with the nest's spoil heaps piled on it. */
export function planMounded(solid: Field, plan: NestPlan): Field {
    const heaps: Field[] = [];
    for (const node of plan.nodes) {
        const heap = moundOf(node);
        if (heap) heaps.push(heap);
    }
    return heaps.length ? anyOf([solid, ...heaps]) : solid;
}

/** `solid` with the nest's heaps piled on and its tunnels cut out. Millimetres. */
export function carvePlan(solid: Field, plan: NestPlan, opts: CarveOptions = {}): Field {
    return carve(planMounded(solid, plan), planHollow(plan, opts));
}

/** A millimetre field, read in the scene's world units. */
export function inWorldUnits(field: Field, origin: Point, mmPerUnit: number): Field {
    return (x, y, z) => field(
        (x - origin[0]) * mmPerUnit,
        (y - origin[1]) * mmPerUnit,
        (z - origin[2]) * mmPerUnit,
    ) / mmPerUnit;
}
