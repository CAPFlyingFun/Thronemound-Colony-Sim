/**
 * Does the world survive being forgotten?
 *
 * Streaming trades storage for arithmetic: at any moment only a 3x3 window of
 * tiles exists as samples, and everything else is a formula plus a sparse note
 * of where the ant disagreed with it. That trade has exactly two ways to go
 * wrong, and neither is visible from a screenshot.
 *
 * The first is the SLIDE. Retained soil is moved inside the same array, source
 * and destination overlapping, which is a memmove and has a memmove's hazard:
 * copy the runs in the wrong order and it smears instead of moving. A smear
 * does not crash and does not tear the mesh — it produces perfectly plausible
 * terrain that is simply not the terrain the formula describes, which is
 * unfalsifiable by eye and which the whole map is then built on.
 *
 * The second is the EDIT REPLAY. A tunnel dug three tiles ago has to come back
 * exactly as it was left, from a store keyed by a hand-rolled index. Off by one
 * plane and the far edge of every dig heals itself on the next scroll — again,
 * invisible, because the healed soil is correct-looking soil.
 *
 * So both are checked against the formula and against an exact snapshot, not
 * against a picture. The mesh checks come last, on the streamed window rather
 * than on the fixed mound, because a window is not a blob and it was worth
 * knowing whether the surface nets care.
 */

import { describe, it, expect } from 'vitest';
import { buildSurfaceNets } from '../src/density/SurfaceNets';
import { TerrainStream } from '../src/density/TerrainStream';
import { eyeScan, survey } from './meshSurvey';
import {
  BITE_DEPTH, BRUSH_RADIUS, CELLS_Y, CELL_MM, CELL_SIZE, CHUNK_CELLS, WORLD_UNIT_MM,
} from '../src/density/labMound';
import {
  SOIL_DEPTH, TILE_CELLS, TILE_MM, WINDOW_BYTES, WINDOW_CELLS, WINDOW_SIZE,
  WINDOW_TILES, WORLD_SPAN, WORLD_TILES, streamGroundHeight, windowDensityAt,
} from '../src/density/labWorld';

const SAMPLES_Y = CELLS_Y + 1;
const SPAN = WINDOW_CELLS + 1;

/**
 * How far the window has drifted from the soil it is supposed to be holding.
 *
 * Strided, because a full sweep is 4.8 million evaluations of four sine pairs
 * and this runs several times per test. Seven is coprime with the tile size,
 * the chunk size and the window span, so the sampled lattice drifts across all
 * of them instead of landing on the same planes every time — a stride of 8
 * would check only cell corners that happen to be chunk-aligned and would miss
 * a slide that was off by anything but a multiple of eight.
 *
 * The reference is `windowDensityAt`, capped, and not the raw world: the rim
 * planes hold the window's own cut face by design. Comparing against the
 * uncapped formula would report the cap as drift on every run, which is the
 * fastest way to end up with a test nobody reads.
 */
function driftFromFormula(stream: TerrainStream, stride = 7): { checked: number; worst: number } {
  let checked = 0;
  let worst = 0;
  for (let z = 0; z < SPAN; z += stride) {
    const wz = (stream.originCellZ + z) * CELL_SIZE;
    for (let y = 0; y < SAMPLES_Y; y += stride) {
      for (let x = 0; x < SPAN; x += stride) {
        const wx = (stream.originCellX + x) * CELL_SIZE;
        const expected = windowDensityAt(wx, y * CELL_SIZE, wz, x, z);
        worst = Math.max(worst, Math.abs(stream.field.get(x, y, z) - expected));
        checked += 1;
      }
    }
  }
  return { checked, worst };
}

/**
 * Is the ground under the ant the ground the WORLD says is there?
 *
 * The drift check above cannot answer that on its own, because the cap is
 * defined relative to wherever the window believes it is — a window that had
 * quietly slid to the wrong place would still agree with itself perfectly.
 *
 * Surface height is the right instrument for the question. The cap only ever
 * lowers positive values, so it can move a zero crossing only within a cell
 * and a half of the rim; everywhere else the surface is the world's surface,
 * and comparing it to `streamGroundHeight` at the same GLOBAL position is a
 * claim about position that no amount of internal consistency can satisfy.
 */
