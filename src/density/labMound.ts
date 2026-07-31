/**
 * The lab's world, in one place.
 *
 * These numbers used to live in the scene, and the watertightness test kept a
 * hand-copy of them so it could build the same mound without pulling three.js
 * into a headless run. That is two definitions of one world, and the moment
 * the scene was rescaled the test carried on happily proving things about a
 * mound that no longer existed — passing, and meaningless. Exactly the fault
 * this project keeps meeting in the terrain itself, one level up.
 *
 * So the field lives here, free of three.js, and both the scene and the test
 * read it. Nothing in this file may import a renderer.
 */

import { DensityField } from './DensityField';

/** One world unit is five millimetres, as everywhere else in Thronemound. */
export const WORLD_UNIT_MM = 5;

/*
 * The bite, in millimetres, because the numbers that decide it are anatomical
 * and nobody thinks about a jaw in world units.
 *
 * The lab shipped with a brush radius of one world unit — a 10 mm bite, five
 * times the queen's mandible span — labelled "5 mm scoop" because the label
 * was quoting the radius rather than the width.
 */
export const BITE_WIDTH_MM = 4;
export const BITE_DEPTH_MM = 0.5;

/**
 * How finely the soil is sampled — the constraint the bite runs into.
 *
 * A brush cannot carve detail the field has nowhere to store. At the lab's
 * original 2.5 mm cells a 0.5 mm bite is a fifth of ONE sample, and lands as
 * a single ragged dent or as nothing. Quarter-millimetre cells make the bite
 * sixteen samples wide and two deep, which is enough to round properly.
 *
 * The WORLD shrinks to pay for that rather than the sample count growing, so
 * remesh cost stays in the same order. Sixteen millimetres is about three
 * ant-lengths — a dirt pile she would plausibly dig into — where the old
 * 120 mm mound was a hillside with the summit out of frame.
 */
export const CELL_MM = 0.25;
export const CELL_SIZE = CELL_MM / WORLD_UNIT_MM;
export const CELLS_X = 64;
export const CELLS_Y = 32;
export const CELLS_Z = 64;

export const BRUSH_RADIUS = BITE_WIDTH_MM / 2 / WORLD_UNIT_MM;
export const BITE_DEPTH = BITE_DEPTH_MM / WORLD_UNIT_MM;

/**
 * Volume of the drawn pellet per unit of radius cubed.
 *
 * The pellet is `CylinderGeometry(r, 0.92r, 1.45r, 8)` — an octagonal frustum,
 * not a sphere — so sizing it by a sphere-equivalent radius makes it hold the
 * wrong amount of soil. A regular octagon of circumradius r has area
 * 2*sqrt(2)*r^2, and the frustum rule h/3 * (A1 + A2 + sqrt(A1*A2)) gives the
 * rest. Derived rather than measured, so it follows the geometry if that is
 * ever retuned.
 */
export const PELLET_SOLIDITY = (() => {
  const a1 = 2 * Math.SQRT2;
  const a2 = 2 * Math.SQRT2 * 0.92 ** 2;
  return (1.45 / 3) * (a1 + a2 + Math.sqrt(a1 * a2));
})();

export const WORLD_WIDTH = CELLS_X * CELL_SIZE;
export const WORLD_HEIGHT = CELLS_Y * CELL_SIZE;
export const WORLD_DEPTH = CELLS_Z * CELL_SIZE;

/**
 * The test mound: a low rise with a little roughness, walled in by margins so
 * the soil is a closed blob rather than something running off the edge of the
 * field.
 *
 * Proportional to the world throughout. The original constants were tuned
 * against a 120 mm mound; left absolute they would put this summit five times
 * over the ceiling and fill the field solid. The roughness FREQUENCY scales
 * the other way — it is per world unit, so a smaller world needs a larger
 * number to keep the same look.
 */
export function makeMoundField(): DensityField {
  const field = new DensityField({
    cellsX: CELLS_X, cellsY: CELLS_Y, cellsZ: CELLS_Z, cellSize: CELL_SIZE,
  });
  const width = WORLD_WIDTH;
  const height = WORLD_HEIGHT;
  const depth = WORLD_DEPTH;
  const margin = CELL_SIZE * 1.5;

  field.fill((x, y, z) => {
    const nx = (x - width * 0.5) / (width * 0.5);
    const nz = (z - depth * 0.5) / (depth * 0.5);
    const radial = nx * nx + nz * nz;
    const rolling = height * 0.0175
      * Math.sin(x * (13.2 / width)) * Math.cos(z * (10.3 / depth));
    const summit = height * 0.4 + height * 0.28 * Math.exp(-radial * 2.45) + rolling;
    return Math.min(
      summit - y, y - margin, x - margin, width - margin - x,
      z - margin, depth - margin - z, height - margin - y,
    );
  });
  return field;
}
