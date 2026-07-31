/**
 * Procedural soil tiles, authored at ant scale.
 *
 * These are placeholders for the photographic pack, and they exist mainly to
 * pin the scale down in code: one tile covers TILE_VOXELS voxels, so at 5 mm
 * per voxel a tile is 4 cm of real ground. Every feature size below is quoted
 * in millimetres and converted, which means when real tiles arrive there is an
 * unambiguous target to match rather than "looks about right".
 *
 * Deterministic (seeded PRNG, no Math.random) so the output is testable, and
 * pure data — no three.js, no canvas — so it runs headlessly.
 */

import { CLAY, SAND, STONE, TOPSOIL, type VoxelId } from './VoxelWorld';

/** How many voxels one texture tile spans. 8 voxels x 5 mm = 4 cm. */
export const TILE_VOXELS = 8;
export const TILE_MM = TILE_VOXELS * 5;
/** Placeholder resolution. Real tiles are 512; this keeps first paint cheap. */
export const TILE_PX = 128;

export interface TileMaps {
  /** RGBA, sRGB. */
  albedo: Uint8Array;
  /** RGBA tangent-space normal, +Y up. */
  normal: Uint8Array;
  /** RGBA greyscale roughness. */
  rough: Uint8Array;
}

interface TileRecipe {
  /** Base colour, linear-ish sRGB bytes. */
  base: readonly [number, number, number];
  /** Per-pixel grain contrast, 0..1. */
  grain: number;
  /** Diameter range of clods/pebbles in millimetres. */
  clodMm: readonly [number, number];
  /** Clods per tile. The spec calls for 3-8 "hero" features. */
  clodCount: number;
  /** How much a clod shifts colour, -1 darker .. +1 lighter. */
  clodTone: number;
  /** Base roughness, 0 = mirror, 1 = fully diffuse. */
  rough: number;
  /** Hairline cracks per tile (stone/clay). */
  cracks: number;
}

/**
 * Base colours are sRGB bytes, because the albedo array is uploaded as an sRGB
 * texture and three.js decodes it to linear before lighting. The earlier
 * vertex-colour path fed linear values straight through, so naively reusing
 * those numbers here renders roughly half as bright — these are the same
 * intended colours passed back through the sRGB transfer function.
 */
const RECIPES: Record<number, TileRecipe> = {
  [TOPSOIL]: { base: [144, 120, 92], grain: 0.34, clodMm: [4, 9], clodCount: 7, clodTone: -0.3, rough: 0.95, cracks: 0 },
  [CLAY]: { base: [172, 125, 103], grain: 0.16, clodMm: [3, 7], clodCount: 4, clodTone: 0.18, rough: 0.72, cracks: 3 },
  [SAND]: { base: [211, 196, 161], grain: 0.42, clodMm: [2, 5], clodCount: 6, clodTone: 0.22, rough: 0.99, cracks: 0 },
  [STONE]: { base: [156, 156, 161], grain: 0.2, clodMm: [6, 12], clodCount: 5, clodTone: -0.22, rough: 0.85, cracks: 5 },
};

/** mulberry32 — small, fast, and repeatable across runs. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sized against the tile being generated, not against TILE_PX — a tile is
 * always TILE_MM of ground whatever its resolution, so a 4 mm clod on a
 * 512 px tile must cover four times the pixels it covers on a 128 px one.
 * At the default size this divides out to exactly the old arithmetic.
 */
function mmToPx(mm: number, size: number): number {
  return (mm / TILE_MM) * size;
}

/** Wrapped distance so clods straddling an edge tile seamlessly. */
function wrapDelta(a: number, b: number, size: number): number {
  let d = a - b;
  if (d > size / 2) d -= size;
  if (d < -size / 2) d += size;
  return d;
}

/**
 * Build one material's maps. Height is accumulated first, then differentiated
 * into a normal map, so relief and shading always agree.
 */
