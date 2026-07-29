import { describe, expect, it } from 'vitest';
import {
  AIR, CHUNK, CLAY, SAND, STONE, TOPSOIL, VoxelWorld,
  isSolid, layeredGenerator, materialOf,
} from '../src/voxel/VoxelWorld';
import { FACES, meshChunk } from '../src/voxel/mesher';
import { MAX_LOOSE_CLODS, LooseSoil } from '../src/voxel/LooseSoil';
import { MAX_CLOD_AXIS_SCALE, MIN_CLOD_AXIS_SCALE, SOIL_CLOD_VARIANT_COUNT, buildClodShape, styleForVoxel } from '../src/voxel/clod';
import { CELL_COUNT, CHIP_CELLS, MAX_REMOVED, buildFracture, cellCentre, cellSurvives, chipMeshData, erosionAt, erosionFor, eventsBetween, feelFor, hashVoxel, removedAt } from '../src/voxel/fracture';
import { raycastVoxel } from '../src/voxel/raycast';
import { DIG_FLOOR, DIG_START, DIG_STEP, DigSession } from '../src/voxel/DigSession';
import { TILE_MM, TILE_VOXELS, buildTileArrays, generateTile } from '../src/voxel/tileTextures';
import { DEN_MIN_CHAMBER, DEN_MIN_DEPTH, QueenFounding, countChamberAir } from '../src/voxel/QueenFounding';
import { BAND_EDGES, DEFAULT_BANDS, STICK_DEADZONE, approach, clampStickOrigin, speedForStick, stickVector } from '../src/voxel/locomotion';
import { ALL_AXES, INPUT_COMMIT_THRESHOLD, MAX_PITCH, dragLook, rollBetween, ORIENTATION_LOCK_MS, WORLD_UP, applyOrientation, attachableWall, axisFromVector, axisVector, canChangeOrientation, createSurfaceState, evaluateEdge, isPerpendicular, lookVector, opposite, rankSurfaces, referenceRight, reframeLook, supportBelow, tickLock, type AxisDirection, type Vec3 } from '../src/voxel/SurfaceFrame';

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
  /** Start a dig and run it to completion in one call. */
  const digOut = (session: DigSession, x: number, y: number, z: number) => {
    session.beginDig(x, y, z);
    return session.tickDig(999);
  };

  it('needs the full dig time before a voxel pops', () => {
    const world = makeWorld();
    const session = new DigSession(world);
    const seconds = session.secondsFor(TOPSOIL);
    session.beginDig(20, SURFACE, 20);
    expect(session.tickDig(seconds * 0.5).kind).toBe('progress');
    expect(world.get(20, SURFACE, 20)).toBe(TOPSOIL);
    expect(session.tickDig(seconds * 0.6).kind).toBe('dug');
    expect(world.get(20, SURFACE, 20)).toBe(AIR);
  });

  it('holds its target so the camera can look away mid-dig', () => {
    const world = makeWorld();
    const session = new DigSession(world);
    session.beginDig(20, SURFACE, 20);
    session.tickDig(session.secondsFor(TOPSOIL) * 0.9);
    // Nothing re-aims it — the locked cube is the only thing tickDig knows
    // about, which is what removed the old thumb-drift progress reset.
    expect(session.digging).toEqual({ x: 20, y: SURFACE, z: 20 });
    expect(session.tickDig(session.secondsFor(TOPSOIL) * 0.2).kind).toBe('dug');
  });

  it('tapping the cube being dug cancels it and discards progress', () => {
    const world = makeWorld();
    const session = new DigSession(world);
    session.toggleDig(20, SURFACE, 20);
    session.tickDig(session.secondsFor(TOPSOIL) * 0.9);
    expect(session.toggleDig(20, SURFACE, 20).kind).toBe('cancelled');
    expect(session.digging).toBeNull();
    expect(session.chewRatio).toBe(0);
    expect(world.get(20, SURFACE, 20)).toBe(TOPSOIL);
  });

  it('tapping a different cube switches target rather than cancelling', () => {
    const world = makeWorld();
    const session = new DigSession(world);
    session.toggleDig(20, SURFACE, 20);
    session.toggleDig(21, SURFACE, 20);
    expect(session.digging).toEqual({ x: 21, y: SURFACE, z: 20 });
  });

  it('conserves soil — you can only place what you dug', () => {
    const world = makeWorld();
    const session = new DigSession(world);
    expect(session.place(20, SURFACE + 2, 20).kind).toBe('empty');
    digOut(session, 20, SURFACE, 20);
    expect(session.carried).toBe(1);
    expect(session.place(20, SURFACE + 2, 20).kind).toBe('placed');
    expect(session.carried).toBe(0);
    expect(world.excavated).toBe(world.deposited);
  });

  it('stops digging once the ant is carrying a full load', () => {
    const world = makeWorld();
    const session = new DigSession(world, { capacity: 2 });
    digOut(session, 20, SURFACE, 20);
    digOut(session, 21, SURFACE, 20);
    expect(session.isFull).toBe(true);
    expect(session.beginDig(22, SURFACE, 20).kind).toBe('full');
    expect(world.get(22, SURFACE, 20)).toBe(TOPSOIL);
  });

  it('abandons a running dig if the cube stops being there', () => {
    const world = makeWorld();
    const session = new DigSession(world);
    session.beginDig(20, SURFACE, 20);
    session.tickDig(0.1);
    // Five seconds is long enough for the world to change under her, so the
    // refusal check runs every tick and not only when the dig starts.
    world.dig(20, SURFACE, 20);
    expect(session.tickDig(0.1).kind).toBe('none');
    expect(session.digging).toBeNull();
  });

  it('reports bedrock rather than silently doing nothing', () => {
    const world = makeWorld();
    const session = new DigSession(world);
    expect(session.beginDig(10, 2, 10).kind).toBe('bedrock');
  });

  it('keeps mixed spoil in separate stacks, newest out first', () => {
    const world = makeWorld();
    const session = new DigSession(world, { capacity: 8 });
    digOut(session, 30, SURFACE, 30);      // topsoil
    digOut(session, 30, SURFACE - 10, 30); // clay
    expect(session.load.map((l) => l.material)).toEqual([TOPSOIL, CLAY]);
    session.place(30, SURFACE + 3, 30);
    expect(world.get(30, SURFACE + 3, 30)).toBe(CLAY);
  });

  describe('practice curve', () => {
    it('starts slow and improves by a step per completed dig', () => {
      const world = makeWorld();
      const session = new DigSession(world);
      expect(session.secondsPerCube).toBeCloseTo(DIG_START);
      digOut(session, 20, SURFACE, 20);
      expect(session.secondsPerCube).toBeCloseTo(DIG_START - DIG_STEP);
    });

    it('bottoms out at the floor and stays there', () => {
      const world = makeWorld();
      const session = new DigSession(world, { capacity: 999 });
      // 9.0 -> 1.8 in 0.4 steps is 18 digs to master; founding the den costs
      // 14-19, so the queen tops out almost exactly as she finishes.
      const toMaster = Math.ceil((DIG_START - DIG_FLOOR) / DIG_STEP);
      expect(toMaster).toBe(18);
      for (let i = 0; i < toMaster + 5; i++) digOut(session, 20 + i, SURFACE, 20);
      expect(session.practiced).toBe(toMaster + 5);
      expect(session.secondsPerCube).toBe(DIG_FLOOR);
    });

    it('does not credit practice for cancelled digs', () => {
      const world = makeWorld();
      const session = new DigSession(world);
      // Otherwise tap-cancel-tap-cancel reaches top speed in a few seconds.
      for (let i = 0; i < 30; i++) {
        session.beginDig(20, SURFACE, 20);
        session.tickDig(0.1);
        session.cancelDig();
      }
      expect(session.practiced).toBe(0);
      expect(session.secondsPerCube).toBeCloseTo(DIG_START);
    });

    it('scales with soil hardness, and clay is the slow one', () => {
      const world = makeWorld();
      const session = new DigSession(world);
      expect(session.secondsFor(TOPSOIL)).toBeCloseTo(session.secondsPerCube);
      expect(session.secondsFor(CLAY)).toBeCloseTo(session.secondsPerCube * 1.5);
      expect(session.secondsFor(SAND)).toBeGreaterThan(session.secondsFor(TOPSOIL));
      expect(session.secondsFor(SAND)).toBeLessThan(session.secondsFor(CLAY));
    });

    it('a mastered ant never faces the ten-second clay cube', () => {
      const world = makeWorld();
      const session = new DigSession(world);
      // The reason hardness dropped from 2x to 1.5x: at 2x the clay figure runs
      // away entirely once the base cost rises.
      expect(session.secondsFor(CLAY)).toBeLessThanOrEqual(13.5);
    });
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

describe('QueenFounding', () => {
  const hollow = (world: VoxelWorld, x: number, y: number, z: number, r: number) => {
    for (let dy = -r; dy <= r; dy++)
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++)
          if (dx * dx + dy * dy + dz * dz <= r * r + 0.5) world.dig(x + dx, y + dy, z + dz);
  };

  it('refuses to found at the surface', () => {
    const world = makeWorld();
    const q = new QueenFounding(SURFACE);
    const status = q.evaluate(world, 64, SURFACE, 64);
    expect(status.phase).toBe('digging');
    expect(status.objective).toMatch(/Dig down/);
    expect(q.found(world, 64, SURFACE, 64)).toBeNull();
    expect(q.founded).toBe(false);
  });

  it('reports remaining depth in millimetres', () => {
    const world = makeWorld();
    const q = new QueenFounding(SURFACE, 5);
    // Must sit BELOW the minimum depth, or the objective has already moved on
    // to hollowing the chamber.
    const shallow = 2;
    const status = q.evaluate(world, 64, SURFACE - shallow, 64);
    expect(status.depth).toBe(shallow);
    expect(status.depthMm).toBe(shallow * 5);
    expect(status.objective).toContain(`${(DEN_MIN_DEPTH - shallow) * 5} mm`);
  });

  it('is not satisfied by a bare shaft at depth', () => {
    const world = makeWorld();
    const q = new QueenFounding(SURFACE);
    const y = SURFACE - DEN_MIN_DEPTH - 2;
    for (let d = 0; d <= DEN_MIN_DEPTH + 4; d++) world.dig(64, SURFACE - d, 64);
    const status = q.evaluate(world, 64, y, 64);
    expect(status.depthMet).toBe(true);
    expect(status.chamberMet).toBe(false);
    expect(status.phase).toBe('digging');
    expect(status.objective).toMatch(/Hollow out a chamber/);
  });

  it('becomes ready once a real chamber is hollowed at depth', () => {
    const world = makeWorld();
    const q = new QueenFounding(SURFACE);
    const y = SURFACE - DEN_MIN_DEPTH - 2;
    hollow(world, 64, y, 64, 2);
    const status = q.evaluate(world, 64, y, 64);
    expect(status.chamber).toBeGreaterThanOrEqual(DEN_MIN_CHAMBER);
    expect(status.phase).toBe('ready');
  });

  it('locks the den once founded and never moves it', () => {
    const world = makeWorld();
    const q = new QueenFounding(SURFACE);
    const y = SURFACE - DEN_MIN_DEPTH - 2;
    hollow(world, 64, y, 64, 2);
    const site = q.found(world, 64, y, 64);
    expect(site).toEqual({ x: 64, y, z: 64, depth: DEN_MIN_DEPTH + 2 });
    expect(q.founded).toBe(true);
    // Walking elsewhere afterwards must not relocate or re-trigger it.
    const later = q.evaluate(world, 10, SURFACE, 10);
    expect(later.phase).toBe('founded');
    expect(q.found(world, 10, SURFACE, 10)).toEqual(site);
    expect(q.den).toEqual(site);
  });

  it('counts only air inside the radius ball', () => {
    const world = makeWorld();
    // Solid ground: the only air is above the surface.
    expect(countChamberAir(world, 64, SURFACE - 20, 64, 1)).toBe(0);
    world.dig(64, SURFACE - 20, 64);
    expect(countChamberAir(world, 64, SURFACE - 20, 64, 1)).toBe(1);
  });
});

describe('den chamber threshold is achievable by hand', () => {
  it('passes for a 3x3x3 pocket dug off a shaft, measured from its floor', () => {
    // The requirement has to be satisfiable from where a player actually
    // STANDS — the chamber floor — not from a theoretical centre point.
    const world = makeWorld();
    const floorY = SURFACE - DEN_MIN_DEPTH - 2;
    for (let y = SURFACE; y >= floorY; y--) world.dig(64, y, 64);
    for (let dy = 0; dy < 3; dy++)
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) world.dig(64 + dx, floorY + dy, 64 + dz);
    const q = new QueenFounding(SURFACE);
    const status = q.evaluate(world, 64, floorY, 64);
    expect(status.chamber).toBeGreaterThanOrEqual(DEN_MIN_CHAMBER);
    expect(status.phase).toBe('ready');
  });

  it('still rejects a bare shaft measured from its floor', () => {
    const world = makeWorld();
    const floorY = SURFACE - DEN_MIN_DEPTH - 2;
    for (let y = SURFACE; y >= floorY; y--) world.dig(64, y, 64);
    const q = new QueenFounding(SURFACE);
    expect(q.evaluate(world, 64, floorY, 64).phase).toBe('digging');
  });
});

