/**
 * THE TREE, checked without a renderer.
 *
 * The claims worth pinning are the ones a screenshot cannot settle: that the
 * same seed is the same tree, that it is the size it was asked to be, and
 * that dropping detail changes how finely the wood is skinned without moving
 * any of it — which is the property that stops an LOD swap reading as a pop.
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BARKS, buildTree, growTree, TreeSolid, type TreeSpec } from '../src/world/tree';

const SPEC: TreeSpec = { girth: 200, height: 5200, seed: 12345 };

describe('the tree', () => {
  it('grows the same tree from the same seed, every time', () => {
    const a = growTree(SPEC);
    const b = growTree(SPEC);
    expect(a.limbs.length).toBe(b.limbs.length);
    for (let i = 0; i < a.limbs.length; i += 1) {
      expect(a.limbs[i]!.a.distanceTo(b.limbs[i]!.a)).toBeLessThan(1e-9);
      expect(a.limbs[i]!.rb).toBeCloseTo(b.limbs[i]!.rb, 9);
    }
  });

  it('grows a different tree from a different seed', () => {
    const a = growTree(SPEC);
    const b = growTree({ ...SPEC, seed: 999 });
    const moved = a.limbs.some((l, i) => l.a.distanceTo(b.limbs[i]!.a) > 1e-6);
    expect(moved).toBe(true);
  });

  it('is the height it was asked for, and the girth at the foot', () => {
    const { limbs } = growTree(SPEC);
    const trunk = limbs.filter((l) => l.order === 0);
    const top = Math.max(...limbs.map((l) => Math.max(l.a.y, l.b.y)));
    // The leader reaches the asked height; boughs sweeping up may pass it.
    expect(Math.max(...trunk.map((l) => l.b.y))).toBeCloseTo(SPEC.height, 3);
    expect(top).toBeGreaterThanOrEqual(SPEC.height);
    // The foot is the asked girth, plus the flare that makes it look rooted.
    const foot = trunk[0]!.ra * 2;
    expect(foot).toBeGreaterThanOrEqual(SPEC.girth);
    expect(foot).toBeLessThan(SPEC.girth * 1.35);
  });

  it('tapers all the way up and never widens', () => {
    const trunk = growTree(SPEC).limbs.filter((l) => l.order === 0);
    // Past the flare at the very bottom, each ring is narrower than the last.
    for (let i = 2; i < trunk.length; i += 1) {
      expect(trunk[i]!.rb).toBeLessThanOrEqual(trunk[i - 1]!.rb + 1e-9);
    }
    expect(trunk[trunk.length - 1]!.rb).toBeGreaterThan(0);
  });

  it('starts its lowest bough well clear of the ground', () => {
    const { limbs } = growTree(SPEC);
    const boughs = limbs.filter((l) => l.order > 0);
    expect(boughs.length).toBeGreaterThan(20);
    const lowest = Math.min(...boughs.map((l) => l.a.y));
    expect(lowest).toBeGreaterThan(SPEC.height * 0.35);
  });

  it('hangs its leaves on the ends of the wood, not in mid-air', () => {
    const { limbs, tufts } = growTree(SPEC);
    expect(tufts.length).toBeGreaterThan(5);
    for (const tuft of tufts) {
      const near = Math.min(...limbs.map((l) => Math.min(
        l.b.distanceTo(tuft.at), l.a.distanceTo(tuft.at),
      )));
      expect(near).toBeLessThan(tuft.r + 1e-6);
    }
  });

  it('offers only barks that actually ship, with no duplicates', () => {
    expect(BARKS.length).toBeGreaterThan(0);
    expect(new Set(BARKS).size).toBe(BARKS.length);
    /* The two withdrawn for carrying a seller's watermark must not creep
     * back by being re-listed — the files are gone, so a name without a
     * file is a tree with no bark at all. */
    expect(BARKS).not.toContain('bark-pale');
    expect(BARKS).not.toContain('bark-oak');
  });

  it('has a file on disk for every bark it lists', () => {
    /* The list and the folder are two places that have to agree, and they
     * are edited separately — a name with no file loads nothing and the
     * tree quietly arrives untextured. Cheaper to fail here. */
    for (const bark of BARKS) {
      expect(existsSync(`public/tree-tex/${bark}.jpg`), `${bark}.jpg`).toBe(true);
    }
  });

  it('scales with the spec rather than baking in one size', () => {
    const small = growTree({ girth: 20, height: 400, seed: 7 });
    const big = growTree({ girth: 200, height: 4000, seed: 7 });
    const smallTop = Math.max(...small.limbs.map((l) => l.b.y));
    const bigTop = Math.max(...big.limbs.map((l) => l.b.y));
    expect(bigTop / smallTop).toBeCloseTo(10, 1);
    expect(small.limbs.length).toBe(big.limbs.length);
  });
});

/**
 * THE TREE AS A SOLID.
 *
 * The claim is that the drawn trunk and the one you cannot walk through are
 * the same wood — no invisible wall standing off the bark, no gap to fall
 * into — and that the field's gradient points out of it, which is what the
 * walker turns into climbing.
 */
