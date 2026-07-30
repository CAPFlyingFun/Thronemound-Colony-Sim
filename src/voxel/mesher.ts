/**
 * Face-culling chunk mesher with per-vertex ambient occlusion.
 *
 * Emits plain typed arrays rather than three.js geometry, so it can be tested
 * headlessly and so the renderer stays a thin adapter over it. Only faces that
 * border AIR are emitted — a fully buried chunk produces nothing at all, which
 * is what keeps a solid world essentially free to draw.
 */

import { AIR, CHUNK, isSolid, materialOf, type VoxelId } from './VoxelWorld';
import { TILE_VOXELS } from './tileTextures';

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /**
   * Texture coordinates in WORLD space divided by TILE_VOXELS, so the pattern
   * flows continuously across neighbouring voxels of the same material instead
   * of restarting on every cube face.
   */
  uvs: Float32Array;
  /** Texture-array layer per vertex; equals the voxel id. */
  layers: Float32Array;
  /** Face tangent (the +U direction), for tangent-space normal mapping. */
  tangents: Float32Array;
  indices: Uint32Array;
  quadCount: number;
}

interface Sampler {
  get(x: number, y: number, z: number): VoxelId;
}

type Vec3 = readonly [number, number, number];

interface Face {
  readonly normal: Vec3;
  /** Unit-cube corners in counter-clockwise order seen from outside. */
  readonly corners: readonly [Vec3, Vec3, Vec3, Vec3];
}