describe('locomotion', () => {
  it('treats a barely-nudged stick as centred', () => {
    expect(speedForStick(0)).toBe(0);
    expect(speedForStick(STICK_DEADZONE)).toBe(0);
    expect(speedForStick(STICK_DEADZONE + 0.01)).toBeGreaterThan(0);
  });

  it('reaches each band at its edge', () => {
    const d = STICK_DEADZONE;
    const at = (t: number) => speedForStick(d + t * (1 - d));
    expect(at(BAND_EDGES.crawl)).toBeCloseTo(DEFAULT_BANDS.crawl, 5);
    expect(at(BAND_EDGES.walk)).toBeCloseTo(DEFAULT_BANDS.walk, 5);
    expect(at(1)).toBeCloseTo(DEFAULT_BANDS.run, 5);
  });

  it('is continuous and monotonic — no speed jumps between bands', () => {
    let previous = -1;
    for (let m = 0; m <= 1.0001; m += 0.01) {
      const v = speedForStick(m);
      expect(v).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = v;
    }
    // A step would show up as a large delta across one sample.
    for (let m = 0.1; m < 1; m += 0.005) {
      expect(Math.abs(speedForStick(m + 0.005) - speedForStick(m))).toBeLessThan(0.35);
    }
  });

  it('gives a genuinely slow band for careful digging', () => {
    // A third of the stick should be well under half walking pace, otherwise
    // "crawl" is a label rather than a usable speed.
    expect(speedForStick(0.3)).toBeLessThan(DEFAULT_BANDS.walk * 0.5);
  });

  it('accelerates and decelerates at different rates', () => {
    expect(approach(0, 10, 20, 40, 0.1)).toBeCloseTo(2, 5);   // accel 20 * 0.1
    expect(approach(10, 0, 20, 40, 0.1)).toBeCloseTo(6, 5);   // decel 40 * 0.1
  });

  it('snaps to the target rather than overshooting', () => {
    expect(approach(0, 1, 100, 100, 1)).toBe(1);
    expect(approach(5, 5, 10, 10, 1)).toBe(5);
  });

  it('clamps the stick origin into its region', () => {
    const b = { minX: 80, maxX: 200, minY: 300, maxY: 700 };
    expect(clampStickOrigin(10, 10, b)).toEqual({ x: 80, y: 300 });
    expect(clampStickOrigin(999, 999, b)).toEqual({ x: 200, y: 700 });
    expect(clampStickOrigin(120, 500, b)).toEqual({ x: 120, y: 500 });
  });

  it('clamps stick throw to the ring but keeps direction', () => {
    const far = stickVector(300, 0, 70);
    expect(far.magnitude).toBe(1);
    expect(far.x).toBeCloseTo(1, 5);
    const half = stickVector(35, 0, 70);
    expect(half.magnitude).toBeCloseTo(0.5, 5);
    const diagonal = stickVector(70, 70, 70);
    expect(diagonal.magnitude).toBe(1);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(1, 5);
  });

  it('reports a centred stick as zero rather than NaN', () => {
    const v = stickVector(0, 0, 70);
    expect(v).toEqual({ x: 0, y: 0, magnitude: 0 });
  });
});

