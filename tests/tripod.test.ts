/**
 * The walk, checked as a walk.
 *
 * Every one of these is a property the clock-driven gait could not state, let
 * alone hold: a stance foot's ground speed, the number of feet down at any
 * instant, and whether a stride is a function of distance rather than of time.
 * The old gait skated, and the reason it was allowed to is that nothing here
 * existed to notice.
 */

import { describe, it, expect } from 'vitest';
import {
  STEP_YAW, SWING_SECONDS, TRIPOD_A, TRIPOD_B, TripodGait, tripodOf, type Leg, type Stride,
} from '../src/anim/tripod';

/* Six legs on a body a little longer than it is wide, roughly the queen's. */
const LEGS: Leg[] = [
  { slot: 'frontLeft', home: [-0.8, -1, 0.7], reach: 1 },
  { slot: 'frontRight', home: [0.8, -1, 0.7], reach: 1 },
  { slot: 'midLeft', home: [-0.9, -1, 0], reach: 1 },
  { slot: 'midRight', home: [0.9, -1, 0], reach: 1 },
  { slot: 'rearLeft', home: [-0.8, -1, -0.7], reach: 1 },
  { slot: 'rearRight', home: [0.8, -1, -0.7], reach: 1 },
];

const FLAT = () => 0;
const at = (z: number, speed = 2, heading = 0): Stride =>
  ({ position: [0, 1, z], heading, speed });

/** Walk her forward, sampling every frame. */
function walk(gait: TripodGait, seconds: number, speed = 2, dt = 1 / 60) {
  const frames = [];
  let z = 0;
  for (let i = 0; i < Math.round(seconds / dt); i += 1) {
    z += speed * dt;
    frames.push(gait.step(dt, at(z, speed), FLAT));
  }
  return frames;
}

describe('the tripods', () => {
  it('steps front and rear of one side with the middle of the other', () => {
    // 1/4/5 and 2/3/6, which is what makes the standing triangle contain her.
    expect([...TRIPOD_A]).toEqual(['frontLeft', 'midRight', 'rearLeft']);
    expect([...TRIPOD_B]).toEqual(['frontRight', 'midLeft', 'rearRight']);
    for (const slot of TRIPOD_A) expect(tripodOf(slot)).toBe(0);
    for (const slot of TRIPOD_B) expect(tripodOf(slot)).toBe(1);
  });

  it('never lifts two legs that are next to each other on the same side', () => {
    const gait = new TripodGait(LEGS);
    for (const frame of walk(gait, 6)) {
      const up = frame.filter((l) => l.swinging).map((l) => l.slot);
      if (up.length === 0) continue;
      // Everything in the air belongs to ONE tripod, always.
      const sides = new Set(up.map((slot) => tripodOf(slot)));
      expect(sides.size, `lifted ${up.join(',')} together`).toBe(1);
    }
  });

  it('always keeps at least three feet on the ground', () => {
    const gait = new TripodGait(LEGS);
    let worst = 6;
    for (const frame of walk(gait, 6)) {
      worst = Math.min(worst, frame.filter((l) => !l.swinging).length);
    }
    /*
     * Three, never two. A tripod stepping while the other is still in the air
     * is a hop, and it is the failure the ordering inside `step` exists to
     * prevent — swings are finished before a new one is considered.
     */
    expect(worst).toBe(3);
  });
});

