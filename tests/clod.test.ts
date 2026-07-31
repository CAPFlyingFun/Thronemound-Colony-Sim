/**
 * Is the pellet one lump, and does it hold what it says?
 *
 * Reported from play as "the clods are not solid and look fractured", which
 * turned out to be exactly and literally true: `THREE.IcosahedronGeometry`
 * comes back NON-INDEXED — sixty vertices for twelve corners, five copies of
 * each — and roughening it by vertex index gave every copy of a corner a
 * different displacement. The twenty faces stopped sharing corners and the
 * pellet came apart into shards. Nothing about it was a shading problem, which
 * is why looking harder at the screenshot was never going to settle it.
 *
 * So the shape is built here as an indexed solid, and these are the three
 * things that would have caught it: corners shared, faces wound outward, and
 * volume matching the number the pellet is SIZED by.
 */

import { describe, it, expect } from 'vitest';
import {
  CLOD_ROUGHNESS, CLOD_SQUASH, PELLET_SOLIDITY, clodGeometry,
} from '../src/density/labMound';
import { survey } from './meshSurvey';

/** Signed volume by the divergence theorem: sum of tetrahedra on the origin. */
function volumeOf(positions: Float32Array, indices: Uint16Array): number {
  let total = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const ax = positions[a]!, ay = positions[a + 1]!, az = positions[a + 2]!;
    const bx = positions[b]!, by = positions[b + 1]!, bz = positions[b + 2]!;
    const cx = positions[c]!, cy = positions[c + 1]!, cz = positions[c + 2]!;
    total += (
      ax * (by * cz - bz * cy)
      - ay * (bx * cz - bz * cx)
      + az * (bx * cy - by * cx)
    ) / 6;
  }
  return total;
}

describe('the clod', () => {
  it('is one closed solid, not twenty loose faces', () => {
    const clod = clodGeometry(3.7);
    expect(clod.positions.length / 3).toBe(12);
    expect(clod.indices.length / 3).toBe(20);

    const s = survey({ positions: clod.positions, indices: new Uint32Array(clod.indices) });
    // Thirty edges, each shared by exactly two faces, none wound against its
    // neighbour. Non-indexed, `boundary` would have been all sixty.
    expect(s).toEqual({
      edges: 30, boundary: 0, nonManifold: 0, flipped: 0, triangles: 20,
    });
  });

  /*
   * Winding, checked by SIGN rather than by eye. A positive signed volume means
   * the faces are listed counter-clockwise seen from outside; get the face list
   * backwards and every triangle is backface-culled, so the pellet renders as
   * nothing at all and looks like the spawn failed.
   */
  it('faces outward', () => {
    for (const seed of [0, 1.4, 17.9, 512.25]) {
      const clod = clodGeometry(seed);
      expect(volumeOf(clod.positions, clod.indices)).toBeGreaterThan(0);
    }
  });

  /*
   * The pellet's radius is `cbrt(removedVolume / PELLET_SOLIDITY)`, so if that
   * constant does not match the shape actually drawn, every clod carries the
   * wrong amount of soil and the one property the whole exercise is for — the
   * pellet HOLDS what the bite took — is quietly false. It already was: the
   * squash along Y was applied to the drawing and left out of the constant.
   */
  it('holds the volume its sizing constant promises', () => {
    let total = 0;
    const seeds = 200;
    for (let i = 0; i < seeds; i += 1) {
      const clod = clodGeometry(i * 1.37);
      total += volumeOf(clod.positions, clod.indices);
    }
    const mean = total / seeds;
    // Roughening moves corners both ways by the same amount, so it cancels to
    // first order but not exactly — the second-order term is positive, because
    // volume grows as the cube. A couple of per cent, well inside the noise on
    // how much soil a bite removes in the first place.
    expect(mean / PELLET_SOLIDITY).toBeGreaterThan(0.99);
    expect(mean / PELLET_SOLIDITY).toBeLessThan(1.06);
  });

  it('varies between clods but is stable for one', () => {
    const a = clodGeometry(4);
    const b = clodGeometry(4);
    const c = clodGeometry(9);
    expect([...a.positions]).toEqual([...b.positions]);
    expect([...a.positions]).not.toEqual([...c.positions]);

    // And every corner stays within the roughness band, so no seed can produce
    // a spike or a pellet turned inside out.
    for (let i = 0; i < c.positions.length; i += 3) {
      const y = c.positions[i + 1]! / CLOD_SQUASH;
      const r = Math.hypot(c.positions[i]!, y, c.positions[i + 2]!);
      expect(r).toBeGreaterThanOrEqual(1 - CLOD_ROUGHNESS - 1e-6);
      expect(r).toBeLessThanOrEqual(1 + CLOD_ROUGHNESS + 1e-6);
    }
  });
});
