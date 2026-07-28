/**
 * Face-culling chunk mesher with per-vertex ambient occlusion.
 *
 * Emits plain typed arrays rather than three.js geometry, so it can be tested
 * headlessly and so the renderer stays a thin adapter over it. Only faces that
 * border AIR are emitted — a fully buried chunk produces nothing at all, which
 * is what keeps a solid world essentially free to draw.
 */

import { AIR, CHUNK, isSolid, materialOf, type VoxelId } from './VoxelWorld';

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
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
function tangentAxes(normal: Vec3): [number, number] {
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

        const material = materialOf(voxel);
        const tint = voxelTint(x, y, z);
        const [br, bg, bb] = material.color;

        for (const face of FACES) {
          const [nx, ny, nz] = face.normal;
          if (isSolid(world.get(x + nx, y + ny, z + nz))) continue;

          const [axisA, axisB] = tangentAxes(face.normal);
          const first = positions.length / 3;
          const ao: number[] = [];

          for (const corner of face.corners) {
            positions.push(x + corner[0], y + corner[1], z + corner[2]);
            normals.push(nx, ny, nz);

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
            colors.push(br * shade, bg * shade, bb * shade);
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
    indices: new Uint32Array(indices),
    quadCount,
  };
}
