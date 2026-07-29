/**
 * Spoil that is lying around.
 *
 * Dropped soil used to go straight back into the voxel grid, which made the
 * mound walkable terrain but meant a heap of dirt could never be shoved,
 * carried again, or knocked into a tunnel. Loose clods are the opposite trade:
 * they are real objects with positions, so they can be pushed out of the way,
 * picked back up, and — the reason this exists — swept into the nest by
 * something else and have to be cleared out again.
 *
 * Soil is still conserved. Every clod here is exactly one voxel that came out
 * of the world, so `excavated === carried + loose + deposited` holds at every
 * instant; this is simply a third place a unit of soil can be.
 *
 * No three.js. Collision samples the voxel grid through the same tiny `Sampler`
 * interface the mesher uses, so the whole thing is testable headlessly.
 */

import { isSolid, type VoxelId } from './VoxelWorld';

/**
 * How big a clod is for collision. Smaller than the voxel it came from, so a
 * one-cube tunnel does not jam solid the moment a single clod rolls into it —
 * an ant can still squeeze past one, which is what makes a blocked tunnel a
 * nuisance to clear rather than a dead end.
 */
export const CLOD_RADIUS = 0.3;

/** Hard ceiling. Well past a founding nest's worth of spoil. */
export const MAX_LOOSE_CLODS = 256;

/** Below this speed for REST_TIME seconds, a clod stops being simulated. */
const SLEEP_SPEED = 0.35;
const REST_TIME = 0.4;

/** Bounce and ground friction. Dirt does neither much of either. */
const RESTITUTION = 0.08;
const FRICTION = 6;
const DRAG = 0.6;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Clod {
  /** Position of the clod's centre, in voxel units. */
  position: Vec3;
  velocity: Vec3;
  material: VoxelId;
  /** The cell this soil was dug from — its shape identity, never its quantity. */
  source: Vec3;
  /** Asleep clods cost nothing per frame until something disturbs them. */
  asleep: boolean;
  restFor: number;
}

interface Sampler {
  get(x: number, y: number, z: number): VoxelId;
}

function solidAt(world: Sampler, x: number, y: number, z: number): boolean {
  return isSolid(world.get(Math.floor(x), Math.floor(y), Math.floor(z)));
}

export class LooseSoil {
  readonly clods: Clod[] = [];

  get count(): number {
    return this.clods.length;
  }

  /** Clods currently being simulated. Everything else is resting and free. */
  get awake(): number {
    return this.clods.reduce((n, c) => n + (c.asleep ? 0 : 1), 0);
  }

  /**
   * Put a unit of soil down at a position. Returns null if the heap is full,
   * so the caller can refuse the drop rather than silently destroying soil.
   */
  drop(at: Vec3, material: VoxelId, source: Vec3, velocity: Vec3 = { x: 0, y: 0, z: 0 }): Clod | null {
    if (this.clods.length >= MAX_LOOSE_CLODS) return null;
    const clod: Clod = {
      position: { ...at },
      velocity: { ...velocity },
      material,
      source: { ...source },
      asleep: false,
      restFor: 0,
    };
    this.clods.push(clod);
    return clod;
  }

  /** Take a specific clod back out of the world. */
  remove(clod: Clod): boolean {
    const index = this.clods.indexOf(clod);
    if (index < 0) return false;
    this.clods.splice(index, 1);
    return true;
  }