export const FACES: readonly Face[] = [
  { normal: [1, 0, 0], corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
  { normal: [-1, 0, 0], corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { normal: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { normal: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { normal: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { normal: [0, 0, -1], corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
];

/**
 * How far a CAVITY wall dishes back into the soil at its middle.
 *
 * Carried over from the hex room, which is the one thing that room did better
 * than this one: bow the middle of each exposed face away from the air and a
 * dug pocket reads as a rounded socket instead of six flat panels meeting at
 * hard creases.
 *
 * A cube's own geometry says 0.207 — the gap between a square cross-section's
 * half-width and its corner — which would take a one-voxel bore out to 1.41
 * voxels round. Far too much: the drawn wall would sit visibly behind where
 * collision stops you. This rounds the creases off without the cavity
 * ballooning, and at 0.6 mm the gap between drawn and solid is not noticeable.
 *
 * ALWAYS into the soil, never toward the air. Targeting is a DDA raycast and
 * collision is axis-separated AABBs, both against the true grid — geometry in
 * front of that plane is rock you can walk your face through.
 */
export const CAVITY_DISH = 0.16;
/** Subdivisions per axis on a dished face. Nine quads instead of one. */
export const DISH_CELLS = 3;
/**
 * Solid neighbours the AIR side needs before its wall is treated as a cavity.
 *
 * This is what keeps the open plain flat. The air above open ground has one
 * solid neighbour beneath it and nothing else, so it never qualifies; the air
 * inside a tunnel is walled on four or five sides and always does. It also
 * means only the faces you actually look at underground pay the subdivision —
 * dishing the whole world would multiply every visible quad by nine.
 */
export const CAVITY_ENCLOSURE = 3;

/** Brightness multiplier per AO level, darkest (fully enclosed corner) first. */
const AO_LEVELS = [0.45, 0.62, 0.8, 1.0] as const;

/** Cheap deterministic per-voxel jitter so soil reads as grain, not plastic. */
export function voxelTint(x: number, y: number, z: number): number {
  let h = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
  h = (h ^ (h >>> 13)) >>> 0;
  return 0.88 + (h % 1000) / 1000 * 0.24;
}

/**
 * Classic voxel AO: a vertex darkens with how many of the three neighbouring
 * voxels touching that corner are solid. Two opposite sides both solid is the
 * darkest case regardless of the corner.
 */
function aoLevel(side1: boolean, side2: boolean, corner: boolean): number {
  if (side1 && side2) return 0;
  return 3 - (Number(side1) + Number(side2) + Number(corner));
}

/** Axis indices other than the face's own axis. */
/** Shared with the fracture mesh, so both lay UVs out the same way. */
export function tangentAxes(normal: Vec3): [number, number] {
  if (normal[0] !== 0) return [1, 2];
  if (normal[1] !== 0) return [0, 2];
  return [0, 1];
}

export function meshChunk(
  world: Sampler,
  chunkX: number,
  chunkY: number,
  chunkZ: number,
): MeshData | null {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const layers: number[] = [];
  const tangents: number[] = [];
  const indices: number[] = [];
  let quadCount = 0;

  const baseX = chunkX * CHUNK;
  const baseY = chunkY * CHUNK;
  const baseZ = chunkZ * CHUNK;

  const offset = [0, 0, 0];
  const sample = (px: number, py: number, pz: number) => isSolid(world.get(px, py, pz));

  for (let ly = 0; ly < CHUNK; ly++) {
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const x = baseX + lx;
        const y = baseY + ly;
        const z = baseZ + lz;
        const voxel = world.get(x, y, z);
        if (voxel === AIR) continue;

        // Per-voxel brightness jitter breaks up large same-material faces. The
        // base colour now comes from the texture array, so vertex colour
        // carries only shading (AO x jitter) and multiplies over the albedo.
        const tint = voxelTint(x, y, z);

        for (const face of FACES) {
          const [nx, ny, nz] = face.normal;
          if (isSolid(world.get(x + nx, y + ny, z + nz))) continue;

          const [axisA, axisB] = tangentAxes(face.normal);
          const first = positions.length / 3;
          const ao: number[] = [];

          // Tangent points along axisA, which is exactly how UVs are laid out
          // below — so the normal map's +X lines up with the texture's +U.
          const tangent: [number, number, number] = [0, 0, 0];
          tangent[axisA] = 1;

          /*
           * Is the air on the other side a CAVITY, or open sky?
           *
           * Counted on the AIR voxel, not this one: a tunnel's air is walled on
           * most sides, open ground's air has only the floor under it. Cheap —
           * six samples, and only for faces that are actually emitted.
           */
          let enclosure = 0;
          for (const probe of FACES) {
            if (sample(
              x + nx + probe.normal[0],
              y + ny + probe.normal[1],
              z + nz + probe.normal[2],
            )) enclosure++;
          }
          const dish = enclosure >= CAVITY_ENCLOSURE ? CAVITY_DISH : 0;

          for (const corner of face.corners) {
            const wx = x + corner[0];
            const wy = y + corner[1];
            const wz = z + corner[2];
            positions.push(wx, wy, wz);
            normals.push(nx, ny, nz);
            layers.push(voxel);
            tangents.push(tangent[0], tangent[1], tangent[2]);
            // World-space UVs: neighbouring voxels of one material read as a
            // single continuous surface, and one tile spans TILE_VOXELS.
            const world = [wx, wy, wz] as const;
            uvs.push(world[axisA]! / TILE_VOXELS, world[axisB]! / TILE_VOXELS);

            // Corner components are 0/1; map to -1/+1 offsets in the face plane.
            const da = corner[axisA] === 1 ? 1 : -1;
            const db = corner[axisB] === 1 ? 1 : -1;

            offset[0] = x + nx; offset[1] = y + ny; offset[2] = z + nz;
            const sideA = (() => {
              const p = [offset[0]!, offset[1]!, offset[2]!];
              p[axisA] = p[axisA]! + da;
              return sample(p[0]!, p[1]!, p[2]!);
            })();
            const sideB = (() => {
              const p = [offset[0]!, offset[1]!, offset[2]!];
              p[axisB] = p[axisB]! + db;
              return sample(p[0]!, p[1]!, p[2]!);
            })();
            const diagonal = (() => {
              const p = [offset[0]!, offset[1]!, offset[2]!];
              p[axisA] = p[axisA]! + da;
              p[axisB] = p[axisB]! + db;
              return sample(p[0]!, p[1]!, p[2]!);
            })();

            const level = aoLevel(sideA, sideB, diagonal);
            ao.push(level);
            const shade = AO_LEVELS[level]! * tint;
            colors.push(shade, shade, shade);
          }

          if (dish > 0) {
            /*
             * Subdivide and bow the middle in.
             *
             * The four corner vertices just pushed stay exactly where they are —
             * the dish falls to zero along every edge, so neighbouring faces
             * still meet vertex for vertex. Carrying it into the edges would
             * inset this face from its neighbours and open a hairline slit at
             * every corner of every tunnel, which you can see straight through.
             *
             * Interior samples are bilinear across the quad: position, UV and
             * AO alike, so the shading follows the geometry rather than being
             * recomputed per sample against neighbours that have not changed.
             */
            const c = face.corners;
            const lerp3 = (u: number, v: number, axis: number) => (
              (c[0][axis]! * (1 - u) + c[1][axis]! * u) * (1 - v)
              + (c[3][axis]! * (1 - u) + c[2][axis]! * u) * v
            );
            const aoAt = (u: number, v: number) => (
              (ao[0]! * (1 - u) + ao[1]! * u) * (1 - v)
              + (ao[3]! * (1 - u) + ao[2]! * u) * v
            );
            /*
             * The quad's own edge vectors, for the surface tangents below.
             * Taken from the corners rather than from the axis indices, because
             * some faces traverse their in-plane axes backwards and the sign
             * matters for the cross product.
             */
            const dU = [c[1][0] - c[0][0], c[1][1] - c[0][1], c[1][2] - c[0][2]];
            const dV = [c[3][0] - c[0][0], c[3][1] - c[0][1], c[3][2] - c[0][2]];
            const gridFirst = positions.length / 3;
            for (let iv = 0; iv <= DISH_CELLS; iv++) {
              for (let iu = 0; iu <= DISH_CELLS; iu++) {
                const u = iu / DISH_CELLS;
                const v = iv / DISH_CELLS;
                // Zero on every edge, full at the middle. Backwards along the
                // normal, so the wall recedes into the soil and never toward
                // the player.
                const back = dish * Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
                const wx = x + lerp3(u, v, 0) - nx * back;
                const wy = y + lerp3(u, v, 1) - ny * back;
                const wz = z + lerp3(u, v, 2) - nz * back;
                positions.push(wx, wy, wz);

                /*
                 * Normals have to FOLLOW the dish, or none of it is visible.
                 *
                 * This is the bug that made the whole thing look like it had
                 * not been applied: every subdivided vertex kept the flat face
                 * normal, so the geometry curved while the shading stayed
                 * uniform — and a wall seen face-on is nothing BUT its shading.
                 * The silhouette bent, which you can only notice at a grazing
                 * angle, and the surface read exactly as square as before.
                 *
                 * Differentiating the displacement analytically: the surface is
                 * the flat quad minus n * dish * sin(pi u) * sin(pi v), so each
                 * tangent picks up a term along the normal.
                 */
                const du = -dish * Math.PI * Math.cos(Math.PI * u) * Math.sin(Math.PI * v);
                const dv = -dish * Math.PI * Math.sin(Math.PI * u) * Math.cos(Math.PI * v);
                const tu = [dU[0]! - nx * du, dU[1]! - ny * du, dU[2]! - nz * du];
                const tv = [dV[0]! - nx * dv, dV[1]! - ny * dv, dV[2]! - nz * dv];
                let cx2 = tu[1]! * tv[2]! - tu[2]! * tv[1]!;
                let cy2 = tu[2]! * tv[0]! - tu[0]! * tv[2]!;
                let cz2 = tu[0]! * tv[1]! - tu[1]! * tv[0]!;
                // Point it the same way the face does; corner winding decides
                // which way the cross product came out.
                if (cx2 * nx + cy2 * ny + cz2 * nz < 0) {
                  cx2 = -cx2; cy2 = -cy2; cz2 = -cz2;
                }
                const len = Math.hypot(cx2, cy2, cz2) || 1;
                const rx = cx2 / len;
                const ry = cy2 / len;
                const rz = cz2 / len;
                normals.push(rx, ry, rz);
                layers.push(voxel);
                /*
                 * Tangent re-orthogonalised against the DISHED normal.
                 *
                 * Tangent-space normal mapping assumes the tangent is
                 * perpendicular to the shading normal. Once the normal follows
                 * the curve, the flat face tangent no longer is, and every
                 * normal-mapped detail on a dished wall is lit off a skewed
                 * basis. One Gram-Schmidt step fixes it.
                 */
                const tdot = tangent[0] * rx + tangent[1] * ry + tangent[2] * rz;
                const ox = tangent[0] - rx * tdot;
                const oy = tangent[1] - ry * tdot;
                const oz = tangent[2] - rz * tdot;
                const olen = Math.hypot(ox, oy, oz) || 1;
                tangents.push(ox / olen, oy / olen, oz / olen);
                const w = [wx, wy, wz] as const;
                uvs.push(w[axisA]! / TILE_VOXELS, w[axisB]! / TILE_VOXELS);
                const shade = AO_LEVELS[Math.round(aoAt(u, v))]! * tint;
                colors.push(shade, shade, shade);
              }
            }
            const stride = DISH_CELLS + 1;
            for (let iv = 0; iv < DISH_CELLS; iv++) {
              for (let iu = 0; iu < DISH_CELLS; iu++) {
                const a = gridFirst + iv * stride + iu;
                indices.push(a, a + 1, a + stride + 1, a, a + stride + 1, a + stride);
                quadCount++;
              }
            }
            continue;
          }

          // Flip the split so the darker corner pair shares the seam; without
          // this, AO gradients crease diagonally across the quad.
          const flip = ao[0]! + ao[2]! > ao[1]! + ao[3]!;
          if (flip) {
            indices.push(first + 1, first + 2, first + 3, first + 1, first + 3, first);
          } else {
            indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
          }
          quadCount++;
        }
      }
    }
  }

  if (quadCount === 0) return null;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    uvs: new Float32Array(uvs),
    layers: new Float32Array(layers),
    tangents: new Float32Array(tangents),
    indices: new Uint32Array(indices),
    quadCount,
  };
}
