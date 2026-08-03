/**
 * The streamed fine soil under the hybrid world — `TerrainStream`, re-aimed.
 *
 * This is a deliberate adaptation of `src/density/TerrainStream.ts` rather
 * than a refactor of it: the lab's stream is load-bearing under a shipped
 * room and its constants are its own. The design is identical and the
 * comments there are the reference — one window-sized field that never
 * reallocates, a world that exists as a function, a sparse store of only the
 * samples the player changed, and recentring as memmove + strip regeneration
 * + edit replay. What differs here is the parameterisation (1 mm cells,
 * 32 mm slide tiles, a 192 mm window, 256 mm of depth, a 4 m world) and the
 * base function, which carries the NEST PLAN inside it — so tunnels stream
 * back in by re-evaluation, not by replay.
 *
 * Folding the two streams into one parametric class is the right refactor
 * AFTER this prototype earns its keep, and is noted in the plan doc.
 */

import { DensityField, type BrushResult, type Vec3Like } from '../density/DensityField';
import {
  CAP_PLANES, CELL_SIZE, CELLS_Y, MM, SAMPLES_Y, TILE_CELLS, WINDOW_CELLS,
  WINDOW_TILES, WORLD_TILES,
  baseDensityUnder, cappedDensityAt, heightMmAt,
} from './worldScape';

const TILE_SAMPLES = TILE_CELLS + 1;
const HEIGHTS = new Float64Array(WINDOW_CELLS + 1);

export interface ScrollReport {
  tilesX: number;
  tilesZ: number;
  copiedSamples: number;
  generatedSamples: number;
  ms: number;
  /** Samples that survived the slide unchanged, in new-local indices. */
  retained: { x0: number; x1: number; z0: number; z1: number };
}

export class WorldStream {
  readonly field = new DensityField({
    cellsX: WINDOW_CELLS, cellsY: CELLS_Y, cellsZ: WINDOW_CELLS, cellSize: CELL_SIZE,
  });

  private tileX = 0;

  private tileZ = 0;

  private readonly edits = new Map<number, Map<number, number>>();

  constructor(centreWorldX = 0, centreWorldZ = 0) {
    this.tileX = this.clampOrigin(this.tileOf(centreWorldX) - (WINDOW_TILES >> 1));
    this.tileZ = this.clampOrigin(this.tileOf(centreWorldZ) - (WINDOW_TILES >> 1));
    this.generate(0, WINDOW_CELLS + 1, 0, SAMPLES_Y, 0, WINDOW_CELLS + 1);
  }

  get originCellX(): number { return this.tileX * TILE_CELLS; }

  get originCellZ(): number { return this.tileZ * TILE_CELLS; }

  get originWorldX(): number { return this.originCellX * CELL_SIZE; }

  get originWorldZ(): number { return this.originCellZ * CELL_SIZE; }

  get editedSamples(): number {
    let total = 0;
    for (const tile of this.edits.values()) total += tile.size;
    return total;
  }

  private tileOf(worldCoord: number): number {
    const cell = Math.floor(worldCoord / CELL_SIZE);
    return Math.min(WORLD_TILES - 1, Math.max(0, Math.floor(cell / TILE_CELLS)));
  }

  private clampOrigin(tile: number): number {
    return Math.min(WORLD_TILES - WINDOW_TILES, Math.max(0, tile));
  }

