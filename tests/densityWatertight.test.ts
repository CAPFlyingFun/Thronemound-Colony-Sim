/**
 * Can you see through it?
 *
 * The one question the old voxel terrain kept failing, asked of the new one.
 *
 * Three separate holes reached the player on the voxel system, and each time
 * the test that was supposed to catch them was structurally incapable of it.
 * Downward ray parity cannot see a gap in a VERTICAL face, because a vertical
 * face contributes nothing to a vertical ray — deleting a whole class of face
 * left it green. Sideways parity cannot survive geometry that legitimately
 * overlaps, because it counts crossings nothing could ever see. And counting
 * open boundary edges cannot see a face wound inside-out, because an edge
 * shared by two triangles is shared by two triangles whichever way they run.
 *
 * That last one is not hypothetical: this file was written against a mesh
 * reporting zero open boundary edges while a tenth of its surface was
 * backface-culled and see-through. So the checks here are chosen to be blind
 * to none of it:
 *
 *  - ORIENTATION, by directed edges. Two triangles sharing an edge must
 *    traverse it in opposite directions. Direction-dependent by construction,
 *    so it catches exactly what closure counting misses.
 *  - CLOSURE, by undirected edges. Every edge shared by exactly two triangles.
 *  - THE EYE, by raycast. From outside, looking at the dig: the first surface
 *    met must face you. A hole is a ray that reaches soil having hit nothing.
 *    Immune to overlap, because an extra surface can only block sooner.
 *
 * Every one of them is run on UNDUG terrain first. Without that control the
 * numbers are unreadable — a ray that hits nothing may simply be flying over
 * the mound, and on the old system that confound alone accounted for 195 of
 * 200 apparent "leaks".
 */

import { describe, it, expect } from 'vitest';
import { buildSurfaceNets, type SurfaceNetMesh } from '../src/density/SurfaceNets';
import {
  BITE_DEPTH, BRUSH_RADIUS, CELLS_X, CELLS_Z, CELL_SIZE, WORLD_WIDTH, makeMoundField,
} from '../src/density/labMound';

/*
 * The world comes from `labMound`, the same module the scene reads.
 *
 * This file used to keep a hand-copy of the constants and the mound formula so
 * it could build a field without dragging three.js into a headless run. Then
 * the lab was rescaled — 2.5 mm cells to 0.25 mm, a 120 mm mound to 16 mm —
 * and the copy went on testing a world that no longer existed. Green, and
 * about nothing. One definition, imported, is the only version of this that
 * stays true.
 */

interface Survey {
  edges: number;
  /** Edges with only one triangle: an actual hole in the surface. */
  boundary: number;
  /** Edges with three or more: the surface pinches or self-touches. */
  nonManifold: number;
  /** Edges whose two triangles run the SAME way: one of them is inside-out. */
  flipped: number;
  triangles: number;
}

function survey(mesh: SurfaceNetMesh): Survey {
  const shared = new Map<string, number>();
  const directed = new Map<string, number>();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.indices[t]!;
    const b = mesh.indices[t + 1]!;
    const c = mesh.indices[t + 2]!;
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
      const key = p < q ? `${p}|${q}` : `${q}|${p}`;
      shared.set(key, (shared.get(key) ?? 0) + 1);
      directed.set(`${p}>${q}`, (directed.get(`${p}>${q}`) ?? 0) + 1);
    }
  }
  let boundary = 0;
  let nonManifold = 0;
  for (const n of shared.values()) {
    if (n === 1) boundary++;
    else if (n > 2) nonManifold++;
  }
  let flipped = 0;
  for (const n of directed.values()) if (n > 1) flipped += n - 1;
  return {
    edges: shared.size, boundary, nonManifold, flipped,
    triangles: mesh.indices.length / 3,
  };
}

