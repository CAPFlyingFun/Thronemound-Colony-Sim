/**
 * The streamed world: soil that is larger than the memory holding it.
 *
 * The lab's fixed field answered "can a mandible carve this?" and it can. It
 * could not answer "can the tank be a tank?", because quarter-millimetre cells
 * over the real 640 mm glass are 1.6 billion samples and 6.3 GB. That is not a
 * tuning problem, it is an arithmetic one, and no amount of faster meshing
 * touches it.
 *
 * Streaming answers it by never holding the world. A fixed WINDOW of tiles is
 * resident, centred on the ant; everything outside is a formula plus whatever
 * she dug there. Resident cost is therefore set by the window, and the world's
 * size stops being a memory question entirely — 320 mm and 640 mm cost exactly
 * the same to stand in.
 *
 * ## Why the tile is 16 mm and not 64
 *
 * A 3x3 of the lab's current 64 mm tiles is 192 mm across, not 576 — nine
 * tiles laid in a GRID span three of them, not nine. And the memory is the
 * part that decides it:
 *
 *   64 mm tile   257 x 129 x 257 samples   34 MB     3x3 resident = 307 MB
 *   32 mm tile   129 x 129 x 129 samples    8.6 MB   3x3 resident =  77 MB
 *   16 mm tile    65 x 129 x  65 samples    2.2 MB   3x3 resident =  18 MB
 *
 * Three hundred megabytes of Float32 plus a WebGL context is how a phone tab
 * gets killed. At 16 mm the whole resident window is 18 MB — barely half of
 * the single fixed field that already runs well — and 16 divides both 320 and
 * 640 exactly, so neither test size needs a ragged edge tile.
 *
 * What it costs is sight: the window is 48 mm across, so loaded soil ends
 * between 16 and 32 mm away. At ant scale that is ten to twenty body lengths,
 * and the fog is set to reach the window edge so the cut face is not the first
 * thing you notice. Seeing further than that is a level-of-detail question —
 * coarse soil beyond the fine window — and it is a different question from
 * this one.
 */

import { CELL_MM, CELL_SIZE, CELLS_Y } from './labMound';

/** Cells along one edge of a tile. Sixteen millimetres at the lab's cell size. */
export const TILE_MM = 16;
export const TILE_CELLS = Math.round(TILE_MM / CELL_MM);

/** Tiles resident along each horizontal axis, with the ant in the middle one. */
export const WINDOW_TILES = 3;
export const WINDOW_CELLS = TILE_CELLS * WINDOW_TILES;

/**
 * The world, in tiles. Twenty is 320 mm — half the tank, which is the size
 * worth proving first: large enough that the window is a small fraction of it
 * (nine tiles of four hundred), small enough to cross on foot while watching.
 * Forty would be the full 640 mm glass and costs nothing more to stand in.
 */
export const WORLD_TILES = 20;

export const TILE_SIZE = TILE_CELLS * CELL_SIZE;
export const WINDOW_SIZE = WINDOW_CELLS * CELL_SIZE;
export const WORLD_SPAN = WORLD_TILES * TILE_SIZE;
export const SOIL_DEPTH = CELLS_Y * CELL_SIZE;

/** Bytes the resident window costs, before meshes. Reported in the HUD. */
export const WINDOW_BYTES =
  (WINDOW_CELLS + 1) ** 2 * (CELLS_Y + 1) * Float32Array.BYTES_PER_ELEMENT;

/**
 * The soil, as a function of where you are — no storage, no seams, no edges.
 *
 * This is the half of streaming that makes the world free: a tile that is not
 * resident is not stored anywhere, it is simply not being evaluated. Which
 * means the function has to be honest at every scale the ant works at, because
 * it is the only description of soil she has not personally touched.
 *
 * Four octaves, each with a job:
 *   ~150 mm  the shape of the ground you walk over
 *   ~45 mm   rises and hollows you would choose between
 *   ~13 mm   the roughness of a slope under one ant
 *   ~4 mm    grit, at the amplitude `GRIT` explains
 *
 * X and Z get different frequencies in every octave. Equal ones make a
 * separable product, which reads as a checkerboard of identical bumps the
 * moment you get low enough to see two of them at once.
 *
 * Free of three.js and of any state, so the stream, the tests and any future
 * collision code all read the same ground rather than three descriptions of it.
 */
