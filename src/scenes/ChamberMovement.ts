/**
 * CHAMBER MOVEMENT — the maths of being loose inside an oval room.
 *
 * A chamber is carved as an ellipsoid (`chamberEllipsoid` in nestCarve.ts,
 * radii = radius x CHAMBER_SCALE). Inside one the queen leaves the rail and
 * walks freely — but "freely" must never mean "through the wall": her centre
 * is a point and her body is not, so the roam area is a SAFE ellipsoid at
 * ~75% of the carved one, shrunk further by her body's own reach.
 *
 * Everything here is pure arithmetic over one caller-chosen unit (the scene
 * passes world units, the tests pass millimetres), mirroring nestCarve's
 * ellipsoid semantics exactly — CHAMBER_SCALE is imported, not copied, so the
 * carve and the containment cannot drift apart.
 */

import { CHAMBER_SCALE } from '../nest/nestCarve';

/** How much of the carved room the queen may roam — the safe ellipsoid. */
export const CHAMBER_SAFE = 0.75;

/**
 * How deep the standing floor dips toward the carved shell, as a fraction of
 * the room's vertical radius. 1.0 would put her feet ON the shell (and her
 * rounding inside it); 0.9 keeps a skin of clearance everywhere while still
 * reading as "walking on the chamber floor" rather than hovering.
 */
export const FLOOR_SKIN = 0.9;

/** A chamber's carved extents: centre plus FULL ellipsoid radii. */
export interface ChamberBox {
    cx: number; cy: number; cz: number;
    rx: number; ry: number; rz: number;
}

/** The carved room around a chamber node of this radius. */
export function chamberBox(
    cx: number, cy: number, cz: number, radius: number,
): ChamberBox {
    return {
        cx, cy, cz,
        rx: radius * CHAMBER_SCALE.x,
        ry: radius * CHAMBER_SCALE.y,
        rz: radius * CHAMBER_SCALE.z,
    };
}

/**
 * Where a point sits relative to the CARVED shell: 0 at the centre, 1 on the
 * shell, beyond 1 outside the room. This is the one coordinate every rule in
 * the scene speaks — release the rail below ~0.55, exit-grab past it, blend
 * the room camera in across ~1.25 → 0.75.
 */
export function chamberNorm(b: ChamberBox, x: number, y: number, z: number): number {
    return Math.hypot((x - b.cx) / b.rx, (y - b.cy) / b.ry, (z - b.cz) / b.rz);
}

/** Is the point anywhere inside the carved room? */
export function insideChamber(b: ChamberBox, x: number, y: number, z: number): boolean {
    return chamberNorm(b, x, y, z) <= 1;
}

/**
 * The horizontal roam ellipse: the safe ellipsoid's footprint, shrunk by the
 * body margin, never collapsing below a fifth of the room (a tiny room must
 * still leave SOMEWHERE to stand rather than dividing by nothing).
 */
export function roamRadii(b: ChamberBox, marginXZ: number): { rx: number; rz: number } {
    return {
        rx: Math.max(b.rx * CHAMBER_SAFE - marginXZ, b.rx * 0.2),
        rz: Math.max(b.rz * CHAMBER_SAFE - marginXZ, b.rz * 0.2),
    };
}

/**
 * How far the roam ellipse extends from the centre along a horizontal
 * direction — "the wall is this far away, the way you are pressing".
 * Direction need not be unit length; a degenerate one returns 0.
 */
export function roamBoundaryDist(
    b: ChamberBox, marginXZ: number, dirX: number, dirZ: number,
): number {
    const roam = roamRadii(b, marginXZ);
    const len = Math.hypot(dirX, dirZ);
    if (len < 1e-9) return 0;
    return 1 / Math.hypot((dirX / len) / roam.rx, (dirZ / len) / roam.rz);
}

/**
 * Clamp a horizontal position into the roam ellipse. The clamp is radial —
 * pushing at the wall slides her along it instead of sticking, the same feel
 * as pressing against any other wall in the game.
 */
export function clampToChamber(
    b: ChamberBox, marginXZ: number, x: number, z: number,
): { x: number; z: number } {
    const roam = roamRadii(b, marginXZ);
    const dx = (x - b.cx) / roam.rx;
    const dz = (z - b.cz) / roam.rz;
    const u = Math.hypot(dx, dz);
    if (u <= 1) return { x, z };
    return { x: b.cx + (dx / u) * roam.rx, z: b.cz + (dz / u) * roam.rz };
}

/**
 * The standing floor under a horizontal position: the carved shell's lower
 * half at FLOOR_SKIN depth. Computed over the FULL radii — the floor is the
 * room's real floor, only the roam AREA is shrunk — so she stands within a
 * skin of the soil she sees, at the wall as at the centre.
 */
export function chamberFloorY(b: ChamberBox, x: number, z: number): number {
    const dx = (x - b.cx) / b.rx;
    const dz = (z - b.cz) / b.rz;
    const h = Math.max(0, 1 - dx * dx - dz * dz);
    return b.cy - b.ry * FLOOR_SKIN * Math.sqrt(h);
}
