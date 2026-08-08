/**
 * The streamed fine soil under the ISLAND — `WorldStream`, re-aimed again,
 * with the one genuinely new mechanism this terrain forces: a FLOATING
 * DEPTH BAND. The streamed world's soil column was a fixed 0–256 mm and the
 * whole landscape lived inside it; Kauai's surface climbs to ~1,600 mm, so
 * the window's 256 mm of samples must ride UNDER the local surface — the
 * band's floor re-anchors (in 32 mm steps, with hysteresis) as the window's
 * lowest surface moves. A re-anchor is a full regenerate: it happens only
 * when the terrain under the window has genuinely changed height class, and
 * the scene's clip-never-outruns-the-meshes rule already covers the rebuild
 * window (the island sheet stays drawn until every chunk is back).
 *
 * Everything else is the proven design, comments in TerrainStream and
 * WorldStream: one window-sized field, memmove slide, sparse edits replayed
 * on regeneration, nest reconstruction by re-evaluating the pure soil
 * function. Edits are keyed by ABSOLUTE sample position (including absolute
 * Y in mm), so they survive both horizontal scrolls and band re-anchors.
 */

import { DensityField, type BrushResult, type Vec3Like } from '../density/DensityField';
import {
  CAP_PLANES, CELLS_Y, CELL_SIZE, MM, SAMPLES_Y, TILE_CELLS, TILE_MM,
  WINDOW_CELLS, WINDOW_TILES,
} from './worldScape';
import type { IslandSoil } from './islandSoil';

const ISLAND_MM = 56000;
const ISLAND_TILES = ISLAND_MM / TILE_MM;
const TILE_SAMPLES = TILE_CELLS + 1;
const HEIGHTS = new Float64Array(WINDOW_CELLS + 1);

/** Edit key packing: absolute Y (mm, < 4096) in the low bits. */
const Y_SPAN = 4096;

/** How far below the window's lowest surface the band floor sits. */
const FLOOR_BELOW_MM = 176;

/** Re-anchor only when the floor would drift this far from ideal. */
const REBASE_SLACK_MM = 56;

export interface IslandScrollReport {
  tilesX: number;
  tilesZ: number;
  rebased: boolean;
  generatedSamples: number;
  ms: number;
  /** Samples that survived the slide unchanged, in new-local indices. */
  retained: { x0: number; x1: number; z0: number; z1: number };
}

export class IslandStream {
  readonly field = new DensityField({
    cellsX: WINDOW_CELLS, cellsY: CELLS_Y, cellsZ: WINDOW_CELLS, cellSize: CELL_SIZE,
  });

  private tileX = 0;

  private tileZ = 0;

  private yBaseMm = 0;

  private readonly edits = new Map<number, Map<number, number>>();

  constructor(
    private readonly soil: IslandSoil,
    /** The undisturbed column top in mm — the DRAWN island surface. */
    private readonly surfaceMmAt: (xMm: number, zMm: number) => number,
    centreWorldX: number,
    centreWorldZ: number,
  ) {
    this.tileX = this.clampOrigin(this.tileOf(centreWorldX) - (WINDOW_TILES >> 1));
    this.tileZ = this.clampOrigin(this.tileOf(centreWorldZ) - (WINDOW_TILES >> 1));
    this.yBaseMm = this.idealFloor();
    this.generate(0, WINDOW_CELLS + 1, 0, SAMPLES_Y, 0, WINDOW_CELLS + 1);
  }

  get originCellX(): number { return this.tileX * TILE_CELLS; }

  get originCellZ(): number { return this.tileZ * TILE_CELLS; }

  get originWorldX(): number { return this.originCellX * CELL_SIZE; }

  get originWorldZ(): number { return this.originCellZ * CELL_SIZE; }

  get bandFloorMm(): number { return this.yBaseMm; }

  get bandFloorWu(): number { return this.yBaseMm / MM; }

  get editedSamples(): number {
    let total = 0;
    for (const tile of this.edits.values()) total += tile.size;
    return total;
  }

  private tileOf(worldCoord: number): number {
    const cell = Math.floor(worldCoord / CELL_SIZE);
    return Math.min(ISLAND_TILES - 1, Math.max(0, Math.floor(cell / TILE_CELLS)));
  }

  private clampOrigin(tile: number): number {
    return Math.min(ISLAND_TILES - WINDOW_TILES, Math.max(0, tile));
  }

