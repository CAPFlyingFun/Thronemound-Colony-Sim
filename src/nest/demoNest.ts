/**
 * A NEST somebody might have designed, for looking at before there is a UI to
 * draw one with.
 *
 * The Nest Designer is a mode where the player drops entrances, junctions and
 * chambers and drags tunnels between them. This is what the mode would produce
 * — a plan, nothing more — so the carving, the chevrons, the pathfinding and
 * the ant can all be built and measured against something real while the
 * drawing tools are still being written. When the tools land they replace this
 * function and nothing downstream of it changes, because the plan is the
 * interface.
 *
 * Millimetres, in the block's own frame: 0 to 64 on every axis, with the top
 * face at y = 64.
 */

import { MIN_ENTRANCE_RADIUS_MM, type NestPlan } from './nestPlan';

/** The top face of the block, in millimetres. */
const TOP_MM = 64;

export function demoNest(): NestPlan {
    return {
        nodes: [
            // On the surface, and deliberately wider than the shaft below it:
            // measured, she strides straight over anything narrower.
            { id: 'mouth', kind: 'entrance', x: 32, y: TOP_MM, z: 16, radiusMm: MIN_ENTRANCE_RADIUS_MM + 1 },
            // Where the shaft bottoms out and the nest branches. A junction is
            // no wider than its tunnels — it is a place they meet, not a room.
            { id: 'hall', kind: 'junction', x: 32, y: 42, z: 16, radiusMm: 4 },
            { id: 'larder', kind: 'chamber', x: 14, y: 34, z: 26, radiusMm: 8 },
            { id: 'royal', kind: 'chamber', x: 48, y: 22, z: 34, radiusMm: 10 },
        ],
        edges: [
            { id: 'descent', from: 'mouth', to: 'hall', radiusMm: 4, flow: 'both' },
            // Bowed, so the run to the larder is an elbow rather than a
            // diagonal — which is the shape a dragged tunnel makes and the
            // reason the carver has to follow the curve and not the chord.
            {
                id: 'toLarder', from: 'hall', to: 'larder', radiusMm: 4, flow: 'both',
                bow: { x: -4, y: 5, z: 0 },
            },
            { id: 'toRoyal', from: 'hall', to: 'royal', radiusMm: 4, flow: 'both' },
            // One-way, so there is something for the chevrons to point at and
            // something for the routing to have to respect: traffic leaves the
            // larder for the royal chamber and comes back the way it came in.
            { id: 'haul', from: 'larder', to: 'royal', radiusMm: 3.5, flow: 'forward' },
        ],
    };
}