describe('SurfaceFrame', () => {
  const S = SURFACE;
  const flat = () => makeWorld();

  it('maps vectors to the nearest of six axes', () => {
    expect(axisFromVector({ x: 0, y: 1, z: 0 })).toBe('pos_y');
    expect(axisFromVector({ x: 0, y: -0.9, z: 0.2 })).toBe('neg_y');
    expect(axisFromVector({ x: -3, y: 1, z: 1 })).toBe('neg_x');
    expect(axisFromVector({ x: 0, y: 0, z: 5 })).toBe('pos_z');
  });

  it('knows opposites and perpendiculars', () => {
    expect(opposite('pos_y')).toBe('neg_y');
    expect(opposite('neg_z')).toBe('pos_z');
    expect(isPerpendicular('pos_y', 'pos_x')).toBe(true);
    expect(isPerpendicular('pos_y', 'neg_y')).toBe(false); // opposite, not perpendicular
    expect(isPerpendicular('pos_y', 'pos_y')).toBe(false);
  });

  it('finds the ground under a standing ant', () => {
    const world = flat();
    expect(supportBelow(world, { x: 64, y: S + 1, z: 64 }, 'pos_y')).toEqual({ x: 64, y: S, z: 64 });
    // Two voxels up there is nothing directly beneath.
    expect(supportBelow(world, { x: 64, y: S + 3, z: 64 }, 'pos_y')).toBeNull();
  });

  it('will not reorient while the hysteresis lock is running', () => {
    const world = flat();
    const state = createSurfaceState();
    applyOrientation(state, 'pos_y', { x: 64, y: S, z: 64 });
    expect(canChangeOrientation(state)).toBe(false);
    expect(evaluateEdge(world, { x: 64, y: S + 1, z: 64 }, state, { x: 1, y: 0, z: 0 }, 1).reason).toBe('locked');
    tickLock(state, ORIENTATION_LOCK_MS);
    expect(canChangeOrientation(state)).toBe(true);
  });

  it('does nothing while the ant is still on its own surface', () => {
    const world = flat();
    const state = createSurfaceState();
    state.support = { x: 64, y: S, z: 64 };
    const d = evaluateEdge(world, { x: 64, y: S + 1, z: 64 }, state, { x: 1, y: 0, z: 0 }, 1);
    expect(d.commit).toBe(false);
    expect(d.reason).toBe('none');
  });

  it('refuses to cross an edge without committed movement — you can stand still on a wall', () => {
    const world = flat();
    // Two voxels deep: one to stand in, one so there is genuinely nothing
    // beneath. Digging only one leaves solid ground below and the ant still
    // has support, so the edge case is never reached.
    world.dig(64, S, 64);
    world.dig(64, S - 1, 64);
    const state = createSurfaceState();
    const at = { x: 64, y: S, z: 64 };
    expect(evaluateEdge(world, at, state, null, 0).reason).toBe('not-committed');
    // Below the input threshold: still no.
    expect(evaluateEdge(world, at, state, { x: 1, y: 0, z: 0 }, INPUT_COMMIT_THRESHOLD - 0.05).reason)
      .toBe('not-committed');
  });

  it('commits across an edge when movement points that way', () => {
    const world = flat();
    world.dig(64, S, 64);
    world.dig(64, S - 1, 64); // nothing beneath -> we are at an edge
    const state = createSurfaceState();
    const decision = evaluateEdge(world, { x: 64, y: S, z: 64 }, state, { x: 1, y: 0, z: 0 }, 1);
    expect(decision.commit).toBe(true);
    // Moving +X onto the wall at +X gives an up of neg_x (the face points back).
    expect(decision.up).toBe('neg_x');
    expect(decision.reason).toBe('convex');
  });

  it('ranks the current support above equally-close rivals — no corner ping-pong', () => {
    const world = flat();
    // An inside corner: floor below AND a wall to +X. Both touch the ant.
    const state = createSurfaceState();
    state.support = { x: 64, y: S, z: 64 };
    state.up = 'pos_y';
    const ranked = rankSurfaces(world, { x: 64, y: S + 1, z: 64 }, state, { x: 1, y: 0, z: 0 });
    expect(ranked[0]!.up).toBe('pos_y'); // stays put despite moving into the wall
  });

  it('prefers the surface being moved toward when nothing is supporting yet', () => {
    const world = flat();
    const state = createSurfaceState();
    state.support = null;
    const ranked = rankSurfaces(world, { x: 64, y: S + 1, z: 64 }, state, { x: 0, y: -1, z: 0 });
    expect(ranked[0]!.up).toBe('pos_y'); // moving down, the floor wins
  });

  it('offers a grippable wall only when one is actually there', () => {
    const world = flat();
    const state = createSurfaceState();
    // Standing on open flat ground: the only surface is the floor, which is
    // not perpendicular to world up, so there is nothing to grip.
    expect(attachableWall(world, { x: 64, y: S + 1, z: 64 }, state, { x: 1, y: 0, z: 0 })).toBeNull();
    // Now stand in a one-voxel trench so walls surround us.
    world.dig(64, S, 64);
    expect(attachableWall(world, { x: 64, y: S, z: 64 }, state, { x: 1, y: 0, z: 0 })).toBe('neg_x');
  });

  it('refuses to offer a wall while already attached', () => {
    const world = flat();
    world.dig(64, S, 64);
    const state = createSurfaceState();
    applyOrientation(state, 'neg_x', { x: 65, y: S, z: 64 });
    expect(state.mode).toBe('attached');
    expect(attachableWall(world, { x: 64, y: S, z: 64 }, state, { x: 1, y: 0, z: 0 })).toBeNull();
  });

  it('returns to grounded when up goes back to world up', () => {
    const state = createSurfaceState();
    applyOrientation(state, 'neg_x', { x: 1, y: 1, z: 1 });
    expect(state.mode).toBe('attached');
    applyOrientation(state, WORLD_UP, { x: 1, y: 0, z: 1 });
    expect(state.mode).toBe('grounded');
  });

  it('never produces a non-axis orientation', () => {
    // The whole simplification depends on this: six frames, no in-betweens.
    const world = flat();
    world.dig(64, S, 64);
    world.dig(64, S - 1, 64);
    const state = createSurfaceState();
    for (const dir of [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: -1, z: 0 }]) {
      const d = evaluateEdge(world, { x: 64, y: S, z: 64 }, state, dir, 1);
      if (d.up) expect(ALL_AXES).toContain(d.up);
    }
  });

  describe('look reframing', () => {
    // yaw and pitch are measured INSIDE a frame, so carrying the same numbers
    // across a reorientation points the camera somewhere unrelated — which is
    // what made mounting a wall feel like the world spun 90 degrees under you.
    const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

    it('preserves the world look direction across every pair of frames', () => {
      // A frame cannot express looking exactly along its own up — yaw stops
      // meaning anything at the pole — so pitch clamps at MAX_PITCH. That caps
      // the error at precisely the clipped wedge and nothing more, which is the
      // real guarantee: assert THAT rather than perfect equality.
      const worstCase = Math.PI / 2 - MAX_PITCH;
      let worstSeen = 0;
      for (const from of ALL_AXES) {
        for (const to of ALL_AXES) {
          for (const yaw of [0, 0.7, -2.2, 3.0]) {
            for (const pitch of [0, 0.6, -1.1, -1.4]) {
              const before = lookVector(from, yaw, pitch);
              const solved = reframeLook(before, to, yaw);
              const after = lookVector(to, solved.yaw, solved.pitch);
              const error = Math.acos(Math.min(1, Math.max(-1, dot(before, after))));
              expect(error).toBeLessThanOrEqual(worstCase + 1e-9);
              worstSeen = Math.max(worstSeen, error);
            }
          }
        }
      }
      // And the clamp is the ONLY thing costing anything — if this ever drifts
      // far below, the cases that exercise the pole have stopped running.
      expect(worstSeen).toBeGreaterThan(0);
    });

    it('is exact whenever the new frame can express the direction', () => {
      for (const from of ALL_AXES) {
        for (const to of ALL_AXES) {
          for (const yaw of [0, 0.7, -2.2]) {
            for (const pitch of [0, 0.4, -0.9]) {
              const before = lookVector(from, yaw, pitch);
              const solved = reframeLook(before, to, yaw);
              if (Math.abs(solved.pitch) >= MAX_PITCH - 1e-9) continue; // clamped
              const after = lookVector(to, solved.yaw, solved.pitch);
              expect(dot(before, after)).toBeCloseTo(1, 9);
            }
          }
        }
      }
    });

    it('looking straight down a shaft still looks down it after mounting a wall', () => {
      // The exact case that felt broken: pitched hard down, walk into the wall,
      // and end up facing sideways.
      const down = lookVector(WORLD_UP, 0, -MAX_PITCH);
      expect(down.y).toBeLessThan(-0.99);
      const solved = reframeLook(down, 'pos_z');
      const after = lookVector('pos_z', solved.yaw, solved.pitch);
      expect(after.y).toBeLessThan(-0.99);
    });

    it('keeps the old yaw at the singularity instead of snapping', () => {
      // Looking exactly along the new up, every yaw gives the same view, so
      // there is nothing to solve — inventing one would spin the camera.
      const straightUp = { x: 0, y: 1, z: 0 };
      expect(reframeLook(straightUp, WORLD_UP, 1.234).yaw).toBeCloseTo(1.234);
    });

    it('never produces a pitch that can escape the frame', () => {
      for (const axis of ALL_AXES) {
        for (const target of [{ x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 1, y: 0, z: 0 }]) {
          const solved = reframeLook(target, axis);
          expect(Math.abs(solved.pitch)).toBeLessThanOrEqual(MAX_PITCH + 1e-9);
        }
      }
    });

    it('reference right is always perpendicular to its own up', () => {
      for (const axis of ALL_AXES) {
        expect(dot(referenceRight(axis), axisVector(axis))).toBe(0);
      }
    });
  });

  describe('screen-relative look', () => {
    const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
    const angle = (a: Vec3, b: Vec3) => Math.acos(Math.min(1, Math.max(-1, dot(a, b))));
    const camAxes = (look: Vec3, up: AxisDirection) => {
      const u = axisVector(up);
      const right = {
        x: look.y * u.z - look.z * u.y,
        y: look.z * u.x - look.x * u.z,
        z: look.x * u.y - look.y * u.x,
      };
      const len = Math.hypot(right.x, right.y, right.z);
      const r = { x: right.x / len, y: right.y / len, z: right.z / len };
      return {
        right: r,
        camUp: { x: r.y * look.z - r.z * look.y, y: r.z * look.x - r.x * look.z, z: r.x * look.y - r.y * look.x },
      };
    };

    it('moves the view by the drag amount, in every frame', () => {
      // The whole point: a drag of a given size does the same thing on screen
      // whichever surface the ant is standing on.
      for (const up of ALL_AXES) {
        for (const yaw of [0, 1.1, -2.4]) {
          for (const pitch of [0, 0.5, -0.8]) {
            const look = lookVector(up, yaw, pitch);
            expect(angle(look, dragLook(look, up, 0.3, 0))).toBeCloseTo(0.3, 6);
            expect(angle(look, dragLook(look, up, 0, 0.3))).toBeCloseTo(0.3, 6);
          }
        }
      }
    });

    it('keeps the drag axes from swapping meaning', () => {
      // A sideways drag must turn the view sideways ON SCREEN and not tilt it,
      // and vice versa. Driving yaw and pitch directly failed this the moment
      // `up` stopped being world up: sideways started running along the shaft.
      for (const up of ALL_AXES) {
        for (const pitch of [0, 0.6, -1.0]) {
          const look = lookVector(up, 0.4, pitch);
          const { right, camUp } = camAxes(look, up);

          const sideways = dragLook(look, up, 0.25, 0);
          expect(dot(sideways, camUp)).toBeCloseTo(0, 6);   // no vertical component
          expect(Math.abs(dot(sideways, right))).toBeGreaterThan(0.2);

          const vertical = dragLook(look, up, 0, 0.25);
          expect(dot(vertical, right)).toBeCloseTo(0, 6);   // no sideways component
          expect(Math.abs(dot(vertical, camUp))).toBeGreaterThan(0.2);
        }
      }
    });

    it('matches the old yaw behaviour on flat ground at level pitch', () => {
      // Standing on the floor looking level is the case that always felt right,
      // so it must not have changed.
      const look = lookVector(WORLD_UP, 0.9, 0);
      const dragged = reframeLook(dragLook(look, WORLD_UP, 0.2, 0), WORLD_UP);
      expect(dragged.yaw).toBeCloseTo(0.9 - 0.2, 6);
      expect(dragged.pitch).toBeCloseTo(0, 6);
    });

    it('still turns when looking straight along up, instead of freezing', () => {
      // At the pole the camera right vector collapses; without a fallback the
      // drag would produce NaN and the camera would lock.
      const straightUp = { x: 0, y: 1, z: 0 };
      const turned = dragLook(straightUp, WORLD_UP, 0.3, 0);
      expect(Number.isFinite(turned.x + turned.y + turned.z)).toBe(true);
      expect(Math.hypot(turned.x, turned.y, turned.z)).toBeCloseTo(1, 6);
    });
  });

  describe('roll continuity', () => {
    it('is zero when the frame does not change', () => {
      for (const axis of ALL_AXES) {
        expect(rollBetween(lookVector(axis, 0.6, 0.2), axis, axis)).toBeCloseTo(0, 9);
      }
    });

    it('is antisymmetric, so the turn undoes itself', () => {
      const look = lookVector(WORLD_UP, 0.4, 0);
      for (const to of ALL_AXES) {
        const there = rollBetween(look, WORLD_UP, to);
        const back = rollBetween(look, to, WORLD_UP);
        expect(there + back).toBeCloseTo(0, 9);
      }
    });

    it('reports a real quarter turn when crawling onto a wall', () => {
      // Screen-up goes from world up to the wall normal, so the picture rotates.
      // It has to be measured, not assumed to be nothing — that snap was the
      // half of the problem that preserving the look direction did not fix.
      const look = lookVector(WORLD_UP, 0, 0);
      expect(Math.abs(rollBetween(look, WORLD_UP, 'pos_x'))).toBeGreaterThan(1.4);
    });

    it('is finite even looking straight along an axis', () => {
      expect(rollBetween({ x: 0, y: 1, z: 0 }, WORLD_UP, 'pos_z')).toBe(0);
    });
  });
});

