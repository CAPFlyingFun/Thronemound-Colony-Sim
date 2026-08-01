import { DensityField, type BrushResult, type Vec3Like } from './DensityField';
import { CELLS_Y, CELL_SIZE } from './labMound';
import {
  CAP_PLANES, TILE_CELLS, WINDOW_CELLS, WINDOW_TILES, WORLD_TILES,
  cappedDensity, densityUnder, streamHeightAt,
} from './labWorld';

/** Scratch for a row of column heights, sized to the widest a bite can be. */
const HEIGHTS = new Float64Array(WINDOW_CELLS + 1);

/** What a recentre cost, for the readout — and what it left alone. */
export interface ScrollReport {
  tilesX: number;
  tilesZ: number;
  copiedSamples: number;
  generatedSamples: number;
  ms: number;
  /**
   * Samples that came through the slide unchanged, in NEW-local indices,
   * upper bounds exclusive. Everything else was rewritten.
   *
   * The caller needs this because "which chunks are still in the window" and
   * "which chunks still hold the right soil" are DIFFERENT questions, and
   * answering only the first is a visible bug. The two planes at the old rim
   * held the window's cut face and now hold ordinary ground, so the chunk
   * around them is stale even though it never left the window. Rebuilding only
   * the chunks that ARRIVED left a wall of earth standing where the map used
   * to end, with sky torn across the hillside beside it — clean before the
   * first scroll, torn after, which is how it was caught.
   */
  retained: { x0: number; x1: number; z0: number; z1: number };
}

const SAMPLES_Y = CELLS_Y + 1;
/** Samples along one tile's edge, counting the shared plane it owns nothing of. */
const TILE_SAMPLES = TILE_CELLS + 1;

/**
 * A fixed window of soil that slides over an unbounded world.
 *
 * Three pieces, and the whole design is in how they divide the work:
 *
 *  - `field` is the only large allocation, and its size never changes. It
 *    holds WINDOW_TILES squared of tiles and nothing else ever exists as
 *    samples.
 *  - `streamDensityAt` describes soil nobody has touched. It is a function, so
 *    it costs nothing to have a world of any size made of it.
 *  - `edits` remembers only where the ant disagreed with that function. A
 *    tunnel is a few thousand samples; the untouched 99.9% of the map is not
 *    stored at all.
 *
 * Recentring is therefore not a load: it is a memmove of the part of the
 * window that stayed, a re-evaluation of the strip that arrived, and a replay
 * of that strip's edits over the top.
 *
 * ## Where a sample lives
 *
 * Every global sample belongs to exactly ONE tile, the one containing
 * `floor(index / TILE_CELLS)`, clamped at the world's far edge. Samples sit on
 * cell CORNERS, so the plane between two tiles is geometrically shared — but
 * ownership is not, or an edit would be stored twice and the two copies would
 * drift the moment one of them was reloaded and the other was not. Owning
 * tiles keep one spare plane of local room for the clamped case.
 */
export class TerrainStream {
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

  /** Global cell index of the window's low corner. */
  get originCellX(): number { return this.tileX * TILE_CELLS; }
  get originCellZ(): number { return this.tileZ * TILE_CELLS; }
  /** World-unit offset from field-local coordinates to world coordinates. */
  get originWorldX(): number { return this.originCellX * CELL_SIZE; }
  get originWorldZ(): number { return this.originCellZ * CELL_SIZE; }
  get originTileX(): number { return this.tileX; }
  get originTileZ(): number { return this.tileZ; }