describe('a planted foot', () => {
  /*
   * THE test. A stance foot's ground speed is zero — not small, zero — because
   * its target is a world position that nothing writes to while it is down.
   * The reported fault was "sliding on ice"; this is the property whose absence
   * that described.
   */
  it('does not move at all while it is down', () => {
    const gait = new TripodGait(LEGS);
    const frames = walk(gait, 6);
    const previous = new Map<string, [number, number, number]>();
    const wasSwinging = new Map<string, boolean>();
    let checked = 0;

    for (const frame of frames) {
      for (const leg of frame) {
        const last = previous.get(leg.slot);
        // Only compare frames where the foot was down for BOTH of them: the
        // frame it lands on legitimately moves.
        if (last && !leg.swinging && wasSwinging.get(leg.slot) === false) {
          const moved = Math.hypot(
            leg.target[0] - last[0], leg.target[1] - last[1], leg.target[2] - last[2],
          );
          expect(moved, `${leg.slot} slid`).toBe(0);
          checked += 1;
        }
        previous.set(leg.slot, [...leg.target] as [number, number, number]);
        wasSwinging.set(leg.slot, leg.swinging);
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('is put down on the ground, not at the body height', () => {
    const gait = new TripodGait(LEGS);
    const hill = (x: number, z: number) => Math.sin(x) * 0.1 + z * 0.05;
    let z = 0;
    for (let i = 0; i < 300; i += 1) {
      z += 2 / 60;
      for (const leg of gait.step(1 / 60, at(z), hill)) {
        if (leg.swinging) continue;
        expect(leg.target[1]).toBeCloseTo(hill(leg.target[0], leg.target[2]), 9);
      }
    }
  });
});

describe('the stride', () => {
  /*
   * Steps are a function of DISTANCE, not of time — the property the whole
   * rewrite is for. Walk the same ground at two different speeds and she takes
   * the same number of steps; the old gait took twice as many at twice the
   * speed only if its cadence constant happened to be tuned for it, and took
   * wildly wrong numbers during any acceleration.
   */
  it('takes the same number of steps over the same ground at any speed', () => {
    /*
     * Counted on ONE leg, not on "is anything swinging". At a run the tripods
     * hand over with barely a gap, so "anything swinging" is true almost
     * continuously and counts one enormous step — which is what it did, and it
     * hid a real fault behind a measurement artefact. A single leg leaving the
     * ground is unambiguous.
     */
    const count = (speed: number) => {
      const gait = new TripodGait(LEGS);
      const dt = 1 / 240;
      let z = 0;
      let steps = 0;
      let up = false;
      while (z < 20) {
        z += speed * dt;
        const leg = gait.step(dt, at(z, speed), FLAT)
          .find((l) => l.slot === 'frontLeft')!;
        if (leg.swinging && !up) steps += 1;
        up = leg.swinging;
      }
      return steps;
    };
    const slow = count(1);
    const fast = count(4);
    expect(slow).toBeGreaterThan(4);
    /*
     * Four times the speed over the same ground. A clock-driven gait takes four
     * times the steps — that is what it means for the legs to be a function of
     * time — so the number to beat is 4x, and anything near 1x is a gait
     * measuring distance.
     *
     * Not exactly 1x, and the residue is honest rather than slop: a tripod may
     * not lift until the other has landed, so at a run it overshoots its
     * trigger by however far she travels during a swing and the stride comes
     * out a little longer. Real animals lengthen their stride with speed for
     * the same reason. What matters is that the count does not SCALE with
     * speed.
     */
    const ratio = fast / slow;
    expect(ratio, `${slow} steps at speed 1, ${fast} at speed 4`).toBeGreaterThan(0.6);
    expect(ratio, `${slow} steps at speed 1, ${fast} at speed 4`).toBeLessThan(1.4);
  });

  it('sweeps symmetrically about the shoulder rather than creeping backwards', () => {
    const gait = new TripodGait(LEGS);
    const frames = walk(gait, 10);
    // The foot's offset from the body, along her heading, over the whole walk.
    let ahead = -Infinity;
    let behind = Infinity;
    let z = 0;
    for (let i = 0; i < frames.length; i += 1) {
      z += 2 / 60;
      const leg = frames[i]!.find((l) => l.slot === 'frontLeft')!;
      if (leg.swinging) continue;
      const home = 0.7 + z;
      ahead = Math.max(ahead, leg.target[2] - home);
      behind = Math.min(behind, leg.target[2] - home);
    }
    const reach = Math.sin(STEP_YAW);
    expect(ahead).toBeLessThanOrEqual(reach + 1e-9);
    expect(behind).toBeGreaterThanOrEqual(-reach - 1e-9);
    // Symmetric to within a frame of travel, so it is a sweep and not a drift.
    expect(Math.abs(ahead + behind)).toBeLessThan(reach * 0.35);
  });

  /*
   * Surfacing from a burrow. The stepper is off underground, so it restarts
   * with anchors from wherever it last ran — which can be a long way from where
   * she now is. She came out of a hole with her legs stretched behind her like
   * a landed spider, and none of the normal rules covered it: they all assume
   * the anchor drifts back gradually and trips the trigger while still in
   * range.
   */
  it('recovers when she arrives somewhere her feet are not', () => {
    const gait = new TripodGait(LEGS);
    walk(gait, 2);
    // Teleport: eight body lengths on, as if she had just climbed out.
    let z = 40;
    const frames = [];
    for (let i = 0; i < 120; i += 1) {
      z += 2 / 60;
      frames.push(gait.step(1 / 60, at(z), FLAT));
    }
    // Within a couple of step cycles every foot is back under her.
    const settled = frames[frames.length - 1]!;
    for (const leg of settled) {
      const home = LEGS.find((l) => l.slot === leg.slot)!;
      const span = Math.hypot(leg.target[0] - home.home[0], leg.target[2] - (z + home.home[2]));
      expect(span, `${leg.slot} left behind`).toBeLessThan(home.reach);
    }
  });

  it('does not step at all when she is standing still', () => {
    const gait = new TripodGait(LEGS);
    gait.reset(at(0, 0), FLAT);
    for (let i = 0; i < 600; i += 1) {
      const frame = gait.step(1 / 60, at(0, 0), FLAT);
      expect(frame.every((l) => !l.swinging)).toBe(true);
    }
  });

  /*
   * Frame rate must not change the walk. A swing measured in frames rather than
   * seconds looks right at 60 and doubles at 120, and the phone and the
   * headless renderer are nowhere near each other.
   */
  it('walks the same at any frame rate', () => {
    const steps = (dt: number) => {
      const gait = new TripodGait(LEGS);
      let z = 0;
      let count = 0;
      let up = false;
      while (z < 20) {
        z += 2 * dt;
        const swinging = gait.step(dt, at(z), FLAT).some((l) => l.swinging);
        if (swinging && !up) count += 1;
        up = swinging;
      }
      return count;
    };
    const base = steps(1 / 60);
    for (const dt of [1 / 120, 1 / 30, 1 / 20]) {
      expect(Math.abs(steps(dt) - base), `at ${Math.round(1 / dt)} fps`).toBeLessThanOrEqual(1);
    }
    expect(SWING_SECONDS).toBeGreaterThan(0);
  });
});
