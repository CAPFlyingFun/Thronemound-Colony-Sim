import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  GRIT_CAP, GRIT_GRAVITY, GRIT_PER_BITE, Grit, stepChip,
} from '../src/scenes/islandGrit';

/** A fixed "random", so a spray is the same spray every run. */
const steady = (): (() => number) => {
  let n = 0;
  return () => { n = (n * 9301 + 49297) % 233280; return n / 233280; };
};

const chip = (vel: [number, number, number]) => ({
  at: new THREE.Vector3(),
  vel: new THREE.Vector3(...vel),
  life: 1,
  span: 1,
  turn: 0,
});

describe('a chip of spoil', () => {
  it('falls, and world-down is the only thing that is world', () => {
    /* The spray is built around the cut's own facing, because she digs
     * sideways down a bore and upside down under an overhang. Gravity is
     * the one direction that does NOT rotate with her. */
    const c = chip([0, 0, 0]);
    stepChip(c, 0.1);
    /* Gravity first, then drag on the whole velocity — so the fall is a
     * little short of `g * dt`, and asserting the bare `g * dt` is
     * asserting a chip that does not tumble. Falling and slower than free
     * fall is the actual claim. */
    expect(c.vel.y).toBeLessThan(0);
    expect(c.vel.y).toBeGreaterThan(-GRIT_GRAVITY * 0.1);
    expect(c.at.y).toBeLessThan(0);
  });

  it('slows as it tumbles rather than flying flat', () => {
    const c = chip([2, 0, 0]);
    stepChip(c, 0.1);
    expect(c.vel.x).toBeLessThan(2);
    expect(c.vel.x).toBeGreaterThan(0);
  });

  it('dies at zero and stays dead', () => {
    const c = chip([1, 0, 0]);
    c.life = 0.05;
    expect(stepChip(c, 0.1)).toBe(0);
    expect(c.life).toBe(0);
    /* A dead chip must not keep integrating — it is about to be reused. */
    const was = c.at.clone();
    expect(stepChip(c, 0.1)).toBe(0);
    expect(c.at.distanceTo(was)).toBe(0);
  });
});

describe('the spray off a cut', () => {
  it('comes back OUT of the hole, not into it', () => {
    /* Spoil leaves along the reverse of the aim. Digging along +x must
     * throw chips with a negative x component, on average. */
    const g = new Grit(steady());
    g.burst(new THREE.Vector3(), new THREE.Vector3(1, 0, 0), 12);
    /* Reach the chips the way the mesh does, through one tick. */
    g.tick(1 / 60);
    const at = new THREE.Vector3();
    let outward = 0;
    for (let i = 0; i < GRIT_CAP; i += 1) {
      const m = new THREE.Matrix4();
      g.mesh.getMatrixAt(i, m);
      at.setFromMatrixPosition(m);
      if (Math.abs(at.x) > 1e5) continue; // parked
      if (at.x < 0) outward += 1;
    }
    expect(outward).toBeGreaterThan(8);
    g.dispose();
  });

  it('works on a PLUMB aim, which is what a shaft is', () => {
    /* The spray needs two axes across itself, and building one with a
     * cross against world up returns nothing when the aim IS world up.
     * Straight down is the most ordinary dig this game has. */
    const g = new Grit(steady());
    expect(g.burst(new THREE.Vector3(), new THREE.Vector3(0, -1, 0), 6)).toBe(6);
    expect(g.tick(1 / 60)).toBe(6);
    g.dispose();
  });

  it('never allocates past the cap, however hard she digs', () => {
    /* A held stroke calls this several times a second for as long as the
     * player likes. The pool is the whole budget. */
    const g = new Grit(steady());
    for (let i = 0; i < 50; i += 1) g.burst(new THREE.Vector3(), new THREE.Vector3(0, 0, 1));
    expect(g.tick(1 / 60)).toBe(GRIT_CAP);
    expect(g.mesh.count).toBe(GRIT_CAP);
    g.dispose();
  });

  it('reuses a chip once it has died, rather than running dry', () => {
    const g = new Grit(steady());
    expect(g.burst(new THREE.Vector3(), new THREE.Vector3(0, 0, 1))).toBe(GRIT_PER_BITE);
    /* Long enough that every one of them is gone. */
    for (let i = 0; i < 120; i += 1) g.tick(1 / 60);
    expect(g.tick(1 / 60)).toBe(0);
    expect(g.burst(new THREE.Vector3(), new THREE.Vector3(0, 0, 1))).toBe(GRIT_PER_BITE);
    g.dispose();
  });

  it('is one draw call whatever is happening', () => {
    /* The whole reason it is instanced. A particle system that grows the
     * scene graph during a held dig spends the budget of the thing it is
     * decorating. */
    const g = new Grit(steady());
    expect(g.mesh.isInstancedMesh).toBe(true);
    expect(g.mesh.count).toBe(GRIT_CAP);
    g.burst(new THREE.Vector3(), new THREE.Vector3(0, 0, 1));
    g.tick(1 / 60);
    expect(g.mesh.count).toBe(GRIT_CAP);
    g.dispose();
  });
});
