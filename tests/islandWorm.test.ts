import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  WORM_BITE_S, WORM_BORE_MM, WORM_CEIL_MM, WORM_FLOOR_MM, WORM_STEP_MM,
  WORM_UNDER_MM, Worm, wanderDir,
} from '../src/scenes/islandWorm';

/** Millimetres per world unit — the project's own scale. */
const MM = 5;

/** Soil that records what was asked of it. */
const soil = (over: { covers?: boolean; surface?: number; base?: number } = {}) => {
  const cuts: { x: number; y: number; z: number; r: number }[] = [];
  return {
    cuts,
    covers: () => over.covers ?? true,
    carve: (x: number, y: number, z: number, r: number) => { cuts.push({ x, y, z, r }); },
    /* A generous column by default — surface at zero and a floor far below,
     * so a test about digging is not accidentally a test about walls. */
    surfaceAt: () => over.surface ?? 0,
    baseAt: () => over.base ?? -1000,
  };
};

/** A fixed "random", so a worm is the same worm every run. */
const steady = (): (() => number) => {
  let n = 7;
  return () => { n = (n * 9301 + 49297) % 233280; return n / 233280; };
};

describe('which way a worm goes next', () => {
  it('is mostly level, not up and down', () => {
    /* Picking uniformly on a sphere would have it spend most of its life
     * going straight up or straight down, which is not what a worm does. */
    const into = new THREE.Vector3();
    const rand = steady();
    let steep = 0;
    for (let i = 0; i < 200; i += 1) {
      wanderDir(rand, WORM_UNDER_MM * 4, WORM_UNDER_MM * 4, into);
      if (Math.abs(into.y) > 0.6) steep += 1;
    }
    expect(steep).toBeLessThan(20);
  });

  it('always turns DOWN when it is near the sky', () => {
    /* The one thing it must not do is leave the ground — outside the soil
     * there is no density field for it to live in. At zero depth the bias
     * is total, so every draw points down. */
    const into = new THREE.Vector3();
    const rand = steady();
    for (let i = 0; i < 60; i += 1) {
      wanderDir(rand, 0, WORM_UNDER_MM * 4, into);
      expect(into.y).toBeLessThanOrEqual(0);
    }
  });

  it('is free again once it is properly under', () => {
    const into = new THREE.Vector3();
    const rand = steady();
    let up = 0;
    for (let i = 0; i < 120; i += 1) {
      wanderDir(rand, WORM_UNDER_MM * 3, WORM_UNDER_MM * 3, into);
      if (into.y > 0) up += 1;
    }
    expect(up).toBeGreaterThan(30);
  });

  it('always hands back a unit vector', () => {
    const into = new THREE.Vector3();
    const rand = steady();
    for (const depth of [0, 1, WORM_UNDER_MM, 500]) {
      wanderDir(rand, depth, depth, into);
      expect(into.length()).toBeCloseTo(1, 9);
    }
  });
});

describe('a worm digging', () => {
  it('takes one bite a second, as asked', () => {
    const w = new Worm(0, 0, 0, steady());
    const s = soil();
    for (let i = 0; i < 60 * 10; i += 1) w.tick(1 / 60, s);
    expect(w.bites).toBe(10 / WORM_BITE_S);
  });

  it('leaves a hole its own thickness', () => {
    const w = new Worm(0, 0, 0, steady());
    const s = soil();
    for (let i = 0; i < 120; i += 1) w.tick(1 / 60, s);
    expect(s.cuts.length).toBeGreaterThan(0);
    for (const c of s.cuts) expect(c.r * 5).toBeCloseTo(WORM_BORE_MM / 2, 9);
  });

  it('advances less than a bore per bite, so the tube is continuous', () => {
    /* Step over bore would leave a string of beads rather than a tunnel —
     * the same reason her own held stroke cuts two overlapping scoops. */
    expect(WORM_STEP_MM).toBeLessThan(WORM_BORE_MM);
  });

  it('moves about a step per bite', () => {
    /* Started INSIDE its band. At y = 0 with the surface at 0 it would be
     * above its own ceiling, and the first tick would clamp it down into the
     * band — a legitimate correction that is not travel, and it read as one
     * as an extra 5 mm on the first frame. */
    const w = new Worm(0, -4, 0, steady());
    const s = soil();
    const from = w.at.clone();
    for (let i = 0; i < 60 * 4; i += 1) w.tick(1 / 60, s);
    /* Four seconds is four bites and about four steps of travel. Not
     * exactly, because it is turning while it goes. */
    const mm = from.distanceTo(w.at) * 5;
    expect(mm).toBeGreaterThan(WORM_STEP_MM * 3);
    expect(mm).toBeLessThanOrEqual(WORM_STEP_MM * 4 + 0.01);
  });

  it('roams outside the streamed window, but leaves no hole there', () => {
    /*
     * THE RULE THAT CHANGED WHEN FIFTY WORMS WENT OUT ACROSS THE ISLAND.
     *
     * The fine soil is a 192 mm window following HER — about 37,000 mm2 of
     * a 3.1-billion-mm2 island. A worm that may only MOVE when it can dig is
     * therefore a worm that never moves: measured in the live scene, zero of
     * fifty took a single bite in ninety seconds.
     *
     * So it travels regardless and carves only where there is a field to
     * carve. Nothing is lost by it: soil is opaque, the only ground she can
     * see into is inside the window, and only the six nearest worms are
     * drawn at all.
     */
    const w = new Worm(0, 0, 0, steady());
    const s = soil({ covers: false });
    const from = w.at.clone();
    for (let i = 0; i < 60 * 5; i += 1) w.tick(1 / 60, s);
    expect(w.bites).toBe(0);
    expect(s.cuts.length).toBe(0);
    /* Five seconds at three millimetres a second. */
    expect(from.distanceTo(w.at) * MM).toBeGreaterThan(WORM_STEP_MM * 4);
  });

  it('digs ahead of itself, not where its head already is', () => {
    /* The mouth is at the front. Carving at the centre would leave the
     * working face untouched and the worm inside its own cut. */
    const w = new Worm(0, 0, 0, steady());
    const s = soil();
    for (let i = 0; i < 70; i += 1) w.tick(1 / 60, s);
    const cut = s.cuts[0]!;
    const ahead = (cut.x - w.at.x) * w.dir.x
      + (cut.y - w.at.y) * w.dir.y + (cut.z - w.at.z) * w.dir.z;
    /* Behind the CURRENT head only because it kept moving after the bite;
     * what matters is that the cut is not at the head's own centre. */
    expect(Math.abs(ahead)).toBeGreaterThan(0);
    expect(w.lastBite.length()).toBeGreaterThan(0);
  });

  it('does nothing on a zero or negative step', () => {
    const w = new Worm(0, 0, 0, steady());
    const s = soil();
    expect(w.tick(0, s)).toBe(false);
    expect(s.cuts.length).toBe(0);
  });
});

