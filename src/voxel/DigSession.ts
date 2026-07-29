/**
 * The dig/carry/deposit loop, independent of rendering and input.
 *
 * The rule that makes this an ant game rather than Minecraft: soil is
 * conserved. You cannot place a voxel you did not first excavate, so the mound
 * above ground is exactly the volume of the tunnels below it.
 */

import { AIR, isSolid, materialOf, type VoxelId, type VoxelWorld } from './VoxelWorld';

/**
 * Digging gets easier with practice.
 *
 * Seconds per cube of topsoil, falling by DIG_STEP for every cube actually
 * removed, floored at DIG_FLOOR. Named constants rather than literals because
 * the first hatched worker will want her own curve — she should start clumsy
 * too, but probably not from as far back as a queen who has never dug at all.
 *
 * The endpoints are load-bearing: 5.0 to 1.5 in steps of 0.2 is eighteen digs
 * to mastery, and founding the den costs fourteen to nineteen. The queen tops
 * out almost exactly as she finishes, so the whole arc of getting good at it is
 * the tutorial.
 */
export const DIG_START = 5;
export const DIG_STEP = 0.2;
export const DIG_FLOOR = 1.5;

export interface DigSessionOptions {
  /** How many voxels of spoil the ant can carry at once. */
  capacity?: number;
  /** Seconds for the first cube of topsoil, before any practice. */
  digStart?: number;
  /** Seconds shaved off per completed dig. */
  digStep?: number;
  /** Fastest this ant will ever get. */
  digFloor?: number;
}

/** A cube being worked on, held across frames so the camera can look away. */
export interface DigTarget {
  x: number;
  y: number;
  z: number;
}

export interface CarryLoad {
  material: VoxelId;
  count: number;
  /**
   * The cell this soil came out of.
   *
   * Carried purely so the visual can stay the same lump from excavation through
   * to being put down — the clod's shape is a pure function of its origin, so
   * this is the whole identity. It has no effect on quantity: a load is still
   * `count` voxels of `material` and conservation never consults it.
   */
  source?: { x: number; y: number; z: number };
}

export type DigOutcome =
  | { kind: 'none' }
  | { kind: 'progress'; ratio: number }
  | { kind: 'dug'; material: VoxelId }
  | { kind: 'cancelled' }
  | { kind: 'full' }
  | { kind: 'bedrock' };

export type PlaceOutcome =
  | { kind: 'none' }
  | { kind: 'empty' }
  | { kind: 'placed'; material: VoxelId };

export class DigSession {
  readonly world: VoxelWorld;
  readonly capacity: number;
  readonly digStart: number;
  readonly digStep: number;
  readonly digFloor: number;

  /** Spoil held, newest last. Mixed materials stack separately. */
  readonly load: CarryLoad[] = [];

  /** Cubes actually removed. Drives the practice curve. */
  private digsCompleted = 0;
  private target: DigTarget | null = null;
  private progress = 0;

  constructor(world: VoxelWorld, options: DigSessionOptions = {}) {
    this.world = world;
    this.capacity = Math.max(1, options.capacity ?? 12);
    this.digStart = options.digStart ?? DIG_START;
    this.digStep = options.digStep ?? DIG_STEP;
    this.digFloor = options.digFloor ?? DIG_FLOOR;
  }

  get practiced(): number {
    return this.digsCompleted;
  }

  /** Seconds the next cube of topsoil will take at the current skill. */
  get secondsPerCube(): number {
    return Math.max(this.digFloor, this.digStart - this.digStep * this.digsCompleted);
  }

  /** Seconds a specific material would take right now. */
  secondsFor(id: VoxelId): number {
    return this.secondsPerCube * materialOf(id).hardness;
  }

  /** The cube currently being worked, if any. */
  get digging(): DigTarget | null {
    return this.target;
  }

  isDigging(x: number, y: number, z: number): boolean {
    const t = this.target;
    return t !== null && t.x === x && t.y === y && t.z === z;
  }

  get carried(): number {
    return this.load.reduce((total, entry) => total + entry.count, 0);
  }

  get isFull(): boolean {
    return this.carried >= this.capacity;
  }

  /** 0..1 progress against the voxel currently being chewed on. */
  get chewRatio(): number {
    return this.progress;
  }

  cancelDig(): void {
    this.target = null;
    this.progress = 0;
  }

