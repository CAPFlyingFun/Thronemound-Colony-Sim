/**
 * Ground that is not a table top.
 *
 * The world used to be a perfectly flat plane at SURFACE_Y, which is fine while
 * everything interesting happens below it and hopeless the moment you stand on
 * top and look around. This gives it relief — one pronounced hill, one hollow,
 * and gentle undulation everywhere else.
 *
 * Deliberately NOT rolling hills. The brief was a hill in a spot and a valley
 * in a spot, and that is a different shape from noise turned up: a single
 * landmark you can navigate by reads as somewhere, where uniform bumpiness
 * reads as texture. So the two features are placed, and the noise only
 * roughens what is between them.
 *
 * No three.js and no VoxelWorld, so the height field can be checked on its own.
 */

import { AIR, CLAY, SAND, STONE, TOPSOIL, type Generator, type VoxelId } from './VoxelWorld';

/**
 * How high the hill stands and how deep the hollow cuts, in voxels.
 *
 * 5 cm and 3 cm at 5 mm a voxel. Held as voxels rather than centimetres
 * because every other length in the simulation is voxels and converting at the
 * boundary is how the pellet ended up three different sizes.
 */
export const HILL_VOXELS = 10;
export const VALLEY_VOXELS = 6;

/** Gentle roughness everywhere else, so between the features it is not glass. */
export const ROLL_VOXELS = 2;

/** How wide the hill and the hollow are, as a fraction of the world. */
const HILL_SPREAD = 0.17;
const VALLEY_SPREAD = 0.13;

/**
 * How finely the ground may sit BETWEEN voxels. The smoothing knob.
 *
 * The terrain used to round its height to a whole voxel, so a slope came out
 * as contour terraces 5 mm tall — taller than the ant, and the one thing in
 * the frame that read as a chart rather than as ground. The height field was
 * always smooth; the rounding was the staircase.
 *
 * Now the field stays continuous and the topmost voxel of each column is drawn
 * PART FULL, so the surface can stop anywhere within its own cell. This is the
 * quantum it snaps to: an eighth of a voxel, 0.625 mm. Fine enough that the
 * step is under the width of her foot, coarse enough that a column's fill is a
 * stable number rather than one that flickers in the last bits of a float.
 *
 * ONE constant, and everything reads it — the generator that decides which
 * voxels exist, the mesher that draws them, the collision that stands on them,
 * and the skirt outside the glass. Set it to 1 and the world goes back to
 * whole-voxel terraces exactly as it was, which is the test that it really is
 * the only place the decision is made.
 */
export const SURFACE_STEP = 1 / 8;

/**
 * Relief beyond the walls, and how far out it takes hold.
 *
 * Inside the tank the brief is a 5 cm hill and a 3 cm hollow. Outside it, the
 * ground is scenery seen through glass from an ant's eye, and holding it to
 * the same 8 cm of range makes the world look like a table the tank is sitting
 * on. So a second, much larger-amplitude layer fades in with distance from the
 * walls — nothing inside the box moves, because the fade is exactly zero there.
 */
export const FAR_RELIEF_VOXELS = 46;
const FAR_FADE = 220;
const FAR_CELL = 150;