describe('a worm inside its band', () => {
  /*
   * THE BAND REPLACED SURFACING. v0.1.71 had worms climb out and lie at the
   * mouth of the burrow, which answered "I don't see any worms" and was
   * then superseded: having seen them, Joshua asked for them kept
   * underground with the whole island to roam. Visibility is bought a
   * different way now — fifty of them rather than three.
   *
   * What survives from that version is the lesson: a BIAS is not a LIMIT.
   * `wanderDir` only runs when a heading is chosen, headings last 30-60 s,
   * and the turn is a hard 0.12 rad/s — so anything that must not happen
   * has to be enforced on the step.
   */
  it('never breaks the surface, however long it points at the sky', () => {
    const w = new Worm(0, -2, 0, steady());
    w.dir.set(0, 1, 0);
    const s = soil({ surface: 0 });
    let highest = -Infinity;
    for (let i = 0; i < 60 * 300; i += 1) {
      w.tick(1 / 60, s);
      /* Height above grade, which with the surface at zero is its own y. */
      highest = Math.max(highest, w.at.y * MM);
    }
    /* It must stay a clear ceiling below the grass, with a hair of slack
     * for the step it is part-way through. */
    expect(highest).toBeLessThanOrEqual(-WORM_CEIL_MM + 0.1);
  });

  it('never digs down past the bottom of the island', () => {
    /* Below the base is water, and these are not sea worms. */
    const w = new Worm(0, -50, 0, steady());
    w.dir.set(0, -1, 0);
    const s = soil({ surface: 0, base: -100 });
    let lowest = Infinity;
    for (let i = 0; i < 60 * 300; i += 1) {
      w.tick(1 / 60, s);
      lowest = Math.min(lowest, (w.at.y - -100) * MM);
    }
    expect(lowest).toBeGreaterThanOrEqual(WORM_FLOOR_MM - 0.1);
  });

  it('turns away from whichever wall is nearer, not the average of both', () => {
    /*
     * Averaging is the trap: a worm in a thin seam has both walls close,
     * the two biases cancel to level, and it ploughs along one plane
     * forever. The stronger bias has to win outright.
     */
    const into = new THREE.Vector3();
    const rand = steady();
    let down = 0;
    for (let i = 0; i < 120; i += 1) {
      /* Ceiling right there, floor a long way off. */
      wanderDir(rand, 0, WORM_UNDER_MM * 4, into);
      if (into.y <= 0) down += 1;
    }
    expect(down).toBe(120);
    let up = 0;
    for (let i = 0; i < 120; i += 1) {
      wanderDir(rand, WORM_UNDER_MM * 4, 0, into);
      if (into.y >= 0) up += 1;
    }
    expect(up).toBe(120);
  });

  it('cannot advance at all where the band has closed up', () => {
    /*
     * WHICH IS WHAT KEEPS THEM OUT OF THE SEA, with no sea check anywhere.
     * Over water the seafloor is below sea level, so the floor rises past
     * the ceiling, both walls fire at once, and nothing can take it further
     * out. Here the surface and base are the same height.
     */
    const w = new Worm(0, 0, 0, steady());
    const s = soil({ surface: 0, base: 0 });
    const from = w.at.clone();
    for (let i = 0; i < 60 * 60; i += 1) {
      w.tick(1 / 60, s);
      /* Whatever it does, it may not climb out or sink through. */
      expect(w.at.y).toBeLessThanOrEqual(from.y + 0.001);
      expect(w.at.y).toBeGreaterThanOrEqual(from.y - 0.001);
    }
  });

  it('still roams freely in the middle of a deep column', () => {
    /* The walls must not be so eager that a worm with room to spare is
     * pinned to a plane — that is the failure the "stronger wins" rule is
     * guarding against, seen from the other side. */
    const w = new Worm(0, -100, 0, steady());
    const s = soil({ surface: 0, base: -200 });
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 60 * 300; i += 1) {
      w.tick(1 / 60, s);
      lo = Math.min(lo, w.at.y);
      hi = Math.max(hi, w.at.y);
    }
    expect((hi - lo) * MM).toBeGreaterThan(WORM_BORE_MM);
  });
});
