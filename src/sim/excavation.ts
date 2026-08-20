/**
 * THE DIG SYSTEM — the only thing in this game allowed to remove soil.
 *
 * The brief's ownership chain for founding puts four separate systems in a
 * row and this is the third of them:
 *
 *     ANT AI          decides she wants that cell gone   `founding`
 *     DIG SYSTEM      validates the request              THIS FILE
 *     VOXEL TERRAIN   modifies the soil                  `VoxelWorld.dig`
 *     MOVEMENT        moves her                          `AntBody`
 *     IK / ANIMATION  poses her                          `LegDrive`
 *
 * And the board's card is blunt about the line between the third and the
 * fourth: "Digging must NEVER directly drive ant locomotion." Nothing here
 * touches a position, a heading or a leg. It is handed a cell, it says yes or
 * no, it wears the cell down over time, and when the cell breaks it says so.
 * Where she walks afterwards is the walker's business.
 *
 * ## It is Ant Scout's digging, in three dimensions
 *
 * Asked for directly — "make it like a 3D version of Ant Scout with the round
 * loading/digging bar". That game's underground map is worth copying because
 * its dig loop is three honest pieces and no more (`js/maps/underground.js`):
 *
 *   - the target is the CELL AHEAD of the ant, chosen off her heading;
 *   - the cell has HIT POINTS, worn down per frame while she digs, and the
 *     round bar is simply `1 - hp`;
 *   - at zero the cell becomes air and bursts dirt.
 *
 * The 2D version drains a flat `DIG.rate` of 0.06 a frame at 60 Hz — 3.6 hp a
 * second, so a cell in 0.28 s. That is an arcade pace for a player holding a
 * button. This is a queen digging by herself while somebody watches, so the
 * rate is slower and, unlike Ant Scout, SCALED BY THE SOIL: the voxel world
 * already carries a `hardness` ratio per material and it would be strange to
 * import a dig system into a world that models clay and then ignore it.
 *
 * ## What is deliberately missing
 *
 * SPOIL. Real excavated soil has to go somewhere and a fire ant carries it up
 * the shaft in her mandibles; here the cell simply stops existing. Hauling is
 * card 05's job and it needs workers, which do not exist yet. Flagged rather
 * than hidden: the tunnel she digs is currently a tunnel with no tailings pile
 * at its mouth, and that is a thing to notice, not a thing to explain away.
 */

import { isSolid, materialOf, type VoxelId } from '../voxel/VoxelWorld';
import { FILL_EPSILON } from './dugSoil';

/** A cell, in voxel coordinates. */
export type Cell = readonly [number, number, number];

/**
 * What the dig system needs of a world: read it, bound it, and remove one
 * cell from it.
 *
 * Narrower than `VoxelWorld` on purpose — it is the whole interface, so a
 * test can hand this a nine-cell object and the excavator cannot tell.
 */
export interface Diggable {
  get(x: number, y: number, z: number): VoxelId;
  inBounds(x: number, y: number, z: number): boolean;
  /** Removes the cell and returns what was there, or AIR if it refused. */
  dig(x: number, y: number, z: number): VoxelId;
  /** How full the cell is now, 0..1. */
  fillOf(x: number, y: number, z: number): number;
  /** Leave the cell partly eaten. */
  setFill(x: number, y: number, z: number, fill: number): void;
  /** Forget a partial fill, when the cell goes entirely. */
  clearFill(x: number, y: number, z: number): void;
}

/**
 * How fast topsoil comes away, in hit points a second, where one cell is one
 * hit point.
 *
 * So about 0.7 s a cell in topsoil and 1.1 in clay, against Ant Scout's 0.28.
 *
 * GAME TUNING, and tuned against the thing being built rather than against
 * biology: a real founding queen takes hours over her shaft. What this number
 * has to be is watchable — slow enough that the round bar is a thing you see
 * fill, fast enough that a keeper watching the founding does not put the
 * phone down.
 *
 * MEASURED AGAINST THE WHOLE FOUNDING, not against one cell. The corridor is
 * three voxels wide and two tall, so a voxel of progress costs about six
 * cells, and the 30 mm descent is a couple of hundred of them. At the first
 * value of 0.62 the founding took over nine minutes and had not finished; at
 * 1.4 it is a little over three, which is a thing you can sit and watch.
 */
export const DIG_RATE = 1.4;

/** Why a request was turned down. `null` means it was not. */
export type Refusal =
  | 'out-of-bounds'
  | 'already-air'
  | 'too-hard'
  | 'unreachable';

