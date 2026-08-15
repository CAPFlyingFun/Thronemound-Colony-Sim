import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  pushShare, QUEEN_BULK_ID, resolveBulk, type Bulk,
} from '../src/scenes/islandBulk';

/**
 * WHO SHOVES WHOM. Asked for as "a weight/push system like Path of Titans so
 * the heavier the object or ant, the more it can push/pull/carry" — so the
 * assertions are about the SHARE of a correction, which is the whole rule.
 */
const body = (over: Partial<Bulk> & { id: string }): Bulk => ({
  at: new THREE.Vector3(),
  radius: 1,
  massMg: 10,
  ...over,
});

describe('the heavier thing wins', () => {
  it('splits a correction evenly between equals', () => {
    expect(pushShare(body({ id: 'a' }), body({ id: 'b' }))).toBeCloseTo(0.5, 6);
  });

  it('makes the light one do the moving', () => {
    const queen = body({ id: 'queen', massMg: 12 });
    const stone = body({ id: 'stone', massMg: 120 });
    /* She takes ten elevenths of it; the stone barely notices. */
    expect(pushShare(queen, stone)).toBeCloseTo(120 / 132, 6);
    expect(pushShare(stone, queen)).toBeCloseTo(12 / 132, 6);
  });

  it('gives an anchored body no push at all, and the other its whole share', () => {
    /* A seed in her jaws must not be knocked out of them. */
    const held = body({ id: 'held', anchored: true });
    const passing = body({ id: 'passing' });
    expect(pushShare(held, passing)).toBe(0);
    expect(pushShare(passing, held)).toBe(1);
  });
});

describe('resolving overlaps', () => {
  it('separates two things that are inside each other', () => {
    const a = body({ id: 'a', at: new THREE.Vector3(0, 0, 0) });
    const b = body({ id: 'b', at: new THREE.Vector3(1, 0, 0) });
    expect(resolveBulk([a, b])).toBe(1);
    expect(a.at.distanceTo(b.at)).toBeCloseTo(2, 6);
    /* Equal masses, so each moved the same distance. */
    expect(a.at.x).toBeCloseTo(-0.5, 6);
    expect(b.at.x).toBeCloseTo(1.5, 6);
  });

  it('moves the queen off the stone, not the stone off the queen', () => {
    const queen = body({ id: 'queen', massMg: 12, at: new THREE.Vector3(0, 0, 0) });
    const stone = body({ id: 'stone', massMg: 120, at: new THREE.Vector3(1.5, 0, 0) });
    resolveBulk([queen, stone]);
    expect(Math.abs(queen.at.x - 0)).toBeGreaterThan(Math.abs(stone.at.x - 1.5) * 5);
  });

  it('leaves things that are not touching alone', () => {
    const a = body({ id: 'a', at: new THREE.Vector3(0, 0, 0) });
    const b = body({ id: 'b', at: new THREE.Vector3(9, 0, 0) });
    expect(resolveBulk([a, b])).toBe(0);
    expect(a.at.x).toBe(0);
    expect(b.at.x).toBe(9);
  });

  it('does not shove two anchored bodies apart', () => {
    const a = body({ id: 'a', anchored: true, at: new THREE.Vector3(0, 0, 0) });
    const b = body({ id: 'b', anchored: true, at: new THREE.Vector3(1, 0, 0) });
    expect(resolveBulk([a, b])).toBe(0);
    expect(a.at.x).toBe(0);
  });

  it('picks a direction rather than dividing by nothing when co-located', () => {
    const a = body({ id: 'a', at: new THREE.Vector3(0, 0, 0) });
    const b = body({ id: 'b', at: new THREE.Vector3(0, 0, 0) });
    resolveBulk([a, b]);
    expect(Number.isFinite(a.at.x)).toBe(true);
    expect(a.at.distanceTo(b.at)).toBeGreaterThan(1);
  });

  it('never makes an overlap worse — a pass is monotone', () => {
    /* The one thing a single un-iterated pass must not do is oscillate. */
    const mk = (): Bulk[] => [
      body({ id: 'a', massMg: 5, at: new THREE.Vector3(0, 0, 0) }),
      body({ id: 'b', massMg: 40, at: new THREE.Vector3(0.7, 0.2, 0) }),
      body({ id: 'c', massMg: 12, at: new THREE.Vector3(-0.4, 0, 0.3) }),
    ];
    const bodies = mk();
    const gap = (): number => Math.min(
      bodies[0]!.at.distanceTo(bodies[1]!.at),
      bodies[0]!.at.distanceTo(bodies[2]!.at),
      bodies[1]!.at.distanceTo(bodies[2]!.at),
    );
    let prev = gap();
    for (let i = 0; i < 40; i += 1) {
      resolveBulk(bodies);
      const now = gap();
      expect(now).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = now;
    }
    expect(prev).toBeGreaterThan(1.9);
  });
});

/*
 * Reported from a PC: "as soon as I grabbed the leaf I was going backwards
 * without any input and weird animation."
 *
 * The real numbers, in world units at MM = 5: her radius is 1.6 mm, a leaf's
 * is 4.4, and a carried thing rides 0.6 mm past her nose. So the two spheres
 * want 6 mm between their centres and have 0.6 — a 5.4 mm interpenetration
 * that exists by construction on every frame she carries anything.
 */
describe('what she is carrying is part of her', () => {
  const MM = 5;
  const her = () => body({
    id: QUEEN_BULK_ID, massMg: 12, radius: 1.6 / MM,
    at: new THREE.Vector3(0, 0, 0),
  });
  /** In her jaws: 0.6 mm along +x, which stands for her nose. */
  const leafInJaws = (over: Partial<Bulk> = {}) => body({
    id: 'leaf', massMg: 4, radius: 4.4 / MM,
    at: new THREE.Vector3(0.6 / MM, 0, 0),
    carrier: QUEEN_BULK_ID,
    anchored: true,
    ...over,
  });

  it('does not shove her backwards out from under her own load', () => {
    const queen = her();
    const leaf = leafInJaws();
    for (let i = 0; i < 60; i += 1) resolveBulk([queen, leaf]);
    expect(queen.at.x).toBe(0);
    expect(queen.at.length()).toBe(0);
  });

  it('is the bug, without the carrier flag', () => {
    /*
     * The same frame with `carrier` left off, which is what shipped: she is
     * driven the full overlap backwards, and because the held thing is
     * anchored she takes ALL of it. One pass, one frame.
     */
    const queen = her();
    const leaf = leafInJaws({ carrier: undefined });
    resolveBulk([queen, leaf]);
    expect(queen.at.x * MM).toBeCloseTo(-5.4, 6);
  });

  it('still lets her shove a stone aside while she is holding the leaf', () => {
    /* Skipping the PAIR, not the body: every other pair either of them is
     * in has to resolve exactly as before. */
    const queen = her();
    const leaf = leafInJaws();
    const stone = body({
      id: 'stone', massMg: 120, radius: 4.4 / MM,
      at: new THREE.Vector3(0, 0, 0.5),
    });
    resolveBulk([queen, leaf, stone]);
    expect(queen.at.z).toBeLessThan(0);
    /* And the leaf was still not allowed to move her. */
    expect(queen.at.x).toBe(0);
  });

  it('leaves an ordinary loose thing colliding with her as it always did', () => {
    /* The flag must be about being HELD, not about being a prop. */
    const queen = her();
    const loose = leafInJaws({ carrier: undefined, anchored: undefined });
    resolveBulk([queen, loose]);
    expect(queen.at.x).toBeLessThan(0);
    expect(loose.at.x).toBeGreaterThan(0.6 / MM);
  });
});
