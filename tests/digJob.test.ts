import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DigJob, SWEEP_STEP_R, digDurationS } from '../src/scenes/digJob';
import { DIG_BEAT_S, DIG_RATE_MM3_S } from '../src/scenes/islandTuning';
import { MM } from '../src/world/worldScape';

/*
 * JOSHUA'S FORMULA, PINNED: seconds = cylinder volume / rate, rounded UP
 * to a whole second — his own worked example was "143/30=4.767 seconds",
 * which rounds to 5. The duration is also the cooldown, so getting this
 * wrong is getting the whole pace of excavation wrong.
 */
describe('how long a bore takes', () => {
  it('matches the worked example: the queen bore rounds 4.77 up to 5', () => {
    /* Her real numbers: 4.5 mm diameter (3.0 height x 1.5), 9 mm long. */
    const r = 2.25 / MM;
    const l = 9 / MM;
    const vol = Math.PI * 2.25 * 2.25 * 9;
    expect(vol / DIG_RATE_MM3_S).toBeGreaterThan(4);
    expect(vol / DIG_RATE_MM3_S).toBeLessThan(5);
    expect(digDurationS(r, l)).toBe(5);
  });

  it('never goes under a second, however small the ant', () => {
    expect(digDurationS(0.5 / MM, 1 / MM)).toBe(1);
  });
});

describe('the chip-away schedule', () => {
  const job = () => new DigJob(
    new THREE.Vector3(10, 5, 10), new THREE.Vector3(0, 0, 1), 9 / MM, 2.25 / MM,
  );

  it('answers the press at once — beat zero fires on the first tick', () => {
    const j = job();
    const first = j.tick(0);
    expect(first.length).toBeGreaterThan(0);
    /* And it opens the MOUTH: the first sphere sits at the origin. */
    expect(first[0]!.distanceTo(new THREE.Vector3(10, 5, 10))).toBeLessThan(1e-9);
  });

  it('finishes in exactly its own duration, and is then done', () => {
    const j = job();
    let spheres = 0;
    for (let t = 0; t < j.durationS + 0.01; t += 1 / 60) spheres += j.tick(1 / 60).length;
    expect(j.done).toBe(true);
    expect(spheres).toBeGreaterThan(0);
    expect(j.tick(1).length).toBe(0);
  });

  it('covers the whole cylinder with no gap wider than the overlap rule', () => {
    /* The popcorn was tangent spheres. The sweep must never place two
     * consecutive spheres further apart than SWEEP_STEP_R radii, and the
     * last one must reach the far end — a bore that stops short leaves a
     * wall at the face she paid for. */
    const j = job();
    const along: number[] = [];
    for (let t = 0; t < j.durationS + 0.01; t += 1 / 60) {
      for (const p of j.tick(1 / 60)) along.push(p.z - 10);
    }
    along.sort((a, b) => a - b);
    expect(along[0]).toBeCloseTo(0, 9);
    expect(along[along.length - 1]).toBeCloseTo(9 / MM, 9);
    for (let i = 1; i < along.length; i += 1) {
      expect(along[i]! - along[i - 1]!).toBeLessThanOrEqual(j.radiusWu * SWEEP_STEP_R + 1e-9);
    }
  });

  it('beats land on the beat, not on the frame rate', () => {
    /* Stepped at a weird cadence, the number of beats that have fired by
     * time T is still floor(T / beat) + 1 — the schedule belongs to the
     * clock, so slow SwiftShader frames chip in bursts rather than
     * stretching the dig. */
    const j = job();
    j.tick(0);
    const mid = j.progress;
    j.tick(j.durationS / 2);
    expect(j.progress).toBeGreaterThan(mid);
    expect(j.progress).toBeGreaterThanOrEqual(0.5 - 1e-9);
    expect(j.done).toBe(false);
    j.tick(j.durationS);
    expect(j.done).toBe(true);
  });

  it('half the queen bore is about ten beats at the half-second', () => {
    const j = job();
    expect(j.durationS).toBe(5);
    /* 5 s at 0.5 s a beat = 10 chips — the granularity Joshua asked the
     * rounding FOR ("so the animation can work maybe every 0.5s"). */
    expect(Math.round(j.durationS / DIG_BEAT_S)).toBe(10);
  });
});