  /** How many samples the ant has changed away from the formula, world-wide. */
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
   * Slide the window so the given world position sits in its middle tile.
   *
   * Clamped at the world's edges, which is the "unless at the edges" case:
   * near a corner the ant stops being centred rather than the window hanging
   * off into nothing. Returns null when nothing moved, so the caller can tell
   * a walk across a tile line from a walk within one.
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
    /*
     * The part of the OLD window that is still inside the new one, in new-local
     * sample coordinates: a sample at new-local x came from old-local x+shift.
     *
     * Shrunk by CAP_PLANES on every side, and those planes are not an
     * off-by-one guard — they are the old CUT FACE. The window caps itself at
     * its rim so it does not render an open edge (see `windowDensityAt`), and
     * after a slide the old rim is somewhere in the middle of the new window,
     * where a wall of air buried in solid soil is exactly wrong. Whichever way
     * the window moved, the surviving old rim sits against the boundary of the
     * retained box, so pulling that boundary in hands it to the generator.
     */
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
      // Everything outside the kept box: two X slabs full depth in Z, then the
      // two Z slabs of what is left between them.
      generated += this.generate(0, keepX0, 0, SAMPLES_Y, 0, span);
      generated += this.generate(keepX1, span, 0, SAMPLES_Y, 0, span);
      generated += this.generate(keepX0, keepX1, 0, SAMPLES_Y, 0, keepZ0);
      generated += this.generate(keepX0, keepX1, 0, SAMPLES_Y, keepZ1, span);
    }

    return {
      tilesX, tilesZ,
      copiedSamples: copied,
      generatedSamples: generated,
      ms: performance.now() - started,
      retained: overlaps
        ? { x0: keepX0, x1: keepX1, z0: keepZ0, z1: keepZ1 }
        : { x0: 0, x1: 0, z0: 0, z1: 0 },
    };
  }

  /**
   * Move the retained soil to its new place inside the same array.
   *
   * This is a memmove and it has a memmove's hazard: source and destination
   * overlap, so the order of the runs decides whether it copies or smears. The
   * offset between a destination index and its source is constant, so when the
   * source is AHEAD the safe order is ascending — every read happens at a
   * higher index than anything written so far — and behind, descending.
   * `copyWithin` handles the overlap inside a single run; the loop order
   * handles it between runs.
   */
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

  /**
   * Fill a box of the window from the formula, then lay the ant's edits back
   * over it. Local sample coordinates, upper bounds exclusive.
   *
   * Edits are replayed from the sparse store rather than probed per sample: a
   * `Map.get` for every one of a million-and-a-half incoming samples costs more
   * than generating them, and all but a handful would miss.
   */
  private generate(
    x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
  ): number {
    if (x1 <= x0 || y1 <= y0 || z1 <= z0) return 0;
    const { values, samplesX, samplesY } = this.field;
    const baseX = this.originCellX;
    const baseZ = this.originCellZ;

    /*
     * One row of ground heights per z, reused down the whole column.
     *
     * The height is the only expensive part of the world — four sine-cosine
     * pairs — and it does not depend on y, so computing it inside the y loop
     * did the same trigonometry 129 times over for every column. That was most
     * of what a recentre cost: 245 ms measured for one diagonal scroll, which
     * is a stall you feel through your thumb. The loop order stays z, y, x, so
     * the writes still run straight along the array.
     */
    const heights = new Float64Array(x1 - x0);

    for (let z = z0; z < z1; z += 1) {
      const wz = (baseZ + z) * CELL_SIZE;
      for (let x = x0; x < x1; x += 1) {
        heights[x - x0] = streamHeightAt((baseX + x) * CELL_SIZE, wz);
      }
      for (let y = y0; y < y1; y += 1) {
        const wy = y * CELL_SIZE;
        let index = x0 + samplesX * (y + samplesY * z);
        for (let x = x0; x < x1; x += 1, index += 1) {
          values[index] = cappedDensity(
            heights[x - x0]!, (baseX + x) * CELL_SIZE, wy, wz, x, z,
          );
        }
      }
    }

    this.replayEdits(x0, x1, y0, y1, z0, z1);
    return (x1 - x0) * (y1 - y0) * (z1 - z0);
  }

  /**
   * Write back stored edits that land inside a freshly generated box.
   *
   * The tile loop runs one PAST the window on each axis. The window's far
   * sample plane is owned by the tile beyond it — ownership is by
   * `floor(index / TILE_CELLS)` and that plane's index is exactly on the
   * boundary — so stopping at the window's own tiles would silently drop the
   * outermost plane of every dig made near the leading edge, and the surface
   * would heal itself there on the next scroll.
   */
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

  /**
   * Carve at a WORLD position, and remember it.
   *
   * Bounds come back in field-local sample indices because that is what the
   * mesher wants. The remembering is the part that makes the map real: without
   * it, walking three tiles away and back would find the tunnel filled in,
   * because the formula has never heard of it.
   */
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
   * Record every sample in the box that now differs from the formula.
   *
   * Sweeping the brush's own bounds rather than having `subtractSphere` report
   * a list: the box is about eight thousand samples for a mandible-sized bite,
   * which is nothing, and it keeps the field the single authority on what its
   * own values are. An edit is stored as the RESULT, not as a diff, so
   * replaying it is idempotent and order between overlapping bites cannot
   * matter.
   *
   * The comparison is against the UNCAPPED world, so the rim planes are
   * skipped: they hold the window's own cut face rather than soil, and
   * recording them as digs would replay a wall of air into the middle of the
   * map on the next scroll. Nothing real is lost, because the ant is kept in
   * the middle tile — the rim is at least sixteen millimetres from any bite,
   * and where the window is clamped against the WORLD's edge the two margins
   * are the same value anyway.
   */
  private remember(bounds: BrushResult['bounds']): void {
    const rim = CAP_PLANES;
    const lastX = Math.min(WINDOW_CELLS - rim, bounds.maxX);
    const firstX = Math.max(rim, bounds.minX);
    for (let z = Math.max(rim, bounds.minZ); z <= Math.min(WINDOW_CELLS - rim, bounds.maxZ); z += 1) {
      const gz = this.originCellZ + z;
      const tz = Math.min(WORLD_TILES - 1, Math.floor(gz / TILE_CELLS));
      /*
       * One ground height per column, reused down it — the same saving the
       * generator takes, for the same reason. A bite's box is about twenty
       * samples on a side, so asking for the height per SAMPLE did four
       * sine-cosine pairs nine thousand times where four hundred would do, and
       * that was most of the two and a half milliseconds a bite spent here.
       */
      for (let x = firstX; x <= lastX; x += 1) {
        HEIGHTS[x - firstX] = streamHeightAt((this.originCellX + x) * CELL_SIZE, gz * CELL_SIZE);
      }
      for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
        for (let x = firstX; x <= lastX; x += 1) {
          const gx = this.originCellX + x;
          const value = this.field.get(x, y, z);
          const base = densityUnder(
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

  /** Forget every dig in the world and rebuild the window from the formula. */
  reset(): void {
    this.edits.clear();
    this.generate(0, WINDOW_CELLS + 1, 0, SAMPLES_Y, 0, WINDOW_CELLS + 1);
  }

  /**
   * The whole world's digs as bytes, for the save file.
   *
   * The edit store is already exactly the thing a save needs — sparse,
   * world-anchored, and replayed onto the window by `generate` — so a save is
   * a serialization of it and nothing more. The format is binary because the
   * numbers are dense and JSON is not: a tile key fits sixteen bits
   * (WORLD_TILES squared is four hundred), the value is the field's own
   * float32, and the local index takes THIRTY-TWO, because a tile owns
   * 65 x 129 x 65 = 545,025 sample slots and that is sixty-five times what a
   * uint16 can say. The first cut wrote sixteen anyway, sized from a
   * seventeen-sample tile this world does not have, and nothing complained:
   * `setUint16` wraps modulo 65,536, so 63,145 of one test shaft's 68,045
   * entries folded onto other samples' indices and a `Map` quietly collapsed
   * the collisions on load. Measured as a fifth of the tunnel healing itself
   * after a resume, with every individual step of the pipeline count-exact.
   * The width is worth checking against the arithmetic, not the comment.
   *
   *   [uint32 tiles] then per tile:
   *   [uint16 key] [uint32 count] then count x ([uint32 local] [float32 value])
   *
   * Eight bytes a sample against some forty as JSON text.
   */
  serializeEdits(): Uint8Array {
    let bytes = 4;
    for (const tile of this.edits.values()) bytes += 6 + tile.size * 8;
    const out = new Uint8Array(bytes);
    const view = new DataView(out.buffer);
    let at = 0;
    view.setUint32(at, this.edits.size, true); at += 4;
    for (const [key, tile] of this.edits) {
      view.setUint16(at, key, true); at += 2;
      view.setUint32(at, tile.size, true); at += 4;
      for (const [local, value] of tile) {
        view.setUint32(at, local, true); at += 4;
        view.setFloat32(at, value, true); at += 4;
      }
    }
    return out;
  }

  /**
   * Replace every edit with a serialized set and regenerate the window, so
   * the soil on screen is the saved world. Throws on a malformed buffer
   * BEFORE touching the store — a half-restored world is worse than a
   * refused one.
   */
  restoreEdits(bytes: Uint8Array): void {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const parsed = new Map<number, Map<number, number>>();
    let at = 0;
    const tiles = view.getUint32(at, true); at += 4;
    for (let t = 0; t < tiles; t += 1) {
      const key = view.getUint16(at, true); at += 2;
      const count = view.getUint32(at, true); at += 4;
      const tile = new Map<number, number>();
      for (let i = 0; i < count; i += 1) {
        const local = view.getUint32(at, true); at += 4;
        const value = view.getFloat32(at, true); at += 4;
        tile.set(local, value);
      }
      parsed.set(key, tile);
    }
    if (at !== bytes.byteLength) throw new Error('trailing bytes in a terrain save');
    this.edits.clear();
    for (const [key, tile] of parsed) this.edits.set(key, tile);
    this.generate(0, WINDOW_CELLS + 1, 0, SAMPLES_Y, 0, WINDOW_CELLS + 1);
  }
}