/** What one `bite` did. */
export interface Bite {
  /** How far through the current cell she is, 0..1 — the round bar. */
  progress: number;
  /** The cell that broke this tick, if one did. */
  broke: Cell | null;
  /** What it was made of, for the dust that comes out of it. */
  removed: VoxelId;
  /** True when the soil's drawn shape changed and has to be re-meshed. */
  changed: boolean;
}

/**
 * How finely a part-dug cell's drawn height is stepped.
 *
 * The cell drains continuously, but re-meshing its chunk is not free and a
 * bite lasts a couple of seconds. Rounding the drawn fill to eighths gives
 * about eight rebuilds a cell instead of a hundred and twenty, and an eighth
 * of a voxel is 0.6 mm — under the width of the crumbs coming off it.
 */
export const FILL_STEPS = 8;

/**
 * ONE FACE AT A TIME.
 *
 * An excavator holds at most one target and wears it down. Aiming somewhere
 * else abandons the old cell's progress rather than banking it, which is both
 * simpler and truer: a half-dug hole you walked away from is a half-dug hole.
 */
export class Excavation {
  private cell: Cell | null = null;

  /** Hit points left in the current cell, 1 down to 0. */
  private hp = 1;

  /**
   * How full the cell should be LEFT, 0..1.
   *
   * Zero for a cell that is simply in the way. Fractional for a cell the
   * corridor's floor passes through: the ramp is a smooth line and the cells
   * it crosses have to end up part full or she is walking down a staircase
   * with 5 mm risers on 1 mm of leg. See `DugSoil`.
   */
  private leaveAt = 0;

  /** And how full it was when she started, so the bar spans the real work. */
  private from = 1;

  /** The drawn fill last written, so a chunk is only re-meshed on a change. */
  private drawn = 1;

  private refusal: Refusal | null = null;

  /** How many cells this excavator has taken out, ever. */
  excavated = 0;

  constructor(private readonly world: Diggable) {}

  /** The cell she is working on, or null. */
  get target(): Cell | null {
    return this.cell;
  }

  /** The round bar, 0..1. Zero when she is not digging anything. */
  get progress(): number {
    return this.cell ? 1 - this.hp : 0;
  }

  /** Why the last `aim` was turned down, or null if it was accepted. */
  get refused(): Refusal | null {
    return this.refusal;
  }

  /**
   * Point her at a cell. Returns whether the dig system will allow it.
   *
   * THE VALIDATION IS THE POINT OF THIS CLASS. The AI is allowed to want
   * anything; what it is not allowed to do is reach through the terrain and
   * delete it. Four rules, and each one is a thing an unchecked brain would
   * otherwise do:
   *
   *   - IN BOUNDS, or a confused heading digs through the edge of the array.
   *   - SOLID, so "dig" always means something was there.
   *   - DIGGABLE, which is the world's own flag: it covers stone, and it
   *     covers the tank's GLASS, whose id has no material at all and so reads
   *     as not-diggable. An ant chewing out through the wall of the
   *     formicarium is the failure that would matter most.
   *   - REACHABLE — touching air. She digs a FACE, and a face by definition
   *     has open space on one side of it. Without this an ant could hollow a
   *     bubble on the far side of the tray from herself.
   *
   * Re-aiming at the cell she is already on is a no-op, so a brain may call
   * this every frame with the same answer and keep its progress.
   */
  aim(cell: Cell, target = 0): boolean {
    if (this.cell
      && this.cell[0] === cell[0] && this.cell[1] === cell[1]
      && this.cell[2] === cell[2]) {
      return true;
    }
    const [x, y, z] = cell;
    this.refusal = this.check(x, y, z);
    if (this.refusal) { this.cell = null; return false; }
    this.cell = [x, y, z];
    this.leaveAt = Math.max(0, Math.min(1, target));
    this.from = this.world.fillOf(x, y, z);
    this.hp = 1;
    return true;
  }

  private check(x: number, y: number, z: number): Refusal | null {
    if (!this.world.inBounds(x, y, z)) return 'out-of-bounds';
    const id = this.world.get(x, y, z);
    if (!isSolid(id)) return 'already-air';
    if (this.world.fillOf(x, y, z) <= FILL_EPSILON) return 'already-air';
    if (!materialOf(id).diggable) return 'too-hard';
    if (!this.openFace(x, y, z)) return 'unreachable';
    return null;
  }