  /**
   * Slide so `worldX, worldZ` sits in the middle tile. The CALLER decides
   * when to ask — leading the position by velocity is what turns this from
   * "load when the index changes" into directional prefetch, and the deadband
   * against ping-ponging lives with the caller too, because only it knows
   * the player's motion. Null when nothing moved.
   */
  recentreOn(worldX: number, worldZ: number): ScrollReport | null {
    const wantX = this.clampOrigin(this.tileOf(worldX) - (WINDOW_TILES >> 1));
    const wantZ = this.clampOrigin(this.tileOf(worldZ) - (WINDOW_TILES >> 1));
    if (wantX === this.tileX && wantZ === this.tileZ) return null;

    const started = performance.now();
    const tilesX = wantX - this.tileX;
    const tilesZ = wantZ - this.tileZ;
    const shiftX = tilesX * TILE_CELLS;
    const shiftZ = tilesZ * TILE_CELLS;
    this.tileX = wantX;
    this.tileZ = wantZ;

    const span = WINDOW_CELLS + 1;
    // Shrunk by the cap planes: the old rim's cut face is soil-shaped air and
    // must be regenerated, not retained. See TerrainStream for the war story.
    const keepX0 = Math.max(0, -shiftX) + CAP_PLANES;
    const keepX1 = Math.min(span, span - shiftX) - CAP_PLANES;
    const keepZ0 = Math.max(0, -shiftZ) + CAP_PLANES;
    const keepZ1 = Math.min(span, span - shiftZ) - CAP_PLANES;
    const overlaps = keepX1 > keepX0 && keepZ1 > keepZ0;

    let copied = 0;
    if (overlaps) copied = this.slide(shiftX, shiftZ, keepX0, keepX1, keepZ0, keepZ1);

    let generated = 0;
    if (!overlaps) {
      generated = this.generate(0, span, 0, SAMPLES_Y, 0, span);
    } else {
      generated += this.generate(0, keepX0, 0, SAMPLES_Y, 0, span);
      generated += this.generate(keepX1, span, 0, SAMPLES_Y, 0, span);
      generated += this.generate(keepX0, keepX1, 0, SAMPLES_Y, 0, keepZ0);
      generated += this.generate(keepX0, keepX1, 0, SAMPLES_Y, keepZ1, span);
    }

    return {
      tilesX,
      tilesZ,
      copiedSamples: copied,
      generatedSamples: generated,
      ms: performance.now() - started,
      retained: overlaps
        ? { x0: keepX0, x1: keepX1, z0: keepZ0, z1: keepZ1 }
        : { x0: 0, x1: 0, z0: 0, z1: 0 },
    };
  }

  /** The memmove. Order chosen so overlapping runs copy instead of smearing. */
  private slide(
    shiftX: number, shiftZ: number,
    x0: number, x1: number, z0: number, z1: number,
  ): number {
    const { values, samplesX, samplesY } = this.field;
    const offset = shiftX + samplesX * samplesY * shiftZ;
    if (offset === 0) return 0;
    const runLength = x1 - x0;
    const ascending = offset > 0;
    let copied = 0;
    for (let n = 0; n < z1 - z0; n += 1) {
      const z = ascending ? z0 + n : z1 - 1 - n;
      for (let m = 0; m < samplesY; m += 1) {
        const y = ascending ? m : samplesY - 1 - m;
        const destination = x0 + samplesX * (y + samplesY * z);
        const source = destination + offset;
        values.copyWithin(destination, source, source + runLength);
        copied += runLength;
      }
    }
    return copied;
  }

  /** Fill a local box from the world function, then replay stored digs. */
  private generate(
    x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
  ): number {
    if (x1 <= x0 || y1 <= y0 || z1 <= z0) return 0;
    const { values, samplesX, samplesY } = this.field;
    const baseX = this.originCellX;
    const baseZ = this.originCellZ;
    // One height per column, reused down it — the trigonometry is the only
    // expensive part of the world and it does not depend on y.
    for (let z = z0; z < z1; z += 1) {
      const wz = (baseZ + z) * CELL_SIZE;
      for (let x = x0; x < x1; x += 1) {
        HEIGHTS[x - x0] = heightMmAt((baseX + x) * CELL_SIZE * MM, wz * MM) / MM;
      }
      for (let y = y0; y < y1; y += 1) {
        const wy = y * CELL_SIZE;
        let index = x0 + samplesX * (y + samplesY * z);
        for (let x = x0; x < x1; x += 1, index += 1) {
          values[index] = cappedDensityAt(
            HEIGHTS[x - x0]!, (baseX + x) * CELL_SIZE, wy, wz, x, z,
          );
        }
      }
    }
    this.replayEdits(x0, x1, y0, y1, z0, z1);
    return (x1 - x0) * (y1 - y0) * (z1 - z0);
  }

