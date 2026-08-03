/**
 * THE CLOD: the soil a bite actually removed, as a lump that falls.
 *
 * A straight port of `_spawn_clod` in the Godot build's `terrain_lab.gd`, kept
 * to its numbers rather than re-derived, because that version demonstrably
 * looks right and this one had no clod at all. Every constant below is Godot's.
 *
 * The one thing that cannot be copied is the rigid body. Godot hands the lump
 * to its physics server; there is no solver here, so it is integrated
 * ballistically and stopped against the density field. That is a smaller
 * difference than it sounds: a clod is in the air for well under a second, it
 * never stacks, and nothing else in the scene collides with it.
 *
 * The mass survives the port anyway, and it has to. Godot's own note:
 *
 *   A velocity, not a flat impulse -- impulse = velocity * mass, so the kick
 *   stays a gentle, consistent pop regardless of how big the clod is. A flat
 *   impulse divided by the 0.02 mass floor (which small mandible-depth bites
 *   hit far more often now than a full-radius dig ever did) is what sent
 *   clods off like rockets: the same shove into a much lighter body.
 *
 * So `clodKick` returns the VELOCITY directly. Applying it as an impulse and
 * dividing by a mass that floors at 0.02 is the bug they already found.
 *
 * World units throughout — one unit is five millimetres, in both builds — so
 * the volume that comes out of `subtractSphere` feeds these formulae unchanged.
 */

/** How long a clod lasts before it is taken away, in seconds. Godot: 12.0. */
export const CLOD_LIFETIME_S = 12;

/** The smallest and largest a clod is ever drawn. Godot: clampf(..., 0.08, 0.32). */
export const CLOD_RADIUS_LIMITS = { min: 0.08, max: 0.32 };

/**
 * Godot: `pow(volume * 3.0 / (4.0 * PI), 1.0 / 3.0) * 0.72`.
 *
 * The sphere-volume formula solved for radius, then shown at 72% linear scale —
 * "so a loose scoop is readable without pretending every bit is one solid
 * boulder". The clamp is what stops a huge bite producing a boulder and a
 * mandible-deep nibble producing something invisible.
 */
export function clodRadius(volume: number): number {
    if (!(volume > 0)) return CLOD_RADIUS_LIMITS.min;
    const solid = Math.cbrt((volume * 3) / (4 * Math.PI)) * 0.72;
    return Math.min(CLOD_RADIUS_LIMITS.max, Math.max(CLOD_RADIUS_LIMITS.min, solid));
}

/** Godot: `maxf(0.02, volume * 0.08)`. The floor is what the kick note is about. */
export function clodMass(volume: number): number {
    return Math.max(0.02, (volume > 0 ? volume : 0) * 0.08);
}

export interface Vec3 { x: number; y: number; z: number }

/**
 * The pop, as a velocity.
 *
 * Godot: `normal * 2.4 + Vector3.UP * 1.8 + Vector3(randf_range(-0.8, 0.8), 0,
 * randf_range(-0.8, 0.8))`.
 *
 * Out of the face, up, and a little sideways so a row of bites does not fire a
 * neat line of identical lumps. The sideways term is world-horizontal in Godot
 * even on a wall, and it is kept that way — it is scatter, not a direction that
 * means anything.
 */
export function clodKick(normal: Vec3, random: () => number = Math.random): Vec3 {
    const spread = (): number => (random() * 2 - 1) * 0.8;
    return {
        x: normal.x * 2.4 + spread(),
        y: normal.y * 2.4 + 1.8,
        z: normal.z * 2.4 + spread(),
    };
}

/**
 * Where the clod starts: Godot's `at + normal * (radius + 0.06)`.
 *
 * Clear of the face by its own radius and a little more, so it is not born
 * inside the soil it came out of.
 */
export function clodStart(at: Vec3, normal: Vec3, radius: number): Vec3 {
    const out = radius + 0.06;
    return { x: at.x + normal.x * out, y: at.y + normal.y * out, z: at.z + normal.z * out };
}

/**
 * How hard the world pulls a loose lump down, in world units per second
 * squared.
 *
 * Godot's project default, and deliberately NOT the ant's own gravity. She has
 * adhesion — while she is on a surface, "down" is her own -Y, which on a wall
 * holds her against it. A clod has let go of everything, and a lump of dirt in
 * mid-air falls the way the world falls.
 */
export const CLOD_GRAVITY = 9.8;

/**
 * How much a bounce keeps. Godot's default physics material does not bounce,
 * and a clod that pinged off the floor would read as a pebble; this takes the
 * speed into the surface away and drags what is left along it.
 */
const BOUNCE = 0;
const GROUND_DRAG = 6;

/** How slow counts as stopped, in world units per second. */
const SETTLED_SPEED = 0.05;

export interface Clod {
    at: Vec3;
    velocity: Vec3;
    /** Drawn radius, in world units. */
    radius: number;
    mass: number;
    /** How long it has existed, in seconds. */
    age: number;
    /** Whether it has come to rest. */
    resting: boolean;
    /** A stable number per clod, so its drawn shape and spin never change. */
    seed: number;
}

/**
 * Make one, from the volume the brush actually removed.
 *
 * The volume is the whole point: Godot's HUD line is "Scoop removed %.2f
 * voxel^3; the clod uses that same volume." A clod sized off the brush radius
 * instead would be the same size whether the bite hit packed soil or clipped
 * the edge of a tunnel she had already dug.
 */
export function makeClod(
    at: Vec3, normal: Vec3, volume: number, random: () => number = Math.random,
): Clod {
    const radius = clodRadius(volume);
    return {
        at: clodStart(at, normal, radius),
        velocity: clodKick(normal, random),
        radius,
        mass: clodMass(volume),
        age: 0,
        resting: false,
        seed: Math.floor(random() * 0xffffff),
    };
}

/**
 * Move every clod on by `dt`, and drop the ones that are done.
 *
 * `solidAt` is asked about the clod's CENTRE rather than its surface. A lump
 * that comes to rest half-buried in the soil it fell onto is what a loose scoop
 * of dirt does; one held off the ground by exactly its own radius reads as a
 * ball bearing.
 */
export function stepClods(
    clods: Clod[], dt: number, solidAt: (x: number, y: number, z: number) => boolean,
): Clod[] {
    for (const clod of clods) {
        clod.age += dt;
        if (clod.resting) continue;

        clod.velocity.y -= CLOD_GRAVITY * dt;
        const wasX = clod.at.x;
        const wasY = clod.at.y;
        const wasZ = clod.at.z;
        clod.at.x += clod.velocity.x * dt;
        clod.at.y += clod.velocity.y * dt;
        clod.at.z += clod.velocity.z * dt;

        if (!solidAt(clod.at.x, clod.at.y, clod.at.z)) continue;

        /*
         * It went into the ground this step. Put it back where it was and take
         * the speed out of it rather than solving a contact — there is no
         * solver here, and a clod has under a second in the air to be wrong in.
         */
        clod.at.x = wasX;
        clod.at.y = wasY;
        clod.at.z = wasZ;
        clod.velocity.y = -clod.velocity.y * BOUNCE;
        const drag = Math.exp(-GROUND_DRAG * dt);
        clod.velocity.x *= drag;
        clod.velocity.z *= drag;
        const speed = Math.hypot(clod.velocity.x, clod.velocity.y, clod.velocity.z);
        if (speed < SETTLED_SPEED) {
            clod.resting = true;
            clod.velocity.x = 0;
            clod.velocity.y = 0;
            clod.velocity.z = 0;
        }
    }
    return clods.filter(c => c.age < CLOD_LIFETIME_S);
}