/**
 * Nearest triangle along a ray. `facing > 0` means it shows the ray its front,
 * and `grazing` is true when the ray meets it nearly edge-on.
 *
 * The grazing flag exists because a silhouette is not a hole. A ray arriving
 * at 79 degrees off the normal is skimming the curve of the mound, which is
 * both where the intersection arithmetic is least trustworthy and where
 * "you can see through it" stops meaning anything to an eye. Measured on the
 * rescaled lab: one ray in 168, at 13 degrees elevation, first meeting a face
 * three quarters of a world unit PAST the crater it was aimed at.
 */
function shoot(mesh: SurfaceNetMesh, origin: number[], dir: number[]) {
  const P = mesh.positions;
  const I = mesh.indices;
  let best = Infinity;
  let facing = 0;
  let incidence = 1;
  for (let t = 0; t < I.length; t += 3) {
    const i0 = I[t]! * 3;
    const i1 = I[t + 1]! * 3;
    const i2 = I[t + 2]! * 3;
    const e1 = [P[i1]! - P[i0]!, P[i1 + 1]! - P[i0 + 1]!, P[i1 + 2]! - P[i0 + 2]!];
    const e2 = [P[i2]! - P[i0]!, P[i2 + 1]! - P[i0 + 1]!, P[i2 + 2]! - P[i0 + 2]!];
    const p = [
      dir[1]! * e2[2]! - dir[2]! * e2[1]!,
      dir[2]! * e2[0]! - dir[0]! * e2[2]!,
      dir[0]! * e2[1]! - dir[1]! * e2[0]!,
    ];
    const det = e1[0]! * p[0]! + e1[1]! * p[1]! + e1[2]! * p[2]!;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const s = [origin[0]! - P[i0]!, origin[1]! - P[i0 + 1]!, origin[2]! - P[i0 + 2]!];
    const u = (s[0]! * p[0]! + s[1]! * p[1]! + s[2]! * p[2]!) * inv;
    if (u < 0 || u > 1) continue;
    const q = [
      s[1]! * e1[2]! - s[2]! * e1[1]!,
      s[2]! * e1[0]! - s[0]! * e1[2]!,
      s[0]! * e1[1]! - s[1]! * e1[0]!,
    ];
    const w = (dir[0]! * q[0]! + dir[1]! * q[1]! + dir[2]! * q[2]!) * inv;
    if (w < 0 || u + w > 1) continue;
    const hit = (e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!) * inv;
    if (hit <= 1e-7 || hit >= best) continue;
    best = hit;
    // Moller-Trumbore's determinant is positive exactly when the triangle
    // presents its front face to the ray.
    facing = det;
    const n = [
      e1[1]! * e2[2]! - e1[2]! * e2[1]!,
      e1[2]! * e2[0]! - e1[0]! * e2[2]!,
      e1[0]! * e2[1]! - e1[1]! * e2[0]!,
    ];
    const nl = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    incidence = Math.abs(dir[0]! * n[0]! + dir[1]! * n[1]! + dir[2]! * n[2]!) / nl;
  }
  return { distance: best, facing, grazing: incidence < 0.2 };
}

/**
 * Eyes on a sphere around a point, all looking at it. Counts what sees inside.
 *
 * The range is a FRACTION of the world, not an absolute distance. It was 9
 * world units, which was a third of the old 120 mm mound and is nearly three
 * times the width of the 16 mm one — from that far out the rays arrive almost
 * parallel and graze the silhouette, which reads as a couple of false
 * inside-out hits. Tying it to the world keeps the probe's geometry the same
 * whatever the lab is scaled to.
 */
