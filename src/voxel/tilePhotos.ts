/**
 * The photographic tile pack — the "real tiles are 512" that the procedural
 * generator was always a placeholder for.
 *
 * Baked offline by scripts/bakeTiles.py from one seamless soil photograph and
 * served as plain PNGs, because a 512³ pack is ~2 MB the first paint should
 * not wait on. The loader returns a TileArrays shaped EXACTLY like
 * buildTileArrays() — same layer indexing, same layer count — so the material
 * can treat "procedural" and "photographic" as interchangeable sources.
 *
 * All-or-nothing on purpose: a pack where topsoil upgraded and clay did not
 * would show a resolution seam at every soil boundary, which looks worse than
 * either pack alone. Any failure returns null and the caller keeps what it
 * has. Stone is not photographed — rock is not soil — so its 512 layer comes
 * from the same procedural recipe, just at full resolution.
 */

import { type VoxelId } from './VoxelWorld';
import { TEXTURED_VOXELS, generateTile, type TileArrays } from './tileTextures';

/** Bake resolution. Must match scripts/bakeTiles.py. */
export const PHOTO_TILE_PX = 512;

/** Which layers have baked photographs, by file stem. */
const PHOTO_STEMS: Partial<Record<VoxelId, string>> = {
  1: 'topsoil',
  2: 'clay',
  3: 'sand',
};

/** Decode one PNG to raw RGBA bytes, byte-exact (no colour management). */
async function decodePng(url: string): Promise<Uint8ClampedArray | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    // colorSpaceConversion 'none': the normal and roughness maps are DATA,
    // and a colour-managed browser "helpfully" bending their bytes would tilt
    // every normal in the world by a little.
    const bitmap = await createImageBitmap(await res.blob(), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch {
    return null;
  }
}

/**
 * Fetch and assemble the full photographic pack, or null if ANY piece is
 * missing, undecodable, or the wrong size.
 */
export async function loadPhotoTileArrays(
  baseUrl = import.meta.env?.BASE_URL ?? '/',
): Promise<TileArrays | null> {
  if (typeof document === 'undefined' || typeof createImageBitmap === 'undefined') return null;
  const size = PHOTO_TILE_PX;
  const layers = Math.max(...TEXTURED_VOXELS) + 1;
  const stride = size * size * 4;
  const albedo = new Uint8Array(stride * layers);
  const normal = new Uint8Array(stride * layers);
  const rough = new Uint8Array(stride * layers);
  // Layer 0 is AIR and never sampled; opaque mid-grey so a bug shows up as
  // flat grey rather than transparent black — same convention as procedural.
  albedo.fill(128, 0, stride);
  normal.fill(128, 0, stride);
  rough.fill(255, 0, stride);

  for (const voxel of TEXTURED_VOXELS) {
    const stem = PHOTO_STEMS[voxel];
    if (!stem) {
      // Stone: the procedural recipe at photo resolution.
      const maps = generateTile(voxel, size);
      albedo.set(maps.albedo, voxel * stride);
      normal.set(maps.normal, voxel * stride);
      rough.set(maps.rough, voxel * stride);
      continue;
    }
    const [a, n, r] = await Promise.all([
      decodePng(`${baseUrl}tiles/${stem}_albedo.png`),
      decodePng(`${baseUrl}tiles/${stem}_normal.png`),
      decodePng(`${baseUrl}tiles/${stem}_rough.png`),
    ]);
    if (!a || !n || !r) return null;
    if (a.length !== stride || n.length !== stride || r.length !== stride) return null;
    albedo.set(a, voxel * stride);
    normal.set(n, voxel * stride);
    rough.set(r, voxel * stride);
  }
  return { albedo, normal, rough, size, layers };
}