  private replayEdits(
    x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
  ): void {
    const { values, samplesX, samplesY } = this.field;
    for (let tz = this.tileZ; tz <= this.tileZ + WINDOW_TILES; tz += 1) {
      if (tz >= WORLD_TILES) break;
      for (let tx = this.tileX; tx <= this.tileX + WINDOW_TILES; tx += 1) {
        if (tx >= WORLD_TILES) break;
        const tile = this.edits.get(tx + WORLD_TILES * tz);
        if (!tile) continue;
        for (const [local, value] of tile) {
          const lx = local % TILE_SAMPLES;
          const rest = (local - lx) / TILE_SAMPLES;
          const gy = rest % SAMPLES_Y;
          const lz = (rest - gy) / SAMPLES_Y;
          const x = tx * TILE_CELLS + lx - this.originCellX;
          const z = tz * TILE_CELLS + lz - this.originCellZ;
          if (x < x0 || x >= x1 || gy < y0 || gy >= y1 || z < z0 || z >= z1) continue;
          values[x + samplesX * (gy + samplesY * z)] = value;
        }
      }
    }
  }

  /** Carve at a WORLD position, and remember only what now differs. */
  subtractSphere(worldCenter: Vec3Like, radius: number): BrushResult {
    const result = this.field.subtractSphere(
      {
        x: worldCenter.x - this.originWorldX,
        y: worldCenter.y,
        z: worldCenter.z - this.originWorldZ,
      },
      radius,
    );
    if (result.changedSamples > 0) this.remember(result.bounds);
    return result;
  }

  /**
   * Record samples in the box that differ from the BASE world — which here
   * includes the nest plan, so digging that merely re-opens a planned tunnel
   * stores nothing. The rim planes are skipped: they hold the window's cut
   * face, and remembering them replays a wall of air into the map's middle.
   */
  private remember(bounds: BrushResult['bounds']): void {
    const rim = CAP_PLANES;
    const firstX = Math.max(rim, bounds.minX);
    const lastX = Math.min(WINDOW_CELLS - rim, bounds.maxX);
    for (let z = Math.max(rim, bounds.minZ); z <= Math.min(WINDOW_CELLS - rim, bounds.maxZ); z += 1) {
      const gz = this.originCellZ + z;
      const tz = Math.min(WORLD_TILES - 1, Math.floor(gz / TILE_CELLS));
      for (let x = firstX; x <= lastX; x += 1) {
        HEIGHTS[x - firstX] = heightMmAt(
          (this.originCellX + x) * CELL_SIZE * MM, gz * CELL_SIZE * MM,
        ) / MM;
      }
      for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
        for (let x = firstX; x <= lastX; x += 1) {
          const gx = this.originCellX + x;
          const value = this.field.get(x, y, z);
          const base = baseDensityUnder(
            HEIGHTS[x - firstX]!, gx * CELL_SIZE, y * CELL_SIZE, gz * CELL_SIZE,
          );
          const tx = Math.min(WORLD_TILES - 1, Math.floor(gx / TILE_CELLS));
          const key = tx + WORLD_TILES * tz;
          const local = (gx - tx * TILE_CELLS)
            + TILE_SAMPLES * (y + SAMPLES_Y * (gz - tz * TILE_CELLS));
          if (Math.abs(value - base) <= 1e-6) {
            this.edits.get(key)?.delete(local);
            continue;
          }
          let tile = this.edits.get(key);
          if (!tile) {
            tile = new Map<number, number>();
            this.edits.set(key, tile);
          }
          tile.set(local, value);
        }
      }
    }
  }

  /**
   * The soil's top at a horizontal WORLD position, read off the LIVE field —
   * so a dug-open entrance is a real drop underfoot, which the analytic
   * ground can never know about. Scans the column top-down and interpolates
   * the crossing; returns the analytic ground when the column is outside the
   * window (the walker should not be there, but the camera can be).
   */
  surfaceHeightAt(worldX: number, worldZ: number): number | null {
    const x = (worldX - this.originWorldX) / CELL_SIZE;
    const z = (worldZ - this.originWorldZ) / CELL_SIZE;
    const xi = Math.round(x);
    const zi = Math.round(z);
    if (xi < 0 || xi > WINDOW_CELLS || zi < 0 || zi > WINDOW_CELLS) return null;
    for (let y = SAMPLES_Y - 1; y > 0; y -= 1) {
      const above = this.field.get(xi, y, zi);
      const below = this.field.get(xi, y - 1, zi);
      if (below > 0 && above <= 0) {
        const t = below / (below - above);
        return (y - 1 + t) * CELL_SIZE;
      }
    }
    return null;
  }
}