function eyeScan(mesh: SurfaceNetMesh, at: number[], range = WORLD_WIDTH * 0.375) {
  let probes = 0;
  let insideOut = 0;
  for (let a = 0; a < 24; a++) {
    for (let e = 0; e < 7; e++) {
      const azimuth = (a / 24) * Math.PI * 2;
      const elevation = 0.05 + (e / 6) * 1.1;
      const dir = [
        Math.cos(elevation) * Math.cos(azimuth),
        Math.sin(elevation),
        Math.cos(elevation) * Math.sin(azimuth),
      ];
      const from = [
        at[0]! + dir[0]! * range, at[1]! + dir[1]! * range, at[2]! + dir[2]! * range,
      ];
      const look = [-dir[0]!, -dir[1]!, -dir[2]!];
      probes++;
      const hit = shoot(mesh, from, look);
      // Hitting nothing is fine here — the eye ring includes angles that
      // legitimately clear the mound. Meeting the INSIDE of the surface first
      // is not: that is the sky coming through.
      if (hit.distance < range * 2 && hit.facing < 0 && !hit.grazing) insideOut++;
    }
  }
  return { probes, insideOut };
}

/** Highest surface vertex near the mound's axis — where the lab aims. */
function summitOf(mesh: SurfaceNetMesh): number[] {
  const cx = (CELLS_X * CELL_SIZE) / 2;
  const cz = (CELLS_Z * CELL_SIZE) / 2;
  let top = 0;
  // Within one bite of the axis, so the "summit" is the patch actually aimed
  // at rather than a shoulder — the old 0.8 was tuned to a world 7x larger.
  for (let i = 0; i < mesh.positions.length; i += 3) {
    if (Math.abs(mesh.positions[i]! - cx) > BRUSH_RADIUS) continue;
    if (Math.abs(mesh.positions[i + 2]! - cz) > BRUSH_RADIUS) continue;
    top = Math.max(top, mesh.positions[i + 1]!);
  }
  return [cx, top, cz];
}

/**
 * Carve as the lab carves: the brush RIDES the surface and dips in by exactly
 * BITE_DEPTH, so its centre sits (radius - depth) ABOVE the point aimed at.
 * `depth` here is how far down the tunnel has already gone, not the bite.
 */
function scoopAt(field: ReturnType<typeof makeMoundField>, at: number[], sunk = 0): number {
  return field.subtractSphere(
    { x: at[0]!, y: at[1]! + (BRUSH_RADIUS - BITE_DEPTH) - sunk, z: at[2]! },
    BRUSH_RADIUS,
  ).removedVolume;
}

