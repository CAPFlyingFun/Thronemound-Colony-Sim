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
import {
  BARKS, buildTree, growTree, ringFactor, sidesAt, TreeSolid, type TreeSpec,
} from '../src/world/tree';

const SPEC: TreeSpec = { girth: 200, height: 5200, seed: 12345 };

/** Millimetres per world unit — the project's own scale. */
const MM = 5;

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

  it('makes the twigs climbable too — they are branches at her size', () => {
    const twig = limbs.find((l) => l.order === 2);
    expect(twig).toBeDefined();
    /* The outermost limb on a twenty-six metre tree measures 9.1 mm
     * through, against an ant 9 mm long — as wide across as she is long.
     * Leaving them out is what kept her off the upper branches. */
    const acrossMm = twig!.ra * 2 * 5;
    expect(acrossMm).toBeGreaterThan(6);
    const on = twig!.a.clone().lerp(twig!.b, 0.5).add(origin);
    expect(solid.solidAt(on.x, on.y, on.z)).toBe(true);
  });

  it('leaves the foliage as open air', () => {
    const { tufts } = growTree(SPEC);
    const far = tufts[tufts.length - 1]!;
    /* Out at the edge of a leaf cluster, clear of the wood that carries it. */
    const edge = far.at.clone().add(origin);
    edge.y += far.r * 0.9;
    expect(solid.solidAt(edge.x, edge.y, edge.z)).toBe(false);
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

/**
 * ONE TUBE PER CHAIN.
 *
 * The trunk used to be skinned as one closed tube per section, so every
 * joint met as two separate rings facing slightly different ways and the
 * outside of each bend opened a wedge you could see through — from inside,
 * a second trunk crossing the first. A chain of limbs is one tube now, with
 * ONE ring at each joint shared by the sections either side, and rings that
 * are literally the same vertices cannot disagree.
 */
describe('the trunk is one continuous tube', () => {
  it('shares a single ring at every joint, so no seam can open', () => {
    const built = buildTree(SPEC, new THREE.Texture(), 'bark-grey');
    const mesh = (built.root.levels[0]!.object as THREE.Group).children[0] as THREE.Mesh;
    const pos = mesh.geometry.getAttribute('position');

    /*
     * Count how many vertices sit in exactly the same place. A per-limb
     * skin duplicates a whole ring at every joint; a shared one does not,
     * so the only coincident pairs left are each ring's seam vertex, which
     * has to be doubled to carry two u coordinates.
     */
    const seen = new Map<string, number>();
    const key = (i: number) => [
      pos.getX(i).toFixed(4), pos.getY(i).toFixed(4), pos.getZ(i).toFixed(4),
    ].join();
    for (let i = 0; i < pos.count; i += 1) {
      const k = key(i);
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    let doubled = 0;
    for (const count of seen.values()) if (count > 1) doubled += count - 1;

    const rings = Math.round(pos.count / (sidesAt(0) + 1));
    /*
     * One duplicate per ring — the wrap seam — and no WHOLE ring anywhere.
     * Per-limb skinning would double a ring at each of the tree's joints,
     * which at this tessellation is sixty-five vertices a time, so the
     * check has room for a handful without any room for that.
     *
     * The handful is real and harmless: at sixty-four sides a twig's tip
     * ring is small enough that neighbouring vertices round to the same
     * four decimal places. Five of them, measured.
     */
    expect(doubled).toBeGreaterThanOrEqual(rings);
    expect(doubled).toBeLessThan(rings + sidesAt(0) / 2);
    built.dispose();
  });

  it('keeps the bark from twisting where two sections meet', () => {
    /* The frame is carried along the chain rather than rebuilt per section:
     * rebuilding it lands the first vertex at a different angle each time,
     * which shears the texture at every joint. Consecutive rings must stay
     * nearly aligned around the axis. */
    const built = buildTree(SPEC, new THREE.Texture(), 'bark-grey');
    const mesh = (built.root.levels[0]!.object as THREE.Group).children[0] as THREE.Mesh;
    const pos = mesh.geometry.getAttribute('position');
    const stride = sidesAt(0) + 1;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const centreA = new THREE.Vector3();
    const centreB = new THREE.Vector3();
    let worst = 0;
    /* The trunk is the first chain, so its rings run from the start. */
    for (let ring = 0; ring < 12; ring += 1) {
      centreA.set(0, 0, 0); centreB.set(0, 0, 0);
      for (let k = 0; k < stride - 1; k += 1) {
        a.fromBufferAttribute(pos, ring * stride + k); centreA.add(a);
        b.fromBufferAttribute(pos, (ring + 1) * stride + k); centreB.add(b);
      }
      centreA.divideScalar(stride - 1); centreB.divideScalar(stride - 1);
      a.fromBufferAttribute(pos, ring * stride).sub(centreA).normalize();
      b.fromBufferAttribute(pos, (ring + 1) * stride).sub(centreB).normalize();
      worst = Math.max(worst, a.angleTo(b));
    }
    // A few degrees of drift as the trunk bends is the bend, not a twist.
    expect(worst).toBeLessThan(0.25);
    built.dispose();
  });

  it('tapers to a five-millimetre circle whatever its girth', () => {
    /* An absolute tip, not a fraction of the base: the old curve held at
     * 16% of the foot, which on the landmark left the leader 80 mm across
     * — a pole with the end sawn off. */
    for (const girth of [200, 60, 20]) {
      const trunk = growTree({ ...SPEC, girth }).limbs.filter((l) => l.order === 0);
      expect(trunk[trunk.length - 1]!.rb * 2 * MM).toBeCloseTo(5, 3);
    }
    /* ...but never wider at the top than at the bottom. A bush whose whole
     * stem is thinner than the tip would otherwise flare upwards. */
    const bush = growTree({ girth: 8 / MM, height: 60 / MM, seed: 3, rings: 4 })
      .limbs.filter((l) => l.order === 0);
    expect(bush[bush.length - 1]!.rb).toBeLessThan(bush[0]!.ra);
    expect(bush[bush.length - 1]!.rb * 2 * MM).toBeCloseTo(4, 3);
  });

  it('never draws the bark INSIDE the wood she is standing on', () => {
    /*
     * THE HOVER, measured. The solid is the exact circle of the limb; a
     * polygon tube with its vertices ON that circle has every flat between
     * them sunk inside it, and she stands on the circle — so she stands
     * that far off the picture. Measured before the fix: a mean 2.79 mm of
     * air under her on the twenty-sided trunk, never less than 0.33, and
     * 51 mm at scrub tessellation.
     *
     * The claim is one-sided: the drawn surface is never INSIDE the
     * collision surface, at any detail level. Sinking a hair into the bark
     * is invisible; floating over it is what was reported.
     */
    const parts = growTree(SPEC);
    const solid = new TreeSolid(parts.limbs, new THREE.Vector3(0, 0, 0));
    const built = buildTree(SPEC, new THREE.Texture(), BARKS[0]!);
    /*
     * The CLEAR TRUNK only — below the lowest bough. Above it a coarse
     * level draws no boughs at all, so a horizontal probe would exit the
     * solid at a bough's skin and find nothing drawn there: a hundred
     * millimetres of "float" that is a missing branch, not a hovering one.
     * The clear trunk is also where she actually stands.
     */
    const lowestBough = Math.min(
      ...parts.limbs.filter((l) => l.order > 0).map((l) => l.a.y),
    );
    const trunk = parts.limbs
      .filter((l) => l.order === 0 && l.b.y < lowestBough);
    const dir = new THREE.Vector3();
    const back = new THREE.Vector3();
    const from = new THREE.Vector3();
    const ray = new THREE.Raycaster();

    for (const level of built.root.levels) {
      const wood = ((level.object as THREE.Group).children[0] as THREE.Mesh).geometry;
      const probe = new THREE.Mesh(
        wood, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
      );
      probe.updateMatrixWorld();
      let worstFloatMm = -Infinity;
      /*
       * BETWEEN the rings, not only at them — and starting at the FOOT.
       *
       * This sampled ring corners from the third section up, which is the
       * one place the fault could not show: a ring is on the cone by
       * construction whatever the section between them does, and the whole
       * error lived in section zero, where the end overrun had stretched
       * the taper. Thirteen millimetres of hovering, measured in the browser
       * on the trunk she actually climbs, while this test read clean.
       */
      for (let i = 0; i < trunk.length - 1; i += 1) {
        for (const frac of [0, 0.25, 0.5, 0.75]) {
        const centre = trunk[i]!.a.clone().lerp(trunk[i]!.b, frac);
        for (let k = 0; k < 8; k += 1) {
          const ang = (k / 8) * Math.PI * 2 + 0.37;
          dir.set(Math.cos(ang), 0, Math.sin(ang));
          let skin = -1;
          let inside = 0;
          for (let d = 0.2; d < SPEC.girth * 2; d += 0.2) {
            if (!solid.solidAt(
              centre.x + dir.x * d, centre.y, centre.z + dir.z * d,
            )) { skin = d; break; }
            inside = d;
          }
          if (skin < 0) continue;
          /* Bisect the bracket: a 1 mm march step would otherwise report
           * 1 mm of float that is the PROBE's, not the tree's. */
          for (let n = 0; n < 24; n += 1) {
            const mid = (inside + skin) / 2;
            if (solid.solidAt(
              centre.x + dir.x * mid, centre.y, centre.z + dir.z * mid,
            )) inside = mid;
            else skin = mid;
          }
          const out = SPEC.girth * 3;
          from.copy(centre).addScaledVector(dir, out);
          ray.set(from, back.copy(dir).negate());
          const hit = ray.intersectObject(probe, false)[0];
          if (!hit) continue;
          worstFloatMm = Math.max(worstFloatMm, (skin - (out - hit.distance)) * MM);
        }
        }
      }
      /*
       * Worst float per level, measured: -0.41, -0.41, -1.60, -20.11 mm.
       * Negative is the bark standing PROUD of the collision, which is the
       * harmless side — her claw sinks a fraction into the picture instead
       * of hanging over it. Sampled at the rings AND between them, from the
       * foot up, the same four levels read +9.84, +29.43, +121.98 and
       * +155.29 mm of air before any of this, and +13.0 mm at the height
       * she actually steps onto the trunk.
       */
      expect(worstFloatMm).toBeLessThan(0);
    }
    built.dispose();
  });
});

/**
 * SHE STANDS ON THE BARK, NOT UNDER IT.
 *
 * The test above pins that the drawn surface is never INSIDE the collision.
 * This pins the other half, which is the one the player reported: the
 * collision must never be inside the DRAWN surface either, or she seats on
 * a circle the mesh has already covered over and ends up half in the trunk.
 *
 * `TreeSolid` is built at the drawn ring radius for exactly this reason.
 */
describe('the wood she seats on contains the wood she sees', () => {
  it('never leaves a drawn facet outside the collision', () => {
    const parts = growTree(SPEC);
    const sides = sidesAt(0);
    const solid = new TreeSolid(parts.limbs, new THREE.Vector3(), ringFactor(sides));
    const built = buildTree(SPEC, new THREE.Texture(), BARKS[0]!);
    const wood = ((built.root.levels[0]!.object as THREE.Group)
      .children[0] as THREE.Mesh).geometry;
    const pos = wood.getAttribute('position');
    const v = new THREE.Vector3();

    /*
     * THE CLEAR TRUNK, above the buried foot and below the lowest bough.
     *
     * A chain's end rings are deliberately overrun — the trunk's first ring
     * is driven 460 mm UNDER the soil so the foot never shows a seam, and it
     * duly measures 194 mm outside a solid that stops at the ground. That is
     * the overrun working, not a fault, and she cannot walk there.
     */
    const trunk = parts.limbs.filter((l) => l.order === 0);
    const lowestBough = Math.min(
      ...parts.limbs.filter((l) => l.order > 0).map((l) => l.a.y),
    );
    const from = trunk[0]!.b.y;

    let worstOutsideMm = -Infinity;
    let tested = 0;
    for (let i = 0; i < pos.count; i += 1) {
      v.fromBufferAttribute(pos, i);
      if (v.y < from || v.y > lowestBough) continue;
      const d = solid.densityAt(v.x, v.y, v.z);
      if (d === -Infinity) continue;
      tested += 1;
      worstOutsideMm = Math.max(worstOutsideMm, -d * MM);
    }
    expect(tested).toBeGreaterThan(100);
    /* Her feet seat on the collision, so a drawn point outside it is a
     * point she stands UNDER. What is left is the ring MITRE at a bend —
     * measured 0.035 mm, which is a two-hundred-and-fiftieth of her body —
     * and `FOOT_AIR` is set above it so the guarantee still holds. */
    expect(worstOutsideMm).toBeLessThan(0.05);
    built.dispose();
  });

  it('leaves no more than a fraction of a millimetre of air on the trunk', () => {
    /*
     * The other side of the same trade. The collision is the circle the
     * drawn polygon is INSCRIBED in, so she is never under the bark — but
     * she is over it by the facet's sagitta, and that is what the near
     * level's side count is for. At the landmark's widest, 573 mm of
     * radius, twenty sides would leave 7 mm of air; sixty-four leaves 0.7.
     */
    const r = 573 / MM;
    const air = r * (ringFactor(sidesAt(0)) - 1) * MM;
    expect(air).toBeLessThan(0.8);
  });

  it('widens a coarse tessellation more, because it needs it more', () => {
    /* A scrub stem is drawn with a handful of sides and stands proud of its
     * own circle by 8%; the near trunk is at sixty-four and stands proud by
     * a tenth of one per cent. A single constant would be wrong for one of
     * them, which is why the collision asks the level how many sides it
     * actually baked. */
    /* Compared as EXCESS over the circle, which is the thing that matters —
     * the factors themselves are both near one and comparing those hides it. */
    expect(ringFactor(sidesAt(3)) - 1).toBeGreaterThan((ringFactor(sidesAt(0)) - 1) * 8);
    expect(ringFactor(sidesAt(0))).toBeLessThan(1.002);
  });
});
