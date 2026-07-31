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

/*
 * 64 x 32 x 64 mm of soil, sixteen times the footprint the lab started with.
 *
 * The cap here is MEMORY, not speed — remeshing is chunked now, so a tap costs
 * the bite rather than the world. This field is 8.5 million samples at four
 * bytes, which is 34 MB and comfortable on a phone. The same quarter-
 * millimetre cells stretched over the real 640 mm tank would be 1.6 billion
 * samples and 6.3 GB, so the finished game cannot hold ant-scale detail
 * everywhere at once — it will want coarse soil away from the digging and fine
 * soil only where she has actually been. That is the next thing this lab
 * should answer, and it is a different question from the one it answers now.
 */
export const CELLS_X = 256;
export const CELLS_Y = 128;
export const CELLS_Z = 256;

/**
 * Cells per side of a remesh chunk — 8 mm at this cell size.
 *
 * Two competing costs. Smaller chunks remesh less per bite but cost a draw
 * call each; larger ones do the reverse. A 4 mm bite spans sixteen cells, so
 * at 32 it touches two chunks per axis at worst, and only the shell of chunks
 * that actually contains surface ever gets a mesh at all.
 */
export const CHUNK_CELLS = 32;

export const BRUSH_RADIUS = BITE_WIDTH_MM / 2 / WORLD_UNIT_MM;
export const BITE_DEPTH = BITE_DEPTH_MM / WORLD_UNIT_MM;

/**
 * How rough a clod is: each vertex is pushed in or out by up to this fraction
 * of the radius. Enough to read as broken earth, not so much that the pellet
 * stops looking like one lump.
 */
export const CLOD_ROUGHNESS = 0.17;

/** How much a clod is flattened along its own Y, so it sits rather than rolls. */
export const CLOD_SQUASH = 0.86;

/**
 * A look adjustment on the drawn pellet, and the one number here that is NOT
 * derived from anything.
 *
 * A clod sized to hold what a 4 mm x 0.5 mm scrape removes comes out about
 * 2.9 mm across, which next to a 9 mm queen is a third of her body — asked to
 * be halved, and halved it is. Radius scales as the cube root of volume, so a
 * half-size clod holds an EIGHTH of what the bite took: the pellets no longer
 * carry the soil away, and roughly seven eighths of every scrape simply
 * vanishes.
 *
 * That is a real property being given up, not a rounding, so it lives behind
 * its own name rather than being folded into `PELLET_SOLIDITY` where it would
 * read as part of the geometry. Two ways to get it back if it is ever wanted:
 * drop the bite to about 0.06 mm deep, which makes 1.5 mm the honest size, or
 * spawn eight clods a bite instead of one.
 */
export const CLOD_DISPLAY_SCALE = 0.5;

/**
 * Volume of the drawn pellet per unit of radius cubed.
 *
 * The pellet used to be `CylinderGeometry(r, 0.92r, 1.45r, 8)` — an octagonal
 * TUBE, which is what it looked like: a little drum of dirt. It is a knobbly
 * solid now (see `clodGeometry`), and this is the number that keeps it honest,
 * because the pellet is sized so that it HOLDS the soil that was removed and
 * that sizing needs to know the shape's real volume.
 *
 * A regular icosahedron of circumradius r encloses (5/12)(3 + sqrt5) * a^3
 * where a is its edge, and a = r * 4 / sqrt(10 + 2*sqrt5). Roughening moves
 * vertices both ways by the same amount, so to first order it cancels and the
 * base solid is the right measure. The squash is a linear scale on one axis and
 * so scales the volume by exactly itself — it used to be applied to the drawn
 * shape and left out of this, which quietly made every pellet hold 14% less
 * than it claimed. Derived rather than measured, so it follows the geometry if
 * that is ever retuned.
 */
export const PELLET_SOLIDITY = (() => {
  const edge = 4 / Math.sqrt(10 + 2 * Math.sqrt(5));
  return (5 / 12) * (3 + Math.sqrt(5)) * edge ** 3 * CLOD_SQUASH;
})();

/**
 * The displacement for one corner, keyed to a seed rather than to Math.random
 * so a clod looks the same every time it is rebuilt and two clods look
 * different from each other.
 */
export function clodJitter(seed: number, index: number): number {
  const h = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return 1 + (h - Math.floor(h) - 0.5) * 2 * CLOD_ROUGHNESS;
}

/*
 * The twelve corners of a regular icosahedron, and the twenty faces over them.
 *
 * Written out here rather than taken from `THREE.IcosahedronGeometry`, and that
 * is the entire fix for clods that looked "not solid, fractured". Three.js
 * builds its platonic solids NON-INDEXED: sixty vertices for twelve corners,
 * each corner duplicated once per touching face. Roughening by vertex index
 * therefore gave the five copies of every corner five DIFFERENT displacements,
 * so the twenty triangles pulled away from each other and the pellet came apart
 * into loose shards. Measured: 60 positions, 12 distinct directions, 5 copies
 * of each.
 *
 * Indexed, a corner is one number and moving it moves every face that uses it,
 * so the solid stays a solid by construction rather than by everyone
 * remembering to weld. Flat shading still gives the facets — that was never
 * what was broken.
 */
const PHI = (1 + Math.sqrt(5)) / 2;
const ICOSA_CORNERS: ReadonlyArray<readonly [number, number, number]> = [
  [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
  [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
  [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
];
const ICOSA_FACES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

export interface ClodGeometry {
  positions: Float32Array;
  indices: Uint16Array;
}

/**
 * One clod, as an indexed solid of unit circumradius.
 *
 * Free of three.js on purpose, so the shape can be checked for closure,
 * winding and volume without a renderer — a pellet has to hold what the bite
 * removed, and that is arithmetic, not art.
 *
 * Each corner is pushed along its own direction, which keeps the solid
 * star-shaped about its centre: no face can fold through another however the
 * seed lands, so there is no roughness value that turns a clod inside out.
 */
export function clodGeometry(seed: number): ClodGeometry {
  const positions = new Float32Array(ICOSA_CORNERS.length * 3);
  for (let i = 0; i < ICOSA_CORNERS.length; i += 1) {
    const corner = ICOSA_CORNERS[i]!;
    const length = Math.hypot(corner[0], corner[1], corner[2]);
    const scale = clodJitter(seed, i) / length;
    positions[i * 3] = corner[0] * scale;
    positions[i * 3 + 1] = corner[1] * scale * CLOD_SQUASH;
    positions[i * 3 + 2] = corner[2] * scale;
  }
  const indices = new Uint16Array(ICOSA_FACES.length * 3);
  for (let f = 0; f < ICOSA_FACES.length; f += 1) {
    const face = ICOSA_FACES[f]!;
    indices[f * 3] = face[0];
    indices[f * 3 + 1] = face[1];
    indices[f * 3 + 2] = face[2];
  }
  return { positions, indices };
}

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