describe('density terrain stays sealed', () => {
  const pristine = buildSurfaceNets(makeMoundField());
  const aim = summitOf(pristine);

  it('CONTROL: the untouched mound is closed, oriented and opaque', () => {
    const s = survey(pristine);
    expect(s.triangles).toBeGreaterThan(1000);
    expect(s.boundary).toBe(0);
    expect(s.nonManifold).toBe(0);
    expect(s.flipped).toBe(0);
    const eyes = eyeScan(pristine, aim);
    expect(eyes.probes).toBeGreaterThan(100);
    // One grazing hit is tolerated; the failure this guards was 86 of 168.
    expect(eyes.insideOut).toBeLessThanOrEqual(1);
  }, 60_000);

  it('one scoop leaves no way to see inside', () => {
    const field = makeMoundField();
    scoopAt(field, aim);
    const mesh = buildSurfaceNets(field);
    const s = survey(mesh);
    expect(s.boundary).toBe(0);
    expect(s.nonManifold).toBe(0);
    /*
     * Zero, not "few". This is the property the whole density experiment is
     * for: on the voxel terrain the same measurement after one dig was 65 and
     * never reached zero across four rounds of patching, because the drawn
     * surface and the collided surface were two different answers. Here there
     * is one field and one mesh, so a hole is not merely unlikely, it has
     * nowhere to come from.
     */
    expect(s.flipped).toBe(0);
    expect(eyeScan(mesh, aim).insideOut).toBe(0);
  }, 60_000);

  it('never opens a hole however deep the shaft goes, but does pinch', () => {
    /*
     * Two findings, and the first one is the one that matters.
     *
     * A shaft driven all the way down NEVER opens the surface. `boundary`
     * stays at zero at every depth, which is the failure this whole
     * experiment exists to rule out and the one the voxel terrain could not
     * rule out after four rounds of patching.
     *
     * What it does do is PINCH, and that is a property of surface nets rather
     * than a mistake. One vertex per cell means a cell holding two separate
     * sheets of surface can only represent one of them, so where a wall thins
     * to under about two cells the two sheets weld. Swept bite by bite, on a
     * 5.46 mm depth of soil under the aim, at quarter-millimetre cells:
     *
     *   bites   depth            non-manifold   wound wrong
     *     1-2   0.5 - 1.0 mm            0             0
     *     3     1.5 mm                  1             2
     *     4     2.0 mm                  5            10
     *     5-8   2.5 - 4.0 mm            2             4
     *
     * It appears at a fifth of the way down, peaks immediately, and then sits
     * flat — it is the crater lip welding to itself, not a tear that grows.
     * Four edges in 36,652 is one hundredth of one per cent, and the eye scan
     * finds nothing to see through.
     *
     * Written down rather than tuned away, because it is a real constraint on
     * the finished game: soil thinner than roughly two cells between a tunnel
     * and open air will weld. Half a millimetre at this cell size — thinner
     * than an ant would leave standing — but if cells are ever coarsened to
     * buy remesh time, this number moves with them, and the nest is where it
     * would show.
     */
    const field = makeMoundField();
    for (let i = 0; i < 8; i++) scoopAt(field, aim, i * BITE_DEPTH);
    const mesh = buildSurfaceNets(field);
    const s = survey(mesh);
    // Non-negotiable: no window to the sky, at any depth.
    expect(s.boundary).toBe(0);
    // And the pinch stays a rounding error rather than tearing the surface
    // open. If either of these climbs, surface nets has stopped coping and
    // the answer is manifold dual contouring, not a bigger tolerance.
    expect(s.nonManifold).toBeLessThan(s.edges * 0.001);
    expect(s.flipped).toBeLessThan(s.edges * 0.001);
    // Nothing sees inside regardless — a weld is two walls meeting, not a gap.
    expect(eyeScan(mesh, aim).insideOut).toBe(0);
  }, 60_000);

  it('meshes in chunks to exactly the same surface as meshing the lot', () => {
    /*
     * The property that lets the map grow.
     *
     * Remeshing the whole field after every bite makes digging cost the size
     * of the WORLD, which is why the mound had to be a pea. Chunking makes it
     * cost the size of the BITE — but only if regions tile EXACTLY, with each
     * cell owning its quads and no other cell emitting them. Get the padding
     * wrong and every chunk boundary is a torn seam, which is the same
     * see-through failure as before wearing a different hat.
     *
     * So: mesh it whole, mesh it in blocks, weld the blocks' vertices back
     * together by position, and require the two surfaces to be the same one —
     * same triangle count, and still closed and consistently wound after the
     * weld.
     */
    const field = makeMoundField();
    scoopAt(field, aim);

    /*
     * A box around the dig, not the whole field. The map is 256 cells a side
     * now, so chunking all of it is two thousand meshes and a minute and a
     * half of test — and it would be testing the same one property over and
     * over. The seams are what matter, so the box is sized to contain several
     * of them.
     */
    const STEP = 16;
    const c = (v: number) => Math.floor(v / CELL_SIZE / STEP) * STEP;
    const box = {
      x0: Math.max(0, c(aim[0]!) - STEP * 2), x1: c(aim[0]!) + STEP * 2,
      y0: Math.max(0, c(aim[1]!) - STEP * 2), y1: c(aim[1]!) + STEP * 2,
      z0: Math.max(0, c(aim[2]!) - STEP * 2), z1: c(aim[2]!) + STEP * 2,
    };
    const whole = survey(buildSurfaceNets(field, 0, box));

    const parts: SurfaceNetMesh[] = [];
    for (let z = box.z0; z < box.z1; z += STEP)
      for (let y = box.y0; y < box.y1; y += STEP)
        for (let x = box.x0; x < box.x1; x += STEP)
          parts.push(buildSurfaceNets(field, 0, {
            x0: x, y0: y, z0: z, x1: x + STEP, y1: y + STEP, z1: z + STEP,
          }));

    /*
     * Weld by position before surveying. Separate chunks legitimately hold
     * their own copies of the vertices they share, and an un-welded union
     * would call every shared edge a boundary whether or not the surface is
     * actually torn — which would make this test fail loudly on a mesh that is
     * perfectly fine, and pass nothing useful.
     */
    const key = new Map<string, number>();
    const positions: number[] = [];
    const indices: number[] = [];
    for (const part of parts) {
      const remap = new Int32Array(part.positions.length / 3);
      for (let v = 0; v < remap.length; v++) {
        const k = `${part.positions[v * 3]!.toFixed(6)},`
          + `${part.positions[v * 3 + 1]!.toFixed(6)},`
          + `${part.positions[v * 3 + 2]!.toFixed(6)}`;
        let id = key.get(k);
        if (id === undefined) {
          id = positions.length / 3;
          key.set(k, id);
          positions.push(
            part.positions[v * 3]!, part.positions[v * 3 + 1]!, part.positions[v * 3 + 2]!,
          );
        }
        remap[v] = id;
      }
      for (const i of part.indices) indices.push(remap[i]!);
    }
    const stitched = survey({
      positions: new Float32Array(positions), indices: new Uint32Array(indices),
    });

    /*
     * The property is that chunked EQUALS whole, in every respect — not that
     * either is closed. A box cut out of the mound has genuinely open edges
     * where the box face slices the soil (294 of them here), and demanding
     * zero would be demanding the sub-region be something it is not. What must
     * not happen is chunking ADDING any: an extra open edge is a seam.
     */
    expect(whole.triangles).toBeGreaterThan(500);
    expect(stitched.triangles).toBe(whole.triangles);
    expect(stitched.boundary).toBe(whole.boundary);
    expect(stitched.nonManifold).toBe(whole.nonManifold);
    expect(stitched.flipped).toBe(whole.flipped);
  }, 60_000);

  it('reports the same soil for the same scoop, and the right amount of it', () => {
    const volumes: number[] = [];
    for (let i = 0; i < 4; i++) volumes.push(scoopAt(makeMoundField(), aim));
    // The pellet is scaled from this number, so a scoop that measured itself
    // differently run to run would hand out different-sized dirt for one bite.
    for (const v of volumes) expect(v).toBeCloseTo(volumes[0]!, 10);

    /*
     * And it is the right ORDER of number, checked against geometry rather
     * than against itself. A sphere of radius r dipping d into a flat surface
     * takes a cap of pi*d^2*(3r - d)/3 — 1.44 mm^3 for a 4 mm bite half a
     * millimetre deep.
     *
     * The band is deliberately loose, and the reason is worth writing down.
     * `subtractSphere` does not measure that cap; it measures how far the
     * FIELD's occupancy moved, and occupancy ramps across a transition band
     * one cell wide. At quarter-millimetre cells that band is half the bite,
     * so the estimate runs high — measured 3 to 6 mm^3 against the ideal
     * 1.44, drifting as the crater floor passes between samples. That is a
     * resolution limit rather than a mistake, and the only cure is finer
     * cells, which is remesh time.
     *
     * So this guards what would actually spoil the game — a bite out by an
     * order of magnitude, which is precisely what shipped: 10 mm wide, 7.9 mm
     * deep, 464 mm^3 a press, freeing a 9 mm pellet for a 2 mm jaw. It does
     * not pretend to a precision the estimator has not got.
     */
    const r = BRUSH_RADIUS;
    const d = BITE_DEPTH;
    const idealCap = (Math.PI * d * d * (3 * r - d)) / 3;
    expect(volumes[0]!).toBeGreaterThan(idealCap * 0.5);
    expect(volumes[0]!).toBeLessThan(idealCap * 6);
  }, 60_000);
});
