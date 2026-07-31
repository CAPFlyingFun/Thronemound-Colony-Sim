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

/** Where this world puts its hill and its hollow. */
export function features(opts: TerrainOptions): {
  hill: { x: number; z: number };
  valley: { x: number; z: number };
} {
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
  return { hill, valley };
}

/**
 * Height of the topmost solid voxel in a column.
 *
 * The single source of truth for "where is the ground here". Depth, spawning,
 * and whether she counts as underground all read it, because the moment two of
 * them disagree about the surface one of them is putting her inside it.
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
  return Math.round(Math.max(
    opts.surfaceY - VALLEY_VOXELS,
    Math.min(opts.surfaceY + HILL_VOXELS, h),
  ));
}

/**
 * Strata that follow the ground rather than a flat plane.
 *
 * Depth is measured down from the column's OWN surface, so topsoil stays a
 * skin over the hill instead of being sliced off by it — which is what happens
 * if you keep the old fixed bands and just move the ground through them.
 */
export function terrainGenerator(opts: TerrainOptions): Generator {
  return (x: number, y: number, z: number): VoxelId => {
    const top = groundHeight(x, z, opts);
    if (y > top) return AIR;
    const depth = top - y;
    if (depth < 6) return TOPSOIL;
    if (depth < 34) return CLAY;
    if (depth < 78) return SAND;
    return STONE;
  };
}
