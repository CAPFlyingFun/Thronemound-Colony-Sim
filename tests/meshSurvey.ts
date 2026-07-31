/**
 * The instruments, kept in one place because two copies of a measuring device
 * is how you get two answers.
 *
 * Extracted when the streaming window needed the same checks the fixed mound
 * gets. Copying them across would have been three lines of work and exactly
 * the fault this project keeps meeting: the watertightness test itself once
 * held a hand-copy of the world it was testing, went on passing after that
 * world was rescaled, and proved nothing for two commits.
 *
 * Every check here is chosen to be blind to none of what the voxel terrain got
 * away with:
 *
 *  - ORIENTATION, by directed edges. Two triangles sharing an edge must
 *    traverse it in opposite directions. Direction-dependent by construction,
 *    so it catches exactly what closure counting misses — this file was
 *    written against a mesh reporting zero open boundary edges while a tenth
 *    of its surface was backface-culled and see-through.
 *  - CLOSURE, by undirected edges. Every edge shared by exactly two triangles.
 *  - THE EYE, by raycast. From outside, looking at a point: the first surface
 *    met must face you. Immune to overlapping geometry, because an extra
 *    surface can only ever block sooner.
 *
 * None of them means anything without a control. Run every one on UNDUG
 * terrain first: a ray that hits nothing may simply be flying over the mound,
 * and on the old system that confound alone accounted for 195 of 200 apparent
 * "leaks".
 */

import { type SurfaceNetMesh } from '../src/density/SurfaceNets';

export interface Survey {
  edges: number;
  /** Edges with only one triangle: an actual hole in the surface. */
  boundary: number;
  /** Edges with three or more: the surface pinches or self-touches. */
  nonManifold: number;
  /** Edges whose two triangles run the SAME way: one of them is inside-out. */
  flipped: number;
  triangles: number;
}

export function survey(mesh: SurfaceNetMesh): Survey {
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
export function shoot(mesh: SurfaceNetMesh, origin: number[], dir: number[]) {
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
 *
 * `outside` is how the probe stays honest on terrain that is not a lone dome.
 * The check is "coming from OUTSIDE, does the first surface face you?", and on
 * a mound every eye is outside by construction, so it never came up. Over
 * rolling ground it does: a low eye a few millimetres away is quite often
 * buried in the next rise, where the nearest surface faces away for the
 * ordinary reason that you are standing in the soil. Counting that as a leak
 * would be the same class of mistake as the 195-out-of-200 rays that were
 * simply flying over the hill. Eyes that fail the test are not probed at all
 * rather than being probed and forgiven, so `probes` still reports how much
 * evidence there actually is.
 */
export function eyeScan(
  mesh: SurfaceNetMesh,
  at: number[],
  range: number,
  outside?: (point: number[]) => boolean,
) {
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
      if (outside && !outside(from)) continue;
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
