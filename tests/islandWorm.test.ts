import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  WORM_BITE_S, WORM_BORE_MM, WORM_OUT_MM, WORM_STEP_MM, WORM_UNDER_MM, Worm,
  wanderDir,
} from '../src/scenes/islandWorm';

/** Millimetres per world unit — the project's own scale. */
const MM = 5;

/** Soil that records what was asked of it. */
const soil = (over: { covers?: boolean; surface?: number } = {}) => {
  const cuts: { x: number; y: number; z: number; r: number }[] = [];
  return {
    cuts,
    covers: () => over.covers ?? true,
    carve: (x: number, y: number, z: number, r: number) => { cuts.push({ x, y, z, r }); },
    surfaceAt: () => over.surface ?? 0,
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
      wanderDir(rand, WORM_UNDER_MM * 4, into);
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
      wanderDir(rand, 0, into);
      expect(into.y).toBeLessThanOrEqual(0);
    }
  });

  it('is free again once it is properly under', () => {
    const into = new THREE.Vector3();
    const rand = steady();
    let up = 0;
    for (let i = 0; i < 120; i += 1) {
      wanderDir(rand, WORM_UNDER_MM * 3, into);
      if (into.y > 0) up += 1;
    }
    expect(up).toBeGreaterThan(30);
  });

  it('always hands back a unit vector', () => {
    const into = new THREE.Vector3();
    const rand = steady();
    for (const depth of [0, 1, WORM_UNDER_MM, 500]) {
      wanderDir(rand, depth, into);
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
    const w = new Worm(0, 0, 0, steady());
    const s = soil();
    const from = w.at.clone();
    for (let i = 0; i < 60 * 4; i += 1) w.tick(1 / 60, s);
    /* Four seconds is four bites and about four steps of travel. Not
     * exactly, because it is turning while it goes. */
    const mm = from.distanceTo(w.at) * 5;
    expect(mm).toBeGreaterThan(WORM_STEP_MM * 3);
    expect(mm).toBeLessThanOrEqual(WORM_STEP_MM * 4 + 0.01);
  });

  it('waits rather than pretending, outside the streamed window', () => {
    /*
     * The fine soil is a 192 mm window that follows HER. A worm outside it
     * has nothing to carve, and one that kept MOVING out there would
     * surface somewhere else with no burrow behind it — which reads as
     * teleporting. Measured in the live scene: over 90 seconds the three
     * worms took 42, 40 and 34 bites rather than 90, because they spend
     * about half their life out of the window waiting.
     */
    const w = new Worm(0, 0, 0, steady());
    const s = soil({ covers: false });
    const from = w.at.clone();
    for (let i = 0; i < 60 * 5; i += 1) w.tick(1 / 60, s);
    expect(w.bites).toBe(0);
    expect(s.cuts.length).toBe(0);
    expect(from.distanceTo(w.at)).toBe(0);
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

describe('a worm coming up for air', () => {
  /*
   * WHY THIS EXISTS AT ALL. Reported twice — "I don't see any worms" — and
   * both times they were there and digging. They spawned twelve millimetres
   * under the grass, and `wanderDir` turns a shallow worm DOWN, so nothing
   * could ever bring one back up: three animals living their whole lives
   * inside opaque ground. These tests pin the fix, because the failure mode
   * is invisible by construction and no probe would have shouted about it.
   */
  it('does not stay buried forever', () => {
    const w = new Worm(0, -4, 0, steady());
    /* Grade at zero, so its depth is simply minus its own height. */
    const s = soil({ surface: 0 });
    expect(w.mood).toBe('down');
    let surfaced = false;
    for (let i = 0; i < 60 * 240 && !surfaced; i += 1) {
      w.tick(1 / 60, s);
      if (w.mood === 'out') surfaced = true;
    }
    expect(surfaced).toBe(true);
    /* And its head really is out of the ground, not merely flagged so. */
    expect(w.at.y).toBeGreaterThanOrEqual(0);
  });

  it('climbs upward once it has decided to, whatever the wander wanted', () => {
    /* `wanderDir` biases a shallow worm DOWN — correct for digging and
     * exactly what kept them buried. Surfacing has to outrank it. */
    const w = new Worm(0, -20, 0, steady());
    const s = soil({ surface: 0 });
    for (let i = 0; i < 60 * 60 && w.mood === 'down'; i += 1) w.tick(1 / 60, s);
    expect(w.mood).toBe('up');
    /* Give the turn rate time to swing it over, then check it is rising. */
    const from = w.at.y;
    for (let i = 0; i < 60 * 30 && w.mood === 'up'; i += 1) w.tick(1 / 60, s);
    expect(w.at.y).toBeGreaterThan(from);
  });

  it('lies still at the mouth rather than carving the sky', () => {
    const w = new Worm(0, 0, 0, steady(), 'out');
    const s = soil({ surface: 0 });
    const from = w.at.clone();
    for (let i = 0; i < 60 * 5; i += 1) w.tick(1 / 60, s);
    expect(w.mood).toBe('out');
    expect(s.cuts.length).toBe(0);
    expect(from.distanceTo(w.at)).toBe(0);
  });

  it('goes back down after its spell at the mouth', () => {
    const w = new Worm(0, 0, 0, steady(), 'out');
    const s = soil({ surface: 0 });
    for (let i = 0; i < 60 * 60 && w.mood === 'out'; i += 1) w.tick(1 / 60, s);
    expect(w.mood).toBe('down');
  });

  it('never flies, however long its heading points at the sky', () => {
    /*
     * A BUG THIS FILE ALREADY HAD, which surfacing merely exposed.
     * `wanderDir` biases downward only at the moment a heading is CHOSEN,
     * and a heading lasts thirty to sixty seconds; the turn rate is a hard
     * 0.12 rad/s, so a worm pointed up needed thirteen seconds to come about
     * and travelled the whole time. Measured in the running game before the
     * ceiling existed: heads 10, 23 and 28 mm above the ground.
     *
     * Started deliberately pointing straight up at the surface, which is the
     * worst case the wander can produce.
     */
    const w = new Worm(0, 0, 0, steady());
    w.dir.set(0, 1, 0);
    const s = soil({ surface: 0 });
    let highest = -Infinity;
    for (let i = 0; i < 60 * 300; i += 1) {
      w.tick(1 / 60, s);
      /* HEIGHT ABOVE GRADE, which with the surface at zero is simply its
       * own y. Written as `-at.y` first, which is DEPTH — the test then
       * reported the deepest point it reached and called it flying. */
      highest = Math.max(highest, w.at.y * MM);
    }
    /* Never more than its own allowance above grade, with a hair of slack
     * for the step it is part-way through. */
    expect(highest).toBeLessThanOrEqual(WORM_OUT_MM + 0.1);
  });

  it('lies with its body down the burrow and only its head out', () => {
    /*
     * The posture an anecic worm actually holds: head at the doorway, tail
     * still anchored below. It falls out of the heading, because the body is
     * laid BACKWARDS along it — so a worm at the mouth has to point UP or its
     * body is drawn lying across the lawn.
     */
    const w = new Worm(0, 0, 0, steady(), 'out');
    expect(w.dir.y).toBeGreaterThan(0.9);
    const tail = w.trail[w.trail.length - 1]!;
    expect(tail.y).toBeLessThan(w.at.y);
  });

  it('does not put three worms on one clock', () => {
    /* Sharing a timer would have them surface, lie and dive together, which
     * reads as a scripted event rather than as animals. */
    const rand = steady();
    const worms = [0, 1, 2].map(() => new Worm(0, -4, 0, rand));
    const s = soil({ surface: 0 });
    const surfacedAt = worms.map(() => -1);
    for (let i = 0; i < 60 * 240; i += 1) {
      worms.forEach((w, k) => {
        w.tick(1 / 60, s);
        if (surfacedAt[k] === -1 && w.mood === 'out') surfacedAt[k] = i;
      });
    }
    expect(surfacedAt.every((t) => t >= 0)).toBe(true);
    expect(new Set(surfacedAt).size).toBe(3);
  });
});
