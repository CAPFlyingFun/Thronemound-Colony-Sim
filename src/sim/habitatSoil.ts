/**
 * THE HABITAT'S OWN GROUND — gentle, because an ant is three millimetres
 * tall.
 *
 * `voxel/terrain.ts` builds the dig room's landscape: a hill, a valley and
 * noise, sized so a first-person player has somewhere to go. Measured
 * against the queen it is mountainous — 0.92 mm of relief per voxel on
 * average, 3.1 mm at the ninetieth percentile and 5 mm at worst, ACROSS ONE
 * VOXEL. Her legs carry 1.1 to 1.8 mm of spare downward reach, so on that
 * ground a third of her feet were reaching into space every frame: measured
 * on the first run of `probe:habitat`, 2.1 of 6 legs groping.
 *
 * That is not a bug in her legs and it is not a bug in that terrain. It is
 * the wrong ground for the animal. A formicarium is a tray of soil, and the
 * milestone asks for "small surface variation" — small meaning small TO HER.
 *
 * SO THE HABITAT GETS ITS OWN FIELD, and it is deliberately dull: two broad
 * swells, no noise, amplitude and wavelength chosen so the steepest place in
 * the tank is still inside her reach. Not flat, because flat would not test
 * the acceptance criterion at all; not scenery, because scenery is what the
 * player will place on top of it (milestone 2).
 *
 * ONE DESCRIPTION OF THE SURFACE. `height` is the truth; the generator, the
 * mesher's fill and its slope are all read off it. That is the same shape
 * `voxel/terrain.ts` uses and for the same reason — two descriptions of one
 * surface is how an ant ends up walking on a ground nobody can see.
 *
 * Pure: no THREE, no world, no scene.
 */

import {
  AIR, CLAY, SAND, STONE, TOPSOIL, type VoxelId,
} from '../voxel/VoxelWorld';

export interface HabitatOptions {
  /** The mean height of the soil, in voxels. */
  surfaceY: number;
  /** Width and depth of the tray, in voxels. */
  size: number;
  seed?: number;
}

/**
 * How much the ground rises and falls, in voxels, peak to trough.
 *
 * One and a half voxels is 7.5 mm — a little over two body heights across
 * the whole tray, which reads as a gently uneven tray of soil rather than as
 * a table top. What matters is not this number but the GRADIENT it implies
 * against the wavelength below.
 */
export const RELIEF_VOXELS = 1.5;

/**
 * And over what distance, in voxels.
 *
 * The pair is what keeps the slope walkable: a swell of amplitude A and
 * wavelength L has a steepest gradient of 2*pi*A/(2L) — here about 0.06
 * voxels of rise per voxel travelled, or 0.3 mm per 5 mm step. Her spare
 * reach is 1.1 mm at the front legs, so she has room to spare on the worst
 * slope in the tank, which is what "handles small surface variation" has to
 * mean for an animal this size.
 */
export const SWELL_VOXELS = 78;

/** How deep the topsoil skin is before the clay, in voxels. */
export const TOPSOIL_DEPTH = 5;

/** And the clay, before sand. Stone is whatever is left at the bottom. */
export const CLAY_DEPTH = 14;

/** The floor of undiggable stone, in voxels from the bottom of the world. */
export const BEDROCK = 3;

/**
 * The drawn surface at a point, in voxels. Continuous — this is a height
 * field, not a stack of cubes, and the cubes are derived from it.
 */
export function habitatHeight(x: number, z: number, opts: HabitatOptions): number {
  const k = (Math.PI * 2) / SWELL_VOXELS;
  const phase = (opts.seed ?? 0) * 0.7;
  /* Two swells crossing at an angle, so the tray has a low and a high
   * corner without either reading as a wave. */
  const a = Math.sin(x * k + phase) * Math.cos(z * k * 0.8 + phase * 1.3);
  const b = Math.sin((x + z) * k * 0.55 - phase);
  return opts.surfaceY + ((a * 0.6 + b * 0.4) * RELIEF_VOXELS) / 2;
}

/** Which soil a solid cell is made of, by its depth under its own surface. */
export function soilAt(y: number, surface: number): VoxelId {
  if (y < BEDROCK) return STONE;
  const depth = surface - y;
  if (depth <= TOPSOIL_DEPTH) return TOPSOIL;
  if (depth <= CLAY_DEPTH) return CLAY;
  return SAND;
}

/** The world builder: solid under the surface, air over it. */
export function habitatGenerator(opts: HabitatOptions) {
  /* One column remembered, the way `terrain.ts` does it: the generator runs
   * once per cell and the height depends only on the column. */
  let lastKey = NaN;
  let lastTop = 0;
  return (x: number, y: number, z: number): VoxelId => {
    const key = x * 65536 + z;
    if (key !== lastKey) { lastKey = key; lastTop = habitatHeight(x, z, opts); }
    return y < lastTop ? soilAt(y, lastTop) : AIR;
  };
}

/**
 * How much of a cell is drawn, 0..1 — the mesher's partial top cell, and the
 * same number the ant's feet read. See `voxelGround.SoilSampler`.
 */
export function habitatFill(
  x: number, y: number, z: number, opts: HabitatOptions,
): number {
  const h = habitatHeight(x, z, opts);
  const top = Math.ceil(h) - 1;
  if (y !== top) return 1;
  return h - top;
}

/** Which way the ground faces here, for the mesher's smooth shading. */
export function habitatSlope(
  x: number, z: number, opts: HabitatOptions,
): readonly [number, number, number] {
  const dx = (habitatHeight(x + 1, z, opts) - habitatHeight(x - 1, z, opts)) / 2;
  const dz = (habitatHeight(x, z + 1, opts) - habitatHeight(x, z - 1, opts)) / 2;
  const len = Math.hypot(dx, 1, dz);
  return [-dx / len, 1 / len, -dz / len];
}