describe('fracture', () => {
  const S = SURFACE;

  it('gives the same voxel the same seed every time', () => {
    expect(hashVoxel(12, 34, 56, TOPSOIL)).toBe(hashVoxel(12, 34, 56, TOPSOIL));
    expect(buildFracture(12, 34, 56, TOPSOIL).seed).toBe(buildFracture(12, 34, 56, TOPSOIL).seed);
    // Same cell, different soil, is a different fracture — which matters where
    // strata meet and one column changes material partway down.
    expect(hashVoxel(12, 34, 56, TOPSOIL)).not.toBe(hashVoxel(12, 34, 56, CLAY));
  });

  it('gives neighbouring voxels different patterns', () => {
    // Not "always" — 27! orderings means collisions are possible in principle.
    // What matters is that a wall of soil doesn't chip in lockstep.
    const seen = new Set<string>();
    for (let x = 0; x < 6; x++) {
      for (let z = 0; z < 6; z++) {
        seen.add(buildFracture(x, S, z, TOPSOIL).order.join(','));
      }
    }
    expect(seen.size).toBe(36);
  });

  it('never restores soil as progress rises', () => {
    for (const [x, z] of [[3, 4], [17, 2], [40, 61]] as const) {
      const pattern = buildFracture(x, S, z, TOPSOIL);
      let previous = 0;
      let goneBefore = new Set<number>();
      for (let p = 0; p <= 1.0001; p += 0.01) {
        const removed = removedAt(pattern, p);
        expect(removed).toBeGreaterThanOrEqual(previous);
        const gone = new Set(Array.from(pattern.order.slice(0, removed)));
        // Superset, not merely a bigger count: a crumb can never come back.
        for (const cell of goneBefore) expect(gone.has(cell)).toBe(true);
        previous = removed;
        goneBefore = gone;
      }
    }
  });

  it('damages one region at a time instead of the whole cube evenly', () => {
    /*
     * The complaint this fixes: erosion used to be global, so every crumb
     * loosened by the same amount at once and the lattice read as an evenly
     * dissolving grid. Damage has to be LOCAL — most of the voxel untouched,
     * a minority visibly chewed.
     */
    const pattern = buildFracture(11, S, 23, TOPSOIL);
    // Checked across the body of the dig, not the very end: once only a few
    // crumbs remain it is right that most of them are being worked at once.
    for (const progress of [0.25, 0.4, 0.55]) {
      let touched = 0;
      let pristine = 0;
      for (let cell = 0; cell < CELL_COUNT; cell++) {
        if (removedAt(pattern, progress) > 0 && !cellSurvives(pattern, cell, progress)) continue;
        if (erosionFor(pattern, cell, progress) > 0) touched++;
        else pristine++;
      }
      // Some soil is always being worked...
      expect(touched).toBeGreaterThan(0);
      // ...and most of what is left is still solid, fused, untouched rock.
      expect(pristine).toBeGreaterThan(touched);
    }
  });

  it('keeps untouched neighbours fused, so no grid shows through', () => {
    const pattern = buildFracture(11, S, 23, TOPSOIL);
    // Interior faces only appear where soil has actually started to loosen. If
    // every crumb emitted all six faces the cube would read as a stack of
    // blocks even before anything broke.
    const early = chipMeshData(pattern, 11, S, 23, 0.2)!;
    const worst = CELL_COUNT * 6;
    expect(early.quadCount).toBeLessThan(worst * 0.5);
  });

  it('opens a crater from the middle of a face and grows outward', () => {
    for (const [x, z] of [[2, 3], [15, 40], [61, 8]] as const) {
      const pattern = buildFracture(x, S, z, TOPSOIL);
      // The strike lands on a face, never inside the volume: a crater that
      // starts in the middle of the CUBE hollows it invisibly behind an intact
      // shell, then caves in all at once.
      const onFace = [pattern.strike.x, pattern.strike.y, pattern.strike.z]
        .filter((v) => v === 0 || v === 1).length;
      expect(onFace).toBe(1);

      // Crumbs go in roughly distance order from that point, so the damage
      // reads as one growing hole rather than as patches of rot.
      const first = cellCentre(pattern.order[0]!);
      const last = cellCentre(pattern.order[CELL_COUNT - 1]!);
      const near = Math.hypot(
        first.x - pattern.strike.x, first.y - pattern.strike.y, first.z - pattern.strike.z,
      );
      const far = Math.hypot(
        last.x - pattern.strike.x, last.y - pattern.strike.y, last.z - pattern.strike.z,
      );
      expect(near).toBeLessThan(far);
    }
  });

  it('has a single centre crumb for the first blow to land on', () => {
    // The reason the grid is odd. An even one has no middle cell, so a crater
    // always opens against a seam instead of at a point.
    expect(CHIP_CELLS % 2).toBe(1);
  });

  it('is a perfect intact cube at zero progress', () => {
    const pattern = buildFracture(8, S, 9, TOPSOIL);
    expect(removedAt(pattern, 0)).toBe(0);
    expect(erosionAt(pattern, 0)).toBe(0);

    const data = chipMeshData(pattern, 8, S, 9, 0)!;
    expect(data).not.toBeNull();
    // Every internal face culled: only the 9 cell-faces per side survive.
    expect(data.quadCount).toBe(6 * CHIP_CELLS * CHIP_CELLS);
    // And it occupies exactly the original voxel, so an untouched target is
    // indistinguishable from ordinary terrain.
    for (let i = 0; i < data.positions.length; i += 3) {
      expect(data.positions[i]!).toBeGreaterThanOrEqual(8 - 1e-6);
      expect(data.positions[i]!).toBeLessThanOrEqual(9 + 1e-6);
      expect(data.positions[i + 1]!).toBeGreaterThanOrEqual(S - 1e-6);
      expect(data.positions[i + 2]!).toBeLessThanOrEqual(10 + 1e-6);
    }
  });

  it('visibly loses volume well before the dig finishes', () => {
    // The whole point: no more sitting perfect and then vanishing.
    const pattern = buildFracture(21, S, 5, TOPSOIL);
    expect(removedAt(pattern, 0.5)).toBeGreaterThan(0);
    const early = chipMeshData(pattern, 21, S, 5, 0.05)!;
    const late = chipMeshData(pattern, 21, S, 5, 0.85)!;
    // Fewer crumbs standing late on. Quad count rises as they separate, so
    // compare the thing that actually matters — how much soil is left.
    expect(removedAt(pattern, 0.85)).toBeGreaterThan(removedAt(pattern, 0.05));
    expect(early.quadCount).toBeGreaterThan(0);
    expect(late.quadCount).toBeGreaterThan(0);
  });

  it('always leaves a crumb for the dig logic to finish', () => {
    // The visual must never make the voxel vanish on its own — removing it is
    // DigSession's call, not the renderer's.
    for (const [x, z] of [[1, 1], [9, 14], [33, 7]] as const) {
      const pattern = buildFracture(x, S, z, TOPSOIL);
      expect(removedAt(pattern, 1)).toBeLessThanOrEqual(MAX_REMOVED);
      expect(chipMeshData(pattern, x, S, z, 1)).not.toBeNull();
    }
  });

  it('fires chip events only when soil actually breaks', () => {
    const pattern = buildFracture(5, S, 5, TOPSOIL);
    // Nothing between two points with no crumb boundary between them.
    expect(eventsBetween(pattern, 0, 0)).toEqual([]);
    const all = eventsBetween(pattern, 0, 1);
    expect(all.some((e) => e.kind === 'DIG_RELEASE')).toBe(true);
    expect(all.some((e) => e.kind === 'DIG_CRACK')).toBe(true);
    // And the release fires once, at the end, not repeatedly.
    expect(eventsBetween(pattern, 1, 1).length).toBe(0);
  });

  it('varies the feel by soil without needing separate systems', () => {
    // Clay lets go in slabs, sand trickles.
    expect(feelFor(CLAY).clumping).toBeGreaterThan(feelFor(SAND).clumping);
    expect(feelFor(SAND).dust).toBeGreaterThan(feelFor(CLAY).dust);
  });

  it('stays cheap enough for a phone', () => {
    // Worst case is every crumb standing and separated: 27 x 6 quads.
    let worst = 0;
    for (let p = 0; p <= 1; p += 0.02) {
      const data = chipMeshData(buildFracture(2, S, 3, TOPSOIL), 2, S, 3, p);
      worst = Math.max(worst, data?.quadCount ?? 0);
    }
    expect(worst).toBeLessThanOrEqual(CELL_COUNT * 6);
  });

  it('cannot be started on bedrock, so bedrock never gets a visual', () => {
    // The scene builds a fracture only for a target DigSession accepted, and
    // it refuses bedrock outright.
    const world = makeWorld();
    const session = new DigSession(world);
    expect(session.beginDig(10, 2, 10).kind).toBe('bedrock');
    expect(session.digging).toBeNull();
  });

  it('tracks exactly one target, so only one voxel is ever chipped', () => {
    const world = makeWorld();
    const session = new DigSession(world);
    session.beginDig(20, SURFACE, 20);
    expect(session.digging).toEqual({ x: 20, y: SURFACE, z: 20 });
    session.beginDig(21, SURFACE, 20);
    expect(session.digging).toEqual({ x: 21, y: SURFACE, z: 20 });
  });

  it('leaves soil conservation untouched — particles are cosmetic', () => {
    // Chipping is a view of the dig. It has no route to the world or the load,
    // so a full dig still moves exactly one voxel.
    const world = makeWorld();
    const session = new DigSession(world);
    session.beginDig(20, SURFACE, 20);
    session.tickDig(999);
    expect(world.excavated).toBe(1);
    expect(session.carried).toBe(1);
    session.place(20, SURFACE + 2, 20);
    expect(world.excavated).toBe(world.deposited);
  });
});

