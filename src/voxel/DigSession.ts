/**
 * The dig/carry/deposit loop, independent of rendering and input.
 *
 * The rule that makes this an ant game rather than Minecraft: soil is
 * conserved. You cannot place a voxel you did not first excavate, so the mound
 * above ground is exactly the volume of the tunnels below it.
 */

import { AIR, isSolid, materialOf, type VoxelId, type VoxelWorld } from './VoxelWorld';

export interface DigSessionOptions {
  /** How many voxels of spoil the ant can carry at once. */
  capacity?: number;
  /** Multiplier on every material's dig time. */
  digSpeed?: number;
}

export interface CarryLoad {
  material: VoxelId;
  count: number;
}

export type DigOutcome =
  | { kind: 'none' }
  | { kind: 'progress'; ratio: number }
  | { kind: 'dug'; material: VoxelId }
  | { kind: 'full' }
  | { kind: 'bedrock' };

export type PlaceOutcome =
  | { kind: 'none' }
  | { kind: 'empty' }
  | { kind: 'placed'; material: VoxelId };

export class DigSession {
  readonly world: VoxelWorld;
  readonly capacity: number;
  readonly digSpeed: number;

  /** Spoil held, newest last. Mixed materials stack separately. */
  readonly load: CarryLoad[] = [];

  private targetKey = '';
  private progress = 0;

  constructor(world: VoxelWorld, options: DigSessionOptions = {}) {
    this.world = world;
    this.capacity = Math.max(1, options.capacity ?? 12);
    this.digSpeed = options.digSpeed ?? 1;
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
    this.targetKey = '';
    this.progress = 0;
  }

  /**
   * Hold-to-dig. Call every frame the player is digging a given voxel; the
   * voxel pops once enough seconds have accumulated against it. Switching
   * target resets progress, so you can't chip away at a whole wall at once.
   */
  digTick(x: number, y: number, z: number, deltaSeconds: number): DigOutcome {
    const voxel = this.world.get(x, y, z);
    if (!isSolid(voxel)) {
      this.cancelDig();
      return { kind: 'none' };
    }
    const material = materialOf(voxel);
    if (!material.diggable) {
      this.cancelDig();
      return { kind: 'bedrock' };
    }
    if (this.isFull) {
      this.cancelDig();
      return { kind: 'full' };
    }

    const key = `${x},${y},${z}`;
    if (key !== this.targetKey) {
      this.targetKey = key;
      this.progress = 0;
    }

    const seconds = Math.max(0.01, material.digSeconds / this.digSpeed);
    this.progress += deltaSeconds / seconds;
    if (this.progress < 1) return { kind: 'progress', ratio: this.progress };

    const removed = this.world.dig(x, y, z);
    this.cancelDig();
    if (removed === AIR) return { kind: 'none' };
    this.pickUp(removed);
    return { kind: 'dug', material: removed };
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

  private pickUp(material: VoxelId): void {
    const top = this.load[this.load.length - 1];
    if (top && top.material === material) {
      top.count++;
      return;
    }
    this.load.push({ material, count: 1 });
  }
}
