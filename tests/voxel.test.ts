import { describe, expect, it } from 'vitest';
import {
  AIR, CHUNK, CLAY, SAND, STONE, TOPSOIL, VoxelWorld,
  isSolid, layeredGenerator, materialOf,
} from '../src/voxel/VoxelWorld';
import {
  CAVITY_DISH, DISH_CELLS, EDGE_CHAMFER, FACES, burialShade, meshChunk, tangentAxes,
} from '../src/voxel/mesher';
import { CLOD_RADIUS, MAX_LOOSE_CLODS, LooseSoil, SCOOP_PIECES, type Clod } from '../src/voxel/LooseSoil';
import { HAUL_FLOOR, PELLET_FILL, QUEEN_MASS_G, clodMassGrams, haulFactor } from '../src/voxel/mass';
import { MAX_CLOD_AXIS_SCALE, MIN_CLOD_AXIS_SCALE, SOIL_CLOD_VARIANT_COUNT, buildClodShape, pieceSource, styleForVoxel } from '../src/voxel/clod';
import { HEX_AIR, HEX_BULGE, HEX_HEIGHT, HEX_NEIGHBOURS, HEX_RADIUS, HexWorld, hexAt, hexCentre, hexCorners, meshHexWorld } from '../src/voxel/HexGrid';
import { SKY_PHASES, packColor, skyAt, wrapHours } from '../src/voxel/daylight';
import { HIT_BEVEL, CELL_COUNT, CHIP_CELLS, chipHalfExtent, chipOffset, CLOD_SIZE_MAX, CLOD_SIZE_MIN, CRACK_BRANCHES, HIT_COUNT, MAX_SHRINK, clodSizeScale, hitPhase, CRACK_JOINTS, CRACK_START, crackSegments, PIECES_PER_VOXEL, releasedBetween, MAX_REMOVED, buildFracture, cellCentre, cellSurvives, chipMeshData, erosionAt, erosionFor, eventsBetween, feelFor, hashVoxel, removedAt } from '../src/voxel/fracture';
import { raycastVoxel } from '../src/voxel/raycast';
import { DIG_FLOOR, DIG_START, DIG_STEP, DigSession } from '../src/voxel/DigSession';
import { TILE_MM, TILE_VOXELS, buildTileArrays, generateTile } from '../src/voxel/tileTextures';
import { DEN_MIN_CHAMBER, DEN_MIN_DEPTH, QueenFounding, countChamberAir } from '../src/voxel/QueenFounding';
import { DEFAULT_BANDS, DEFAULT_GAIT, GAITS, topSpeed, STICK_DEADZONE, approach, clampStickOrigin, speedForStick, stickVector } from '../src/voxel/locomotion';
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

/**
 * Which axis a vertex's face points along, recovered from its own UVs.
 *
 * The normals used to give this away, but they now follow the dish, so reading
 * the axis off them is exactly the mistake that would make these tests agree
 * with a bug. UVs are world[axisA] and world[axisB] over TILE_VOXELS, so the
 * two axes that match the UVs are the in-plane pair and the remaining one is
 * the face's own.
 */