  /** The nearest clod within `range` of a point, or null. */
  nearest(point: Vec3, range: number): Clod | null {
    let best: Clod | null = null;
    let bestDistance = range * range;
    for (const clod of this.clods) {
      const dx = clod.position.x - point.x;
      const dy = clod.position.y - point.y;
      const dz = clod.position.z - point.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d <= bestDistance) {
        bestDistance = d;
        best = clod;
      }
    }
    return best;
  }

  /** Shove a clod, waking it. This is what walking into one does. */
  push(clod: Clod, impulse: Vec3): void {
    clod.velocity.x += impulse.x;
    clod.velocity.y += impulse.y;
    clod.velocity.z += impulse.z;
    clod.asleep = false;
    clod.restFor = 0;
  }

  /**
   * Advance every awake clod.
   *
   * Axis-separated collision against the voxel grid, the same approach the ant
   * uses — cheap, and it slides along walls instead of sticking to them.
   * Sleeping is what keeps a nest full of spoil affordable: a resting heap does
   * no work at all until something touches it.
   */
  step(world: Sampler, dt: number, gravity: number): void {
    for (const clod of this.clods) {
      if (clod.asleep) continue;

      clod.velocity.y -= gravity * dt;
      const damp = Math.max(0, 1 - DRAG * dt);
      clod.velocity.x *= damp;
      clod.velocity.z *= damp;

      let grounded = false;
      for (const axis of ['x', 'y', 'z'] as const) {
        const step = clod.velocity[axis] * dt;
        if (step === 0) continue;
        const next = { ...clod.position };
        next[axis] += step;
        // Sample the leading face of the clod rather than its centre, so it
        // stops on contact instead of sinking half a radius in.
        const lead = next[axis] + Math.sign(step) * CLOD_RADIUS;
        const probe = { ...next };
        probe[axis] = lead;
        if (solidAt(world, probe.x, probe.y, probe.z)) {
          if (axis === 'y' && step < 0) grounded = true;
          clod.velocity[axis] *= -RESTITUTION;
        } else {
          clod.position[axis] = next[axis];
        }
      }

      if (grounded) {
        // Ground friction, so a shoved clod slides to a halt rather than
        // gliding forever.
        const slow = Math.max(0, 1 - FRICTION * dt);
        clod.velocity.x *= slow;
        clod.velocity.z *= slow;
      }

      const speed = Math.hypot(clod.velocity.x, clod.velocity.y, clod.velocity.z);
      if (speed < SLEEP_SPEED && grounded) {
        clod.restFor += dt;
        if (clod.restFor >= REST_TIME) {
          clod.asleep = true;
          clod.velocity.x = 0;
          clod.velocity.y = 0;
          clod.velocity.z = 0;
        }
      } else {
        clod.restFor = 0;
      }
    }
  }

  /**
   * Shove clods out of a moving body's way and report how many were touched.
   *
   * This is the whole "push" interaction: the ant does not carry special code
   * for it, she simply displaces what she walks into. Returns the clods that
   * were pushed so the caller can react (sound, a little resistance).
   */
  displace(centre: Vec3, radius: number, motion: Vec3, strength: number): Clod[] {
    const touched: Clod[] = [];
    const reach = radius + CLOD_RADIUS;
    for (const clod of this.clods) {
      const dx = clod.position.x - centre.x;
      const dy = clod.position.y - centre.y;
      const dz = clod.position.z - centre.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance > reach || distance === 0) continue;

      // Push along the line of centres, biased by which way the body is
      // actually moving, so a clod slides aside rather than being flung back.
      const nx = dx / distance;
      const ny = dy / distance;
      const nz = dz / distance;
      const along = Math.max(0, motion.x * nx + motion.y * ny + motion.z * nz);
      this.push(clod, {
        x: (nx * 0.6 + motion.x * 0.4) * strength * (0.4 + along),
        y: 0.12 * strength,
        z: (nz * 0.6 + motion.z * 0.4) * strength * (0.4 + along),
      });
      touched.push(clod);
    }
    return touched;
  }

  /** Serialisable state. Shape is rebuilt from `source`, never stored. */
  toJSON(): { p: [number, number, number]; m: VoxelId; s: [number, number, number] }[] {
    return this.clods.map((c) => ({
      p: [c.position.x, c.position.y, c.position.z],
      m: c.material,
      s: [c.source.x, c.source.y, c.source.z],
    }));
  }

  static fromJSON(data: ReturnType<LooseSoil['toJSON']>): LooseSoil {
    const soil = new LooseSoil();
    for (const entry of data) {
      soil.clods.push({
        position: { x: entry.p[0], y: entry.p[1], z: entry.p[2] },
        velocity: { x: 0, y: 0, z: 0 },
        material: entry.m,
        source: { x: entry.s[0], y: entry.s[1], z: entry.s[2] },
        // Reloaded spoil is already where it settled, so it starts asleep.
        asleep: true,
        restFor: REST_TIME,
      });
    }
    return soil;
  }
}
