/**
 * Amanatides & Woo voxel traversal.
 *
 * Used instead of a three.js Raycaster against chunk meshes because it walks
 * the grid directly: it is independent of how many triangles exist, and it
 * returns the exact voxel hit AND the face normal — which is what "place a
 * block against the face I'm looking at" needs.
 */

import { AIR, isSolid, type VoxelId } from './VoxelWorld';

export interface VoxelHit {
  /** Voxel that was hit. */
  x: number;
  y: number;
  z: number;
  /** Face normal, pointing back toward the ray origin. */
  nx: number;
  ny: number;
  nz: number;
  distance: number;
  voxel: VoxelId;
}

interface Sampler {
  get(x: number, y: number, z: number): VoxelId;
}

export function raycastVoxel(
  world: Sampler,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistance: number,
): VoxelHit | null {
  const length = Math.hypot(dx, dy, dz);
  if (length === 0 || !Number.isFinite(length)) return null;
  const rx = dx / length;
  const ry = dy / length;
  const rz = dz / length;

  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);

  const stepX = rx > 0 ? 1 : rx < 0 ? -1 : 0;
  const stepY = ry > 0 ? 1 : ry < 0 ? -1 : 0;
  const stepZ = rz > 0 ? 1 : rz < 0 ? -1 : 0;

  // Distance along the ray between successive grid planes on each axis.
  const tDeltaX = stepX === 0 ? Infinity : Math.abs(1 / rx);
  const tDeltaY = stepY === 0 ? Infinity : Math.abs(1 / ry);
  const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(1 / rz);

  // Distance to the first plane crossing on each axis.
  let tMaxX = stepX === 0 ? Infinity : ((stepX > 0 ? x + 1 - ox : ox - x) / Math.abs(rx));
  let tMaxY = stepY === 0 ? Infinity : ((stepY > 0 ? y + 1 - oy : oy - y) / Math.abs(ry));
  let tMaxZ = stepZ === 0 ? Infinity : ((stepZ > 0 ? z + 1 - oz : oz - z) / Math.abs(rz));

  // Starting inside solid material counts as an immediate hit.
  const startVoxel = world.get(x, y, z);
  if (isSolid(startVoxel)) {
    return { x, y, z, nx: -stepX, ny: -stepY, nz: -stepZ, distance: 0, voxel: startVoxel };
  }

  let nx = 0;
  let ny = 0;
  let nz = 0;
  let travelled = 0;

  // Bounded so a ray escaping the volume can't spin forever.
  for (let guard = 0; guard < 4096; guard++) {
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      travelled = tMaxX;
      if (travelled > maxDistance) return null;
      x += stepX;
      tMaxX += tDeltaX;
      nx = -stepX; ny = 0; nz = 0;
    } else if (tMaxY < tMaxZ) {
      travelled = tMaxY;
      if (travelled > maxDistance) return null;
      y += stepY;
      tMaxY += tDeltaY;
      nx = 0; ny = -stepY; nz = 0;
    } else {
      travelled = tMaxZ;
      if (travelled > maxDistance) return null;
      z += stepZ;
      tMaxZ += tDeltaZ;
      nx = 0; ny = 0; nz = -stepZ;
    }

    const voxel = world.get(x, y, z);
    if (voxel !== AIR) {
      return { x, y, z, nx, ny, nz, distance: travelled, voxel };
    }
  }
  return null;
}