/**
 * Amplitude of the finest octave — 0.1 mm, a fifth of a bite.
 *
 * It started at 0.05 world units, which is 0.25 mm and a full cell of swing
 * either way, on the reasoning that the finest thing the field can hold is the
 * right size for the finest thing in the world. That is wrong, and the reason
 * is the mesher: surface nets place ONE vertex per cell, so a feature whose
 * whole swing fits inside a cell can put two sheets of surface in the same
 * cell, and the two get welded into one. The weld shows up as a pair of
 * triangles wound the same way — one of them backface-culled, a quarter-
 * millimetre hole in the ground.
 *
 * Measured on the untouched 48 mm window, over about 260,000 triangles:
 *
 *   amplitude   flipped edges
 *   0.05        22
 *   0.025       10
 *   0.02         2
 *   0.012        2
 *
 * So it is not a threshold to squeak under, it is a curve, and 0.02 is where
 * it flattens. Chasing zero is not on offer — surface nets pinch by
 * construction and the tunnel test next door documents the same limit — but
 * there is no reason to tune the terrain's finest detail to sit exactly on the
 * failure and then assert around it.
 */
const GRIT = 0.02;

/** How far the soil's surface is closed in from each of the world's six sides. */
export const WORLD_MARGIN = CELL_SIZE * 1.5;

/**
 * The ground's height, which is where all the trigonometry lives.
 *
 * Split out from the density because it is a function of TWO coordinates and
 * the density is a function of three. Filling a column of the field means
 * asking for 129 densities at the same x and z, and the first version obliged
 * by evaluating four sine-cosine pairs for every one of them — a hundred and
 * twenty-nine times the trigonometry needed, which is most of what a scroll
 * cost. Measured at 245 ms for one diagonal recentre; a stall you can feel.
 */
export function streamHeightAt(x: number, z: number): number {
  return SOIL_DEPTH * 0.45
    + 1.10 * Math.sin(x * 0.191) * Math.cos(z * 0.167)
    + 0.45 * Math.sin(x * 0.611 + 1.7) * Math.cos(z * 0.733 - 0.9)
    + 0.16 * Math.sin(x * 2.31 - 0.4) * Math.cos(z * 2.09 + 2.2)
    + GRIT * Math.sin(x * 7.9 + 0.8) * Math.cos(z * 8.6 - 1.3);
}

/**
 * Density given a height already computed for this column.
 *
 * The margins close the blob at the world's six sides. Without them the soil
 * runs off the end of the field and the surface has an open rim, which is a
 * hole by every measure in the watertightness harness — and correctly so,
 * since you could stand at the boundary and look into solid ground.
 */
export function densityUnder(
  height: number, x: number, y: number, z: number,
): number {
  return Math.min(
    height - y,
    y - WORLD_MARGIN,
    SOIL_DEPTH - WORLD_MARGIN - y,
    x - WORLD_MARGIN,
    WORLD_SPAN - WORLD_MARGIN - x,
    z - WORLD_MARGIN,
    WORLD_SPAN - WORLD_MARGIN - z,
  );
}

export function streamDensityAt(x: number, y: number, z: number): number {
  return densityUnder(streamHeightAt(x, z), x, y, z);
}

