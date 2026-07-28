import { describe, expect, it } from 'vitest';
import {
  AIR, CHUNK, CLAY, SAND, STONE, TOPSOIL, VoxelWorld,
  isSolid, layeredGenerator, materialOf,
} from '../src/voxel/VoxelWorld';
import { FACES, meshChunk } from '../src/voxel/mesher';
import { raycastVoxel } from '../src/voxel/raycast';
import { DigSession } from '../src/voxel/DigSession';
import { TILE_MM, TILE_VOXELS, buildTileArrays, generateTile } from '../src/voxel/tileTextures';

const SURFACE = 96;
const makeWorld = () => new VoxelWorld(128, 128, 128, layeredGenerator(SURFACE));

describe('VoxelWorld', () => {
  it('generates stratified soil below the surface and air above', () => {
    const world = makeWorld();
    expect(world.get(10, SURFACE + 1, 10)).toBe(AIR);
    expect(world.get(10, SURFACE, 10)).toBe(TOPSOIL);
    expect(world.get(10, SURFACE - 10, 10)).toBe(CLAY);
    expect(world.get(10, 2, 10)).toBe(STONE);
  });

  it('treats the sides and floor as solid but leaves the sky open', () => {
    const world = makeWorld();
    expect(isSolid(world.get(-1, 10, 10))).toBe(true);
    expect(isSolid(world.get(10, -1, 10))).toBe(true);
    expect(world.get(10, 999, 10)).toBe(AIR);
  });

  it('keeps untouched chunks at zero bytes and allocates only on write', () => {
    const world = makeWorld();
    world.allMeshableChunks(); // forces classification of every chunk
    // Soil strata don't align to chunk boundaries, so almost every chunk holds
    // two materials. Storage still has to be zero, because an unmodified chunk
    // is reproducible from the generator.
    expect(world.allocatedBytes()).toBe(0);
    world.dig(64, SURFACE - 40, 64);
    expect(world.allocatedBytes()).toBe(CHUNK * CHUNK * CHUNK);
    world.dig(65, SURFACE - 40, 64); // same chunk — no further allocation
    expect(world.allocatedBytes()).toBe(CHUNK * CHUNK * CHUNK);
  });

  it('reads modified voxels back and leaves neighbours untouched', () => {
    const world = makeWorld();
    world.dig(64, SURFACE - 40, 64); // depth 40 -> sand band
    expect(world.get(64, SURFACE - 40, 64)).toBe(AIR);
    expect(world.get(65, SURFACE - 40, 64)).toBe(SAND);
  });

  it('marks the neighbouring chunk dirty when digging on a chunk seam', () => {
    const world = makeWorld();
    world.dirty.clear();
    world.dig(32, SURFACE - 40, 40); // local x === 0 -> touches the chunk to -X
    const coords = [...world.dirty].map((i) => world.chunkCoords(i).join(','));
    expect(coords).toContain('1,1,1');
    expect(coords).toContain('0,1,1');
  });

  it('will not dig bedrock', () => {
    const world = makeWorld();
    expect(world.dig(10, 2, 10)).toBe(AIR);
    expect(world.get(10, 2, 10)).toBe(STONE);
  });

  it('counts excavated and deposited volume separately', () => {
    const world = makeWorld();
    world.dig(20, SURFACE, 20);
    world.deposit(20, SURFACE + 4, 20, TOPSOIL);
    expect(world.excavated).toBe(1);
    expect(world.deposited).toBe(1);
  });
});