export interface TerrainOptions {
  /** Height the flat world used to sit at — still the reference for depth. */
  surfaceY: number;
  /** Width of the world in voxels; features are placed inside it. */
  size: number;
  seed?: number;
}

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(seed | 0, 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smoothstep, so the lattice of the value noise does not show as creases. */
const ease = (t: number) => t * t * (3 - 2 * t);

/** Value noise in -1..1 at a given cell size. */
function noise(x: number, z: number, cell: number, seed: number): number {
  const fx = x / cell;
  const fz = z / cell;
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const tx = ease(fx - x0);
  const tz = ease(fz - z0);
  const c00 = hash2(x0, z0, seed);
  const c10 = hash2(x0 + 1, z0, seed);
  const c01 = hash2(x0, z0 + 1, seed);
  const c11 = hash2(x0 + 1, z0 + 1, seed);
  const a = c00 + (c10 - c00) * tx;
  const b = c01 + (c11 - c01) * tx;
  return (a + (b - a) * tz) * 2 - 1;
}

/** A smooth radial falloff, 1 at the centre and 0 at `radius` and beyond. */
function bump(dx: number, dz: number, radius: number): number {
  const d = Math.hypot(dx, dz) / radius;
  if (d >= 1) return 0;
  // Cosine rather than a linear cone: a cone has a crease at its tip and a rim
  // you can see from across the world, and both read as geometry rather than
  // ground.
  return (Math.cos(d * Math.PI) + 1) / 2;
}

/**
 * Placements, worked out once per world.
 *
 * `groundHeight` is now called per VERTEX by the skirt as well as per voxel by
 * the generator — a few million times on a load — and it opened by hashing the
 * same six numbers to rediscover where the hill is every time. The answer
 * depends only on the options object, so it is cached against it.
 */
const featureCache = new WeakMap<TerrainOptions, {
  hill: { x: number; z: number };
  valley: { x: number; z: number };
}>();

/** Where this world puts its hill and its hollow. */
export function features(opts: TerrainOptions): {
  hill: { x: number; z: number };
  valley: { x: number; z: number };
} {
  const cached = featureCache.get(opts);
  if (cached) return cached;
  const seed = opts.seed ?? 1;
  const { size } = opts;
  /*
   * Kept off the middle and away from the walls.
   *
   * The middle is where she starts, and starting inside a hill or at the bottom
   * of a hollow makes the first thing the player sees a wall of dirt. The
   * margin keeps both features whole rather than sliced off by the edge of the
   * world.
   */
  const margin = size * 0.22;
  const span = size - margin * 2;
  /** Inside the margin band, always — including when pushed. */
  const inside = (v: number) => Math.round(Math.min(size - margin, Math.max(margin, v)));
  const place = (salt: number) => ({
    x: inside(margin + hash2(salt, 7, seed) * span),
    z: inside(margin + hash2(11, salt, seed) * span),
  });
  const hill = place(1);
  let valley = place(2);
  /*
   * Pushed apart if they landed on top of each other, because a hollow on the
   * summit just cancels the hill and the world is flat again with extra steps.
   *
   * Pushed AWAY from whichever edge is nearer, and clamped by the same margin
   * as the original placement — the first version clamped only to the world
   * bounds, so a hill already near the far side shoved the hollow to within
   * two voxels of the wall and it came out as a notch in the edge rather than
   * as a hollow.
   */
  const apart = Math.hypot(valley.x - hill.x, valley.z - hill.z);
  const wanted = size * (HILL_SPREAD + VALLEY_SPREAD);
  if (apart < wanted) {
    const away = (v: number) => (v > size / 2 ? v - wanted : v + wanted);
    valley = { x: inside(away(hill.x)), z: inside(away(hill.z)) };
  }
  const placed = { hill, valley };
  featureCache.set(opts, placed);
  return placed;
}

/**
 * How far outside the tank a point is, from 0 at the wall to 1 well beyond it.
 *
 * Exactly zero everywhere inside the world, which is the property that matters:
 * the distant relief is multiplied by this, so it cannot move a single voxel of
 * the ground the player can actually dig, and the two meet at the wall with no
 * step to give the join away.
 */
export function outsideness(x: number, z: number, size: number): number {
  const beyond = Math.max(0, -x, x - size, -z, z - size);
  return ease(Math.min(1, beyond / FAR_FADE));
}

/**
 * Height of the ground surface in a column — CONTINUOUS, not a whole voxel.
 *
 * The single source of truth for "where is the ground here". Depth, spawning,
 * whether she counts as underground, how full the topmost voxel is drawn, what
 * her feet stand on, and the ground outside the glass all read it, because the
 * moment two of them disagree about the surface one of them is putting her
 * inside it.
 *
 * This used to round to a whole voxel and that rounding WAS the staircase: a
 * slope of half a voxel per voxel came out as a 5 mm terrace every second
 * cell. Now it snaps to SURFACE_STEP instead — an eighth of a voxel — and the
 * mesher draws the topmost cell part full to match.
 */
export function groundHeight(x: number, z: number, opts: TerrainOptions): number {
  const { hill, valley } = features(opts);
  const up = bump(x - hill.x, z - hill.z, opts.size * HILL_SPREAD);
  const down = bump(x - valley.x, z - valley.z, opts.size * VALLEY_SPREAD);
  /*
   * The roughness fades out where a feature takes over.
   *
   * Without this the noise sits ON the summit and subtracts from it, so the
   * hill the brief asks for at 5 cm arrives at 4.5 and the number in the
   * constant is a lie. Fading it also happens to be the better shape: a
   * summit and the floor of a hollow are the two places ground is smoothest,
   * because that is where material collects.
   */
  const feature = Math.max(up, down);
  const roll = (
    noise(x, z, 26, (opts.seed ?? 1) + 1) * 0.65
    + noise(x, z, 11, (opts.seed ?? 1) + 2) * 0.35
  ) * ROLL_VOXELS * (1 - feature);
  const h = opts.surfaceY + roll + up * HILL_VOXELS - down * VALLEY_VOXELS;
  // Clamped to the brief: the hill tops out at 5 cm and the hollow bottoms at
  // 3 cm, so the roughness cannot quietly add to either.
  const inside = Math.max(
    opts.surfaceY - VALLEY_VOXELS,
    Math.min(opts.surfaceY + HILL_VOXELS, h),
  );
  /*
   * Distant country, and it is added AFTER the clamp on purpose.
   *
   * Clamping it too would hold the horizon to the same 8 cm band as the tank
   * and the world would end in a plain. The fade is zero inside the walls, so
   * this term cannot reach anything that is dug, spawned on, or collided with.
   */
  const far = outsideness(x, z, opts.size) * FAR_RELIEF_VOXELS * (
    noise(x, z, FAR_CELL, (opts.seed ?? 1) + 3) * 0.7
    + noise(x, z, FAR_CELL / 3, (opts.seed ?? 1) + 4) * 0.3
  );
  return Math.round((inside + far) / SURFACE_STEP) * SURFACE_STEP;
}

/**
 * The topmost voxel that actually EXISTS in a column.
 *
 * `ceil - 1` rather than `floor`, so a column whose surface lands exactly on a
 * voxel boundary owns the cell BELOW the boundary at full height, instead of
 * owning the cell above it at zero height. That keeps `surfaceFill` in (0, 1]
 * and means there is never a cell in the world drawn with no thickness.
 */
export function surfaceVoxel(x: number, z: number, opts: TerrainOptions): number {
  return Math.ceil(groundHeight(x, z, opts)) - 1;
}

/**
 * How full a cell is drawn, from 0 (exclusive) to 1.
 *
 * 1 for every cell in the world except the topmost of each terrain column,
 * which is the whole trick: the voxel grid is untouched — cells are still
 * whole, still dug whole, still stored a byte each — and only the LAST one in
 * a column is drawn and collided with as a slab. Dig it away and the cell
 * beneath answers 1, because this is a question about the height field rather
 * than about the cell, and the height field does not know she has been
 * digging.
 */
export function surfaceFill(x: number, y: number, z: number, opts: TerrainOptions): number {
  const h = groundHeight(x, z, opts);
  const top = Math.ceil(h) - 1;
  if (y !== top) return 1;
  return h - top;
}

/**
 * Strata that follow the ground rather than a flat plane.
 *
 * Depth is measured down from the column's OWN surface, so topsoil stays a
 * skin over the hill instead of being sliced off by it — which is what happens
 * if you keep the old fixed bands and just move the ground through them.
 */
export function terrainGenerator(opts: TerrainOptions): Generator {
  /*
   * One column, remembered.
   *
   * The generator is called once per CELL and the answer depends only on the
   * column, so without this every world load evaluates the height field a
   * hundred and twenty-eight times more often than it needs to. A single slot
   * is enough because the world is filled a column at a time.
   */
  let lastKey = NaN;
  let lastTop = 0;
  return (x: number, y: number, z: number): VoxelId => {
    const key = x * 65536 + z;
    if (key !== lastKey) {
      lastKey = key;
      lastTop = surfaceVoxel(x, z, opts);
    }
    const top = lastTop;
    if (y > top) return AIR;
    const depth = top - y;
    if (depth < 6) return TOPSOIL;
    if (depth < 34) return CLAY;
    if (depth < 78) return SAND;
    return STONE;
  };
}