export function generateTile(voxel: VoxelId, size = TILE_PX, seed = voxel * 9176): TileMaps {
  const recipe = RECIPES[voxel] ?? RECIPES[TOPSOIL]!;
  const rand = prng(seed);
  const n = size * size;

  const height = new Float32Array(n);
  const tone = new Float32Array(n);

  // Grain: fine per-pixel noise, lightly blurred so it reads as particles
  // rather than television static.
  for (let i = 0; i < n; i++) {
    const v = rand();
    tone[i] = (v - 0.5) * recipe.grain;
    height[i] = v * 0.25;
  }
  const blurred = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const sx = (x + dx + size) % size;
          const sy = (y + dy + size) % size;
          sum += height[sy * size + sx]!;
        }
      }
      blurred[y * size + x] = sum / 9;
    }
  }
  height.set(blurred);

  // Clods / pebbles — the "hero" features. Sized in millimetres so they land
  // at 15-25% of tile width exactly as the texture spec requires.
  for (let c = 0; c < recipe.clodCount; c++) {
    const [minMm, maxMm] = recipe.clodMm;
    const radius = mmToPx(minMm + rand() * (maxMm - minMm), size) / 2;
    const cx = rand() * size;
    const cy = rand() * size;
    const strength = 0.5 + rand() * 0.5;
    const r2 = radius * radius;
    const minX = Math.floor(cx - radius) - 1;
    const maxX = Math.ceil(cx + radius) + 1;
    const minY = Math.floor(cy - radius) - 1;
    const maxY = Math.ceil(cy + radius) + 1;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = ((x % size) + size) % size;
        const py = ((y % size) + size) % size;
        const dx = wrapDelta(x, cx, size);
        const dy = wrapDelta(y, cy, size);
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const falloff = Math.sqrt(1 - d2 / r2); // domed, not flat-topped
        const i = py * size + px;
        height[i] = height[i]! + falloff * strength * 0.9;
        tone[i] = tone[i]! + falloff * recipe.clodTone * 0.55;
      }
    }
  }

  // Hairline cracks: random walks that cut down into the surface.
  for (let k = 0; k < recipe.cracks; k++) {
    let x = rand() * size;
    let y = rand() * size;
    let angle = rand() * Math.PI * 2;
    const steps = Math.floor(size * (0.5 + rand() * 0.8));
    for (let s = 0; s < steps; s++) {
      angle += (rand() - 0.5) * 0.45;
      x = (x + Math.cos(angle) + size) % size;
      y = (y + Math.sin(angle) + size) % size;
      const i = Math.floor(y) * size + Math.floor(x);
      height[i] = height[i]! - 0.55;
      tone[i] = tone[i]! - 0.3;
    }
  }

  const albedo = new Uint8Array(n * 4);
  const normal = new Uint8Array(n * 4);
  const rough = new Uint8Array(n * 4);
  const [br, bg, bb] = recipe.base;

  // Sobel on the height field -> tangent-space normal. Wrapped sampling keeps
  // the normal map seamless alongside the albedo.
  const h = (x: number, y: number) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)]!;
  const SCALE = 2.2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const o = i * 4;

      const shade = 1 + tone[i]!;
      albedo[o] = clampByte(br * shade);
      albedo[o + 1] = clampByte(bg * shade);
      albedo[o + 2] = clampByte(bb * shade);
      albedo[o + 3] = 255;

      const dx = (h(x + 1, y) - h(x - 1, y)) * SCALE;
      const dy = (h(x, y + 1) - h(x, y - 1)) * SCALE;
      let nx = -dx;
      let ny = -dy;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      normal[o] = clampByte((nx * 0.5 + 0.5) * 255);
      normal[o + 1] = clampByte((ny * 0.5 + 0.5) * 255);
      normal[o + 2] = clampByte((nz / len * 0.5 + 0.5) * 255);
      normal[o + 3] = 255;

      // Raised grains catch a little more light; recesses stay matte.
      const r = clampByte((recipe.rough - height[i]! * 0.08) * 255);
      rough[o] = r;
      rough[o + 1] = r;
      rough[o + 2] = r;
      rough[o + 3] = 255;
    }
  }

  return { albedo, normal, rough };
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** Voxel ids that get a texture layer, in layer order. Layer index === voxel id. */
export const TEXTURED_VOXELS: readonly VoxelId[] = [TOPSOIL, CLAY, SAND, STONE];

export interface TileArrays {
  albedo: Uint8Array<ArrayBuffer>;
  normal: Uint8Array<ArrayBuffer>;
  rough: Uint8Array<ArrayBuffer>;
  size: number;
  layers: number;
}

/**
 * Pack every material into one contiguous buffer per map, laid out for a
 * DataArrayTexture. Layer index equals the voxel id, so the mesher can write
 * the id straight into a vertex attribute with no lookup table.
 */
export function buildTileArrays(size = TILE_PX): TileArrays {
  const layers = Math.max(...TEXTURED_VOXELS) + 1;
  const stride = size * size * 4;
  const albedo = new Uint8Array(stride * layers);
  const normal = new Uint8Array(stride * layers);
  const rough = new Uint8Array(stride * layers);
  // Layer 0 is AIR and never sampled; leave it opaque mid-grey so a bug shows
  // up as flat grey rather than transparent black.
  albedo.fill(128, 0, stride);
  normal.fill(128, 0, stride);
  rough.fill(255, 0, stride);
  for (const voxel of TEXTURED_VOXELS) {
    const maps = generateTile(voxel, size);
    albedo.set(maps.albedo, voxel * stride);
    normal.set(maps.normal, voxel * stride);
    rough.set(maps.rough, voxel * stride);
  }
  return { albedo, normal, rough, size, layers };
}