function surfaceError(stream: TerrainStream, stride = 11): { checked: number; worst: number } {
  let checked = 0;
  let worst = 0;
  for (let z = 6; z < SPAN - 6; z += stride) {
    const wz = (stream.originCellZ + z) * CELL_SIZE;
    for (let x = 6; x < SPAN - 6; x += stride) {
      const wx = (stream.originCellX + x) * CELL_SIZE;
      let top = -1;
      for (let y = CELLS_Y; y >= 0; y -= 1) {
        if (stream.field.get(x, y, z) > 0) { top = y * CELL_SIZE; break; }
      }
      worst = Math.max(worst, Math.abs(top - streamGroundHeight(wx, wz)));
      checked += 1;
    }
  }
  return { checked, worst };
}

/** Bite at a world position, the way the scene does: riding the surface. */
function bite(stream: TerrainStream, x: number, z: number, depthIndex = 0) {
  const surface = streamGroundHeight(x, z) - depthIndex * BITE_DEPTH;
  return stream.subtractSphere(
    { x, y: surface + BRUSH_RADIUS - BITE_DEPTH, z },
    BRUSH_RADIUS,
  );
}

/** Exact copy of the resident window, for comparing against itself later. */
const snapshot = (stream: TerrainStream): Float32Array => stream.field.values.slice();