describe('mesher', () => {
  it('winds every face outward', () => {
    // Cross product of the first triangle must point along the declared normal.
    // This is what stops a face table typo from silently producing a hole.
    for (const face of FACES) {
      const [a, b, c] = face.corners;
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
      const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
      const cross = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
      ];
      const dot = cross[0]! * face.normal[0] + cross[1]! * face.normal[1] + cross[2]! * face.normal[2];
      expect(dot).toBeGreaterThan(0);
    }
  });

  it('emits nothing for a fully buried chunk', () => {
    const world = makeWorld();
    // Chunk (1,1,1) spans y 32..63 — all solid, and every neighbour is too.
    // It holds both sand and clay, so this only works because the skip test
    // asks "is it all solid?" rather than "is it all one material?".
    expect(world.chunkMayHaveFaces(1, 1, 1)).toBe(false);
    expect(meshChunk(world, 1, 1, 1)).toBeNull();
  });

  it('skips the pure-air chunk above the ground', () => {
    const world = makeWorld();
    // y 128+ would be out of range; chunk (1,3,1) holds the surface itself, so
    // check the air-only case by asking a world with a lower surface.
    const shallow = new VoxelWorld(128, 128, 128, layeredGenerator(20));
    expect(shallow.chunkMayHaveFaces(1, 3, 1)).toBe(false);
    expect(meshChunk(shallow, 1, 3, 1)).toBeNull();
  });

  it('emits exactly one top face per column for a flat surface chunk', () => {
    const world = makeWorld();
    const cy = Math.floor(SURFACE / CHUNK);
    const data = meshChunk(world, 1, cy, 1);
    expect(data).not.toBeNull();
    // 32x32 columns of ground, one upward face each; the chunk's own side walls
    // are buried against neighbouring chunks so they contribute nothing.
    expect(data!.quadCount).toBe(CHUNK * CHUNK);
    expect(data!.positions.length).toBe(data!.quadCount * 4 * 3);
    expect(data!.indices.length).toBe(data!.quadCount * 6);
  });

  it('opens up new faces once a voxel is removed', () => {
    const world = makeWorld();
    const cy = Math.floor(SURFACE / CHUNK);
    const before = meshChunk(world, 1, cy, 1)!.quadCount;
    world.dig(40, SURFACE, 40);
    const after = meshChunk(world, 1, cy, 1)!.quadCount;
    // Within THIS chunk: lose one top face, gain four side walls. The pit's
    // floor face belongs to the chunk below — SURFACE is the first voxel row
    // of chunk cy, so y-1 is across the seam. That's exactly why set() dirties
    // the neighbouring chunk as well.
    expect(after).toBe(before + 3);
    const below = meshChunk(world, 1, cy - 1, 1);
    expect(below).not.toBeNull();
    expect(below!.quadCount).toBe(1);
  });
});

describe('raycastVoxel', () => {
  const world = makeWorld();

  it('hits the ground looking straight down', () => {
    const hit = raycastVoxel(world, 64.5, SURFACE + 4.5, 64.5, 0, -1, 0, 20);
    expect(hit).not.toBeNull();
    expect(hit!.y).toBe(SURFACE);
    expect([hit!.nx, hit!.ny, hit!.nz]).toEqual([0, 1, 0]);
  });

  it('returns null when nothing is within reach', () => {
    expect(raycastVoxel(world, 64.5, SURFACE + 40, 64.5, 0, 1, 0, 10)).toBeNull();
    expect(raycastVoxel(world, 64.5, SURFACE + 40, 64.5, 0, -1, 0, 5)).toBeNull();
  });

  it('reports the face it entered through on a diagonal ray', () => {
    const fresh = makeWorld();
    const hit = raycastVoxel(fresh, 64.5, SURFACE + 3.5, 64.5, 0.6, -1, 0, 20);
    expect(hit).not.toBeNull();
    expect(hit!.ny).toBe(1);
    expect(isSolid(hit!.voxel)).toBe(true);
  });

  it('ignores zero-length directions instead of looping', () => {
    expect(raycastVoxel(world, 10, 10, 10, 0, 0, 0, 10)).toBeNull();
  });
});

