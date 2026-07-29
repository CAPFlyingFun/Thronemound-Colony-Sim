/**
 * The dig/carry/deposit loop, independent of rendering and input.
 *
 * The rule that makes this an ant game rather than Minecraft: soil is
 * conserved. You cannot place a voxel you did not first excavate, so the mound
 * above ground is exactly the volume of the tunnels below it.
 */

import { LAYER_CELLS, LAYER_COUNT } from './fracture';
import { PIECES_PER_VOXEL, SCOOP_PIECES } from './LooseSoil';
import { AIR, isSolid, materialOf, type VoxelId, type VoxelWorld } from './VoxelWorld';

/**
 * Digging gets easier with practice.
 *
 * Seconds per cube of topsoil, falling by DIG_STEP for every cube actually
 * removed, floored at DIG_FLOOR. Named constants rather than literals because
 * the first hatched worker will want her own curve — she should start clumsy
 * too, but probably not from as far back as a queen who has never dug at all.
 *
 * The endpoints are load-bearing, and the floor is now the interesting one. A
 * cube is four LAYERS, and 6.4 seconds is 1.6 a layer — the rate a practised
 * ant works at. An unpractised queen takes twice that, and 12.5 down to 6.4 in
 * steps of 0.34 is eighteen digs to master; founding the den costs fourteen to
 * nineteen, so she tops out almost exactly as she finishes.
 */
export const DIG_START = 12.5;
export const DIG_STEP = 0.34;
export const DIG_FLOOR = 6.4;

export interface DigSessionOptions {
  /** How many voxels of spoil the ant can carry at once. */
  /**
   * How many VOXELS' worth she can carry.
   *
   * Stated in voxels even though the load is counted in pieces, because a bare
   * `capacity: 8` silently meant eight pieces the moment the unit changed —
   * an eighth of a cube, when every caller meant eight cubes. One unit at the
   * boundary, one unit inside, and no way to confuse them.
   */
  capacityVoxels?: number;
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
  /**
   * PIECES, not voxels.
   *
   * A voxel now breaks into PIECES_PER_VOXEL of them and an ant gathers a
   * scoop at a time, so the piece is the only unit that divides evenly into
   * everything the game does with soil. Voxels are derived from it, never the
   * other way round — one number, so conservation cannot drift between two.
   */
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
  /** One sheet came away. She stops; the next needs another press. */
  | { kind: 'layer'; done: number; material: VoxelId }
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
  /** Pieces she can hold. Derived from capacityVoxels, never set directly. */
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

  /**
   * Sheets already taken off each cube, keyed by cell.
   *
   * A dig is ONE layer and then she stops, so this has to survive between
   * presses — and it has to be per CELL rather than a single "current cube",
   * or wandering off to dig somewhere else and coming back would restart a
   * half-dug cube from zero and spill its soil a second time. Entries are
   * dropped the moment the cube goes, so this only ever holds cubes that are
   * partly dug.
   */
  private readonly sheets = new Map<string, number>();

  constructor(world: VoxelWorld, options: DigSessionOptions = {}) {
    this.world = world;
    this.capacity = Math.max(1, options.capacityVoxels ?? 12) * PIECES_PER_VOXEL;
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

  /** Pieces held. */
  get carried(): number {
    return this.load.reduce((total, entry) => total + entry.count, 0);
  }

  /** Whole voxels' worth held — what `place()` can actually spend. */
  get carriedVoxels(): number {
    return Math.floor(this.carried / PIECES_PER_VOXEL);
  }

  /** Scoops held, rounded up: a part scoop is still something in the jaws. */
  get carriedScoops(): number {
    return Math.ceil(this.carried / SCOOP_PIECES);
  }

  get isFull(): boolean {
    return this.carried >= this.capacity;
  }

  private static cell(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }

  /** Sheets already off this cube. 0 for one nobody has touched. */
  sheetsDone(x: number, y: number, z: number): number {
    return this.sheets.get(DigSession.cell(x, y, z)) ?? 0;
  }

  /**
   * 0..1 against the whole CUBE, counting sheets already off.
   *
   * The chipping visual is built per cube, so it needs the cube's progress —
   * not the current sheet's — or every press would rewind the lattice to
   * whole and spill the same soil again.
   */
  get chewRatio(): number {
    const t = this.target;
    const done = t ? this.sheetsDone(t.x, t.y, t.z) : 0;
    return (done + this.progress) / LAYER_COUNT;
  }

  /** Sheets off the cube she is working, or the one she last worked. */
  get sheetsOnTarget(): number {
    const t = this.target;
    return t ? this.sheetsDone(t.x, t.y, t.z) : 0;
  }

  /**
   * Pieces excavated, counting part-dug cubes.
   *
   * `world.excavated` only counts WHOLE cubes, and a sheet coming away puts 16
   * real pieces in the world while its cube is still standing — so the world's
   * figure is short by exactly the sheets in flight. Conservation is checked
   * against this, not against the cube count.
   */
  get excavatedPieces(): number {
    let partial = 0;
    for (const done of this.sheets.values()) partial += done * LAYER_CELLS;
    return this.world.excavated * PIECES_PER_VOXEL + partial;
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

    /*
     * One SHEET per press, not one cube.
     *
     * secondsFor() is the whole cube, so a sheet is a quarter of it. She stops
     * when it comes away and the next needs another press — which is what
     * makes clearing the spoil part of digging rather than something you do
     * afterwards.
     */
    const material = this.world.get(x, y, z);
    const seconds = Math.max(0.01, this.secondsFor(material) / LAYER_COUNT);
    this.progress += deltaSeconds / seconds;
    if (this.progress < 1) return { kind: 'progress', ratio: this.progress };

    const key = DigSession.cell(x, y, z);
    const done = (this.sheets.get(key) ?? 0) + 1;
    if (done < LAYER_COUNT) {
      this.sheets.set(key, done);
      this.cancelDig();
      return { kind: 'layer', done, material };
    }

    const removed = this.world.dig(x, y, z);
    this.sheets.delete(key);
    this.cancelDig();
    if (removed === AIR) return { kind: 'none' };
    // Practice counts only completed cubes. Crediting it per sheet would make
    // tap-cancel-tap-cancel a way to reach top speed in seconds.
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
  release(pieces = 1): CarryLoad | null {
    const top = this.load[this.load.length - 1];
    if (!top) return null;
    const take = Math.min(pieces, top.count);
    if (take <= 0) return null;
    const unit: CarryLoad = { material: top.material, count: take, source: top.source };
    top.count -= take;
    if (top.count <= 0) this.load.pop();
    return unit;
  }

  /**
   * Pack a whole voxel of spoil into an empty cell. Newest material first.
   *
   * Needs a FULL voxel's worth of pieces of one material — four scoops. Letting
   * a part load place a cube would mint soil out of nothing, which is the one
   * thing conservation exists to prevent.
   */
  place(x: number, y: number, z: number): PlaceOutcome {
    const top = this.load[this.load.length - 1];
    if (!top) return { kind: 'empty' };
    if (top.count < PIECES_PER_VOXEL) return { kind: 'empty' };
    if (!this.world.deposit(x, y, z, top.material)) return { kind: 'none' };
    top.count -= PIECES_PER_VOXEL;
    if (top.count <= 0) this.load.pop();
    return { kind: 'placed', material: top.material };
  }

  private pickUp(material: VoxelId, source?: { x: number; y: number; z: number }): void {
    const top = this.load[this.load.length - 1];
    if (top && top.material === material) {
      top.count += PIECES_PER_VOXEL;
      return;
    }
    this.load.push({ material, count: PIECES_PER_VOXEL, source });
  }
}