const faceAxisOf = (
  p: readonly [number, number, number],
  u: number,
  v: number,
): number => {
  const inPlane = new Set<number>();
  for (const [uv, _] of [[u, 0], [v, 1]] as const) {
    for (let axis = 0; axis < 3; axis++) {
      if (Math.abs(p[axis]! / TILE_VOXELS - uv) < 1e-5) { inPlane.add(axis); break; }
    }
  }
  for (let axis = 0; axis < 3; axis++) if (!inPlane.has(axis)) return axis;
  return 1;
};

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

  /*
   * A lone voxel floating in a void, so every edge and corner is convex and the
   * chamfer runs at full strength. This is the only configuration that exercises
   * all of it at once.
   */
  const loneVoxel = (sx: number, sy: number, sz: number) => ({
    get: (x: number, y: number, z: number) => (x === sx && y === sy && z === sz ? TOPSOIL : 0),
  });

  /** Every undirected edge of the triangle soup, keyed by POSITION not index. */
  const edgeCensus = (data: NonNullable<ReturnType<typeof meshChunk>>) => {
    const key = (i: number) => {
      const p = data.positions;
      return `${p[i * 3]!.toFixed(4)},${p[i * 3 + 1]!.toFixed(4)},${p[i * 3 + 2]!.toFixed(4)}`;
    };
    const counts = new Map<string, number>();
    for (let t = 0; t < data.indices.length; t += 3) {
      const v = [data.indices[t]!, data.indices[t + 1]!, data.indices[t + 2]!];
      for (let e = 0; e < 3; e++) {
        const a = key(v[e]!);
        const b = key(v[(e + 1) % 3]!);
        const id = a < b ? `${a}|${b}` : `${b}|${a}`;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return counts;
  };

  it('chamfers a lone voxel into a rhombicuboctahedron', () => {
    const data = meshChunk(loneVoxel(5, 5, 5), 0, 0, 0)!;
    expect(data).not.toBeNull();
    // 6 square faces + 12 edge bevels + 8 corner triangles. This is the shape
    // that reads as round from every direction rather than only sideways.
    expect(data.quadCount).toBe(26);
    expect(data.positions.length / 3).toBe(6 * 4 + 12 * 4 + 8 * 3);
    expect(data.indices.length).toBe(6 * 6 + 12 * 6 + 8 * 3);
  });

  it('leaves no hole where cut and uncut vertices meet', () => {
    /*
     * The case the lone-voxel census could never see, and the one that shipped
     * broken: every vertex of a lone voxel is cut, so nothing there ever has to
     * agree with a neighbour that did NOT chamfer.
     *
     * A domino and a 2x2x2 block are the smallest CLOSED surfaces carrying both
     * kinds of vertex — the outward corners are cut, the ones facing the other
     * voxels are not — so a disagreement surfaces here as an unpaired edge
     * rather than as sky seen through the ground two commits later.
     */
    const domino = {
      get: (x: number, y: number, z: number) => (
        y === 5 && z === 5 && (x === 5 || x === 6) ? TOPSOIL : 0
      ),
    };
    const block = {
      get: (x: number, y: number, z: number) => (
        x >= 5 && x <= 6 && y >= 5 && y <= 6 && z >= 5 && z <= 6 ? TOPSOIL : 0
      ),
    };
    for (const shape of [domino, block]) {
      const counts = edgeCensus(meshChunk(shape, 0, 0, 0)!);
      expect([...counts.entries()].filter(([, n]) => n !== 2)).toEqual([]);
    }
  });

  it('chamfers along a RUN of rim and tapers at both its ends', () => {
    /*
     * The thing "all three faces open" could not do. A tunnel rim has only two
     * faces open, so under that rule every rim stayed square; the question that
     * works is whether the convex edge CONTINUES past this vertex.
     *
     * A three-cell trench in flat ground: the rim runs from z=10 to z=13, so the
     * two interior vertices are supported by the edge carrying on and the two
     * end vertices are not. The face should be cut back in the middle and sit on
     * the lattice at the ends — a taper, which is what a chamfered edge is.
     */
    const trench = {
      get: (x: number, y: number, z: number) => {
        if (y > 5) return 0;
        if (x === 10 && y === 5 && z >= 10 && z <= 12) return 0;
        return TOPSOIL;
      },
    };
    const data = meshChunk(trench, 0, 0, 0)!;
    // The sky-facing edge of the rim voxels at x=11, sampled per lattice line.
    const byZ = new Map<number, number>();
    for (let i = 0; i < data.positions.length; i += 3) {
      const [px, py, pz] = [data.positions[i]!, data.positions[i + 1]!, data.positions[i + 2]!];
      if (data.normals[i + 1]! < 0.5 || Math.abs(py - 6) > 1e-6) continue;
      if (px < 11 - 1e-6 || px > 11 + EDGE_CHAMFER + 1e-6) continue;
      if (Math.abs(pz - Math.round(pz)) > 1e-6) continue;
      byZ.set(Math.round(pz), Math.min(byZ.get(Math.round(pz)) ?? 99, px));
    }
    // Ends of the run sit on the lattice; the interior is cut back.
    expect(byZ.get(10)).toBeCloseTo(11, 5);
    expect(byZ.get(13)).toBeCloseTo(11, 5);
    expect(byZ.get(11)).toBeCloseTo(11 + EDGE_CHAMFER, 5);
    expect(byZ.get(12)).toBeCloseTo(11 + EDGE_CHAMFER, 5);
  });

  it('opens no hole along a run of rim either', () => {
    /*
     * A taper is exactly where two voxels have to agree about a shared vertex
     * and can most easily disagree. Measured as sky-facing area, which a hole
     * eats into: flat ground less the three cells of trench.
     */
    const world = makeWorld();
    const cy = Math.floor(SURFACE / CHUNK);
    world.dig(40, SURFACE, 40);
    world.dig(40, SURFACE, 41);
    world.dig(40, SURFACE, 42);
    const data = meshChunk(world, 1, cy, 1)!;
    let up = 0;
    for (let t = 0; t < data.indices.length; t += 3) {
      const [i, j, k] = [data.indices[t]!, data.indices[t + 1]!, data.indices[t + 2]!];
      const p = (n: number) => [data.positions[n * 3]!, data.positions[n * 3 + 2]!];
      const [a, b, c] = [p(i), p(j), p(k)];
      const area = ((b[0]! - a[0]!) * (c[1]! - a[1]!) - (c[0]! - a[0]!) * (b[1]! - a[1]!)) / 2;
      if (data.normals[i * 3 + 1]! > 0.5) up += Math.abs(area);
    }
    expect(up).toBeCloseTo(CHUNK * CHUNK - 3, 4);
  });

  it('opens no hole at the corners of a dug pit', () => {
    /*
     * The exact shape of the shipped bug, kept as a regression. At a pit corner
     * three top faces meet: the two bordering the pit pulled their corner in,
     * the diagonal one did not, and the wedge between them was open sky.
     *
     * Measured as upward-facing area rather than by edge census, because a
     * chunk's mesh is not a closed surface — it ends at the chunk seam, where
     * unpaired edges are legitimate. The ground is flat, so the area facing the
     * sky must come to exactly the number of columns still covered.
     */
    const world = makeWorld();
    const cy = Math.floor(SURFACE / CHUNK);
    world.dig(40, SURFACE, 40);
    const data = meshChunk(world, 1, cy, 1)!;
    let up = 0;
    for (let t = 0; t < data.indices.length; t += 3) {
      const [i, j, k] = [data.indices[t]!, data.indices[t + 1]!, data.indices[t + 2]!];
      const p = (n: number) => [data.positions[n * 3]!, data.positions[n * 3 + 2]!];
      const [a, b, c] = [p(i), p(j), p(k)];
      // Signed area projected onto the ground plane, upward-facing only.
      const area = ((b[0]! - a[0]!) * (c[1]! - a[1]!) - (c[0]! - a[0]!) * (b[1]! - a[1]!)) / 2;
      if (data.normals[i * 3 + 1]! > 0.5) up += Math.abs(area);
    }
    // 32x32 columns less the one dug away. A corner hole is a shortfall here.
    expect(up).toBeCloseTo(CHUNK * CHUNK - 1, 4);
  });

  it('leaves no slit anywhere in the chamfered surface', () => {
    /*
     * The whole risk of insetting a face is that its neighbours no longer meet
     * it and you get a hairline crack you can see straight through. A closed
     * surface has every edge shared by exactly two triangles; anything shared
     * once is a hole.
     */
    const counts = edgeCensus(meshChunk(loneVoxel(5, 5, 5), 0, 0, 0)!);
    const open = [...counts.entries()].filter(([, n]) => n !== 2);
    expect(open).toEqual([]);
  });

  it('only ever cuts material away, never adds it', () => {
    /*
     * Targeting is a DDA raycast and collision is axis-separated AABBs, both
     * against the true grid. Geometry drawn OUTSIDE the voxel is rock the
     * player can walk their face through, so the chamfer has to stay inside.
     */
    const data = meshChunk(loneVoxel(5, 5, 5), 0, 0, 0)!;
    for (let i = 0; i < data.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        expect(data.positions[i + axis]!).toBeGreaterThanOrEqual(5 - 1e-6);
        expect(data.positions[i + axis]!).toBeLessThanOrEqual(6 + 1e-6);
      }
    }
  });

  it('winds every chamfer primitive outward too', () => {
    /*
     * The bevels and corner triangles pick their winding from a cross product
     * at runtime rather than from a hand-written table, because the FACES table
     * traverses some faces' in-plane axes backwards. This checks the result
     * against the normal each vertex actually carries.
     */
    const data = meshChunk(loneVoxel(5, 5, 5), 0, 0, 0)!;
    for (let t = 0; t < data.indices.length; t += 3) {
      const [i, j, k] = [data.indices[t]!, data.indices[t + 1]!, data.indices[t + 2]!];
      const p = (n: number) => [
        data.positions[n * 3]!, data.positions[n * 3 + 1]!, data.positions[n * 3 + 2]!,
      ] as const;
      const [a, b, c] = [p(i), p(j), p(k)];
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const cross = [
        ab[1]! * ac[2]! - ab[2]! * ac[1]!,
        ab[2]! * ac[0]! - ab[0]! * ac[2]!,
        ab[0]! * ac[1]! - ab[1]! * ac[0]!,
      ];
      const n = [data.normals[i * 3]!, data.normals[i * 3 + 1]!, data.normals[i * 3 + 2]!];
      expect(cross[0]! * n[0]! + cross[1]! * n[1]! + cross[2]! * n[2]!).toBeGreaterThan(0);
    }
  });

  it('costs a flat wall nothing — no convex edges, no chamfer', () => {
    /*
     * The property that makes this affordable. A wall voxel has one exposed
     * face and four solid in-plane neighbours, so no pair of faces is open and
     * none of the chamfer code runs. Asserted through the vertex count, which
     * would rise the moment a bevel appeared.
     */
    const world = makeWorld();
    const cy = Math.floor(SURFACE / CHUNK);
    const data = meshChunk(world, 1, cy, 1)!;
    expect(data.positions.length / 3).toBe(data.quadCount * 4);
    expect(data.indices.length).toBe(data.quadCount * 6);
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
    /*
     * Within THIS chunk: lose one top face, gain four side walls — and those
     * walls face a CAVITY, so each is subdivided into DISH_CELLS² quads to be
     * bowed into the soil. The open sky face that went was a single quad,
     * because open ground is never dished.
     */
    const cell = DISH_CELLS * DISH_CELLS;
    /*
     * And no chamfer at all.
     *
     * Each rim voxel does show two perpendicular faces, so the edge between
     * them is convex — but BOTH its ends run on into solid rim, so neither end
     * vertex is cut and the bevel would have nothing to taper to. Chamfering it
     * anyway is what punched sky-holes through the corners of the pit.
     *
     * So a one-voxel pit is drawn exactly as it was before the chamfer existed.
     * Rounding a rim properly needs the cut to run ALONG the convex edge across
     * several voxels and taper only at its true ends, which needs the face
     * boundary subdivided; see the note on EDGE_CHAMFER.
     */
    expect(after).toBe(before - 1 + 4 * cell);
    // The pit's floor belongs to the chunk BELOW — SURFACE is the first voxel
    // row of chunk cy, so y-1 is across the seam. That is exactly why set()
    // dirties the neighbouring chunk as well.
    const below = meshChunk(world, 1, cy - 1, 1);
    expect(below).not.toBeNull();
    expect(below!.quadCount).toBe(cell);
  });

  it('leaves open ground flat and dishes only cavity walls', () => {
    /*
     * The hex room's rounded sockets, brought across to the cube world — but
     * only where they belong. Dishing the open plain would make the ground
     * read as bumpy and would multiply every visible quad on the surface by
     * nine for nothing.
     */
    const world = makeWorld();
    const cy = Math.floor(SURFACE / CHUNK);
    const flat = meshChunk(world, 1, cy, 1)!;
    // Untouched ground: every emitted quad is a whole face, none subdivided.
    for (let i = 0; i < flat.positions.length; i += 3) {
      const y = flat.positions[i + 1]!;
      // A dished vertex sits off the voxel lattice; a flat one never does.
      expect(Math.abs(y - Math.round(y))).toBeLessThan(1e-6);
    }
  });

  it('always has solid soil immediately behind the drawn surface', () => {
    /*
     * Targeting is a DDA raycast and collision is axis-separated AABBs, both
     * against the true grid. Drawn geometry in FRONT of that grid is rock the
     * player can walk their face through.
     *
     * Stated as "step a hair along -normal and you must be inside solid soil",
     * which is the invariant itself rather than a proxy for it. That matters
     * now: the old form measured each vertex against its own lattice plane and
     * recovered the face axis from the UVs, which is meaningless for a bevel or
     * a corner triangle — they have no single face axis. This covers flat faces,
     * dished faces and chamfer geometry with one rule.
     *
     * Sampled at triangle CENTROIDS, not vertices. A vertex can sit exactly on a
     * lattice corner shared by four voxels, and if any one of them has been dug
     * then which voxel floor() picks is arbitrary — (40,97,40) is such a point
     * here. The centroid of a triangle is always strictly inside its own face,
     * so there is nothing to be ambiguous about.
     */
    const world = makeWorld();
    world.dig(40, SURFACE, 40);
    world.dig(40, SURFACE - 1, 40);
    const cy = Math.floor(SURFACE / CHUNK);
    const data = meshChunk(world, 1, cy, 1)!;
    for (let t = 0; t < data.indices.length; t += 3) {
      const vs = [data.indices[t]!, data.indices[t + 1]!, data.indices[t + 2]!];
      const mid = [0, 1, 2].map((k) => vs.reduce((s, v) => s + data.positions[v * 3 + k]!, 0) / 3);
      const n = [0, 1, 2].map((k) => vs.reduce((s, v) => s + data.normals[v * 3 + k]!, 0) / 3);
      const behind = [0, 1, 2].map((k) => Math.floor(mid[k]! - 1e-3 * n[k]!));
      expect(world.get(behind[0]!, behind[1]!, behind[2]!)).not.toBe(0);
    }
  });

  it('anchors the dish to the CHAMFERED boundary, so bevels still meet it', () => {
    /*
     * Dishing and chamfering both move a face's vertices, and they have to agree
     * about where its boundary is. The dish bows the middle of the quad back and
     * must fall to zero at the quad's edge; the chamfer decides where that edge
     * IS. Point the dish at the raw lattice corners instead of the inset ones
     * and each dished face stops short of its own bevel, opening a hairline slit
     * at every rounded edge — the same trap the hex mesher had.
     *
     * The two want different neighbourhoods, so the shape has to satisfy both.
     * Dishing needs the AIR to be walled in on three sides or more; a cut vertex
     * needs three of the SOLID voxel's faces open. Three single air cells poked
     * into solid rock along +X, +Y and +Z from (6,5,6) does both: each pocket is
     * enclosed on all six sides bar one, and (6,5,6) has exactly one cut vertex,
     * at (+1,+1,+1).
     */
    const pockets = {
      get: (x: number, y: number, z: number) => (
        (x === 7 && y === 5 && z === 6)
        || (x === 6 && y === 6 && z === 6)
        || (x === 6 && y === 5 && z === 7) ? 0 : TOPSOIL
      ),
    };
    const data = meshChunk(pockets, 0, 0, 0)!;
    // The +X face of (6,5,6): on the plane x=7, dished back along -X.
    const onFace: number[][] = [];
    for (let i = 0; i < data.positions.length; i += 3) {
      const [px, py, pz] = [data.positions[i]!, data.positions[i + 1]!, data.positions[i + 2]!];
      if (px <= 7 + 1e-6 && px >= 7 - CAVITY_DISH - 1e-6
        && py >= 5 - 1e-6 && py <= 6 + 1e-6 && pz >= 6 - 1e-6 && pz <= 7 + 1e-6
        && data.normals[i]! > 0) onFace.push([py, pz]);
    }
    expect(onFace.length).toBeGreaterThanOrEqual((DISH_CELLS + 1) ** 2);
    /*
     * And the face's top edge TAPERS along its length, which is the whole point
     * of deciding this per vertex.
     *
     * Only the (+1,+1,+1) end of that edge is cut — the other end runs on into
     * solid soil at -Z, so it stays on the lattice and the bevel narrows to a
     * point there. Cutting the edge back uniformly is what tore holes at the
     * corners of a dug pit.
     */
    const near = onFace.filter(([, pz]) => pz! >= 6.5).map(([py]) => py!);
    const far = onFace.filter(([, pz]) => pz! <= 6.05).map(([py]) => py!);
    expect(Math.max(...near)).toBeCloseTo(6 - EDGE_CHAMFER, 5);
    expect(Math.max(...far)).toBeCloseTo(6, 5);
    expect(Math.min(...onFace.map(([py]) => py!))).toBeCloseTo(5, 5);
  });

  it('leaves no orphaned vertices in the buffer', () => {
    /*
     * A dished face used to push its four flat corners and then never index
     * them, drawing a subdivided grid instead: four dead vertices on every
     * dished face, which is most of the underground surface. It also made the
     * buffer impossible to reason about from outside, which is how the
     * chamfer's own test came to be measuring geometry that is never drawn.
     */
    const world = makeWorld();
    world.dig(40, SURFACE, 40);
    world.dig(40, SURFACE - 1, 40);
    const cy = Math.floor(SURFACE / CHUNK);
    for (const data of [meshChunk(world, 1, cy, 1)!, meshChunk(loneVoxel(5, 5, 5), 0, 0, 0)!]) {
      expect(new Set(data.indices).size).toBe(data.positions.length / 3);
    }
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

/**
 * Dig a cell out. ONE press — kept as a helper so the tests that only want the
 * cell gone still read the same as they did when it took four.
 */
const digOut = (session: DigSession, x: number, y: number, z: number) => {
  session.beginDig(x, y, z);
  return session.tickDig(999);
};

describe('DigSession', () => {
  it('pops a voxel in ONE press, whole', () => {
    /*
     * It used to take four, a sheet at a time. That existed to make one voxel
     * feel like more than one object, and it cost a cell that could be solid in
     * the world while having already handed the player its soil — the state
     * every conservation bug lived in. The cell is the unit now: either she
     * finishes and it is gone, or she stops and it is untouched.
     */
    const world = makeWorld();
    const session = new DigSession(world);
    const full = session.secondsFor(TOPSOIL);

    session.beginDig(20, SURFACE, 20);
    expect(session.tickDig(full * 0.5).kind).toBe('progress');
    expect(world.get(20, SURFACE, 20)).toBe(TOPSOIL);
    expect(session.tickDig(full * 0.6).kind).toBe('dug');
    expect(world.get(20, SURFACE, 20)).toBe(AIR);
    expect(session.digging).toBeNull();
    expect(session.carried).toBe(1);
  });

  it('leaves nothing behind when a dig is cancelled part way', () => {
    /*
     * The half-dug cube is gone as a concept, so this is a statement about the
     * whole model: stopping mid-press excavates nothing, spills nothing and
     * credits no practice. There is no partial state to carry between presses,
     * so nothing can spill its soil a second time.
     */
    const world = makeWorld();
    const session = new DigSession(world);
    session.beginDig(20, SURFACE, 20);
    session.tickDig(session.secondsFor(TOPSOIL) * 0.9);
    session.cancelDig();
    expect(world.get(20, SURFACE, 20)).toBe(TOPSOIL);
    expect(session.carried).toBe(0);
    expect(session.excavatedPieces).toBe(0);
    expect(session.practiced).toBe(0);
    session.beginDig(20, SURFACE, 20);
    expect(session.chewRatio).toBe(0);
  });

  it('holds its target so the camera can look away mid-dig', () => {
    const world = makeWorld();
    const session = new DigSession(world);
    const full = session.secondsFor(TOPSOIL);
    session.beginDig(20, SURFACE, 20);
    session.tickDig(full * 0.9);
    // Nothing re-aims it — the locked cube is the only thing tickDig knows
    // about, which is what removed the old thumb-drift progress reset.
    expect(session.digging).toEqual({ x: 20, y: SURFACE, z: 20 });
    expect(session.tickDig(full * 0.2).kind).toBe('dug');
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
    // Counted in PIECES: one dug cube is a voxel's worth of them, and placing
    // a cube spends the lot. A part load cannot place, which is what stops
    // four scoops of nothing becoming a cube.
    expect(session.carried).toBe(PIECES_PER_VOXEL);
    expect(session.carriedVoxels).toBe(1);
    expect(session.place(20, SURFACE + 2, 20).kind).toBe('placed');
    expect(session.carried).toBe(0);
    expect(world.excavated).toBe(world.deposited);
  });

  it('stops digging once the ant is carrying a full load', () => {
    const world = makeWorld();
    const session = new DigSession(world, { capacityVoxels: 2 });
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
    const session = new DigSession(world, { capacityVoxels: 8 });
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
      const session = new DigSession(world, { capacityVoxels: 999 });
      // 12.5 -> 1.7 in 0.6 steps is 18 digs to master; founding the den costs
      // 14-19, so the queen tops out almost exactly as she finishes.
      // Rounded, not ceiled: (12.5 - 1.7) / 0.6 is 18.000000000000004 in
      // binary floating point, and ceil turns that into a spurious 19.
      const toMaster = Math.round((DIG_START - DIG_FLOOR) / DIG_STEP);
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
      expect(session.secondsFor(CLAY)).toBeLessThanOrEqual(19);
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

  it('tops out at the gait she is in, not at a run', () => {
    /*
     * The reported problem, in one assertion: a thumb parked on the rim of the
     * stick used to mean RUN, because the three bands shared a single throw and
     * nobody drives a stick to 35% and holds it. Full throw is a walk now, and
     * the other two gaits are asked for rather than found by accident.
     */
    expect(speedForStick(1)).toBeCloseTo(DEFAULT_BANDS.walk, 5);
    expect(speedForStick(1, 'walk')).toBeCloseTo(DEFAULT_BANDS.walk, 5);
    expect(speedForStick(1, 'crawl')).toBeCloseTo(DEFAULT_BANDS.crawl, 5);
    expect(speedForStick(1, 'run')).toBeCloseTo(DEFAULT_BANDS.run, 5);
    expect(DEFAULT_GAIT).toBe('walk');
  });

  it('keeps the stick analogue inside every gait', () => {
    // The point of the mode is to cap the top, not to throw away fine control:
    // half a throw is still half speed, whichever gait is engaged.
    for (const gait of GAITS) {
      const top = topSpeed(gait);
      expect(speedForStick(0, gait)).toBe(0);
      expect(speedForStick(STICK_DEADZONE, gait)).toBe(0);
      const half = STICK_DEADZONE + (1 - STICK_DEADZONE) / 2;
      expect(speedForStick(half, gait)).toBeCloseTo(top / 2, 5);
      expect(speedForStick(1, gait)).toBeCloseTo(top, 5);
    }
  });

  it('is continuous and monotonic within a gait', () => {
    for (const gait of GAITS) {
      let previous = -1;
      for (let m = 0; m <= 1.0001; m += 0.01) {
        const v = speedForStick(m, gait);
        expect(v).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = v;
      }
      for (let m = 0.1; m < 1; m += 0.005) {
        const step = Math.abs(speedForStick(m + 0.005, gait) - speedForStick(m, gait));
        expect(step).toBeLessThan(0.35);
      }
    }
  });

  it('orders the gaits, and makes the crawl genuinely slow', () => {
    expect(topSpeed('crawl')).toBeLessThan(topSpeed('walk'));
    expect(topSpeed('walk')).toBeLessThan(topSpeed('run'));
    // Otherwise "crawl" is a label rather than a usable placement speed.
    expect(topSpeed('crawl')).toBeLessThan(topSpeed('walk') * 0.5);
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

  it('gives neighbouring voxels different shapes', () => {
    /*
     * A wall of soil must not wobble in lockstep. This used to compare removal
     * ORDER across cells, which was the only per-voxel variation a 64-piece
     * cube had; a cell has one piece now, so the variation lives entirely in
     * the jitter and spin. Same guarantee, read off what still carries it.
     */
    const seen = new Set<string>();
    for (let x = 0; x < 6; x++) {
      for (let z = 0; z < 6; z++) {
        const f = buildFracture(x, S, z, TOPSOIL);
        seen.add([...f.jitter, ...f.spin].map((v) => v.toFixed(4)).join(','));
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

  /** Every crack on the lump, across all six faces. */
  const allCracks = (pattern: Parameters<typeof crackSegments>[0]) => (
    FACES.flatMap((_, i) => crackSegments(pattern, i))
  );

  it('cracks the face progressively, and never un-cracks it', () => {
    /*
     * With one cell per press there is nothing to subtract during a dig, so the
     * cracks ARE the progress readout. They have to grow monotonically — a
     * crack that closed again would read as the soil healing.
     */
    const pattern = buildFracture(7, S, 9, TOPSOIL);
    const at = (p: number) => allCracks(pattern).filter((c) => p >= c.at - 1e-4).length;
    expect(at(0)).toBe(0);
    expect(at(CRACK_START - 0.01)).toBe(0);
    let last = 0;
    for (let p = 0; p <= 1.0001; p += 0.02) {
      const n = at(p);
      expect(n).toBeGreaterThanOrEqual(last);
      last = n;
    }
    // The struck face at full strength, the other five reduced and delayed.
    expect(last).toBe((CRACK_BRANCHES + 5 * (CRACK_BRANCHES - 3)) * CRACK_JOINTS);
  });

  it('keeps every crack on the face it belongs to', () => {
    /*
     * Branches reach up to 1.6 across a face that spans 1, so before they were
     * folded back they were simply drawn past the edge — thin dark whiskers
     * hanging in the air beside the block. That also made the block MEASURE a
     * seventh wider than the solid it is, at the one moment its size is being
     * compared against the pellet replacing it.
     *
     * The limit is the square face at its smallest, which is after the bevel
     * has taken HIT_BEVEL off each side: the twelve bevels and eight corner
     * cuts around it are freshly broken soil and carry no old cracks.
     */
    const room = 1 - HIT_BEVEL;
    for (let i = 0; i < 24; i++) {
      const pattern = buildFracture(3 + i, S, 7 + i * 5, i % 2 ? TOPSOIL : CLAY);
      for (let face = 0; face < 6; face++) {
        for (const seg of crackSegments(pattern, face)) {
          for (const v of [seg.ax, seg.ay, seg.bx, seg.by]) {
            expect(Math.abs(v) + seg.width).toBeLessThanOrEqual(room + 1e-9);
          }
          // And every joint is a REAL one: folding back at the edge has to move
          // the point, or the list claims cracks the mesh will not draw.
          expect(Math.hypot(seg.bx - seg.ax, seg.by - seg.ay)).toBeGreaterThan(1e-6);
        }
      }
    }
  });

  it('grows the crack geometry with the dig', () => {
    // The mesh has to carry it, not just the segment list: a cracked cell is
    // six cube faces plus one quad per crack that has opened so far.
    const pattern = buildFracture(7, S, 9, TOPSOIL);
    const early = chipMeshData(pattern, 7, S, 9, 0.05)!.quadCount;
    const mid = chipMeshData(pattern, 7, S, 9, 0.5)!.quadCount;
    const late = chipMeshData(pattern, 7, S, 9, 0.95)!.quadCount;
    expect(early).toBe(6);
    expect(mid).toBeGreaterThan(early);
    expect(late).toBeGreaterThan(mid);
    const open = allCracks(pattern).filter((c) => 0.95 >= c.at - 1e-4).length;
    expect(late).toBe(26 + open);
  });

  it('starts every crack at the point she struck', () => {
    /*
     * Damage radiating from one blow, not noise sprinkled over a face. The
     * strike point is also what decides which face is cracked at all, so this
     * catches the pattern being laid out on the wrong side of the cell.
     */
    const pattern = buildFracture(7, S, 9, TOPSOIL, { x: 1, y: 0, z: 0 });
    const [axisA, axisB] = tangentAxes([1, 0, 0]);
    const strike = [pattern.strike.x, pattern.strike.y, pattern.strike.z];
    const su = strike[axisA]! * 2 - 1;
    const sv = strike[axisB]! * 2 - 1;
    // The struck face only: the other five have no blow to radiate from.
    const struckFace = FACES.findIndex((f) => f.normal[0] === 1);
    const roots = crackSegments(pattern, struckFace).filter((c) => c.ax === su && c.ay === sv);
    expect(roots).toHaveLength(CRACK_BRANCHES);
  });

  it('winds every crack quad outward, on every face she can strike', () => {
    /*
     * The bug this exists for: the face-local (u, v) basis is not consistently
     * right-handed against the face normal — on a top face the tangent axes are
     * X and Z, and cross(X, Z) is -Y — so a fixed index order leaves the crack
     * facing INTO the soil on half the faces and back-face culling eats it. It
     * rendered nothing at all and the quad COUNT was still correct, which is
     * exactly why counting quads could not see it.
     */
    for (const face of FACES) {
      const pattern = buildFracture(7, S, 9, TOPSOIL, {
        x: face.normal[0], y: face.normal[1], z: face.normal[2],
      });
      const data = chipMeshData(pattern, 7, S, 9, 0.9)!;
      for (let t = 0; t < data.indices.length; t += 3) {
        const [i, j, k] = [data.indices[t]!, data.indices[t + 1]!, data.indices[t + 2]!];
        const p = (n: number) => [
          data.positions[n * 3]!, data.positions[n * 3 + 1]!, data.positions[n * 3 + 2]!,
        ] as const;
        const [a, b, c] = [p(i), p(j), p(k)];
        const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const cross = [
          ab[1]! * ac[2]! - ab[2]! * ac[1]!,
          ab[2]! * ac[0]! - ab[0]! * ac[2]!,
          ab[0]! * ac[1]! - ab[1]! * ac[0]!,
        ];
        const n = [data.normals[i * 3]!, data.normals[i * 3 + 1]!, data.normals[i * 3 + 2]!];
        expect(cross[0]! * n[0]! + cross[1]! * n[1]! + cross[2]! * n[2]!).toBeGreaterThan(0);
      }
    }
  });

  it('cracks the same way every time, so a cancel does not reshuffle them', () => {
    const a = allCracks(buildFracture(7, S, 9, TOPSOIL));
    const b = allCracks(buildFracture(7, S, 9, TOPSOIL));
    expect(a).toEqual(b);
    // And a different cell cracks differently.
    expect(allCracks(buildFracture(8, S, 9, TOPSOIL))).not.toEqual(a);
    // And no two FACES of one cell share a pattern, or the lump reads as one
    // stamp repeated six times however you walk round it.
    const p = buildFracture(7, S, 9, TOPSOIL);
    const perFace = FACES.map((_, i) => JSON.stringify(crackSegments(p, i)));
    expect(new Set(perFace).size).toBe(FACES.length);
  });

  it('draws the cell as ONE lump, not a cluster', () => {
    /*
     * The complaint that started the rework: it read as one large cube breaking
     * apart, because it WAS — a 4x4x4 cluster of crumbs pretending to be a
     * voxel. One cell is one lump, so the chip mesh is one cube's worth of
     * faces and there are no interior seams for a grid to show through.
     */
    const pattern = buildFracture(11, S, 23, TOPSOIL);
    /*
     * Sampled before the first HIT lands, so this counts the lump alone and
     * unbevelled: six faces, no interior seams for a grid to show through.
     */
    expect(chipMeshData(pattern, 11, S, 23, CRACK_START - 0.01)!.quadCount).toBe(6);
    /*
     * And whatever grows after that is cracks on its surface, never more lumps.
     * Stated against the segments actually open at that moment rather than
     * against all fifteen, so it does not quietly depend on where the last
     * crack falls relative to the cell letting go.
     */
    const late = 0.9;
    const open = allCracks(pattern).filter((c) => late >= c.at - 1e-4).length;
    expect(open).toBeGreaterThan(0);
    /*
     * Once she has been hitting it, the lump is a chamfered box — 6 faces, 12
     * edge bevels, 8 corner triangles — because the corners are knocked back a
     * step per hit. Still ONE lump: no extra bodies, just a rounder one.
     */
    expect(chipMeshData(pattern, 11, S, 23, late)!.quadCount - open).toBe(26);
  });

  it('frees every piece, because nothing is deleted any more', () => {
    // The old model left one crumb standing to become the clod. Now all 64
    // come away as real soil, so a dig is 64 pieces in, 64 pieces out.
    const pattern = buildFracture(2, S, 3, TOPSOIL, { x: 0, y: 1, z: 0 });
    expect(removedAt(pattern, 1)).toBe(CELL_COUNT);
    expect(CELL_COUNT).toBe(PIECES_PER_VOXEL);
    expect(releasedBetween(pattern, 0, 1)).toHaveLength(CELL_COUNT);
  });

  it('hands each piece out exactly once, in order', () => {
    /*
     * releasedBetween is what turns a piece into a real lump of soil, so a
     * piece handed out twice is soil minted from nothing and one skipped is
     * soil destroyed. Walking the whole dig in small steps has to yield each
     * cell precisely once.
     */
    const pattern = buildFracture(7, S, 2, TOPSOIL, { x: 0, y: 1, z: 0 });
    const seen: number[] = [];
    let from = 0;
    for (let to = 0.02; to <= 1.0001; to += 0.02) {
      seen.push(...releasedBetween(pattern, from, to));
      from = to;
    }
    seen.push(...releasedBetween(pattern, from, 1));
    expect(seen).toHaveLength(CELL_COUNT);
    expect(new Set(seen).size).toBe(CELL_COUNT);
    expect(seen).toEqual(Array.from(pattern.order));
  });

  it('cracks BEFORE it visibly shrinks, not after', () => {
    /*
     * Reported from play: the block started shrinking and the cracks turned up
     * about three seconds later, so it read as the soil deflating and then
     * splitting rather than splitting and then giving.
     *
     * Two causes. Cracks were held until 12% of the dig, and the shrink ran
     * linearly from 0% — so the ordering was literally reversed. Measured off
     * the geometry rather than the constants, because that is what the player
     * sees.
     */
    const pattern = buildFracture(3, S, 4, TOPSOIL);
    const width = (p: number) => {
      const d = chipMeshData(pattern, 3, S, 4, p)!;
      let lo = Infinity; let hi = -Infinity;
      for (let i = 0; i < d.positions.length; i += 3) {
        lo = Math.min(lo, d.positions[i]!); hi = Math.max(hi, d.positions[i]!);
      }
      return hi - lo;
    };
    const whole = width(0);
    const firstCrack = Math.min(...allCracks(pattern).map((c) => c.at));
    /*
     * Under a tenth of the dig — about a second at twelve seconds a cell.
     * It was 0.23, or nearly three seconds, which is what the report described.
     */
    expect(firstCrack).toBeLessThan(0.1);
    expect(whole - width(firstCrack + 0.001)).toBeLessThan(whole * 0.01);
    /*
     * Deliberately NOT asserting the end-state size from the same measurement.
     * By then the cell is tilted and carrying a hundred crack quads lifted
     * proud of its faces, both of which grow the axis-aligned bounds — the box
     * is actually WIDER at 0.95 than at 0, so it says nothing about shrink.
     * MAX_SHRINK is checked against the thing it is derived FROM instead: the
     * block has to finish at exactly the size of the pellet it becomes, or the
     * handover is a swap between two different objects rather than one lump
     * carrying on.
     */
    expect(1 - MAX_SHRINK).toBeCloseTo(2 * CLOD_RADIUS, 6);
    /*
     * And with the per-cell variation applied, every cell still lands on its
     * OWN pellet — which is the property that lets the size vary at all.
     */
    for (let i = 0; i < 40; i++) {
      const scale = clodSizeScale(i, S, 7, TOPSOIL);
      expect(scale).toBeGreaterThanOrEqual(CLOD_SIZE_MIN);
      expect(scale).toBeLessThanOrEqual(CLOD_SIZE_MAX);
      const p2 = buildFracture(i, S, 7, TOPSOIL);
      expect(p2.sizeScale).toBeCloseTo(scale, 9);
    }
    // Different cells really do differ, or the variation is decorative only.
    const scales = new Set(
      Array.from({ length: 30 }, (_, i) => clodSizeScale(i, S, 8, TOPSOIL).toFixed(5)),
    );
    expect(scales.size).toBeGreaterThan(25);
  });

  it('publishes the size it is drawn at, for collision to use', () => {
    /*
     * The block stays SOLID in the world for the whole dig — that is what stops
     * the soil being spent before it is earned — so the ant collided with a
     * full cube however far the block under her had shrunk. Standing on a cell
     * she was digging down through, she hovered a third of a voxel above it and
     * dropped when it finally went.
     *
     * Collision reads chipHalfExtent now, so it can only be right if that is
     * the same number the mesh is built from. Measured against the mesh here
     * rather than re-derived, because a second copy of this arithmetic is
     * exactly how the block and the pellet came to be different sizes.
     */
    const pattern = buildFracture(11, S, 23, TOPSOIL);
    let last = Infinity;
    for (const progress of [0, 0.2, 0.4, 0.6, 0.8, 0.95]) {
      const half = chipHalfExtent(pattern, progress);
      // Never grows back: collision that ratchets the wrong way would push her
      // out of a hole she had already dug.
      expect(half).toBeLessThanOrEqual(last + 1e-9);
      last = half;

      // The faces of the drawn block sit exactly this far from its centre. Its
      // own drift and jolt move the whole lump, so measure about the middle of
      // what was drawn rather than about the cell.
      const data = chipMeshData(pattern, 11, S, 23, progress)!;
      for (const k of [0, 1, 2]) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = k; i < data.positions.length; i += 3) {
          lo = Math.min(lo, data.positions[i]!);
          hi = Math.max(hi, data.positions[i]!);
        }
        // Bevelled corners and tilt pull the extremes IN, and the cracks lifted
        // proud of each face push them back out, so this is a bound rather than
        // an equality — but a full cube would be 0.5 and blow straight past it.
        expect((hi - lo) / 2).toBeLessThanOrEqual(half * 1.2);
      }
    }
    // It ends on the pellet, which is the whole point of the handover.
    expect(chipHalfExtent(pattern, 0.999)).toBeCloseTo(CLOD_RADIUS * pattern.sizeScale, 9);
    // And a fresh cell is still a whole voxel, or she would fall into the
    // ground the instant she started digging.
    expect(chipHalfExtent(pattern, 0)).toBeCloseTo(0.5, 9);
  });

  it('publishes where the block has drifted to, for the outline to follow', () => {
    /*
     * The block does not sit still: it drifts as it loosens and kicks on every
     * hit. The target outline was a full cell centred on the CELL, so by the
     * last hits it enclosed a lump half its size sitting off to one side — an
     * outline drawn where there was no longer any soil.
     *
     * Checked against where the mesh actually IS rather than by re-deriving the
     * arithmetic, because a second copy of it is how the block and the pellet
     * came to be different sizes in the first place.
     */
    const pattern = buildFracture(11, S, 23, TOPSOIL);
    let moved = 0;
    for (const progress of [0, 0.25, 0.5, 0.75, 0.95]) {
      const data = chipMeshData(pattern, 11, S, 23, progress)!;
      const offset = chipOffset(pattern, progress);
      const cell = [11.5, S + 0.5, 23.5];
      for (const k of [0, 1, 2]) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = k; i < data.positions.length; i += 3) {
          lo = Math.min(lo, data.positions[i]!);
          hi = Math.max(hi, data.positions[i]!);
        }
        // Tilt turns about the block's own centre and the cracks sit on
        // opposite faces alike, so the middle of what is drawn IS its middle.
        const drawn = (lo + hi) / 2 - cell[k]!;
        expect(drawn).toBeCloseTo([offset.x, offset.y, offset.z][k]!, 2);
        moved = Math.max(moved, Math.abs(drawn));
      }
    }
    // It really does wander, or an outline pinned to the cell would have been
    // fine all along and this is testing nothing.
    expect(moved).toBeGreaterThan(0.02);
    // An untouched cell has not moved: the outline starts out on the cell.
    const still = chipOffset(pattern, 0);
    expect(Math.hypot(still.x, still.y, still.z)).toBeCloseTo(0, 9);
  });

  it('changes only ON a hit, never between them', () => {
    /*
     * The dig is a sequence of BLOWS now, not a smooth dissolve: a crack opens,
     * the block jolts and loses a step of size, dust comes off — and between
     * hits nothing happens at all. Continuous erosion made the cell shrink on
     * its own while nothing was striking it, which reads as the soil
     * evaporating rather than as an ant working at it.
     *
     * Asserted by sampling either side of a hit boundary: no crack may open in
     * the quiet stretch between two blows.
     */
    const pattern = buildFracture(3, S, 4, TOPSOIL);
    for (const c of allCracks(pattern)) {
      // Every crack lands exactly on a hit boundary.
      expect(c.at * HIT_COUNT).toBeCloseTo(Math.round(c.at * HIT_COUNT), 6);
    }
    // And the quiet stretch really is quiet.
    for (let h = 0; h < HIT_COUNT; h++) {
      const from = (h + 0.05) / HIT_COUNT;
      const to = (h + 0.95) / HIT_COUNT;
      expect(eventsBetween(pattern, from, to)).toEqual([]);
    }
  });

  it('jolts on the hit and settles before the next one', () => {
    // The kick has to die away, or the block buzzes continuously instead of
    // being struck. Driven off hit phase, not wall time, so it stays in step
    // with a dig that speeds up with practice.
    expect(hitPhase(0).hits).toBe(0);
    expect(hitPhase(1).hits).toBe(HIT_COUNT);
    const mid = hitPhase(2.5 / HIT_COUNT);
    expect(mid.hits).toBe(2);
    expect(mid.since).toBeCloseTo(0.5, 6);
    // Out of range clamps rather than running the hit count off either end.
    expect(hitPhase(-1).hits).toBe(0);
    expect(hitPhase(99).hits).toBe(HIT_COUNT);
  });

  it('sheds dust from each crack as it opens', () => {
    /*
     * One cell means ONE removal event, so the whole trickle of chip events
     * that used to come from 64 pieces breaking away went with the sheets and
     * the dig was silent until the cell let go. A crack opening is the only
     * thing actually happening during a press, so it is what carries the dust.
     */
    const pattern = buildFracture(3, S, 4, TOPSOIL);
    const mid = eventsBetween(pattern, 0.3, 0.6);
    expect(mid.length).toBeGreaterThan(0);
    expect(mid.every((e) => e.kind === 'DIG_CHIP_SMALL')).toBe(true);
    // Positioned ON the block, so the dust falls off the damage rather than
    // appearing in a cloud around it.
    for (const e of mid) {
      for (const k of ['x', 'y', 'z'] as const) {
        expect(e.at[k]).toBeGreaterThanOrEqual(0);
        expect(e.at[k]).toBeLessThanOrEqual(1);
      }
    }
    /*
     * Every crack fires exactly once across the whole dig, never twice — plus
     * the one the CELL ITSELF fires as it comes away, which is a different
     * thing and has to still be there.
     */
    const chips = eventsBetween(pattern, 0, 1).filter((e) => e.kind === 'DIG_CHIP_SMALL');
    expect(chips.length).toBe(allCracks(pattern).length + 1);
  });

  it('fires chip events only when soil actually breaks', () => {
    const pattern = buildFracture(5, S, 5, TOPSOIL);
    // Nothing between two points with no crumb boundary between them.
    expect(eventsBetween(pattern, 0, 0)).toEqual([]);
    const all = eventsBetween(pattern, 0, 1);
    // DIG_CRACK went with the sheets: a crack marked a scoop's worth of soil
    // coming loose while the cube still stood, and there is no such moment now.
    expect(all.some((e) => e.kind === 'DIG_RELEASE')).toBe(true);
    expect(all.some((e) => e.kind === 'DIG_CRACK')).toBe(false);
    // And the release fires once, at the end, not repeatedly.
    expect(eventsBetween(pattern, 1, 1).length).toBe(0);
  });

  it('varies the feel by soil without needing separate systems', () => {
    // Clay lets go in slabs, sand trickles.
    expect(feelFor(CLAY).clumping).toBeGreaterThan(feelFor(SAND).clumping);
    expect(feelFor(SAND).dust).toBeGreaterThan(feelFor(CLAY).dust);
  });

  it('stays cheap enough for a phone', () => {
    // Worst case is the whole lump plus every crack open: 6 + 28 quads, for
    // ONE cell being worked at a time. It was 27 x 6 when a voxel was a cluster,
    // and only ever ONE cell is being worked, so this is the whole dig budget.
    let worst = 0;
    for (let p = 0; p <= 1; p += 0.02) {
      const data = chipMeshData(buildFracture(2, S, 3, TOPSOIL), 2, S, 3, p);
      worst = Math.max(worst, data?.quadCount ?? 0);
    }
    const pattern = buildFracture(2, S, 3, TOPSOIL);
    // A chamfered box (26) plus six faces of cracks, on ONE cell — and only
    // ever one cell is being worked, so this is the whole per-dig budget.
    expect(worst).toBeLessThanOrEqual(26 + allCracks(pattern).length);
    expect(worst).toBeLessThan(180);
  });

  it('cannot mint soil by cancelling half way through', () => {
    /*
     * The trap the old model opened, kept because the property still matters.
     * Pieces used to be handed to the world a sheet at a time while the cube
     * was still standing, so a cancel had to reclaim whatever had already gone
     * out or the same cube could spill twice.
     *
     * There is no window to reclaim any more: one press is the whole cell, so
     * until it lands nothing has been issued at all. Asserted from the outside,
     * against the world, so it stays true however the visual is built.
     */
    const world = makeWorld();
    const session = new DigSession(world);
    const before = world.excavated;
    session.beginDig(20, SURFACE, 20);
    session.tickDig(session.secondsFor(TOPSOIL) * 0.96);
    expect(world.excavated).toBe(before);
    expect(session.excavatedPieces).toBe(before * PIECES_PER_VOXEL);
    session.cancelDig();
    expect(world.excavated).toBe(before);
    expect(session.carried).toBe(0);
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
    digOut(session, 20, SURFACE, 20);
    expect(world.excavated).toBe(1);
    expect(session.carried).toBe(PIECES_PER_VOXEL);
    session.place(20, SURFACE + 2, 20);
    expect(world.excavated).toBe(world.deposited);
  });
});

describe('weight', () => {
  it('fills the fraction of its bounding cube the mass model assumes', () => {
    /*
     * PELLET_FILL is the one number in mass.ts that is not measured — it is a
     * property of the SHAPE, asserted in a file that never sees the geometry.
     * So measure it: the divergence theorem over the real triangles, against
     * the cube the shape spans. A pellet is a cube with its corners knocked
     * off, so this sits below 1 and well above the 0.52 of a sphere.
     *
     * If the bevel is ever retuned, this is what notices — rather than every
     * load in the game quietly weighing the wrong amount.
     */
    const fills: number[] = [];
    for (let variant = 0; variant < SOIL_CLOD_VARIANT_COUNT; variant++) {
      const shape = buildClodShape(variant);
      let volume = 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < shape.positions.length; i += 9) {
        const p = (k: number) => [
          shape.positions[i + k * 3]!,
          shape.positions[i + k * 3 + 1]!,
          shape.positions[i + k * 3 + 2]!,
        ];
        const [a, b, c] = [p(0), p(1), p(2)];
        volume += (
          a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!)
          - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!)
          + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)
        ) / 6;
        for (let k = 0; k < 3; k++) {
          lo = Math.min(lo, shape.positions[i + k * 3]!);
          hi = Math.max(hi, shape.positions[i + k * 3]!);
        }
      }
      const span = hi - lo;
      fills.push(Math.abs(volume) / (span * span * span));
    }
    /*
     * A BAND, not a point. The lumping moves each variant a few percent either
     * side, so PELLET_FILL is a representative average and pretending it is
     * exact would just mean a test that has to be edited every time the soil
     * feel is touched. What matters is that the constant sits among the real
     * shapes rather than drifting off on its own.
     */
    expect(Math.min(...fills)).toBeGreaterThan(0.76);
    expect(Math.max(...fills)).toBeLessThan(0.9);
    expect(PELLET_FILL).toBeGreaterThan(Math.min(...fills) - 0.05);
    expect(PELLET_FILL).toBeLessThan(Math.max(...fills) + 0.05);
  });

  it('weighs a pellet at something a real ant could pick up', () => {
    /*
     * A nominal topsoil pellet is 2.5 mm across, and real fire-ant and
     * leafcutter pellets run around 17 mg. Landing near there is the check that
     * the g/cm^3 to g/mm^3 conversion went the right way: getting it backwards
     * makes every load a thousand times too light, which is the one error that
     * produces no symptom at all beyond the ant never slowing down.
     */
    const nominal = clodMassGrams(CLOD_RADIUS, TOPSOIL) * 1000;
    expect(nominal).toBeGreaterThan(8);
    expect(nominal).toBeLessThan(30);
    // Denser soil weighs more at the same size, which is the whole reason for
    // giving materials a density rather than soil one shared constant.
    expect(clodMassGrams(CLOD_RADIUS, CLAY)).toBeGreaterThan(clodMassGrams(CLOD_RADIUS, TOPSOIL));
    // Mass goes as the CUBE of size: twice the radius is eight times the load,
    // not twice. Linear here would flatten most of the spread away.
    expect(clodMassGrams(CLOD_RADIUS * 2, TOPSOIL))
      .toBeCloseTo(clodMassGrams(CLOD_RADIUS, TOPSOIL) * 8, 6);
  });

  it('slows her in proportion to the load, and never to a stop', () => {
    expect(haulFactor(0)).toBe(1);
    const light = clodMassGrams(CLOD_RADIUS * CLOD_SIZE_MIN, SAND);
    const heavy = clodMassGrams(CLOD_RADIUS * CLOD_SIZE_MAX, CLAY);
    expect(haulFactor(heavy)).toBeLessThan(haulFactor(light));
    /*
     * The SPREAD is the point of the whole change. If the lightest and heaviest
     * pellet moved her at the same speed then the flat multiplier this replaced
     * was already right and nothing has been bought.
     */
    expect(haulFactor(light) - haulFactor(heavy)).toBeGreaterThan(0.05);
    let last = 1.0001;
    for (let g = 0; g < 5; g += 0.05) {
      const f = haulFactor(g);
      expect(f).toBeLessThanOrEqual(last + 1e-9);
      expect(f).toBeGreaterThanOrEqual(HAUL_FLOOR - 1e-9);
      last = f;
    }
    // Floored rather than able to pin her in place.
    expect(haulFactor(1000)).toBe(HAUL_FLOOR);
  });

  it('is expressed against the ANT, so a heavier carrier struggles less', () => {
    // Body mass is a parameter, not a constant baked into the curve: the same
    // pellet has to cost a worker more than it costs the queen once workers
    // exist, without this file learning anything new.
    const pellet = clodMassGrams(CLOD_RADIUS, TOPSOIL);
    expect(haulFactor(pellet, QUEEN_MASS_G / 3)).toBeLessThan(haulFactor(pellet, QUEEN_MASS_G));
    expect(haulFactor(pellet, QUEEN_MASS_G * 3)).toBeGreaterThan(haulFactor(pellet, QUEEN_MASS_G));
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
      /*
       * ...but never a spike. Measured against the MEAN rather than the min,
       * because the shape families are deliberately not balls: a cube's own
       * corner sits 1.73x its face distance before a single lump goes on, so a
       * max/min bound would now be a bound on being cube-shaped rather than on
       * being spiky. A spike is a vertex far from the body of the shape.
       */
      const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
      expect(max / mean).toBeLessThan(1.8);
      expect(min / mean).toBeGreaterThan(0.35);
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

  /*
   * The handoff, which had been wrong in two ways at once and looked it.
   *
   * A dig ends by swapping the worked block for a loose pellet, in one frame,
   * in the middle of the screen. For that not to read as a swap, the pellet has
   * to be the same solid at the same size — and neither side of it held:
   *
   *  - SIZE: both sides scale themselves by clodSizeScale of a coordinate, but
   *    pieceSource scrambled the pellet's, so the two drew INDEPENDENT numbers
   *    out of the same range. Measured at up to a quarter apart.
   *  - SHAPE: the block ends as a cube with its corners knocked off; the pellet
   *    was a hex prism.
   *
   * Both are pinned here rather than left to the eye, because neither is
   * visible in any single frame of a screenshot — only in the cut between two.
   */
  it('hands the block over to a pellet of the same size', () => {
    for (const [x, y, z] of [[64, S, 64], [65, S, 64], [64, S - 1, 64], [70, S, 71]]) {
      // What the chip mesh shrinks to: half-extent CLOD_RADIUS * its own scale.
      const blockHalf = CLOD_RADIUS * clodSizeScale(x!, y!, z!, TOPSOIL);
      // What the pellet is drawn at: PIECE_SIZE * the scale for its source
      // cell, applied to a shape whose own half-extent is 0.5.
      const src = pieceSource(x!, y!, z!, 0);
      const pelletHalf = CLOD_RADIUS * clodSizeScale(src.x, src.y, src.z, TOPSOIL);
      expect(pelletHalf).toBeCloseTo(blockHalf, 10);
    }
  });

  it('builds the pellet as the block, cut back by the same bevel', () => {
    const shape = buildClodShape(0);
    /*
     * Half-extent along an axis is simply how far the solid reaches on it: the
     * six square faces ARE the extremes. Unlike a sphere-sampled hull there is
     * no vertex sitting ON the axis to go looking for — an earlier version of
     * this went looking for one, found none, and reported a half-extent of zero.
     */
    const axis = (k: number) => {
      let most = 0;
      for (let i = k; i < shape.positions.length; i += 3) {
        most = Math.max(most, Math.abs(shape.positions[i]!));
      }
      return most;
    };
    // 0.5, so PIECE_SIZE scales it onto the block's own span. The roughening
    // moves it a little; the tolerance is that, not slack.
    for (const k of [0, 1, 2]) expect(axis(k)).toBeGreaterThan(0.46);
    for (const k of [0, 1, 2]) expect(axis(k)).toBeLessThan(0.54);

    /*
     * And the corners really are cut. An uncut cube reaches sqrt(3) times its
     * face distance; this solid stops at sqrt(1 + 2 * (1 - HIT_BEVEL)^2), which
     * is what makes it read as worked rather than as a die.
     */
    let far = 0;
    for (let i = 0; i < shape.positions.length; i += 3) {
      far = Math.max(far, Math.hypot(
        shape.positions[i]!, shape.positions[i + 1]!, shape.positions[i + 2]!,
      ));
    }
    const cut = Math.hypot(1, 1 - HIT_BEVEL, 1 - HIT_BEVEL);
    expect(far / 0.5).toBeLessThan(cut * 1.12);
    expect(far / 0.5).toBeGreaterThan(1.2);
  });

  it('rests a pellet on the floor at the size it is drawn', () => {
    /*
     * The floating-clod fault, one rung down from where it was caught before.
     *
     * That time the drawn radius was hard-coded at 0.085 against a collision
     * radius of 0.3. This time the drawn radius was right and the PHYSICS used
     * the nominal size, so a pellet drawing at 0.78 of nominal came to rest on
     * a sphere a fifth bigger than itself and hovered above the floor.
     */
    const sizeOf = (c: Clod) => CLOD_RADIUS * clodSizeScale(
      c.source.x, c.source.y, c.source.z, c.material,
    );
    const floor = { get: (_x: number, y: number) => (y <= S ? TOPSOIL : AIR) };
    /*
     * The EXTREMES of the size range, searched for rather than picked.
     *
     * The first version of this used two cells that happened to land near the
     * nominal size, so the gap it exists to catch was a few thousandths of a
     * voxel — and it passed with the fault put back in. These two are the
     * smallest and largest pellet in a 60x60 sweep.
     */
    const sources = [{ x: 48, y: S, z: 47 }, { x: 26, y: S, z: 4 }];
    const sizes = sources.map((source) => {
      const soil = new LooseSoil(sizeOf);
      const clod = soil.drop({ x: 20.5, y: S + 3, z: 20.5 }, TOPSOIL, source)!;
      for (let i = 0; i < 900; i++) soil.step(floor, 1 / 60, 9.8);
      /*
       * Its underside is ON the floor: neither sunk into it nor hovering.
       *
       * Two decimals, which is not slack. It settles within a thousandth --
       * the physics stops on contact a fraction of a frame's fall short -- and
       * resting at the nominal size instead misses by fifty times that.
       */
      expect(clod.position.y - soil.radius(clod)).toBeCloseTo(S + 1, 2);
      return soil.radius(clod);
    });
    // Far enough apart that resting them both at the nominal size cannot pass.
    expect(Math.abs(sizes[0]! - sizes[1]!)).toBeGreaterThan(0.08);
  });

  it('conserves soil across dig, drop and pick up again', () => {
    const world = makeWorld();
    const session = new DigSession(world);
    const soil = new LooseSoil();

    digOut(session, 20, S, 20);
    expect(world.excavated).toBe(1);

    const unit = session.release(PIECES_PER_VOXEL)!;
    expect(unit.source).toEqual({ x: 20, y: S, z: 20 });
    for (let i = 0; i < unit.count; i++) {
      soil.drop({ x: 20.5, y: S + 2, z: 20.5 }, unit.material, unit.source!);
    }
    // Every piece is in exactly one place at a time.
    expect(session.carried).toBe(0);
    expect(soil.count).toBe(PIECES_PER_VOXEL);
    expect(world.excavated * PIECES_PER_VOXEL)
      .toBe(session.carried + soil.count + world.deposited * PIECES_PER_VOXEL);

    // Scooping it back up returns the SAME soil, with the same identity.
    const clod = soil.clods[0]!;
    for (const piece of [...soil.clods]) soil.remove(piece);
    session.load.push({ material: clod.material, count: PIECES_PER_VOXEL, source: clod.source });
    expect(session.carried).toBe(PIECES_PER_VOXEL);
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
    digOut(session, 20, S, 20);
    expect(session.carried).toBe(PIECES_PER_VOXEL);

    const unit = session.release(PIECES_PER_VOXEL)!;
    expect(session.carried).toBe(0);
    // Simulating the refusal path: putting it back restores the load exactly.
    session.load.push(unit);
    expect(session.carried).toBe(PIECES_PER_VOXEL);
    expect(world.excavated * PIECES_PER_VOXEL).toBe(session.carried);
  });

  it('wakes resting spoil when the ground under it is dug away', () => {
    /*
     * The bug: a resting piece stops being simulated, which is what makes a
     * nest full of spoil affordable — and also means it never notices the cube
     * it was lying on being removed. A whole sheet sat asleep in mid-air over
     * the hole it had just come out of. Anything that mutates the grid has to
     * wake what is near it, or sleep quietly becomes levitation.
     */
    const world = makeWorld();
    const soil = new LooseSoil();
    soil.drop({ x: 20.5, y: SURFACE + 1.2, z: 20.5 }, TOPSOIL, { x: 20, y: SURFACE, z: 20 });
    for (let i = 0; i < 400; i++) soil.step(world, 1 / 60, 12);
    const clod = soil.clods[0]!;
    expect(clod.asleep).toBe(true);
    const restingAt = clod.position.y;

    // Take the floor away. Asleep, it would hang here for ever.
    world.dig(20, SURFACE, 20);
    for (let i = 0; i < 60; i++) soil.step(world, 1 / 60, 12);
    expect(clod.position.y).toBeCloseTo(restingAt, 5);

    expect(soil.wakeNear({ x: 20.5, y: SURFACE + 0.5, z: 20.5 }, 2.5)).toBe(1);
    expect(clod.asleep).toBe(false);
    for (let i = 0; i < 120; i++) soil.step(world, 1 / 60, 12);
    expect(clod.position.y).toBeLessThan(restingAt - 0.3);
  });

  it('only wakes what is actually near the change', () => {
    const soil = new LooseSoil();
    const near = soil.drop({ x: 20, y: 0, z: 20 }, TOPSOIL, { x: 1, y: 0, z: 0 })!;
    const far = soil.drop({ x: 40, y: 0, z: 40 }, TOPSOIL, { x: 2, y: 0, z: 0 })!;
    near.asleep = true;
    far.asleep = true;
    expect(soil.wakeNear({ x: 20, y: 0, z: 20 }, 2.5)).toBe(1);
    expect(near.asleep).toBe(false);
    expect(far.asleep).toBe(true);
  });

  it('gathers a scoop of the nearest pieces, not one grain at a time', () => {
    /*
     * An ant packs a mandible-load and walks. Nearest-first rather than a
     * radius, so a scoop is a FULL scoop wherever there is soil to fill it and
     * the pile is eaten from the near side instead of hollowing wherever the
     * radius happened to land.
     */
    const soil = new LooseSoil();
    for (let i = 0; i < 30; i++) {
      soil.drop({ x: 20 + i * 0.05, y: S, z: 20 }, TOPSOIL, { x: 20, y: S, z: 20 + i });
    }
    const scoop = soil.scoop({ x: 20, y: S, z: 20 }, SCOOP_PIECES, 2);
    expect(scoop).toHaveLength(SCOOP_PIECES);
    // Every piece taken is nearer than every piece left behind.
    const taken = new Set(scoop);
    const far = soil.clods.filter((c) => !taken.has(c));
    const worstTaken = Math.max(...scoop.map((c) => c.position.x - 20));
    const bestLeft = Math.min(...far.map((c) => c.position.x - 20));
    expect(worstTaken).toBeLessThanOrEqual(bestLeft);
  });

  it('gives a short grab rather than a phantom one when soil runs out', () => {
    // Soil conservation again: a grab must never hand back more pellets than
    // are actually lying there, however many the caller asks for.
    const soil = new LooseSoil();
    for (let i = 0; i < 3; i++) soil.drop({ x: 20, y: S, z: 20 }, TOPSOIL, { x: i, y: S, z: 20 });
    expect(soil.scoop({ x: 20, y: S, z: 20 }, 5, 2)).toHaveLength(3);
    expect(soil.scoop({ x: 40, y: S, z: 40 }, 5, 2)).toHaveLength(0);
  });

  it('holds a whole voxel as ONE pellet', () => {
    /*
     * A cube was four scoops of sixteen pieces. Cell, pellet and grab are all
     * the same object now, which is the point: there is no second unit for
     * conservation to drift between. The economy is unchanged — it still takes
     * a cube's worth to pack a cube.
     */
    expect(PIECES_PER_VOXEL).toBe(1);
    expect(SCOOP_PIECES).toBe(1);
    const world = makeWorld();
    const session = new DigSession(world, { capacityVoxels: 1 });
    digOut(session, 20, S, 20);
    expect(session.carriedVoxels).toBe(1);

    // Put the one pellet down and there is nothing left to pack a cube with.
    session.release(1);
    expect(session.place(20, S + 2, 20).kind).toBe('empty');
    expect(world.deposited).toBe(0);
  });

  it('builds a different lump for every cell it came out of', () => {
    /*
     * A pellet's shape is a pure function of its ORIGIN, so the same soil looks
     * the same lump from excavation through carrying to being put down, and the
     * same again after a reload. This used to vary the piece index within one
     * cube; a cube is one pellet now, so the variation that matters is between
     * neighbouring cells.
     */
    const variants = new Set<number>();
    for (let i = 0; i < 12; i++) {
      const src = pieceSource(20 + i, S, 20, 0);
      variants.add(styleForVoxel(src.x, src.y, src.z, TOPSOIL).variant);
      // Deterministic: same cell, same answer.
      expect(pieceSource(20 + i, S, 20, 0)).toEqual(src);
    }
    // Not all 12, but nothing like all-the-same either.
    expect(variants.size).toBeGreaterThan(6);
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
    // Closer than it used to be: a piece is a quarter-voxel across now, so
    // the reach that shoved a whole clod no longer touches one.
    const pushed = soil.displace(
      { x: 20.5, y: clod.position.y, z: clod.position.z - 0.25 }, 0.3, { x: 0, y: 0, z: 1 }, 3,
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
    digOut(session, 20, S, 20);
    session.release();
    // Nothing was deposited, and the world is still a plain voxel grid.
    expect(world.deposited).toBe(0);
    expect(world.get(20, S, 20)).toBe(AIR);
    expect(world.get(21, S, 20)).toBe(TOPSOIL);
  });
});

describe('hex grid experiment', () => {
  it('lists neighbours in the same order as the side faces', () => {
    /*
     * The bug this pins: side face i spans corners i and i+1, so its outward
     * normal lies at 60 + 60i degrees. Listing the neighbours in the usual
     * [1,0]-first order puts every entry one step out of phase, culling the
     * wrong faces — the walls render as disconnected vertical slats.
     */
    const corners = hexCorners();
    for (let i = 0; i < 6; i++) {
      const a = corners[i]!;
      const b = corners[(i + 1) % 6]!;
      const faceAngle = Math.atan2((a.z + b.z) / 2, (a.x + b.x) / 2);

      const [dq, dr] = HEX_NEIGHBOURS[i]!;
      const here = hexCentre(0, 0, 0);
      const there = hexCentre(dq, dr, 0);
      const neighbourAngle = Math.atan2(there.z - here.z, there.x - here.x);

      const delta = Math.atan2(
        Math.sin(faceAngle - neighbourAngle), Math.cos(faceAngle - neighbourAngle),
      );
      expect(Math.abs(delta)).toBeLessThan(1e-6);
    }
  });

  it('rounds a world position to the cell that actually contains it', () => {
    // Rounding q and r independently lands in the wrong cell near a shared
    // edge, which is the classic hex-grid trap.
    for (const [q, r] of [[0, 0], [2, -1], [-3, 2], [1, 3]] as const) {
      const centre = hexCentre(q, r, 0);
      const found = hexAt(centre.x, 0, centre.z);
      expect([found.q, found.r]).toEqual([q, r]);
    }
  });

  it('emits nothing for a fully buried cell', () => {
    // Same property that makes the cube world affordable: cost tracks what has
    // been dug, not how big the room is.
    const world = new HexWorld(1, 3, 0);
    const before = meshHexWorld(world, () => 1).faceCount;
    world.dig(0, 0, -1); // the middle layer of the centre column
    const after = meshHexWorld(world, () => 1).faceCount;
    // Opening a buried cell exposes its own six sides plus a cap and a floor.
    expect(after).toBeGreaterThan(before);
  });

  it('digs a cell once and leaves it empty', () => {
    const world = new HexWorld(2, 4, 0);
    expect(world.get(0, 0, 0)).not.toBe(HEX_AIR);
    expect(world.dig(0, 0, 0)).not.toBe(HEX_AIR);
    expect(world.get(0, 0, 0)).toBe(HEX_AIR);
    expect(world.dig(0, 0, 0)).toBe(HEX_AIR);
  });

  it('winds every triangle to face the way its normal points', () => {
    /*
     * The bug this pins, and it cost a build to find by eye: every triangle was
     * fanned the other way round, so each face's front pointed INTO the soil.
     * The material is FrontSide, so the walls around you were culled and you
     * saw the inside of the far ones through them — no walls, floating in a
     * bowl. Winding is invisible to a face count and invisible to a normal
     * check; it only shows up as a cross product.
     */
    const world = new HexWorld(2, 4, 0);
    world.dig(0, 0, -1);
    world.dig(0, 0, -2);
    const data = meshHexWorld(world, () => 1);
    const at = (i: number) => [
      data.positions[i * 3]!, data.positions[i * 3 + 1]!, data.positions[i * 3 + 2]!,
    ] as const;

    let checked = 0;
    for (let t = 0; t < data.indices.length; t += 3) {
      const ia = data.indices[t]!;
      const a = at(ia); const b = at(data.indices[t + 1]!); const c = at(data.indices[t + 2]!);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
      const cross = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
      ] as const;
      const n = [
        data.normals[ia * 3]!, data.normals[ia * 3 + 1]!, data.normals[ia * 3 + 2]!,
      ] as const;
      const dot = cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2];
      expect(dot).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('dishes the walls back into the soil, never out into the cavity', () => {
    /*
     * The socket is rounded by pushing each wall's waist AWAY from the air.
     * Targeting is a ray march against the grid and collision is a grid query,
     * so the true surface is the flat prism — drawn geometry that stood in
     * FRONT of it would be rock you can walk your face through.
     */
    const world = new HexWorld(1, 4, 0);
    world.dig(0, 0, -1);
    const data = meshHexWorld(world, () => 1);
    const apothem = (HEX_RADIUS * Math.sqrt(3)) / 2;

    // Every vertex of the dug cell's own wall must be at least an apothem from
    // that cell's axis: on the flat plane, or behind it.
    const centre = hexCentre(0, 0, -1);
    let waist = 0;
    for (let i = 0; i < data.positions.length; i += 3) {
      const y = data.positions[i + 1]!;
      if (Math.abs(y - centre.y) > HEX_HEIGHT / 2 - 1e-6) continue; // cap ring
      const d = Math.hypot(data.positions[i]! - centre.x, data.positions[i + 2]! - centre.z);
      if (d > HEX_RADIUS + HEX_BULGE + 1e-6) continue; // a neighbour's far wall
      expect(d).toBeGreaterThanOrEqual(apothem - 1e-6);
      waist = Math.max(waist, d);
    }
    // And it really does reach the circle through the corners at the waist,
    // rather than staying a prism with rounded corners.
    expect(waist).toBeCloseTo(HEX_RADIUS, 2);
  });

  it('pinches back to the full hexagon at every cell boundary', () => {
    /*
     * The dish MUST fall to zero at the ends. Carry it into the cap and the
     * wall's top edge sits inset from the cap's rim, over a solid neighbour's
     * footprint where nothing is meshed — a hairline slit at every floor and
     * ceiling that you can see straight through.
     */
    const world = new HexWorld(1, 4, 0);
    world.dig(0, 0, -1);
    const data = meshHexWorld(world, () => 1);
    const centre = hexCentre(0, 0, -1);
    const half = HEX_HEIGHT / 2;

    // Outward normals of the six sides. A point sits exactly ON the hexagon
    // boundary when its furthest projection onto one of them is the apothem;
    // anything less is inset, and inset is what opens the slit.
    const corners = hexCorners();
    const apothem = (HEX_RADIUS * Math.sqrt(3)) / 2;
    const normals = corners.map((c, i) => {
      const d = corners[(i + 1) % 6]!;
      const mx = (c.x + d.x) / 2;
      const mz = (c.z + d.z) / 2;
      const len = Math.hypot(mx, mz);
      return { x: mx / len, z: mz / len };
    });

    let seen = 0;
    for (let i = 0; i < data.positions.length; i += 3) {
      const y = data.positions[i + 1]!;
      if (Math.abs(Math.abs(y - centre.y) - half) > 1e-6) continue;
      const ox = data.positions[i]! - centre.x;
      const oz = data.positions[i + 2]! - centre.z;
      if (Math.hypot(ox, oz) > HEX_RADIUS + 1e-6) continue;
      const reach = Math.max(...normals.map((n) => ox * n.x + oz * n.z));
      expect(reach).toBeCloseTo(apothem, 6);
      seen++;
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe('daylight', () => {
  it('lands exactly on a phase at its own hour', () => {
    for (const phase of SKY_PHASES) {
      const grade = skyAt(phase.at);
      expect(grade.background).toBeCloseTo(phase.background, 6);
      expect(grade.sunIntensity).toBeCloseTo(phase.sunIntensity, 6);
      expect(grade.from.name).toBe(phase.name);
      expect(grade.blend).toBe(0);
    }
  });

  it('blends the short way round midnight instead of running backwards', () => {
    /*
     * The one case worth a test. Phases are ordered by hour, so the gap between
     * the LAST of them and the first runs through midnight — measured as a
     * plain subtraction it comes out negative and puts the blend outside 0..1,
     * which reads as the sky snapping from dusk back to noon at 23:59.
     */
    const dusk = SKY_PHASES[SKY_PHASES.length - 1]!;
    const night = SKY_PHASES[0]!;
    const span = 24 - dusk.at + night.at;
    const mid = skyAt(dusk.at + span / 2);
    expect(mid.from.name).toBe(dusk.name);
    expect(mid.to.name).toBe(night.name);
    expect(mid.blend).toBeCloseTo(0.5, 5);
    // And it really is between the two, not past either end.
    const lo = Math.min(dusk.background, night.background);
    const hi = Math.max(dusk.background, night.background);
    expect(mid.background).toBeGreaterThanOrEqual(lo);
    expect(mid.background).toBeLessThanOrEqual(hi);
  });

  it('wraps, so any hour is a valid hour', () => {
    expect(wrapHours(-1)).toBe(23);
    expect(wrapHours(25)).toBe(1);
    expect(skyAt(-6).background).toBeCloseTo(skyAt(18).background, 6);
    for (let h = -48; h <= 48; h += 0.37) {
      const g = skyAt(h);
      expect(Number.isFinite(g.background)).toBe(true);
      expect(g.blend).toBeGreaterThanOrEqual(0);
      expect(g.blend).toBeLessThanOrEqual(1);
    }
  });

  it('never goes darker than night or brighter than noon', () => {
    // A lerp between listed phases cannot overshoot, and that is the property
    // that keeps a bad phase table from blowing out the exposure at 03:00.
    const lows = SKY_PHASES.map((p) => p.background);
    for (let h = 0; h < 24; h += 0.1) {
      expect(skyAt(h).background).toBeGreaterThanOrEqual(Math.min(...lows) - 1e-9);
      expect(skyAt(h).background).toBeLessThanOrEqual(Math.max(...lows) + 1e-9);
    }
  });

  it('packs colours without wrapping a channel', () => {
    expect(packColor([0, 0, 0])).toBe(0x000000);
    expect(packColor([1, 1, 1])).toBe(0xffffff);
    // Out of range must clamp, not roll over into the next channel.
    expect(packColor([2, -1, 0.5])).toBe(0xff0080);
  });
});

describe('burial shading', () => {
  it('bottoms out exactly where the terrain AO does', () => {
    /*
     * The bug this exists for: loose soil had NO occlusion at all. Terrain gets
     * per-vertex AO and the chip visual has a burial term, but a pellet in a
     * tunnel was drawn at plain material brightness — the one thing in frame
     * lit from nowhere, which is what made spoil look pasted on.
     *
     * The floor has to MATCH, or a pellet and the wall behind it bottom out at
     * different darknesses and the pellet reads as a hole or a highlight.
     */
    const solid = { get: () => TOPSOIL };
    // A cell walled in on every side is the darkest case either system has, and
    // both have to agree on it. 0.45 is AO_LEVELS[0] inside the mesher.
    expect(burialShade(FACES.length)).toBeCloseTo(0.45, 6);
    // And a pellet out in the open is not darkened at all, the way open ground
    // is not — otherwise spoil on the surface reads as permanently in shadow.
    expect(burialShade(0)).toBe(1);
    expect(meshChunk(solid, 0, 0, 0)).toBeNull();
  });

  it('is monotonic and never brightens anything', () => {
    expect(burialShade(0)).toBe(1);
    let last = 1.0001;
    for (let n = 0; n <= FACES.length; n++) {
      const v = burialShade(n);
      expect(v).toBeLessThanOrEqual(last);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
      last = v;
    }
    // Out of range clamps rather than going negative and inverting the colour.
    expect(burialShade(99)).toBe(burialShade(FACES.length));
    expect(burialShade(-3)).toBe(1);
  });
});

describe('chamfer holes at dug corners', () => {
  /*
   * Watertightness by ray parity, not by area and not by edge census.
   *
   * Both of those were tried and both were wrong. The edge census cannot tell a
   * hole from a T-junction, which the cavity dish creates by the hundred. And
   * upward-facing AREA is not conserved at all: chamfering a convex vertical
   * edge legitimately trades flat top surface for sloped bevel, so a perfectly
   * closed pit corner comes up half a chamfer squared short — which is the
   * "shortfall" two earlier tests here were built around and failed on forever.
   *
   * Parity is immune to both. A ray from the sky down into deep soil crosses a
   * closed surface an ODD number of times, whatever the tessellation.
   */
  const digAt = (cells: [number, number, number][]) => {
    const world = makeWorld();
    for (const [x, y, z] of cells) world.dig(x, y, z);
    const tris: number[][] = [];
    for (let cy = 1; cy <= 3; cy++) {
      const d = meshChunk(world, 1, cy, 1);
      if (!d) continue;
      const p = (n: number) => [
        d.positions[n * 3]!, d.positions[n * 3 + 1]!, d.positions[n * 3 + 2]!,
      ];
      for (let t = 0; t < d.indices.length; t += 3) {
        tris.push([...p(d.indices[t]!), ...p(d.indices[t + 1]!), ...p(d.indices[t + 2]!)]);
      }
    }
    return tris;
  };

  /** Sample points whose downward ray crosses the surface an EVEN number of times. */
  const leaks = (tris: number[][], lo: number, hi: number) => {
    const bad: string[] = [];
    const N = 12;
    for (let iu = 0; iu < (hi - lo) * N; iu++) {
      for (let iv = 0; iv < (hi - lo) * N; iv++) {
        // Offset by irrationals: a sample landing exactly on a quad's shared
        // diagonal hits both of its triangles and reads as even for no reason.
        const x = lo + (iu + 0.5) / N + 0.00317;
        const z = lo + (iv + 0.5) / N + 0.00731;
        let n = 0;
        for (const t of tris) {
          const [ax, az] = [t[0]!, t[2]!];
          const [bx, bz] = [t[3]!, t[5]!];
          const [cx, cz] = [t[6]!, t[8]!];
          const dA = (x - bx) * (az - bz) - (ax - bx) * (z - bz);
          const dB = (x - cx) * (bz - cz) - (bx - cx) * (z - cz);
          const dC = (x - ax) * (cz - az) - (cx - ax) * (z - az);
          if ((dA < 0 || dB < 0 || dC < 0) && (dA > 0 || dB > 0 || dC > 0)) continue;
          n++;
        }
        if (n % 2 === 0) bad.push(`${x.toFixed(3)},${z.toFixed(3)} crossings=${n}`);
      }
    }
    return bad;
  };

  it('leaves no hole where two runs of rim meet at a corner', () => {
    // An L is the case where two runs of rim MEET, so a vertex can be supported
    // by the edge continuing along one arm while the other arm disagrees.
    const tris = digAt([
      [40, SURFACE, 40], [41, SURFACE, 40], [42, SURFACE, 40],
      [40, SURFACE, 41], [40, SURFACE, 42],
    ]);
    expect(leaks(tris, 38, 45)).toEqual([]);
  });

  it('leaves no hole around a cell dug diagonally from another', () => {
    // The checkerboard case: two cells touching only along an edge, each
    // carrying its own rim, with nothing between them to agree with.
    expect(leaks(digAt([[45, SURFACE, 45], [46, SURFACE, 46]]), 43, 49)).toEqual([]);
  });

  it('leaves no hole in a pit whose floor steps down unevenly', () => {
    // Depth varying cell to cell is what an ant actually digs, and it is the
    // only shape here that exercises the chamfer on vertical edges of walls
    // that are one cell tall in one place and three in the next.
    const cells: [number, number, number][] = [];
    const depth = [1, 3, 2, 0, 2, 1, 3, 1, 0, 2, 1, 3, 2, 1, 1, 0];
    for (let i = 0; i < 16; i++) {
      for (let d = 0; d < depth[i]!; d++) {
        cells.push([44 + (i & 3), SURFACE - d, 44 + (i >> 2)]);
      }
    }
    expect(leaks(digAt(cells), 43, 49)).toEqual([]);
  });
});

describe('chunk invalidation', () => {
  /*
   * The corner holes reported from play, and the reason every test above could
   * be green while the game was visibly broken: the MESHER was never at fault.
   * Chunks are meshed independently and marked dirty by proximity to the edit,
   * and that rule only ever counted the six FACE neighbours — from back when a
   * voxel's geometry depended only on the six voxels touching it.
   *
   * The chamfer changed that. It decides each corner by asking whether the
   * convex edge runs on past the vertex, which reads a voxel DIAGONALLY across,
   * so digging beside a seam can change geometry in a chunk that meets this one
   * only at an edge or a corner. That chunk was never rebuilt: it went on
   * chamfering as though nothing had been dug while the chunk next to it pulled
   * its corners in for the new pit, and the wedge between the two was open sky.
   */
  const fingerprints = (world: VoxelWorld) => {
    const out = new Map<number, string>();
    for (let cy = 0; cy < world.chunksY; cy++) {
      for (let cz = 0; cz < world.chunksZ; cz++) {
        for (let cx = 0; cx < world.chunksX; cx++) {
          const d = meshChunk(world, cx, cy, cz);
          let h = 0;
          for (const v of d?.positions ?? []) h = (Math.imul(h, 31) + Math.round(v * 4096)) | 0;
          out.set(world.chunkIndex(cx, cy, cz), `${d?.positions.length ?? 0}:${h}`);
        }
      }
    }
    return out;
  };

  it('marks every chunk whose mesh a dig changes, not just the face neighbours', () => {
    // Narrow rather than the usual 128 cube: this re-meshes the WHOLE world
    // twice to see what moved, so the cost is every chunk in it.
    const world = new VoxelWorld(64, 128, 64, layeredGenerator(SURFACE));
    /*
     * Set up so that (32, SURFACE, 32) — the first cell of chunk (1,·,1) — has
     * its top corner chamfered only once the DIAGONAL cell is gone. That is the
     * trench rule: the edge runs on past the vertex when the cell across the
     * corner is air too. The two digs are in two different chunks, and neither
     * shares a face with (1,·,1)'s.
     */
    world.dig(31, SURFACE, 32);
    const before = fingerprints(world);
    world.dirty.clear();
    world.dig(31, SURFACE, 31);
    const after = fingerprints(world);

    const changed = [...before.keys()].filter((i) => before.get(i) !== after.get(i));
    // If this ever comes up empty the test has stopped testing anything, so
    // assert the setup as well as the rule.
    expect(changed.length).toBeGreaterThan(1);
    expect(changed.filter((i) => !world.dirty.has(i))).toEqual([]);
  });

  it('reaches every chunk the mesher can read from, in all 26 directions', () => {
    const world = makeWorld();
    // A voxel in the very corner of chunk (1,1,1) can be read by the mesher
    // from all eight chunks meeting at that lattice corner.
    const corner = world.chunksNear(32, 32, 32);
    for (const [cx, cy, cz] of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1],
      [1, 1, 0], [1, 0, 1], [0, 1, 1], [1, 1, 1]] as [number, number, number][]) {
      expect(corner).toContain(world.chunkIndex(cx, cy, cz));
    }
    // Deep inside a chunk nothing else can see it, and rebuilding 27 chunks per
    // dig would undo the whole point of chunking.
    expect(world.chunksNear(48, 48, 48)).toEqual([world.chunkIndex(1, 1, 1)]);
    // Clamped at the world edge rather than emitting out-of-range indices.
    expect(world.chunksNear(0, 0, 0)).toEqual([world.chunkIndex(0, 0, 0)]);
  });
});
