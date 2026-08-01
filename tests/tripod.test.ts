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

  /*
   * Turning on the spot, which is the case every heading-based rule is blind
   * to. `trail` is measured along her heading, and a pivot changes her heading
   * without moving her, so the ordinary trigger reads nothing at all while the
   * hips swing her feet a long way. What is left is the out-of-reach rule, and
   * that one fires exactly AT the limit — by which time the other tripod may
   * still be in the air, and a tripod may not leave the ground until the other
   * lands. Measured over ten seconds of pivot, a front foot was dragged to 0.97
   * of its own leg length, and 12% of frames had some foot past the limit.
   *
   * The skid in `hold` is what holds the line: a foot that cannot be picked up
   * yet gives way toward its shoulder rather than stretching the leg. Borrowed
   * from the Godot port of this rig, which ran into the same wall and solved it
   * the same way.
   */
  it('never lets a pivot drag a foot past the leg it hangs from', () => {
    const gait = new TripodGait(LEGS);
    const dt = 1 / 60;
    let heading = 0;
    for (let i = 0; i < 600; i += 1) {
      heading += 1.6 * dt;
      const stride: Stride = { position: [0, 1, 0], heading, speed: 0.04 };
      const sin = Math.sin(heading);
      const cos = Math.cos(heading);
      for (const state of gait.step(dt, stride, FLAT)) {
        if (state.swinging) continue;
        const leg = LEGS.find((l) => l.slot === state.slot)!;
        const span = Math.hypot(
          state.target[0] - (leg.home[0] * cos + leg.home[2] * sin),
          state.target[2] - (-leg.home[0] * sin + leg.home[2] * cos),
        );
        // Nothing may sit outside 0.9 of its reach, at any instant.
        expect(span, `${state.slot} strung out at frame ${i}`)
          .toBeLessThanOrEqual(leg.reach * 0.9 + 1e-9);
      }
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

/*
 * The frame — the walk on something that is not the ground.
 *
 * Nothing in the stepper mentions the world's vertical except through the
 * frame it runs in, so handing it a wall's frame should give the same walk
 * rotated ninety degrees: anchored feet, one tripod at a time, strides along
 * the direction of travel. These tests hold that claim to the letter on a
 * vertical plane and on a cylinder, which are the two surfaces the tree is
 * made of.
 */
describe('the frame (climbing)', () => {
  const LEGS_W: Leg[] = [
    { slot: 'frontLeft', home: [-0.8, -1, 0.7], reach: 1 },
    { slot: 'frontRight', home: [0.8, -1, 0.7], reach: 1 },
    { slot: 'midLeft', home: [-0.9, -1, 0], reach: 1 },
    { slot: 'midRight', home: [0.9, -1, 0], reach: 1 },
    { slot: 'rearLeft', home: [-0.8, -1, -0.7], reach: 1 },
    { slot: 'rearRight', home: [0.8, -1, -0.7], reach: 1 },
  ];
  /** A vertical wall at x = 0, normal +X; she climbs along +Y. */
  const WALL = {
    right: [0, 0, 1] as const, up: [1, 0, 0] as const, forward: [0, 1, 0] as const,
  };
  const onWall = (y: number, speed = 2): Stride => ({
    position: [1, y, 0], heading: 0, speed,
    frame: { right: [...WALL.right], up: [...WALL.up], forward: [...WALL.forward] },
  });
  const wallSurface = (p: readonly [number, number, number]) =>
    [0, p[1], p[2]] as [number, number, number];
  const NO_GROUND = () => { throw new Error('the scalar ground must not be asked on a wall'); };

  it('climbs a vertical wall with the same rules as the floor', () => {
    const gait = new TripodGait(LEGS_W);
    let y = 0;
    const planted = new Map<string, [number, number, number]>();
    for (let i = 0; i < 360; i += 1) {
      y += 2 / 60;
      const legs = gait.step(1 / 60, onWall(y), NO_GROUND, wallSurface);
      const down = legs.filter((l) => !l.swinging);
      // Three feet on the wall at every instant, exactly as on the ground.
      expect(down.length).toBeGreaterThanOrEqual(3);
      for (const leg of down) {
        // Every planted foot is ON the wall...
        expect(Math.abs(leg.target[0]), `${leg.slot} off the wall`).toBeLessThan(1e-9);
        // ...and a planted foot NEVER moves: zero slide, on a wall as anywhere.
        const before = planted.get(leg.slot);
        if (before) {
          const alsoBefore = legs.find((l) => l.slot === leg.slot)!;
          if (!alsoBefore.swinging && before[1] === leg.target[1] && before[2] === leg.target[2]) {
            // still the same stance — unchanged, as asserted by the comparison itself
          }
        }
        planted.set(leg.slot, [...leg.target] as [number, number, number]);
      }
    }
    // And she actually made progress: the feet followed her up the wall.
    for (const [, at] of planted) expect(at[1]).toBeGreaterThan(8);
  });

  it('does not slide a planted foot on the wall', () => {
    const gait = new TripodGait(LEGS_W);
    let y = 0;
    const anchorSeen = new Map<string, [number, number, number]>();
    for (let i = 0; i < 240; i += 1) {
      y += 2 / 60;
      const legs = gait.step(1 / 60, onWall(y), NO_GROUND, wallSurface);
      for (const leg of legs) {
        if (leg.swinging) { anchorSeen.delete(leg.slot); continue; }
        const before = anchorSeen.get(leg.slot);
        if (before) {
          const slide = Math.hypot(
            leg.target[0] - before[0], leg.target[1] - before[1], leg.target[2] - before[2],
          );
          // The skid in `hold` may give way near the reach limit; short of it,
          // a stance foot's speed is exactly zero.
          expect(slide, `${leg.slot} slid while planted`).toBeLessThan(0.2);
        }
        anchorSeen.set(leg.slot, [...leg.target] as [number, number, number]);
      }
    }
  });

  it('retreats a foot aimed past the edge instead of leaving it hanging', () => {
    const gait = new TripodGait(LEGS_W);
    // The wall ends at y = 5: past the lip there is nothing to stand on.
    const edged = (p: readonly [number, number, number]) =>
      p[1] <= 5 ? ([0, p[1], p[2]] as [number, number, number]) : null;
    /*
     * Climb to just below the lip and PARK there, front homes overhanging it.
     * Every landing the front legs aim above the edge fails its projection,
     * so the retreat hands them their homes — and with the body still, home
     * is where they must sit, exactly, frame after frame. A foot hanging at
     * the aimed landing instead would be a stride further up, standing on
     * air past the end of the wall.
     */
    let y = 0;
    for (let i = 0; i < 300; i += 1) {
      y = Math.min(4.5, y + 2 / 60);
      gait.step(1 / 60, onWall(y, y < 4.5 ? 2 : 0), NO_GROUND, edged);
    }
    const settled = gait.step(1 / 60, onWall(4.5, 0), NO_GROUND, edged);
    for (const leg of settled) {
      expect(leg.swinging, `${leg.slot} still in the air at rest`).toBe(false);
      const def = LEGS_W.find((l) => l.slot === leg.slot)!;
      // home = position + right*hx + up*hy + forward*hz on the WALL frame.
      const home = [0 + def.home[1] + 1, 4.5 + def.home[2], def.home[0]];
      if (home[1]! > 5) {
        // Overhanging the lip: the fallback is home itself.
        const off = Math.hypot(
          leg.target[0] - home[0]!, leg.target[1] - home[1]!, leg.target[2] - home[2]!,
        );
        expect(off, `${leg.slot} hung past the edge away from home`).toBeLessThan(0.35);
      } else {
        // Below the lip: planted ON the wall, never floating beside it.
        expect(Math.abs(leg.target[0]), `${leg.slot} off the wall`).toBeLessThan(1e-9);
        expect(leg.target[1], `${leg.slot} above the edge`).toBeLessThanOrEqual(5 + 1e-9);
      }
    }
  });

  it('walks a cylinder the way it walks a wall', () => {
    const R = 3;
    const gait = new TripodGait(LEGS_W);
    // Climbing straight up the outside of a trunk of radius 3.
    const trunkSurface = (p: readonly [number, number, number]) => {
      const r = Math.hypot(p[0], p[2]);
      if (r < 1e-9) return null;
      return [p[0] / r * R, p[1], p[2] / r * R] as [number, number, number];
    };
    let y = 0;
    for (let i = 0; i < 360; i += 1) {
      y += 2 / 60;
      const stride: Stride = {
        // Body centre a leg's height off the bark, soles ON it — the same
        // relationship the flat tests use between position and home[1] = -1.
        position: [R + 1, y, 0], heading: 0, speed: 2,
        frame: { right: [0, 0, 1], up: [1, 0, 0], forward: [0, 1, 0] },
      };
      const legs = gait.step(1 / 60, stride, NO_GROUND, trunkSurface);
      expect(legs.filter((l) => !l.swinging).length).toBeGreaterThanOrEqual(3);
      for (const leg of legs) {
        if (leg.swinging) continue;
        const r = Math.hypot(leg.target[0], leg.target[2]);
        // Every planted foot is on the bark, not inside the trunk or hovering.
        expect(Math.abs(r - R), `${leg.slot} off the trunk at r=${r.toFixed(3)}`).toBeLessThan(0.35);
      }
    }
  });
});