  /**
   * The band anchors to the surface at the WINDOW'S CENTRE — where the ant
   * (and whatever she is digging) actually is. The first cut anchored to
   * the window's lowest corner, which read as obviously safe and failed on
   * the very first real hill: Waiʻaleʻale has 230 m of relief inside one
   * 192 m window, so "floor below the minimum" pushed the band's ceiling
   * 130 mm under the summit and the whole nest fell above the soil. Centre
   * anchoring keeps the band wrapped around the ground underfoot; window
   * EDGES on steep country may still overrun the ceiling, and cap there —
   * the walker's footing already treats a capped column as "stand on the
   * drawn island instead".
   */
  private idealFloor(): number {
    const cx = (this.tileX + WINDOW_TILES / 2) * TILE_MM;
    const cz = (this.tileZ + WINDOW_TILES / 2) * TILE_MM;
    const want = Math.floor(
      (this.surfaceMmAt(cx, cz) - FLOOR_BELOW_MM) / TILE_MM,
    ) * TILE_MM;
    return Math.max(0, want);
  }

  /**
   * Slide (and possibly re-anchor the depth band) so `worldX, worldZ` sits
   * in the middle tile. Null when nothing needs doing. A re-anchor throws
   * the whole window away — the band's absolute Y changed, so every local
   * sample means a different place now — and the report says so with an
   * empty retained box, which the scene already treats as "cover with the
   * island sheet until every chunk is rebuilt".
   */
  recentreOn(worldX: number, worldZ: number): IslandScrollReport | null {
    const wantX = this.clampOrigin(this.tileOf(worldX) - (WINDOW_TILES >> 1));
    const wantZ = this.clampOrigin(this.tileOf(worldZ) - (WINDOW_TILES >> 1));
    const moved = wantX !== this.tileX || wantZ !== this.tileZ;
    const tilesX = wantX - this.tileX;
    const tilesZ = wantZ - this.tileZ;
    this.tileX = wantX;
    this.tileZ = wantZ;
    const ideal = this.idealFloor();
    const rebase = Math.abs(ideal - this.yBaseMm) > REBASE_SLACK_MM;
    if (!moved && !rebase) return null;

    const started = performance.now();
    const span = WINDOW_CELLS + 1;

    if (rebase) {
      /* The band's absolute Y changed: every local sample means a different
       * place now, so nothing can be retained. Rare by construction — the
       * hysteresis means the terrain under the window changed height class. */
      this.yBaseMm = ideal;
      const generated = this.generate(0, span, 0, SAMPLES_Y, 0, span);
      return {
        tilesX,
        tilesZ,
        rebased: true,
        generatedSamples: generated,
        ms: performance.now() - started,
        retained: { x0: 0, x1: 0, z0: 0, z1: 0 },
      };
    }

    // The proven memmove slide, WorldStream's exact shape: retain the soil
    // that survives (shrunk by the rim cap planes, whose cut faces are
    // soil-shaped air that must be regenerated), regenerate the strips.
    const keepX0 = Math.max(0, -tilesX * TILE_CELLS) + CAP_PLANES;
    const keepX1 = Math.min(span, span - tilesX * TILE_CELLS) - CAP_PLANES;
    const keepZ0 = Math.max(0, -tilesZ * TILE_CELLS) + CAP_PLANES;
    const keepZ1 = Math.min(span, span - tilesZ * TILE_CELLS) - CAP_PLANES;
    const overlaps = keepX1 > keepX0 && keepZ1 > keepZ0;

    if (overlaps) {
      this.slide(tilesX * TILE_CELLS, tilesZ * TILE_CELLS, keepX0, keepX1, keepZ0, keepZ1);
    }
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
      rebased: false,
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
  ): void {
    const { values, samplesX, samplesY } = this.field;
    const offset = shiftX + samplesX * samplesY * shiftZ;
    if (offset === 0) return;
    const runLength = x1 - x0;
    const ascending = offset > 0;
    for (let n = 0; n < z1 - z0; n += 1) {
      const z = ascending ? z0 + n : z1 - 1 - n;
      for (let m = 0; m < samplesY; m += 1) {
        const y = ascending ? m : samplesY - 1 - m;
        const destination = x0 + samplesX * (y + samplesY * z);
        const source = destination + offset;
        values.copyWithin(destination, source, source + runLength);
      }
    }
  }

