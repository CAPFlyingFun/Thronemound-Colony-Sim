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
import { DensityField } from '../src/density/DensityField';
import { buildSurfaceNets, type SurfaceNetMesh } from '../src/density/SurfaceNets';

/** The lab scene's own numbers, so this tests what actually ships. */
const CELL_SIZE = 0.5;
const CELLS_X = 48;
const CELLS_Y = 32;
const CELLS_Z = 48;
const BRUSH_RADIUS = 1;
/** How far past the surface the lab sinks the brush centre before carving. */
const BRUSH_SINK = 0.58;

/** The lab's mound, rebuilt here rather than imported: the scene needs WebGL. */
function makeField(): DensityField {
  const field = new DensityField({
    cellsX: CELLS_X, cellsY: CELLS_Y, cellsZ: CELLS_Z, cellSize: CELL_SIZE,
  });
  const width = CELLS_X * CELL_SIZE;
  const height = CELLS_Y * CELL_SIZE;
  const depth = CELLS_Z * CELL_SIZE;
  const margin = CELL_SIZE * 1.5;
  field.fill((x: number, y: number, z: number) => {
    const nx = (x - width * 0.5) / (width * 0.5);
    const nz = (z - depth * 0.5) / (depth * 0.5);
    const radial = nx * nx + nz * nz;
    const rolling = 0.28 * Math.sin(x * 0.55) * Math.cos(z * 0.43);
    const summit = 6.4 + 4.5 * Math.exp(-radial * 2.45) + rolling;
    return Math.min(
      summit - y, y - margin, x - margin, width - margin - x,
      z - margin, depth - margin - z, height - margin - y,
    );
  });
  return field;
}

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

/** Nearest triangle along a ray. `facing > 0` means it shows the ray its front. */
function shoot(mesh: SurfaceNetMesh, origin: number[], dir: number[]) {
  const P = mesh.positions;
  const I = mesh.indices;
  let best = Infinity;
  let facing = 0;
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
  }
  return { distance: best, facing };
}

/** Eyes on a sphere around a point, all looking at it. Counts what sees inside. */
function eyeScan(mesh: SurfaceNetMesh, at: number[], range = 9) {
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
      if (hit.distance < range * 2 && hit.facing < 0) insideOut++;
    }
  }
  return { probes, insideOut };
}

/** Highest surface vertex near the mound's axis — where the lab aims. */
function summitOf(mesh: SurfaceNetMesh): number[] {
  const cx = (CELLS_X * CELL_SIZE) / 2;
  const cz = (CELLS_Z * CELL_SIZE) / 2;
  let top = 0;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    if (Math.abs(mesh.positions[i]! - cx) > 0.8) continue;
    if (Math.abs(mesh.positions[i + 2]! - cz) > 0.8) continue;
    top = Math.max(top, mesh.positions[i + 1]!);
  }
  return [cx, top, cz];
}

/** Carve as the lab carves: centre sunk below the point that was aimed at. */
function scoopAt(field: DensityField, at: number[], depth = 0): number {
  return field.subtractSphere(
    { x: at[0]!, y: at[1]! - BRUSH_RADIUS * BRUSH_SINK - depth, z: at[2]! },
    BRUSH_RADIUS,
  ).removedVolume;
}

describe('density terrain stays sealed', () => {
  const pristine = buildSurfaceNets(makeField());
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
    const field = makeField();
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

  it('a tunnel eight scoops deep leaves no way to see inside', () => {
    const field = makeField();
    for (let i = 0; i < 8; i++) scoopAt(field, aim, i * 0.55);
    const mesh = buildSurfaceNets(field);
    const s = survey(mesh);
    expect(s.boundary).toBe(0);
    expect(s.nonManifold).toBe(0);
    expect(s.flipped).toBe(0);
    expect(eyeScan(mesh, aim).insideOut).toBe(0);
  }, 60_000);

  it('reports the same soil for the same scoop, and the right amount of it', () => {
    const volumes: number[] = [];
    for (let i = 0; i < 4; i++) volumes.push(scoopAt(makeField(), aim));
    // The pellet is scaled from this number, so a scoop that measured itself
    // differently run to run would hand out different-sized dirt for one bite.
    for (const v of volumes) expect(v).toBeCloseTo(volumes[0]!, 10);

    /*
     * And it is the RIGHT number, checked against geometry rather than against
     * itself. A sphere whose centre sits BRUSH_SINK*r below a flat surface
     * keeps everything but the cap standing proud of it:
     *   cap height h = r - sink*r,  cap volume = pi*h^2*(3r - h)/3
     * The mound is convex, so slightly less soil sits under the brush than a
     * flat plane would give — the measurement should land just under.
     */
    const r = BRUSH_RADIUS;
    const h = r - BRUSH_SINK * r;
    const cap = (Math.PI * h * h * (3 * r - h)) / 3;
    const buriedOnFlat = (4 / 3) * Math.PI * r ** 3 - cap;
    expect(volumes[0]!).toBeLessThan(buriedOnFlat);
    expect(volumes[0]!).toBeGreaterThan(buriedOnFlat * 0.9);
  }, 60_000);
});