describe('streamed soil', () => {
  /*
   * The arithmetic that decided the tile size, written down where it can fail.
   *
   * The proposal was nine 64 mm tiles for "576 mm", and both halves of that
   * needed correcting: nine tiles in a GRID span three of them, and nine 64 mm
   * tiles of quarter-millimetre samples is 307 MB resident, which is how a
   * phone tab gets killed rather than how it gets a big map. These assertions
   * are the reason the tile ended up at 16 mm, so if somebody bumps it back
   * the number that actually mattered fails first.
   */
  it('costs less resident memory than the fixed field it replaces', () => {
    expect(WINDOW_TILES * TILE_MM).toBe(48);
    expect(WORLD_SPAN * WORLD_UNIT_MM).toBe(320);
    expect(WORLD_TILES * WORLD_TILES).toBe(400);

    const megabytes = WINDOW_BYTES / 1048576;
    expect(megabytes).toBeLessThan(24);

    // What the proposal as written would have cost, for contrast.
    const sixtyFour = (64 / CELL_MM + 1) ** 2 * (CELLS_Y + 1) * 4 * WINDOW_TILES ** 2;
    expect(sixtyFour / 1048576).toBeGreaterThan(280);

    // And the point of the whole exercise: the world's size is not a memory
    // cost. Doubling it to the full 640 mm tank changes nothing resident.
    expect(WINDOW_BYTES).toBe((WINDOW_CELLS + 1) ** 2 * SAMPLES_Y * 4);
  });

  it('starts holding exactly what the formula describes', () => {
    const stream = new TerrainStream(WORLD_SPAN * 0.5, WORLD_SPAN * 0.5);
    const drift = driftFromFormula(stream);
    expect(drift.checked).toBe(28 * 19 * 28);
    expect(drift.worst).toBeLessThan(1e-6);

    // And it is the soil at THIS place in the world, not merely soil.
    const surface = surfaceError(stream);
    expect(surface.checked).toBeGreaterThan(200);
    expect(surface.worst).toBeLessThanOrEqual(CELL_SIZE);
  }, 60000);

  /*
   * The slide, from every direction that can order the copy differently.
   *
   * Positive and negative on each axis (the ascending and descending memmove
   * cases), both diagonals (where the X and Z shifts disagree in sign and the
   * offset's sign comes from Z alone), and a jump far enough that the windows
   * do not overlap at all and the copy path is skipped entirely.
   */
  it('holds the formula after sliding in every direction', () => {
    const stream = new TerrainStream(WORLD_SPAN * 0.5, WORLD_SPAN * 0.5);
    const tile = TILE_CELLS * CELL_SIZE;
    const centre = WORLD_SPAN * 0.5;
    const walks: Array<[number, number]> = [
      [1, 0], [0, 1], [-1, 0], [0, -1],
      [1, 1], [-1, -1], [1, -1], [-1, 1],
      [6, 6], [-6, -6],
    ];

    let at: [number, number] = [centre, centre];
    for (const [dx, dz] of walks) {
      at = [at[0] + dx * tile, at[1] + dz * tile];
      const scroll = stream.recentreOn(at[0], at[1]);
      expect(scroll, `walking ${dx},${dz} tiles should move the window`).not.toBeNull();
      const drift = driftFromFormula(stream);
      expect(drift.worst, `drift after walking ${dx},${dz} tiles`).toBeLessThan(1e-6);
      const surface = surfaceError(stream);
      expect(surface.worst, `surface after walking ${dx},${dz} tiles`)
        .toBeLessThanOrEqual(CELL_SIZE);
    }
  }, 120000);

  it('does not move the window for a step inside the same tile', () => {
    const centre = WORLD_SPAN * 0.5;
    const stream = new TerrainStream(centre, centre);
    const before = stream.originTileX;
    expect(stream.recentreOn(centre + CELL_SIZE, centre + CELL_SIZE)).toBeNull();
    expect(stream.originTileX).toBe(before);
  }, 60000);

  /*
   * "Unless at the edges" — the one place the ant stops being centred.
   *
   * Walking into the corner must clamp the window rather than hang it off the
   * end of the world, and the far corner must clamp the other way. Getting the
   * clamp backwards is silent: the window still slides, it just slides past
   * soil the formula does not define, and every sample out there is the
   * bounding margin, so it looks like flat ground rather than like a bug.
   */
  it('clamps the window at the world edges instead of hanging off them', () => {
    const stream = new TerrainStream(0, 0);
    expect(stream.originTileX).toBe(0);
    expect(stream.originTileZ).toBe(0);

    stream.recentreOn(WORLD_SPAN, WORLD_SPAN);
    expect(stream.originTileX).toBe(WORLD_TILES - WINDOW_TILES);
    expect(stream.originTileZ).toBe(WORLD_TILES - WINDOW_TILES);
    expect(driftFromFormula(stream).worst).toBeLessThan(1e-6);
  }, 60000);

  /*
   * The whole point of the edit store: soil remembers.
   *
   * Six tiles away is far enough that the windows share nothing, so every
   * sample of the tunnel is discarded and has to be rebuilt from the store
   * rather than merely survive in place. The comparison is exact and over the
   * WHOLE window, not strided — a heal at the edge of a dig is a handful of
   * samples and a stride would walk straight past it.
   */
  it('brings a dug tunnel back after the window has forgotten it', () => {
    const centre = WORLD_SPAN * 0.5;
    const stream = new TerrainStream(centre, centre);
    const tile = TILE_CELLS * CELL_SIZE;

    let removed = 0;
    for (let i = 0; i < 8; i += 1) {
      removed += bite(stream, centre, centre, i).removedVolume;
    }
    expect(removed).toBeGreaterThan(0);
    expect(stream.editedSamples).toBeGreaterThan(0);

    const dug = snapshot(stream);
    const originX = stream.originCellX;
    const originZ = stream.originCellZ;

    stream.recentreOn(centre + tile * 6, centre + tile * 6);
    expect(stream.originCellX).not.toBe(originX);
    stream.recentreOn(centre, centre);
    expect(stream.originCellX).toBe(originX);
    expect(stream.originCellZ).toBe(originZ);

    let differing = 0;
    let worst = 0;
    const back = stream.field.values;
    for (let i = 0; i < back.length; i += 1) {
      const delta = Math.abs(back[i]! - dug[i]!);
      if (delta > 1e-6) differing += 1;
      worst = Math.max(worst, delta);
    }
    expect({ differing, worst }).toEqual({ differing: 0, worst: 0 });
  }, 120000);

  /*
   * Sparse means sparse. If edits accumulated per SAMPLE TOUCHED rather than
   * per sample actually changed, a long tunnel would quietly become a second
   * copy of the map — which is the failure the whole design exists to avoid,
   * and it would only show up as an out-of-memory crash an hour into play.
   */
  it('stores only the soil that actually changed, and forgets it on reset', () => {
    const centre = WORLD_SPAN * 0.5;
    const stream = new TerrainStream(centre, centre);
    for (let i = 0; i < 8; i += 1) bite(stream, centre, centre, i);

    const edited = stream.editedSamples;
    expect(edited).toBeGreaterThan(0);
    // A 4 mm sphere is 33.5 mm3, which at 0.25 mm cells is about 2,100 samples
    // inside it; eight overlapping bites down a shaft can reach a few times
    // that. A hundredth of the window is a generous ceiling and still four
    // orders of magnitude below storing the map.
    expect(edited).toBeLessThan(SPAN * SPAN * SAMPLES_Y * 0.01);

    stream.reset();
    expect(stream.editedSamples).toBe(0);
    expect(driftFromFormula(stream).worst).toBeLessThan(1e-6);
  }, 60000);

  /*
   * The question the scene gets wrong if it only asks half of it.
   *
   * A scroll leaves most chunks where they are, and the scene keeps their
   * meshes rather than remeshing the world every sixteen millimetres — that is
   * the entire reason a scroll is affordable. But "still in the window" is not
   * "still correct": the two planes at the old rim carried the window's cut
   * face and now carry ordinary soil, so the chunk around them changed without
   * moving. Keeping it left a wall of earth standing in mid-air where the map
   * used to end, and sky torn across the hillside next to it.
   *
   * This does not check my reasoning about which chunks those are. It meshes
   * every chunk before and after, finds the ones that ACTUALLY changed, and
   * requires the policy to have flagged all of them. A policy that rebuilds
   * more than it needs to is merely slow; one that rebuilds less is the bug.
   */
  it('knows which resident chunks a scroll made stale', () => {
    const centre = WORLD_SPAN * 0.5;
    const stream = new TerrainStream(centre, centre);
    const chunksPerAxis = WINDOW_CELLS / CHUNK_CELLS;
    const chunksY = CELLS_Y / CHUNK_CELLS;

    /**
     * Mesh every chunk, keyed by GLOBAL chunk coordinate as the scene keys
     * them, with vertices in WORLD space.
     *
     * The world-space part is not a detail. `buildSurfaceNets` emits positions
     * local to the window, and the window moves, so comparing raw output
     * across a scroll reports every surviving chunk as changed — which is what
     * the first version of this test did, and it accused the policy of missing
     * 24 chunks that were perfectly fine. The scene resolves the same
     * ambiguity by baking the build-time origin into each mesh's transform;
     * adding it here asks the same question the renderer asks.
     */
    const meshAll = (): Map<string, { world: Float64Array; count: number }> => {
      const out = new Map<string, { world: Float64Array; count: number }>();
      const ox = stream.originWorldX;
      const oz = stream.originWorldZ;
      for (let cz = 0; cz < chunksPerAxis; cz += 1)
        for (let cy = 0; cy < chunksY; cy += 1)
          for (let cx = 0; cx < chunksPerAxis; cx += 1) {
            const x0 = cx * CHUNK_CELLS;
            const y0 = cy * CHUNK_CELLS;
            const z0 = cz * CHUNK_CELLS;
            const data = buildSurfaceNets(stream.field, 0, {
              x0, y0, z0,
              x1: x0 + CHUNK_CELLS, y1: y0 + CHUNK_CELLS, z1: z0 + CHUNK_CELLS,
            });
            const world = new Float64Array(data.positions.length);
            for (let i = 0; i < data.positions.length; i += 3) {
              world[i] = data.positions[i]! + ox;
              world[i + 1] = data.positions[i + 1]!;
              world[i + 2] = data.positions[i + 2]! + oz;
            }
            const gx = (stream.originCellX + x0) / CHUNK_CELLS;
            const gz = (stream.originCellZ + z0) / CHUNK_CELLS;
            out.set(`${gx},${cy},${gz}`, { world, count: data.indices.length });
          }
      return out;
    };

    const before = meshAll();
    const scroll = stream.recentreOn(centre + TILE_CELLS * CELL_SIZE, centre);
    expect(scroll).not.toBeNull();
    const after = meshAll();

    const inside = (c: number, lo: number, hi: number): boolean =>
      c - 2 >= lo && c + CHUNK_CELLS + 2 < hi;
    /*
     * Compared with a tolerance, and the tolerance is set by FLOAT32.
     *
     * A vertex at window-local 96 cells with an origin of 576 is the same
     * POINT as one at local 32 with an origin of 640 — and not the same
     * number. Positions come back as a Float32Array, so the two spellings
     * differ by about 3e-7 at this magnitude, which is the format's epsilon
     * and nothing to do with the terrain. Comparing as strings, and then at
     * 1e-9, each accused two dozen untouched chunks of going stale; the field
     * samples feeding them were bit-identical. A thousandth of a cell is four
     * orders of magnitude above the noise and four below anything real.
     */
    const differs = (a: { world: Float64Array; count: number },
                     b: { world: Float64Array; count: number }): boolean => {
      if (a.count !== b.count || a.world.length !== b.world.length) return true;
      for (let i = 0; i < a.world.length; i += 1) {
        if (Math.abs(a.world[i]! - b.world[i]!) > CELL_SIZE * 1e-3) return true;
      }
      return false;
    };

    const changed: string[] = [];
    const missed: string[] = [];
    for (const [key, mesh] of after) {
      const was = before.get(key);
      if (was === undefined || !differs(was, mesh)) continue;
      changed.push(key);
      const parts = key.split(',').map(Number);
      const cellX = parts[0]! * CHUNK_CELLS - stream.originCellX;
      const cellZ = parts[2]! * CHUNK_CELLS - stream.originCellZ;
      const kept = inside(cellX, scroll!.retained.x0, scroll!.retained.x1)
        && inside(cellZ, scroll!.retained.z0, scroll!.retained.z1);
      if (kept) missed.push(key);
    }

    /*
     * `changed` only ever contains chunks that were ALREADY resident before
     * the scroll and came out different afterwards — which is precisely the
     * class the scene used to skip, because it rebuilt what arrived and
     * nothing else. That the class is non-empty is the proof the old policy
     * was wrong; that `missed` is empty is the proof the new one covers it.
     * Measured at 30 chunks for a one-tile walk along X.
     */
    expect(changed.length).toBeGreaterThanOrEqual(24);
    expect(missed).toEqual([]);
  }, 180000);

  /*
   * And the surface over it all. The streamed window is not the fixed mound —
   * it is a slab with six cut faces rather than a lone blob — so it was worth
   * confirming that the surface nets close it just the same, both untouched
   * and after a shaft.
   *
   * The eyes only fire from points that are in AIR. Over rolling ground a low
   * eye is often buried in the next rise, where the nearest surface faces away
   * for the entirely correct reason that you are standing inside the soil.
   */
  it('meshes the streamed window closed, oriented and opaque', () => {
    const centre = WORLD_SPAN * 0.5;
    const stream = new TerrainStream(centre, centre);
    const inAir = (p: number[]): boolean => {
      const x = p[0]! - stream.originWorldX;
      const z = p[2]! - stream.originWorldZ;
      if (x < 0 || x > WINDOW_SIZE || z < 0 || z > WINDOW_SIZE) return true;
      if (p[1]! < 0 || p[1]! > SOIL_DEPTH) return true;
      return stream.field.sample(x, p[1]!, z) <= 0;
    };
    const aim = [centre, streamGroundHeight(centre, centre), centre];

    const pristine = buildSurfaceNets(stream.field, 0);
    const control = survey(pristine);
    expect(control.triangles).toBeGreaterThan(200000);

    /*
     * Boundary edges are held at zero and nothing else will do: an open edge
     * is a hole you can see the sky through, which is the failure this whole
     * line of work exists to end.
     *
     * Flipped and non-manifold edges get a budget instead, because surface
     * nets weld two sheets that share a cell and no tuning removes that in
     * general. What tuning DOES remove is terrain that sits on the failure on
     * purpose — see `GRIT` in labWorld, where making the finest octave one
     * cell tall was worth 22 flipped edges and shortening it to four fifths of
     * a cell took that to 2. Sixteen is generous against a measured 2 out of
     * 260,000 triangles; it is here to catch a regression back towards 22, not
     * to bless the 2.
     */
    expect(control.boundary).toBe(0);
    expect(control.flipped).toBeLessThanOrEqual(16);
    expect(control.nonManifold).toBeLessThanOrEqual(16);

    const controlEyes = eyeScan(pristine, aim, WINDOW_SIZE * 0.16, inAir);
    expect(controlEyes.probes).toBeGreaterThan(20);
    expect(controlEyes.insideOut).toBe(0);

    for (let i = 0; i < 6; i += 1) bite(stream, centre, centre, i);
    const dug = buildSurfaceNets(stream.field, 0);
    const after = survey(dug);
    expect(after.boundary).toBe(0);
    expect(after.flipped).toBeLessThanOrEqual(16);

    const eyes = eyeScan(dug, aim, WINDOW_SIZE * 0.16, inAir);
    expect(eyes.probes).toBeGreaterThan(20);
    expect(eyes.insideOut).toBe(0);
  }, 180000);
});
