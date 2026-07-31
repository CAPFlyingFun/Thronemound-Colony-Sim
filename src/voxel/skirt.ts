/**
 * The ground OUTSIDE the glass.
 *
 * The world is a 64 cm tank and the ant is 6 mm long, so the walls are a couple
 * of body lengths away and she spends most of her time looking through them.
 * Until now what she saw through them was nothing: the terrain stopped dead at
 * the world bounds and the horizon was the inside of a skybox. A formicarium on
 * a table would at least have a table.
 *
 * This is the same height field carried on past the walls — not a second
 * landscape that has to be kept in step with the first. It reads
 * `groundHeight`, which is exactly zero-affected by distance inside the box and
 * grows a much larger relief outside it, so the join at the glass is the same
 * number on both sides by construction rather than by tuning.
 *
 * Not voxels. Nothing out there can be dug, walked on, or collided with, so
 * paying voxel memory and a chunk mesher for it would be paying for six
 * capabilities to get one. It is a plain height-field mesh, built once, and it
 * covers about five metres in every direction for a tenth of the triangles one
 * chunk of soil costs.
 *
 * No three.js, so the shape can be checked without a renderer.
 */

import { TILE_VOXELS } from './tileTextures';
import { TOPSOIL } from './VoxelWorld';
import { groundHeight, type TerrainOptions } from './terrain';

/**
 * How far out the ground goes, in voxels. 220 is 1.1 metres.
 *
 * Sized against the FOG rather than against the map. The scene fogs out
 * completely at 150 voxels and the camera never leaves a 128-voxel tank, so
 * every triangle past about 215 voxels from a wall is drawn in pure sky colour
 * whatever is on it. Reaching further would be paying triangles to move a
 * horizon that is already invisible; if the fog is ever opened up, this is the
 * number that follows it out.
 */
export const SKIRT_REACH = 220;

/**
 * Spacing of the sample lines that cross the world, in voxels.
 *
 * These decide how finely the strips ALONG each wall are cut, which is the
 * resolution she actually sees — the near ground, a few centimetres past the
 * glass. One centimetre a quad.
 */
export const SKIRT_TREAD = 2;

/** How fast the rings coarsen going out. Detail where she is, not at the edge. */
export const SKIRT_GROWTH = 1.16;

/**
 * How far the ground is cut away where it meets the glass, and over what.
 *
 * The tank is BEDDED into the ground rather than balanced on top of it, which
 * is both what a real formicarium in soil looks like and the honest fix for a
 * seam that cannot be made exact: inside the walls the surface is a field of
 * flat-topped cells, outside it is an interpolated mesh, and between two sample
 * lines the mesh rises above the cell top it is supposed to meet. Sinking the
 * outside edge by more than that gap can ever be turns a poke-through into a
 * trench at the foot of the glass, where the timber frame already is.
 */
export const SKIRT_TUCK = 0.6;
const TUCK_FADE = 16;

export interface SkirtMesh {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  uvs: Float32Array;
  layers: Float32Array;
  tangents: Float32Array;
  indices: Uint32Array;
  /** Triangles emitted, for tests and for the debug readout. */
  triangleCount: number;
}

/**
 * Where the grid lines fall, on one axis, sorted.
 *
 * Even spacing across the world so the strips along the walls are cut finely,
 * then rings marching outward at a growing step. One list per axis and the same
 * list for both, because the box is square and two lists would be two things
 * meaning one number.
 */
export function skirtLines(size: number, reach = SKIRT_REACH): number[] {
  const lines: number[] = [];
  for (let v = 0; v < size; v += SKIRT_TREAD) lines.push(v);
  lines.push(size);
  let step = SKIRT_TREAD;
  let out = 0;
  while (out < reach) {
    out += step;
    lines.push(-out, size + out);
    step *= SKIRT_GROWTH;
  }
  return lines.sort((a, b) => a - b);
}

