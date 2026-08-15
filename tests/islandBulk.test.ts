import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { pushShare, resolveBulk, type Bulk } from '../src/scenes/islandBulk';

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