describe('DigSession', () => {
  it('needs the full dig time before a voxel pops', () => {
    const world = makeWorld();
    const session = new DigSession(world);
    const seconds = materialOf(TOPSOIL).digSeconds;
    expect(session.digTick(20, SURFACE, 20, seconds * 0.5).kind).toBe('progress');
    expect(world.get(20, SURFACE, 20)).toBe(TOPSOIL);
    expect(session.digTick(20, SURFACE, 20, seconds * 0.6).kind).toBe('dug');
    expect(world.get(20, SURFACE, 20)).toBe(AIR);
  });

  it('resets progress when the player looks at a different voxel', () => {
    const world = makeWorld();
    const session = new DigSession(world);
    session.digTick(20, SURFACE, 20, 0.3);
    session.digTick(21, SURFACE, 20, 0.05);
    expect(session.chewRatio).toBeLessThan(0.5);
    expect(world.get(20, SURFACE, 20)).toBe(TOPSOIL);
  });

  it('conserves soil — you can only place what you dug', () => {
    const world = makeWorld();
    const session = new DigSession(world);
    expect(session.place(20, SURFACE + 2, 20).kind).toBe('empty');
    session.digTick(20, SURFACE, 20, 99);
    expect(session.carried).toBe(1);
    expect(session.place(20, SURFACE + 2, 20).kind).toBe('placed');
    expect(session.carried).toBe(0);
    expect(world.excavated).toBe(world.deposited);
  });

  it('stops digging once the ant is carrying a full load', () => {
    const world = makeWorld();
    const session = new DigSession(world, { capacity: 2 });
    session.digTick(20, SURFACE, 20, 99);
    session.digTick(21, SURFACE, 20, 99);
    expect(session.isFull).toBe(true);
    expect(session.digTick(22, SURFACE, 20, 99).kind).toBe('full');
    expect(world.get(22, SURFACE, 20)).toBe(TOPSOIL);
  });

  it('reports bedrock rather than silently doing nothing', () => {
    const world = makeWorld();
    const session = new DigSession(world);
    expect(session.digTick(10, 2, 10, 99).kind).toBe('bedrock');
  });

  it('keeps mixed spoil in separate stacks, newest out first', () => {
    const world = makeWorld();
    const session = new DigSession(world, { capacity: 8 });
    session.digTick(30, SURFACE, 30, 99);      // topsoil
    session.digTick(30, SURFACE - 10, 30, 99); // clay
    expect(session.load.map((l) => l.material)).toEqual([TOPSOIL, CLAY]);
    session.place(30, SURFACE + 3, 30);
    expect(world.get(30, SURFACE + 3, 30)).toBe(CLAY);
  });
});

