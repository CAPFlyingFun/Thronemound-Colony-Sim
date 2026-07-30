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
 * How big one PELLET is for collision.
 *
 * One cell is now one pellet, so this is a whole voxel's worth of soil rather
 * than a sixty-fourth: half the block across, which is what a mouthful of soil
 * looks like next to the hole it came out of. The old piece was a 1.25mm grain
 * — that is sand, and it is why the chipping read as dust rather than as soil
 * being moved.
 *
 * Note the consequence: at half a voxel across, a pellet dropped in a one-cell
 * bore leaves 0.5 clear and the ant is 0.6 across, so she cannot squeeze past
 * it. A blocked tunnel is now a real block rather than a nuisance, and clearing
 * spoil is not optional. The old 0.1 radius was deliberately under the true
 * eighth so she always could.
 */
export const CLOD_RADIUS = 0.25;

/**
 * One cell, one pellet.
 *
 * These were 64 and 16: a voxel broke into 64 pieces and an ant gathered a
 * scoop of 16. Both are 1 now, which is what makes the piece and the cell the
 * same object — there is no second unit for conservation to drift between.
 * They are kept as named constants rather than inlined because the carry
 * boundary still states capacity in voxels, and a bare 1 at a call site loses
 * which of the two it meant.
 */
export const PIECES_PER_VOXEL = 1;
export const SCOOP_PIECES = 1;

/**
 * Hard ceiling, in pellets.
 *
 * DOWN from 768, not up. A pellet is a whole cell now rather than a
 * sixty-fourth of one, so 256 of them is four times the SOIL the old cap held
 * while simulating a third as many objects. At 768 pieces the old cap could not
 * even hold the spoil from founding the den, which is why soil kept having to
 * be cleared mid-dig. Settled pellets sleep and cost a matrix each, so the
 * per-frame price is the handful still moving, not this number.
 */
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

/** How big one pellet is, so the caller can vary it per cell. */
export type ClodRadius = (clod: Clod) => number;

export class LooseSoil {
  readonly clods: Clod[] = [];

  /**
   * Injected rather than imported.
   *
   * Pellet size varies per source cell, and the function that says by how much
   * lives next to the fracture code that also uses it — which imports
   * CLOD_RADIUS from here, so reaching for it directly would be a cycle. A
   * caller that knows about both passes it in; anything that only cares about
   * the physics gets the nominal size and never has to know.
   */
  private readonly sizeOf: ClodRadius;

  constructor(sizeOf: ClodRadius = () => CLOD_RADIUS) {
    this.sizeOf = sizeOf;
  }

  /**
   * This pellet's own radius.
   *
   * Public because the ANT collides with pellets too, and her idea of how big
   * one is has to be the same as theirs. Resting height came from the nominal
   * radius while the pellet was DRAWN at its own, so a small one hovered a
   * twentieth of a voxel off the floor — which is the floating-clod fault
   * again, one rung down.
   */
  radius(clod: Clod): number {
    return this.sizeOf(clod);
  }

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

  /**
   * The clod the crosshair is actually pointing at.
   *
   * A plain radius around the eye is not enough: it picks up clods behind you,
   * below you, or off to one side, so CARRY kept claiming the action button
   * while you were trying to dig something else entirely. Requiring the clod to
   * sit near the aim ray makes "look at it to grab it" literal.
   *
   * `maxOffset` is how far the crosshair may miss the clod's centre and still
   * count — generous enough to be easy on a phone, tight enough that spoil to
   * one side is ignored. Nearest along the ray wins, so a clod in front of
   * another is the one you get.
   */
  alongRay(origin: Vec3, direction: Vec3, maxDistance: number, maxOffset: number): Clod | null {
    let best: Clod | null = null;
    let bestDistance = Infinity;
    for (const clod of this.clods) {
      const vx = clod.position.x - origin.x;
      const vy = clod.position.y - origin.y;
      const vz = clod.position.z - origin.z;
      const along = vx * direction.x + vy * direction.y + vz * direction.z;
      // Behind the eye, or past arm's length.
      if (along < 0 || along > maxDistance) continue;
      const ox = vx - direction.x * along;
      const oy = vy - direction.y * along;
      const oz = vz - direction.z * along;
      if (Math.hypot(ox, oy, oz) > maxOffset) continue;
      if (along < bestDistance) {
        bestDistance = along;
        best = clod;
      }
    }
    return best;
  }

  /**
   * The nearest `count` pieces to a point — one scoop.
   *
   * An ant does not pick grains up one at a time; it gathers a mandible-load.
   * Nearest-first rather than a radius, so a scoop is always a full scoop where
   * there is soil to fill it, and the pile is eaten from the near side instead
   * of hollowing wherever the radius happened to fall.
   */
  scoop(point: Vec3, count: number, range: number): Clod[] {
    const within: { clod: Clod; d: number }[] = [];
    const limit = range * range;
    for (const clod of this.clods) {
      const dx = clod.position.x - point.x;
      const dy = clod.position.y - point.y;
      const dz = clod.position.z - point.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d <= limit) within.push({ clod, d });
    }
    within.sort((a, b) => a.d - b.d);
    return within.slice(0, count).map((e) => e.clod);
  }

  /**
   * Wake everything near a point, because the world moved under it.
   *
   * A resting piece stops being simulated — that is what makes a nest full of
   * spoil affordable — but it also means it never notices the cube it was
   * lying on being dug out. Sixty-four pieces sat asleep in mid-air over the
   * hole they had just been shaken out of. Anything that MUTATES the grid has
   * to call this, or sleep silently turns into levitation.
   */
  wakeNear(point: Vec3, radius: number): number {
    let woken = 0;
    const limit = radius * radius;
    for (const clod of this.clods) {
      if (!clod.asleep) continue;
      const dx = clod.position.x - point.x;
      const dy = clod.position.y - point.y;
      const dz = clod.position.z - point.z;
      if (dx * dx + dy * dy + dz * dz > limit) continue;
      clod.asleep = false;
      clod.restFor = 0;
      woken++;
    }
    return woken;
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
        const lead = next[axis] + Math.sign(step) * this.sizeOf(clod);
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
    for (const clod of this.clods) {
      const reach = radius + this.sizeOf(clod);
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

  static fromJSON(data: ReturnType<LooseSoil['toJSON']>, sizeOf?: ClodRadius): LooseSoil {
    const soil = new LooseSoil(sizeOf);
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