  /**
   * Does this cell touch open space on any of its six sides?
   *
   * ASKED OF THE FILL, NOT OF THE ID, and the difference is not academic. A
   * voxel can be solid and EMPTY at the same time: the terrain marks the top
   * cell of a column solid and then gives it a fractional fill for the height
   * field, and where the ground lands near a cell line that fraction is
   * nearly nought. There is no soil in such a cell — the ant walks under its
   * ceiling, and `surfaceAt` already returns `y + fill` and so agrees.
   *
   * Judged by the id, the first cell of every ramp had a "solid" empty cell
   * over it and was refused as unreachable, so the queen stood at her chosen
   * site for a minute digging nothing at all. Measured: 0 cells.
   *
   * "Open" therefore means NOT FULL rather than empty — see the note on the
   * neighbour test below.
   */
  private openFace(x: number, y: number, z: number): boolean {
    for (const [dx, dy, dz] of FACES) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      /*
       * OUTSIDE THE WORLD IS NOT AN OPEN FACE. It reads like one — nothing is
       * there — but a cell whose only opening is the edge of the array is a
       * cell she cannot get to, and treating the void as reachable would let
       * an ant standing anywhere dig the far wall.
       */
      if (!this.world.inBounds(nx, ny, nz)) continue;
      if (!isSolid(this.world.get(nx, ny, nz))) return true;
      /*
       * ANY GAP AT ALL, not only an empty neighbour. A cell beside one that
       * has been cut down to a third has a third of a cell of open space
       * against its face, and an ant can get her mandibles into that. Read
       * as "must be entirely empty", the rule refused every cell of a tunnel
       * whose floor and walls were all part-dug — measured, the queen graded
       * a ramp 55 cells long and never once removed a cell to make headroom.
       */
      if (this.world.fillOf(nx, ny, nz) < 1 - FILL_EPSILON) return true;
    }
    return false;
  }

  /** Stop working the current cell and drop its progress. */
  cancel(): void {
    this.cell = null;
    this.hp = 1;
    this.leaveAt = 0;
    this.from = 1;
    this.drawn = 1;
  }

  /**
   * A moment of chewing. Returns the round bar's new value, and the cell if
   * this was the bite that took it out.
   *
   * RE-CHECKED EVERY TICK, not only at `aim`. The world moves underneath an
   * excavator — another ant may take the same cell, and later a collapse may
   * fill it — so a target that stopped being valid is dropped here rather
   * than quietly finished.
   */
  bite(dt: number): Bite {
    if (!this.cell) return IDLE;
    const [x, y, z] = this.cell;
    const id = this.world.get(x, y, z);
    if (!isSolid(id) || !materialOf(id).diggable) {
      this.cancel();
      return IDLE;
    }
    /*
     * Hardness is a RATIO — how much longer than topsoil — so it divides the
     * rate rather than multiplying it. Clay at 1.5 takes half again as long,
     * which is what the material's own comment says it means.
     *
     * AND SCALED BY HOW MUCH OF THE CELL IS ACTUALLY BEING TAKEN. Shaving a
     * cell from full to three quarters is a quarter of a cell's work; charging
     * it a whole cell would make a graded ramp cost as much as a hollow one.
     */
    const span = Math.max(0.02, this.from - this.leaveAt);
    this.hp -= (DIG_RATE * dt) / (Math.max(0.01, materialOf(id).hardness) * span);
    if (this.hp > 0) {
      const now = this.from - (this.from - this.leaveAt) * (1 - this.hp);
      /* Quantised, so the chunk is rebuilt eight times a cell and not every
       * frame. See `FILL_STEPS`. */
      const stepped = Math.round(now * FILL_STEPS) / FILL_STEPS;
      let changed = false;
      if (stepped !== this.drawn) {
        this.world.setFill(x, y, z, stepped);
        this.drawn = stepped;
        changed = true;
      }
      return { progress: 1 - this.hp, broke: null, removed: 0, changed };
    }

    /*
     * DONE. A cell worked down to a fractional target STAYS — it is the ramp
     * she walks on. Only a cell taken to nothing is actually removed, and
     * only that counts as excavated.
     */
    if (this.leaveAt > FILL_EPSILON) {
      this.world.setFill(x, y, z, this.leaveAt);
      this.cancel();
      return { progress: 0, broke: null, removed: 0, changed: true };
    }
    const removed = this.world.dig(x, y, z);
    this.world.clearFill(x, y, z);
    this.cancel();
    if (!isSolid(removed)) return { ...IDLE, changed: true };
    this.excavated += 1;
    return { progress: 0, broke: [x, y, z], removed, changed: true };
  }
}

const IDLE: Bite = { progress: 0, broke: null, removed: 0, changed: false };

/** The six neighbours that share a face. Corners are not reachable. */
const FACES: readonly Cell[] = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];