  /**
   * Start working a cube, or cancel it if it is already the one being worked.
   *
   * This is the whole input model: one tap starts, one tap stops. Because the
   * target is *locked* here rather than re-read from a ray every frame, the
   * camera is free to look elsewhere while she digs — which also removes the
   * old failure where a few pixels of thumb drift silently reset the progress
   * bar to zero.
   */
  toggleDig(x: number, y: number, z: number): DigOutcome {
    if (this.isDigging(x, y, z)) {
      this.cancelDig();
      return { kind: 'cancelled' };
    }
    return this.beginDig(x, y, z);
  }

  /** Lock a cube and start the timer. Refuses anything that can't be dug. */
  beginDig(x: number, y: number, z: number): DigOutcome {
    const refusal = this.refuse(x, y, z);
    if (refusal) {
      this.cancelDig();
      return refusal;
    }
    this.target = { x, y, z };
    this.progress = 0;
    return { kind: 'progress', ratio: 0 };
  }

  /**
   * Advance the locked dig. Call every frame; it does nothing when idle.
   *
   * The refusal check runs every tick rather than only at the start, because
   * five seconds is long enough for the world to change underneath her — the
   * cube can stop being solid, or a load can fill. Reach is checked by the
   * caller, since how far an ant can lean is a scene concern.
   */
  tickDig(deltaSeconds: number): DigOutcome {
    const target = this.target;
    if (!target) return { kind: 'none' };

    const { x, y, z } = target;
    const refusal = this.refuse(x, y, z);
    if (refusal) {
      this.cancelDig();
      return refusal;
    }

    const seconds = Math.max(0.01, this.secondsFor(this.world.get(x, y, z)));
    this.progress += deltaSeconds / seconds;
    if (this.progress < 1) return { kind: 'progress', ratio: this.progress };

    const removed = this.world.dig(x, y, z);
    this.cancelDig();
    if (removed === AIR) return { kind: 'none' };
    // Practice counts only completed cubes. Crediting it on beginDig instead
    // would make tap-cancel-tap-cancel a way to reach top speed in seconds.
    this.digsCompleted++;
    this.pickUp(removed, { x, y, z });
    return { kind: 'dug', material: removed };
  }

  /** Why this cube can't be dug right now, or null if it can. */
  private refuse(x: number, y: number, z: number): DigOutcome | null {
    const voxel = this.world.get(x, y, z);
    if (!isSolid(voxel)) return { kind: 'none' };
    if (!materialOf(voxel).diggable) return { kind: 'bedrock' };
    if (this.isFull) return { kind: 'full' };
    return null;
  }

  /** The load the ant is about to put down, for the visual to follow. */
  get topLoad(): CarryLoad | null {
    return this.load[this.load.length - 1] ?? null;
  }

  /**
   * Hand one unit of soil out of the load WITHOUT putting it in the world.
   *
   * This is how dropping works now: the scene turns the returned unit into a
   * loose clod, which is a real object that can be shoved, knocked into a
   * tunnel and picked up again — none of which a deposited voxel could ever be.
   * Conservation is unchanged and still exact, because the unit is simply in a
   * third place: `excavated === carried + loose + deposited`.
   *
   * `place()` is kept for the terrain path (and the day a deliberate "pack the
   * soil down" action arrives), but the player's DROP no longer uses it.
   */
  release(): CarryLoad | null {
    const top = this.load[this.load.length - 1];
    if (!top) return null;
    const unit: CarryLoad = { material: top.material, count: 1, source: top.source };
    top.count--;
    if (top.count <= 0) this.load.pop();
    return unit;
  }

  /** Drop one voxel of spoil into an empty cell. Newest material goes first. */
  place(x: number, y: number, z: number): PlaceOutcome {
    const top = this.load[this.load.length - 1];
    if (!top) return { kind: 'empty' };
    if (!this.world.deposit(x, y, z, top.material)) return { kind: 'none' };
    top.count--;
    if (top.count <= 0) this.load.pop();
    return { kind: 'placed', material: top.material };
  }

  private pickUp(material: VoxelId, source?: { x: number; y: number; z: number }): void {
    const top = this.load[this.load.length - 1];
    if (top && top.material === material) {
      top.count++;
      return;
    }
    this.load.push({ material, count: 1, source });
  }
}