  /** Fill a local box from the soil function, then replay stored digs. */
  private generate(
    x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
  ): number {
    if (x1 <= x0 || y1 <= y0 || z1 <= z0) return 0;
    const { values, samplesX, samplesY } = this.field;
    const baseX = this.originCellX;
    const baseZ = this.originCellZ;
    const floorWu = this.yBaseMm / MM;
    for (let z = z0; z < z1; z += 1) {
      const wz = (baseZ + z) * CELL_SIZE;
      for (let x = x0; x < x1; x += 1) {
        HEIGHTS[x - x0] = this.surfaceMmAt((baseX + x) * CELL_SIZE * MM, wz * MM) / MM;
      }
      for (let y = y0; y < y1; y += 1) {
        const wy = floorWu + y * CELL_SIZE;
        let index = x0 + samplesX * (y + samplesY * z);
        for (let x = x0; x < x1; x += 1, index += 1) {
          let soil = this.soil.densityUnder(
            HEIGHTS[x - x0]!, floorWu, (baseX + x) * CELL_SIZE, wy, wz,
          );
          // The window's own rim: two sharp cap planes on every side face
          // and the band ceiling, so loaded soil ends in an honest cut.
          const edge = Math.min(
            x, WINDOW_CELLS - x, z, WINDOW_CELLS - z, (SAMPLES_Y - 1) - y,
          );
          if (edge < CAP_PLANES) soil = Math.min(soil, (edge - 1.5) * CELL_SIZE);
          values[index] = soil;
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
      if (tz >= ISLAND_TILES) break;
      for (let tx = this.tileX; tx <= this.tileX + WINDOW_TILES; tx += 1) {
        if (tx >= ISLAND_TILES) break;
        const tile = this.edits.get(tx + ISLAND_TILES * tz);
        if (!tile) continue;
        for (const [local, value] of tile) {
          const yAbs = local % Y_SPAN;
          const rest = (local - yAbs) / Y_SPAN;
          const lx = rest % TILE_SAMPLES;
          const lz = (rest - lx) / TILE_SAMPLES;
          const x = tx * TILE_CELLS + lx - this.originCellX;
          const z = tz * TILE_CELLS + lz - this.originCellZ;
          const y = yAbs - this.yBaseMm;
          if (x < x0 || x >= x1 || y < y0 || y >= y1 || z < z0 || z >= z1) continue;
          values[x + samplesX * (y + samplesY * z)] = value;
        }
      }
    }
  }

  /**
   * Re-run the soil function over a WORLD-unit box — the designer's DIG IT
   * after the plan changed. `generate` already replays stored digs on top.
   * Returns the LOCAL sample bounds touched (for remeshing), or null when
   * the box misses the window entirely.
   */
  regenerateBox(min: Vec3Like, max: Vec3Like): BrushResult['bounds'] | null {
    const span = WINDOW_CELLS + 1;
    const x0 = Math.max(0, Math.floor((min.x - this.originWorldX) / CELL_SIZE) - 1);
    const x1 = Math.min(span, Math.ceil((max.x - this.originWorldX) / CELL_SIZE) + 2);
    const z0 = Math.max(0, Math.floor((min.z - this.originWorldZ) / CELL_SIZE) - 1);
    const z1 = Math.min(span, Math.ceil((max.z - this.originWorldZ) / CELL_SIZE) + 2);
    const y0 = Math.max(0, Math.floor((min.y - this.bandFloorWu) / CELL_SIZE) - 1);
    const y1 = Math.min(SAMPLES_Y, Math.ceil((max.y - this.bandFloorWu) / CELL_SIZE) + 2);
    if (x1 <= x0 || y1 <= y0 || z1 <= z0) return null;
    this.generate(x0, x1, y0, y1, z0, z1);
    return {
      minX: x0, maxX: x1 - 1, minY: y0, maxY: y1 - 1, minZ: z0, maxZ: z1 - 1,
    };
  }

  /** Carve at an absolute WORLD position, and remember what now differs. */
  subtractSphere(worldCenter: Vec3Like, radius: number): BrushResult {
    const result = this.field.subtractSphere(
      {
        x: worldCenter.x - this.originWorldX,
        y: worldCenter.y - this.bandFloorWu,
        z: worldCenter.z - this.originWorldZ,
      },
      radius,
    );
    if (result.changedSamples > 0) this.remember(result.bounds);
    return result;
  }

  /** Relax the field over a LOCAL sample box — the smoothing brush. The
   *  box is what a brush just returned, so no conversion is needed. */
  smoothBox(
    bounds: BrushResult['bounds'], strength?: number, maxShift?: number,
  ): BrushResult['bounds'] | null {
    const result = this.field.smoothBox(bounds, strength, maxShift);
    if (result.changedSamples === 0) return null;
    this.remember(result.bounds);
    return result.bounds;
  }

  /** The oriented scoop, at an absolute WORLD position — see
   *  `DensityField.subtractEllipsoid`. Direction needs no translation. */
  subtractEllipsoid(
    worldCenter: Vec3Like, along: Vec3Like,
    semis: { deep: number; wide: number; tall: number }, rightHint?: Vec3Like,
  ): BrushResult {
    const result = this.field.subtractEllipsoid(
      {
        x: worldCenter.x - this.originWorldX,
        y: worldCenter.y - this.bandFloorWu,
        z: worldCenter.z - this.originWorldZ,
      },
      along, semis, rightHint,
    );
    if (result.changedSamples > 0) this.remember(result.bounds);
    return result;
  }

  /**
   * Record samples in the box that differ from the BASE soil — which
   * includes the nest plan, so re-opening a planned tunnel stores nothing.
   * The rim cap planes are skipped, exactly as WorldStream's comment warns.
   */
  private remember(bounds: BrushResult['bounds']): void {
    const rim = CAP_PLANES;
    const floorWu = this.yBaseMm / MM;
    const firstX = Math.max(rim, bounds.minX);
    const lastX = Math.min(WINDOW_CELLS - rim, bounds.maxX);
    const firstY = Math.max(0, bounds.minY);
    const lastY = Math.min(SAMPLES_Y - 1 - rim, bounds.maxY);
    for (let z = Math.max(rim, bounds.minZ); z <= Math.min(WINDOW_CELLS - rim, bounds.maxZ); z += 1) {
      const gz = this.originCellZ + z;
      const tz = Math.min(ISLAND_TILES - 1, Math.floor(gz / TILE_CELLS));
      for (let x = firstX; x <= lastX; x += 1) {
        HEIGHTS[x - firstX] = this.surfaceMmAt(
          (this.originCellX + x) * CELL_SIZE * MM, gz * CELL_SIZE * MM,
        ) / MM;
      }
      for (let y = firstY; y <= lastY; y += 1) {
        for (let x = firstX; x <= lastX; x += 1) {
          const gx = this.originCellX + x;
          const value = this.field.get(x, y, z);
          const base = this.soil.densityUnder(
            HEIGHTS[x - firstX]!, floorWu,
            gx * CELL_SIZE, floorWu + y * CELL_SIZE, gz * CELL_SIZE,
          );
          const tx = Math.min(ISLAND_TILES - 1, Math.floor(gx / TILE_CELLS));
          const key = tx + ISLAND_TILES * tz;
          const local = (this.yBaseMm + y)
            + Y_SPAN * ((gx - tx * TILE_CELLS) + TILE_SAMPLES * (gz - tz * TILE_CELLS));
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
   * The soil's top at a horizontal WORLD position, read off the LIVE field
   * in ABSOLUTE world units — a dug-open entrance is a real drop underfoot.
   * Null when the column is outside the window.
   */
  surfaceHeightAt(worldX: number, worldZ: number): number | null {
    return this.surfaceBelowY(worldX, worldZ, Infinity);
  }

  /**
   * The first soil-top BELOW a given height — the underground question.
   * Scanning from the TOP of the column is right on the surface and wrong
   * the moment she is in a tunnel: the topmost crossing is the tunnel's
   * ROOF-side ground, and easing toward it yanks her up through the roof
   * (playtest: "it bounced me back up"). Scanning down from HER height
   * finds the floor she is actually standing over — shaft bottom, drift
   * floor, chamber floor — and the roof above her never matters.
   */
  surfaceBelowY(worldX: number, worldZ: number, fromWorldY: number): number | null {
    const x = (worldX - this.originWorldX) / CELL_SIZE;
    const z = (worldZ - this.originWorldZ) / CELL_SIZE;
    const xi = Math.round(x);
    const zi = Math.round(z);
    if (xi < CAP_PLANES || xi > WINDOW_CELLS - CAP_PLANES
      || zi < CAP_PLANES || zi > WINDOW_CELLS - CAP_PLANES) return null;
    const fromCell = Math.ceil((fromWorldY - this.bandFloorWu) / CELL_SIZE);
    let y = Math.min(SAMPLES_Y - 1, Math.max(1, fromCell));
    for (; y > 0; y -= 1) {
      const above = this.field.get(xi, y, zi);
      const below = this.field.get(xi, y - 1, zi);
      if (below > 0 && above <= 0) {
        const t = below / (below - above);
        return this.bandFloorWu + (y - 1 + t) * CELL_SIZE;
      }
    }
    return null;
  }

  /** Is this ABSOLUTE world-unit position inside soil? Null out of window. */
  solidAtWu(worldX: number, worldY: number, worldZ: number): boolean | null {
    const xi = Math.round((worldX - this.originWorldX) / CELL_SIZE);
    const zi = Math.round((worldZ - this.originWorldZ) / CELL_SIZE);
    const yi = Math.round((worldY - this.bandFloorWu) / CELL_SIZE);
    if (xi < 0 || xi > WINDOW_CELLS || zi < 0 || zi > WINDOW_CELLS
      || yi < 0 || yi >= SAMPLES_Y) return null;
    return this.field.get(xi, yi, zi) > 0;
  }
}
