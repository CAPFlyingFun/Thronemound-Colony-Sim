/**
 * What things weigh, and what carrying them costs.
 *
 * Hauling used to be a single flat multiplier: carrying anything at all made
 * her 15% slower, carrying nothing made her fast, and the pellet in her jaws
 * had no say in it. That is fine until pellets stop being interchangeable —
 * they vary by a fifth either way in size and by a quarter in density, so a big
 * clay pellet is nearly four times the load of a small sandy one and read
 * exactly the same.
 *
 * So mass is derived rather than asserted: a pellet's volume comes from the
 * geometry it is actually drawn with, its density from the material table, and
 * the speed penalty from the ratio of the two to the ant carrying it. Pure
 * arithmetic, no three.js, so the numbers can be checked without a renderer.
 */

import { VOXEL_MM, materialOf, type VoxelId } from './VoxelWorld';

/**
 * How much of its own bounding cube the worked block actually fills.
 *
 * MEASURED, not derived. A pellet is a cube with its corners knocked off — six
 * square faces, twelve bevels, eight corner cuts — and then roughened and
 * settled on its underside, so no clean formula covers it. This is the mean
 * over every variant and material, taken by integrating the real triangles;
 * they span 0.796 to 0.864, which is why the test that checks this allows two
 * decimal places rather than pretending it is exact.
 *
 * The first version of this constant was a guess at the pure bevelled cube,
 * 0.8455, and the test caught it. Worth keeping the test: if the bevel is ever
 * retuned, that is what notices, rather than every load in the game quietly
 * weighing the wrong amount.
 */
export const PELLET_FILL = 0.8382;

/**
 * A mated fire ant queen, in grams.
 *
 * Solenopsis invicta, which is what the player is. She is the reference the
 * whole haul curve is expressed against, because "fraction of your own body
 * mass" is the only comparison that stays meaningful when the ant changes —
 * a worker hauling the same pellet should struggle more, and will, without
 * this file needing to know she exists.
 */
export const QUEEN_MASS_G = 0.012;

/**
 * Speed lost per body-mass carried.
 *
 * A feel number, and deliberately gentler than physics. Real ants carry many
 * times their own weight, so a strict reading would barely slow her at all and
 * the trip out would stop being a decision. This is set so a typical topsoil
 * pellet — about 1.4 body masses — lands near the flat 0.85 hauling used to
 * apply, and everything lighter or heavier now spreads out either side of it
 * instead of all reading the same.
 */
export const HAUL_PENALTY = 0.11;

/** However heavy the load, she never drops below this fraction of her pace. */
export const HAUL_FLOOR = 0.55;

/**
 * Mass of one pellet in grams, from the size it is DRAWN at.
 *
 * `radiusVoxels` is the pellet's own radius — LooseSoil.radius(), which already
 * varies per source cell — so this is the mass of the thing on screen rather
 * than of a nominal average pellet.
 */
export function clodMassGrams(radiusVoxels: number, material: VoxelId): number {
  const spanMm = radiusVoxels * 2 * VOXEL_MM;
  const volumeMm3 = PELLET_FILL * spanMm * spanMm * spanMm;
  // g/cm^3 to g/mm^3 is a factor of a thousand, and forgetting it is a
  // thousand-fold error in the one direction nobody notices: everything simply
  // becomes weightless.
  return volumeMm3 * (materialOf(material).density / 1000);
}

/**
 * Speed multiplier for a load, as a fraction of normal pace.
 *
 * Linear in mass and floored. Linear because the alternative — a curve tuned
 * until it felt right — would be a second set of numbers doing the job the
 * masses are already doing, and floored so that a pathological load slows her
 * down rather than pinning her in place.
 */
export function haulFactor(loadGrams: number, bodyGrams = QUEEN_MASS_G): number {
  if (loadGrams <= 0) return 1;
  const bodies = loadGrams / Math.max(1e-9, bodyGrams);
  return Math.max(HAUL_FLOOR, 1 - HAUL_PENALTY * bodies);
}