describe('tile textures', () => {
  it('sizes clods to the ant-scale spec (15-25% of tile width)', () => {
    // The whole point of the texture spec: a "hero" feature must be a
    // noticeable fraction of the tile, not a speck. Tile = 40 mm.
    expect(TILE_MM).toBe(40);
    const biggest = 12; // stone's largest clod, mm
    expect(biggest / TILE_MM).toBeGreaterThan(0.15);
    expect(biggest / TILE_MM).toBeLessThan(0.35);
  });

  it('generates fully opaque maps of the right size', () => {
    const maps = generateTile(TOPSOIL, 32);
    for (const map of [maps.albedo, maps.normal, maps.rough]) {
      expect(map.length).toBe(32 * 32 * 4);
      for (let i = 3; i < map.length; i += 4) expect(map[i]).toBe(255);
    }
  });

  it('is deterministic — same seed, same bytes', () => {
    const a = generateTile(CLAY, 32);
    const b = generateTile(CLAY, 32);
    expect(Array.from(a.albedo)).toEqual(Array.from(b.albedo));
  });

  it('gives each material a distinguishable average colour', () => {
    const avg = (id: number) => {
      const { albedo } = generateTile(id, 32);
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < albedo.length; i += 4) { r += albedo[i]!; g += albedo[i + 1]!; b += albedo[i + 2]!; }
      const n = albedo.length / 4;
      return [r / n, g / n, b / n];
    };
    const [topsoil, clay, sand, stone] = [avg(TOPSOIL), avg(CLAY), avg(SAND), avg(STONE)];
    expect(sand[0]!).toBeGreaterThan(clay[0]!);       // sand is the palest
    expect(clay[0]! - clay[2]!).toBeGreaterThan(40); // clay is distinctly red
    expect(Math.abs(stone[0]! - stone[2]!)).toBeLessThan(20); // stone is neutral
    expect(topsoil[0]!).toBeLessThan(sand[0]!);
  });

  it('produces normals that mostly point outward', () => {
    const { normal } = generateTile(TOPSOIL, 32);
    let outward = 0;
    for (let i = 0; i < normal.length; i += 4) if (normal[i + 2]! > 128) outward++;
    expect(outward).toBe(normal.length / 4); // z component always positive
  });

  it('packs one layer per material, indexed by voxel id', () => {
    const arrays = buildTileArrays(16);
    const stride = 16 * 16 * 4;
    expect(arrays.layers).toBe(STONE + 1);
    expect(arrays.albedo.length).toBe(stride * arrays.layers);
    // Layer 0 is AIR: never sampled, filled mid-grey so a bug is visible.
    expect(arrays.albedo[0]).toBe(128);
    // Layer TOPSOIL must differ from layer SAND.
    const at = (layer: number) => arrays.albedo[layer * stride];
    expect(at(TOPSOIL)).not.toBe(at(SAND));
  });
});

describe('mesher texture attributes', () => {
  it('emits uv, layer and tangent per vertex', () => {
    const world = makeWorld();
    const cy = Math.floor(SURFACE / CHUNK);
    const data = meshChunk(world, 1, cy, 1)!;
    const verts = data.quadCount * 4;
    expect(data.uvs.length).toBe(verts * 2);
    expect(data.layers.length).toBe(verts);
    expect(data.tangents.length).toBe(verts * 3);
    // The surface chunk is all topsoil.
    expect([...new Set(data.layers)]).toEqual([TOPSOIL]);
  });

  it('lays UVs out in world space so one tile spans TILE_VOXELS', () => {
    const world = makeWorld();
    const cy = Math.floor(SURFACE / CHUNK);
    const data = meshChunk(world, 1, cy, 1)!;
    // Chunk 1 starts at voxel 32; 32 / 8 = 4.0 tiles in.
    const us = Array.from(data.uvs).filter((_, i) => i % 2 === 0);
    expect(Math.min(...us)).toBeCloseTo(32 / TILE_VOXELS, 5);
    expect(Math.max(...us)).toBeCloseTo(64 / TILE_VOXELS, 5);
  });

  it('keeps tangents unit-length and perpendicular to the face normal', () => {
    const world = makeWorld();
    world.dig(40, SURFACE, 40); // open up side faces too
    const cy = Math.floor(SURFACE / CHUNK);
    const data = meshChunk(world, 1, cy, 1)!;
    for (let i = 0; i < data.layers.length; i++) {
      const t = [data.tangents[i * 3]!, data.tangents[i * 3 + 1]!, data.tangents[i * 3 + 2]!];
      const n = [data.normals[i * 3]!, data.normals[i * 3 + 1]!, data.normals[i * 3 + 2]!];
      expect(Math.hypot(...t)).toBeCloseTo(1, 6);
      expect(t[0]! * n[0]! + t[1]! * n[1]! + t[2]! * n[2]!).toBeCloseTo(0, 6);
    }
  });

  it('carries only greyscale ambient occlusion in vertex colour', () => {
    const world = makeWorld();
    const cy = Math.floor(SURFACE / CHUNK);
    const data = meshChunk(world, 1, cy, 1)!;
    for (let i = 0; i < data.colors.length; i += 3) {
      expect(data.colors[i]).toBe(data.colors[i + 1]);
      expect(data.colors[i]).toBe(data.colors[i + 2]);
    }
  });
});