/** How far this point is bedded below the true ground, fading with distance. */
export function skirtTuck(x: number, z: number, size: number): number {
  const beyond = Math.max(0, -x, x - size, -z, z - size);
  return SKIRT_TUCK * Math.max(0, 1 - beyond / TUCK_FADE);
}

/** The height the skirt is drawn at — the world's own field, bedded in. */
export function skirtHeight(x: number, z: number, opts: TerrainOptions): number {
  return groundHeight(x, z, opts) - skirtTuck(x, z, opts.size);
}

/** Is this quad entirely inside the tank, where the real voxel terrain is? */
function insideWorld(x0: number, x1: number, z0: number, z1: number, size: number): boolean {
  return x0 >= 0 && x1 <= size && z0 >= 0 && z1 <= size;
}

export function buildSkirt(opts: TerrainOptions): SkirtMesh {
  const lines = skirtLines(opts.size);
  const n = lines.length;
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const layers: number[] = [];
  const tangents: number[] = [];
  const indices: number[] = [];

  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = lines[ix]!;
      const z = lines[iz]!;
      const y = skirtHeight(x, z, opts);
      positions.push(x, y, z);

      /*
       * The normal from the field's own slope, sampled at the spacing of the
       * grid rather than at some fixed epsilon.
       *
       * A fixed epsilon would read the noise between two samples the mesh never
       * visits, and light a facet that is not the facet being drawn — the
       * distant rings are tens of voxels across and the ground inside one of
       * them is not flat. Differencing over the same span the quad covers makes
       * the shading agree with the geometry.
       */
      const dx = (lines[Math.min(n - 1, ix + 1)]! - lines[Math.max(0, ix - 1)]!) / 2 || 1;
      const dz = (lines[Math.min(n - 1, iz + 1)]! - lines[Math.max(0, iz - 1)]!) / 2 || 1;
      const gx = (skirtHeight(x + dx, z, opts) - skirtHeight(x - dx, z, opts)) / (2 * dx);
      const gz = (skirtHeight(x, z + dz, opts) - skirtHeight(x, z - dz, opts)) / (2 * dz);
      const len = Math.hypot(gx, 1, gz);
      const ny = 1 / len;
      normals.push(-gx / len, ny, -gz / len);

      /*
       * Tangent along +X, laid on the surface — the same direction the UVs run,
       * which is what tangent-space normal mapping assumes. Taken from the
       * slope rather than from the world axis, or the normal map on a hillside
       * would be lit off a basis lying flat while the surface tilts under it.
       */
      const tl = Math.hypot(1, gx) || 1;
      tangents.push(1 / tl, gx / tl, 0);

      /*
       * The SAME uv convention the mesher uses for its +Y faces: world x and z
       * over TILE_VOXELS. That is what makes the dirt run straight out from
       * under the glass instead of restarting at the wall.
       */
      uvs.push(x / TILE_VOXELS, z / TILE_VOXELS);
      layers.push(TOPSOIL);

      // Flat ground brighter, slopes darker — a stand-in for the per-vertex AO
      // the mesher computes from voxel neighbours, which do not exist out here.
      const shade = 0.7 + 0.3 * ny;
      colors.push(shade, shade, shade);
    }
  }

  for (let iz = 0; iz + 1 < n; iz++) {
    for (let ix = 0; ix + 1 < n; ix++) {
      /*
       * The hole in the middle. Everything inside the walls is real voxel soil
       * that can be dug out, and a sheet stretched under it would show through
       * the moment she opened a pit.
       */
      if (insideWorld(lines[ix]!, lines[ix + 1]!, lines[iz]!, lines[iz + 1]!, opts.size)) continue;
      const a = iz * n + ix;
      const b = a + 1;
      const c = a + n + 1;
      const d = a + n;
      // Wound counter-clockwise seen from above, matching the +Y faces of the
      // soil so one material lights both without a two-sided pass.
      indices.push(a, c, b, a, d, c);
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    uvs: new Float32Array(uvs),
    layers: new Float32Array(layers),
    tangents: new Float32Array(tangents),
    indices: new Uint32Array(indices),
    triangleCount: indices.length / 3,
  };
}