/**
 * The same soil, capped at the edge of what is loaded.
 *
 * Without this the resident window is a slab of soil whose surface simply
 * STOPS at the rim: measured on the first run, 1,708 open boundary edges on
 * untouched ground. Open edges are not an abstraction — the ground sheet ends
 * in mid-air, its underside is backface-culled, and standing near the rim you
 * see sky through the floor. Exactly the class of hole that took four rounds
 * to chase out of the voxel terrain.
 *
 * So the window closes itself: a cut face one and a half cells in from the
 * rim, which reads as a wall of earth where the map runs out and is what the
 * fog is set to reach. It costs 0.375 mm of soil at each edge and it is the
 * honest picture, because there genuinely is nothing beyond it yet.
 *
 * The cap is a property of WHERE THE WINDOW IS, not of the world, so a sample
 * that is cap now is ordinary soil once the window slides past it — and that
 * is why the band it touches has to be as thin as it can be. A smooth ramp
 * (`min(soil, distanceToRim)`) looks like the obvious spelling and is wrong:
 * deep soil reads about 2.9 world units, so the ramp keeps biting until the
 * rim is nearly fifteen millimetres away, which is a QUARTER of the window
 * carrying values that depend on where the window happens to be. Sliding one
 * tile then left the retained soil disagreeing with the world by 1.66.
 *
 * Two planes, sharply, and the rest is the world. `TerrainStream` regenerates
 * two planes beyond what it retains and the old cut face is gone.
 *
 * ## Why the position is an index and not a distance
 *
 * "Which plane is this?" is a counting question, so it is asked in integers.
 * The first spelling took world coordinates and subtracted the window origin,
 * which is the same number in principle and not in binary: at one window
 * position `(576 + 190) * 0.05 - 576 * 0.05` came out as 9.500000000000004,
 * the distance to the far rim as 0.09999999999999787, and a plane that should
 * have been ordinary soil got capped because it missed the threshold by
 * 2e-15. One column of the map, wrong by 1.85 — soil suddenly reading as
 * nearly-air a third of the way through the window, on one axis, at one
 * window position out of four hundred. It only surfaced because the slide
 * test compares against the world sample by sample.
 */
export const CAP_PLANES = 2;

export function windowDensityAt(
  worldX: number, worldY: number, worldZ: number,
  cellX: number, cellZ: number,
): number {
  return cappedDensity(streamHeightAt(worldX, worldZ), worldX, worldY, worldZ, cellX, cellZ);
}

/** The same, given a height already computed for this column. */
export function cappedDensity(
  height: number,
  worldX: number, worldY: number, worldZ: number,
  cellX: number, cellZ: number,
): number {
  const soil = densityUnder(height, worldX, worldY, worldZ);
  const edge = Math.min(
    cellX, WINDOW_CELLS - cellX, cellZ, WINDOW_CELLS - cellZ,
  );
  if (edge >= CAP_PLANES) return soil;
  return Math.min(soil, (edge - 1.5) * CELL_SIZE);
}

/**
 * The top of the packed soil at a horizontal position, exactly.
 *
 * Density falls as `height - y` and is clipped by the world's floor, ceiling
 * and sides, so the topmost y with soil in it is just the height, bounded by
 * those clips — no search required.
 *
 * It WAS a search, by bisection from y = 0, and that version returned zero for
 * every position on the map: soil is closed underneath by `y - margin`, so
 * density at the very bottom is negative and the first probe read it as "no
 * soil here". Not a crash and not a suspicious-looking number — it simply put
 * the scout's feet on the bedrock plane and aimed every test bite eleven
 * millimetres underground, where they removed soil perfectly happily.
 */
export function streamGroundHeight(x: number, z: number): number {
  const sides = Math.min(
    x - WORLD_MARGIN, WORLD_SPAN - WORLD_MARGIN - x,
    z - WORLD_MARGIN, WORLD_SPAN - WORLD_MARGIN - z,
  );
  if (sides <= 0) return 0;
  return Math.max(
    WORLD_MARGIN,
    Math.min(streamHeightAt(x, z), SOIL_DEPTH - WORLD_MARGIN),
  );
}
