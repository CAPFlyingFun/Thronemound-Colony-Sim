/**
 * TCS SOIL AS A DENSITY FIELD — the tray, as one continuous surface.
 *
 * The voxel tray stored a MATERIAL PER CELL and a HEIGHT PER COLUMN. That
 * second half is the whole reason this file exists: a column height can only
 * describe a surface you could pour water onto. A tunnel has a floor AND a
 * roof in the same column, and a dug ramp made of column heights is a flight
 * of 5 mm treads under an ant whose front foot reaches 0.81 mm below her body.
 *
 * A signed field has no such opinion. It says "how far inside the soil is this
 * point", everywhere, in three dimensions — so a tunnel is just a region where
 * the answer went negative, and its floor is as smooth as the arithmetic.
 *
 * ## Sign convention: POSITIVE IS SOLID
 *
 * Matching `DensityField`, `SurfaceNets` (which counts `value > 0` as inside at
 * iso 0) and `carve.ts`. Intersection is therefore `Math.min` and it reads
 * backwards until you hold that in your head: `Math.min(a, b)` is "inside both".
 *
 * ## Why the tank got smaller
 *
 * The voxel tray was 480 mm across. At the 0.25 mm cells this needs to make a
 * 3 mm worker tunnel look round, 480 mm is 1920 cells a side — about 3.9
 * billion samples, or 15.7 GB. That is not a tuning problem, it is an
 * arithmetic one, and it is why `labWorld` streams tiles instead.
 *
 * So this first pass uses the size the density lab already proved runs well on
 * the target devices: 64 x 48 x 64 mm at 0.25 mm, which is 12.7 M samples and
 * about 51 MB. Smaller tank, real geometry. Tiling it back up to a full
 * formicarium is the chunk manager's job and is deliberately not attempted
 * here — one hard thing at a time.
 */

import { DensityField } from '../../density/DensityField';

/** One world unit is one 5 mm voxel, as everywhere else in the sim. */
export const MM_PER_UNIT = 5;

/** Density resolution. 3 mm worker tunnel = 12 cells across. */
export const CELL_MM = 0.25;
export const CELL_SIZE = CELL_MM / MM_PER_UNIT;

/** The tank's interior, in millimetres. See the note on size above. */
export const TANK_MM = 64;
export const TANK_HEIGHT_MM = 48;

export const CELLS_X = Math.round(TANK_MM / CELL_MM);
export const CELLS_Y = Math.round(TANK_HEIGHT_MM / CELL_MM);
export const CELLS_Z = CELLS_X;

/** The same span, in world units, which is what the field is addressed in. */
export const TANK = TANK_MM / MM_PER_UNIT;
export const TANK_HEIGHT = TANK_HEIGHT_MM / MM_PER_UNIT;

/**
 * Where the soil's surface sits when nothing has dug it, in world units.
 *
 * Just under half the tank, so there is room to watch her on top and room for
 * a 30 mm founding beneath her without meeting the floor.
 */
export const GRADE = TANK_HEIGHT * 0.55;

/**
 * How much the surface rolls, in world units — gentle.
 *
 * The voxel tray used 1.5 voxels (7.5 mm) of relief across 78 voxels, and the
 * ant walked it with nothing groping. Keeping the same gentle character rather
 * than making the density version showier: this is a geometry change, not an
 * art-direction change, and a dramatic surface would be a second variable when
 * the first one is still being proved.
 */
export const RELIEF = 0.3;

/** How far in from the glass the soil stops, so the tray reads as a tray. */
const MARGIN = CELL_SIZE * 1.5;

/**
 * The untouched tray's density at a world point.
 *
 * Exported on its own because it is the BASE SOIL FUNCTION the chunk manager
 * will eventually rebuild untouched tiles from — a tile nobody has dug can
 * always be regenerated from this and needs no storage. Keeping it a pure
 * function of position, with no field and no state, is what makes that
 * possible later.
 */
export function tcsSoilAt(x: number, y: number, z: number, seed = 1): number {
  const k = (Math.PI * 2) / (TANK * 0.8);
  const phase = seed * 0.7;
  /* Two swells crossing at an angle, so the tray has a low corner and a high
   * one without either reading as a wave — the voxel tray's own shape. */
  const a = Math.sin(x * k + phase) * Math.cos(z * k * 0.8 + phase * 1.3);
  const b = Math.sin((x + z) * k * 0.55 - phase);
  const surface = GRADE + ((a * 0.6 + b * 0.4) * RELIEF) / 2;

  /*
   * Soil below the surface, INTERSECTED with the tank's interior. `min` is
   * intersection for a positive-inside field, so every term has to be positive
   * for the point to be soil: below the surface, above the floor, and inside
   * all four walls.
   */
  return Math.min(
    surface - y,
    y - MARGIN,
    x - MARGIN, TANK - MARGIN - x,
    z - MARGIN, TANK - MARGIN - z,
  );
}

/** The whole tray, filled once. */
export function makeTcsSoil(seed = 1): DensityField {
  const field = new DensityField({
    cellsX: CELLS_X, cellsY: CELLS_Y, cellsZ: CELLS_Z, cellSize: CELL_SIZE,
  });
  field.fill((x, y, z) => tcsSoilAt(x, y, z, seed));
  return field;
}

/**
 * SOIL COLOUR BY DEPTH — the strata, kept as TCS's own.
 *
 * The voxel world stored a material id per cell. A density field stores one
 * number and has no room for that, which is fine and arguably better: strata
 * are a function of DEPTH, so they can be computed rather than stored, and
 * they stay correct in a tunnel wall without anybody having to remember to
 * write them there.
 *
 * The colours are the voxel `MATERIALS` table's, unchanged, because this is a
 * geometry change and the tray should still look like TCS.
 */
const TOPSOIL: readonly [number, number, number] = [0.28, 0.19, 0.11];
const SAND: readonly [number, number, number] = [0.66, 0.56, 0.36];
const CLAY: readonly [number, number, number] = [0.42, 0.21, 0.14];
const STONE: readonly [number, number, number] = [0.34, 0.34, 0.36];

/** Depths below grade at which each layer takes over, in world units. */
const TOPSOIL_DEEP = 5 / MM_PER_UNIT;
const SAND_DEEP = 22 / MM_PER_UNIT;
const CLAY_DEEP = 38 / MM_PER_UNIT;

export function soilColourAt(
  x: number, y: number, z: number, into: [number, number, number],
): void {
  const below = GRADE - y;
  const band = below < TOPSOIL_DEEP ? TOPSOIL
    : below < SAND_DEEP ? SAND
      : below < CLAY_DEEP ? CLAY
        : STONE;
  /*
   * A little jitter so a flat band does not read as painted-on — and it has
   * to be jitter in ALL THREE AXES.
   *
   * The first cut varied only with y, on the reasoning that a stratum is a
   * height and should therefore be one shade right across the tray. That is
   * true of the BANDS and false of the grain: on a surface that rolls, a
   * shade that depends only on height draws a contour line, and the tray came
   * out looking like a topographic map — concentric rings around every swell.
   * Measured on the rendered tray, not argued about.
   *
   * Three incommensurate frequencies give speckle instead. The bands above
   * still key off depth alone, so the strata stay legible as layers; only the
   * fine grain moves sideways.
   */
  const grain = 0.94 + 0.06 * Math.sin(
    x * 37.1 + Math.sin(y * 29.3) * 2.1 + Math.sin(z * 41.7) * 1.7,
  );
  into[0] = band[0] * grain;
  into[1] = band[1] * grain;
  into[2] = band[2] * grain;
}