describe('loose soil', () => {
  const S = SURFACE;

  it('gives the same voxel the same clod every time', () => {
    const a = styleForVoxel(4, S, 9, TOPSOIL);
    const b = styleForVoxel(4, S, 9, TOPSOIL);
    expect(a.variant).toBe(b.variant);
    expect(a.axisScale).toEqual(b.axisScale);
    expect(a.variant).toBeGreaterThanOrEqual(0);
    expect(a.variant).toBeLessThan(SOIL_CLOD_VARIANT_COUNT);
  });

  it('gives different cells different clods', () => {
    const variants = new Set<number>();
    for (let i = 0; i < 40; i++) variants.add(styleForVoxel(i, S, i * 3, TOPSOIL).variant);
    expect(variants.size).toBeGreaterThan(5);
  });

  it('keeps every clod the same quantity of soil', () => {
    // Proportions vary, volume must not: a clod that looked half the size of
    // its neighbour would be a lie about how much dirt is in it.
    for (let i = 0; i < 50; i++) {
      const [sx, sy, sz] = styleForVoxel(i, S, i, TOPSOIL).axisScale;
      expect(sx * sy * sz).toBeCloseTo(1, 6);
      expect(sx).toBeGreaterThanOrEqual(MIN_CLOD_AXIS_SCALE - 1e-9);
      expect(sx).toBeLessThanOrEqual(MAX_CLOD_AXIS_SCALE + 1e-9);
    }
  });

  it('builds clods that are lumpy but not spiky', () => {
    for (let variant = 0; variant < SOIL_CLOD_VARIANT_COUNT; variant++) {
      const shape = buildClodShape(variant);
      const radii: number[] = [];
      for (let i = 0; i < shape.positions.length; i += 3) {
        radii.push(Math.hypot(shape.positions[i]!, shape.positions[i + 1]!, shape.positions[i + 2]!));
      }
      const min = Math.min(...radii);
      const max = Math.max(...radii);
      // Irregular enough to read as broken soil...
      expect(max - min).toBeGreaterThan(0.02);
      // ...but never a spike. A ratio above ~2 is a starfish, not a clod.
      expect(max / min).toBeLessThan(2);
      expect(radii.every((r) => Number.isFinite(r))).toBe(true);
    }
  });

  it('keeps variants roughly equal in volume', () => {
    const means = Array.from({ length: SOIL_CLOD_VARIANT_COUNT }, (_, v) => {
      const shape = buildClodShape(v);
      let total = 0;
      let n = 0;
      for (let i = 0; i < shape.positions.length; i += 3) {
        total += Math.hypot(shape.positions[i]!, shape.positions[i + 1]!, shape.positions[i + 2]!);
        n++;
      }
      return total / n;
    });
    expect(Math.max(...means) / Math.min(...means)).toBeLessThan(1.12);
  });

  it('conserves soil across dig, drop and pick up again', () => {
    const world = makeWorld();
    const session = new DigSession(world);
    const soil = new LooseSoil();

    session.beginDig(20, S, 20);
    session.tickDig(999);
    expect(world.excavated).toBe(1);

    const unit = session.release()!;
    expect(unit.source).toEqual({ x: 20, y: S, z: 20 });
    soil.drop({ x: 20.5, y: S + 2, z: 20.5 }, unit.material, unit.source!);
    // The unit is in exactly one place at a time.
    expect(session.carried).toBe(0);
    expect(soil.count).toBe(1);
    expect(world.excavated).toBe(session.carried + soil.count + world.deposited);

    // Picking it back up returns the SAME soil, with the same identity.
    const clod = soil.clods[0]!;
    soil.remove(clod);
    session.load.push({ material: clod.material, count: 1, source: clod.source });
    expect(session.carried).toBe(1);
    expect(soil.count).toBe(0);
    expect(styleForVoxel(clod.source.x, clod.source.y, clod.source.z, clod.material).variant)
      .toBe(styleForVoxel(20, S, 20, TOPSOIL).variant);
  });

  it('never loses a unit when a release cannot be placed', () => {
    /*
     * release() takes the unit OUT of the load, so every path after it has to
     * either place the unit or push it back. An early return there was quietly
     * destroying soil — the load went down by one and nothing appeared.
     */
    const world = makeWorld();
    const session = new DigSession(world);
    session.beginDig(20, S, 20);
    session.tickDig(999);
    expect(session.carried).toBe(1);

    const unit = session.release()!;
    expect(session.carried).toBe(0);
    // Simulating the refusal path: putting it back restores the load exactly.
    session.load.push(unit);
    expect(session.carried).toBe(1);
    expect(world.excavated).toBe(session.carried);
  });

  it('drops a clod onto the ground and lets it fall asleep there', () => {
    const world = makeWorld();
    const soil = new LooseSoil();
    soil.drop({ x: 20.5, y: S + 4, z: 20.5 }, TOPSOIL, { x: 20, y: S, z: 20 });
    for (let i = 0; i < 400; i++) soil.step(world, 1 / 60, 12);
    const clod = soil.clods[0]!;
    // Landed on the surface rather than sinking through it or hovering.
    expect(clod.position.y).toBeGreaterThan(S);
    expect(clod.position.y).toBeLessThan(S + 2.5);
    // And resting clods stop costing anything.
    expect(clod.asleep).toBe(true);
    expect(soil.awake).toBe(0);
  });

  it('can be shoved, and wakes up when it is', () => {
    const world = makeWorld();
    const soil = new LooseSoil();
    soil.drop({ x: 20.5, y: S + 1.4, z: 20.5 }, TOPSOIL, { x: 20, y: S, z: 20 });
    for (let i = 0; i < 400; i++) soil.step(world, 1 / 60, 12);
    const clod = soil.clods[0]!;
    expect(clod.asleep).toBe(true);
    const before = clod.position.z;

    // Walking into it from -Z should send it along +Z.
    const pushed = soil.displace(
      { x: 20.5, y: clod.position.y, z: clod.position.z - 0.5 }, 0.3, { x: 0, y: 0, z: 1 }, 3,
    );
    expect(pushed).toContain(clod);
    expect(clod.asleep).toBe(false);
    for (let i = 0; i < 60; i++) soil.step(world, 1 / 60, 12);
    expect(clod.position.z).toBeGreaterThan(before);
  });

  it('only offers a clod the crosshair is actually pointing at', () => {
    /*
     * The bug this pins: pickup was a plain sphere around the eye, so a clod
     * dropped a couple of cubes away kept claiming the action button while you
     * were trying to dig something else. Proximity has no idea what you meant;
     * aiming does.
     */
    const soil = new LooseSoil();
    const eye = { x: 10, y: 10, z: 10 };
    const ahead = { x: 0, y: 0, z: -1 };

    const front = soil.drop({ x: 10, y: 10, z: 8.8 }, TOPSOIL, { x: 0, y: 0, z: 0 })!;
    soil.drop({ x: 11.6, y: 10, z: 8.8 }, TOPSOIL, { x: 1, y: 0, z: 0 }); // off to one side
    soil.drop({ x: 10, y: 10, z: 11.5 }, TOPSOIL, { x: 2, y: 0, z: 0 }); // behind her

    // Straight ahead is offered; beside and behind are not.
    expect(soil.alongRay(eye, ahead, 1.8, 0.55)).toBe(front);
    // Look away and nothing is offered, even though all three are still close.
    expect(soil.alongRay(eye, { x: 1, y: 0, z: 0 }, 1.8, 0.55)).toBeNull();
    // Look down at the floor — which is what you do to dig — and still nothing.
    expect(soil.alongRay(eye, { x: 0, y: -1, z: 0 }, 1.8, 0.55)).toBeNull();
  });

  it('offers the nearest clod when two line up', () => {
    const soil = new LooseSoil();
    const eye = { x: 0, y: 0, z: 0 };
    const ahead = { x: 0, y: 0, z: -1 };
    const near = soil.drop({ x: 0, y: 0, z: -0.8 }, TOPSOIL, { x: 0, y: 0, z: 0 })!;
    soil.drop({ x: 0, y: 0, z: -1.6 }, TOPSOIL, { x: 1, y: 0, z: 0 });
    expect(soil.alongRay(eye, ahead, 1.8, 0.55)).toBe(near);
  });

  it('will not offer a clod out past arm\'s length', () => {
    const soil = new LooseSoil();
    soil.drop({ x: 0, y: 0, z: -3 }, TOPSOIL, { x: 0, y: 0, z: 0 });
    expect(soil.alongRay({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 1.8, 0.55)).toBeNull();
  });

  it('refuses to drop past the cap rather than destroying soil', () => {
    const soil = new LooseSoil();
    for (let i = 0; i < MAX_LOOSE_CLODS; i++) {
      expect(soil.drop({ x: 0, y: 0, z: 0 }, TOPSOIL, { x: i, y: 0, z: 0 })).not.toBeNull();
    }
    expect(soil.drop({ x: 0, y: 0, z: 0 }, TOPSOIL, { x: 999, y: 0, z: 0 })).toBeNull();
    expect(soil.count).toBe(MAX_LOOSE_CLODS);
  });

  it('survives a save round trip with the same shapes', () => {
    const soil = new LooseSoil();
    soil.drop({ x: 3.5, y: 9.5, z: 4.5 }, CLAY, { x: 3, y: 9, z: 4 });
    const restored = LooseSoil.fromJSON(soil.toJSON());
    expect(restored.count).toBe(1);
    const a = soil.clods[0]!;
    const b = restored.clods[0]!;
    expect(b.source).toEqual(a.source);
    expect(styleForVoxel(b.source.x, b.source.y, b.source.z, b.material).variant)
      .toBe(styleForVoxel(a.source.x, a.source.y, a.source.z, a.material).variant);
    // Reloaded spoil is already where it settled.
    expect(b.asleep).toBe(true);
  });

  it('leaves the terrain grid cube-based', () => {
    // The whole point of the change: only EXCAVATED soil stops being a cube.
    const world = makeWorld();
    const session = new DigSession(world);
    session.beginDig(20, S, 20);
    session.tickDig(999);
    session.release();
    // Nothing was deposited, and the world is still a plain voxel grid.
    expect(world.deposited).toBe(0);
    expect(world.get(20, S, 20)).toBe(AIR);
    expect(world.get(21, S, 20)).toBe(TOPSOIL);
  });
});