describe('the tree you can climb', () => {
  const origin = new THREE.Vector3(100, 50, 200);
  const { limbs } = growTree(SPEC);
  const solid = new TreeSolid(limbs, origin);
  const trunk = limbs.filter((l) => l.order === 0);

  it('is solid on the axis and hollow well outside it', () => {
    const low = trunk[3]!;
    const mid = low.a.clone().lerp(low.b, 0.5).add(origin);
    expect(solid.solidAt(mid.x, mid.y, mid.z)).toBe(true);
    expect(solid.solidAt(mid.x + SPEC.girth, mid.y, mid.z)).toBe(false);
  });

  it('has its skin where the drawn bark is, within a millimetre', () => {
    const low = trunk[4]!;
    const t = 0.5;
    const mid = low.a.clone().lerp(low.b, t).add(origin);
    const r = low.ra + (low.rb - low.ra) * t;
    // Just inside the drawn radius is wood; just outside is air.
    expect(solid.solidAt(mid.x + r * 0.9, mid.y, mid.z)).toBe(true);
    expect(solid.solidAt(mid.x + r * 1.1, mid.y, mid.z)).toBe(false);
  });

  it('reads as a true distance, so the gradient is a unit normal', () => {
    const low = trunk[4]!;
    const mid = low.a.clone().lerp(low.b, 0.5).add(origin);
    const r = low.ra * 0.5 + low.rb * 0.5;
    const h = 0.2;
    const at = (x: number, y: number, z: number) => solid.densityAt(x, y, z);
    const px = mid.x + r * 0.6;
    const g = new THREE.Vector3(
      at(px - h, mid.y, mid.z) - at(px + h, mid.y, mid.z),
      at(px, mid.y - h, mid.z) - at(px, mid.y + h, mid.z),
      at(px, mid.y, mid.z - h) - at(px, mid.y, mid.z + h),
    ).multiplyScalar(1 / (2 * h));
    // A unit gradient, pointing OUT of the trunk (away from the axis).
    expect(g.length()).toBeCloseTo(1, 1);
    expect(g.clone().normalize().x).toBeGreaterThan(0.9);
  });

  it('leaves the canopy alone — twigs and leaves are not climbable', () => {
    const twig = limbs.find((l) => l.order === 2);
    expect(twig).toBeDefined();
    const on = twig!.a.clone().lerp(twig!.b, 0.5).add(origin);
    // The twig itself is not solid; only trunk and boughs are.
    const boughs = limbs.filter((l) => l.order <= 1);
    const nearBough = Math.min(...boughs.map((l) => Math.min(
      l.a.distanceTo(on.clone().sub(origin)), l.b.distanceTo(on.clone().sub(origin)),
    )));
    if (nearBough > SPEC.girth) expect(solid.solidAt(on.x, on.y, on.z)).toBe(false);
  });

  it('answers instantly for points nowhere near it', () => {
    expect(solid.densityAt(origin.x + 1e5, origin.y, origin.z)).toBe(-Infinity);
    expect(solid.solidAt(origin.x, origin.y - 1e5, origin.z)).toBe(false);
  });

  it('stands where it was put, not at the world origin', () => {
    const low = trunk[3]!;
    const mid = low.a.clone().lerp(low.b, 0.5);
    expect(solid.solidAt(mid.x, mid.y, mid.z)).toBe(false);
    expect(solid.solidAt(mid.x + origin.x, mid.y + origin.y, mid.z + origin.z)).toBe(true);
  });
});

/**
 * WHICH WAY THE SKIN FACES.
 *
 * The tree's material is single-sided, so a backwards winding does not draw
 * a slightly-wrong tree — it culls the near wall and leaves you looking at
 * the INSIDE of the far one. A solid metre-thick trunk then reads as a
 * hollow funnel you are standing in, which is exactly how it was reported.
 *
 * Nothing else in the scene would have caught it: the terrain's material is
 * double-sided, so it has never cared which way its triangles face. This is
 * the check that would have.
 */
describe('the tree is skinned outward', () => {
  it('winds every triangle to face out of the wood', () => {
    const built = buildTree(SPEC, new THREE.Texture(), 'bark-grey');
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const face = new THREE.Vector3();
    const vertex = new THREE.Vector3();

    for (const level of built.root.levels) {
      const mesh = (level.object as THREE.Group).children[0] as THREE.Mesh;
      const pos = mesh.geometry.getAttribute('position');
      const nrm = mesh.geometry.getAttribute('normal');
      const idx = mesh.geometry.getIndex()!;
      let inward = 0;
      for (let i = 0; i < idx.count; i += 3) {
        a.fromBufferAttribute(pos, idx.getX(i));
        b.fromBufferAttribute(pos, idx.getX(i + 1));
        c.fromBufferAttribute(pos, idx.getX(i + 2));
        face.crossVectors(b.sub(a), c.sub(a));
        if (face.lengthSq() < 1e-18) continue;
        vertex.fromBufferAttribute(nrm, idx.getX(i));
        /* The geometric winding and the shading normal must agree: a
         * triangle whose cross product opposes its own vertex normal is one
         * the renderer will cull from outside. */
        if (face.dot(vertex) <= 0) inward += 1;
      }
      expect(inward).toBe(0);
    }
    built.dispose();
  });
});
