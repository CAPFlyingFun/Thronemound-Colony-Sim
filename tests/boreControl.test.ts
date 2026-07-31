/**
 * Driving the dig as a bore, not as a mouse click.
 *
 * The model this checks is the one the control scheme was specified in: set a
 * pitch, toggle the dig ON, and the joystick moves you along that pitch. Every
 * clause of that had a bug in the version before it, and each failed quietly —
 * a dig that moves you on its own looks like a control you did not press, a
 * yaw with the wrong sign looks like a game that ignores you, and pitch that
 * steers only the bite looks like a shallow trench with the gauge reading
 * minus seventy-seven.
 */

import { describe, it, expect } from 'vitest';
import {
  BoreRig, DIG_YAW_RATE, PITCH_MAX, PITCH_MIN, PITCH_STEP, STROKE_SECONDS, YAW_RATE, dipAt,
} from '../src/scenes/BoreControl';

const HOLD = { yaw: 0, forward: 0 };
const AHEAD = { yaw: 0, forward: 1 };
const BACK = { yaw: 0, forward: -1 };

function run(rig: BoreRig, seconds: number, input = AHEAD, dt = 1 / 60) {
  let bites = 0;
  let maxDip = 0;
  for (let i = 0; i < Math.round(seconds / dt); i += 1) {
    const step = rig.step(dt, input);
    if (step.bite) bites += 1;
    maxDip = Math.max(maxDip, step.dip);
  }
  return { bites, maxDip };
}

describe('the dig toggle', () => {
  /*
   * The reported fault, in one test: "it moved when it wasn't supposed to".
   * The dig used to creep her forward on its own so a tunnel would form, which
   * is a reasonable thing to want and not what was asked for — the joystick is
   * the only thing that moves her.
   */
  it('does nothing at all on its own', () => {
    const rig = new BoreRig();
    rig.toggleDig();
    expect(rig.digging).toBe(true);
    const { bites, maxDip } = run(rig, 4, HOLD);
    expect(bites).toBe(0);
    expect(maxDip).toBe(0);
  });

  it('latches on and off rather than needing to be held', () => {
    const rig = new BoreRig();
    expect(rig.digging).toBe(false);
    rig.toggleDig();
    expect(run(rig, 3).bites).toBeGreaterThan(3);
    rig.toggleDig();
    expect(rig.digging).toBe(false);
    expect(run(rig, 3).bites).toBe(0);
  });

  it('does not dig while reversing back up its own tunnel', () => {
    const rig = new BoreRig();
    rig.toggleDig();
    expect(run(rig, 4, BACK).bites).toBe(0);
  });

  /*
   * Bites are a function of TIME, not of frames — a bite fired every Nth frame
   * passes perfectly at 60 and doubles at 120, and the phone and the headless
   * renderer are nowhere near each other.
   */
  it('bites at the same rate however fast the frames come', () => {
    const expected = Math.floor(4 / STROKE_SECONDS);
    for (const dt of [1 / 120, 1 / 60, 1 / 30, 1 / 10, 1 / 4]) {
      const rig = new BoreRig();
      rig.toggleDig();
      const { bites } = run(rig, 4, AHEAD, dt);
      expect(Math.abs(bites - expected), `at ${Math.round(1 / dt)} fps`).toBeLessThanOrEqual(1);
    }
  });
});

describe('aiming', () => {
  it('steps in ten-degree increments between level and straight down', () => {
    const rig = new BoreRig();
    expect(rig.pitch).toBe(0);

    rig.aim(-1);
    expect(rig.pitch * 180 / Math.PI).toBeCloseTo(-10, 9);
    rig.aim(-3);
    expect(rig.pitch * 180 / Math.PI).toBeCloseTo(-40, 9);
    rig.aim(2);
    expect(rig.pitch * 180 / Math.PI).toBeCloseTo(-20, 9);

    // Level is the ceiling: there is no boring into your own roof.
    for (let i = 0; i < 20; i += 1) rig.aim(1);
    expect(rig.pitch).toBe(PITCH_MAX);
    expect(PITCH_MAX).toBe(0);

    // Straight down is the floor, and reachable — a shaft is a normal thing.
    for (let i = 0; i < 20; i += 1) rig.aim(-1);
    expect(rig.pitch).toBeCloseTo(PITCH_MIN, 9);
    expect(PITCH_MIN * 180 / Math.PI).toBeCloseTo(-90, 9);
    expect(Math.round(PITCH_MIN / PITCH_STEP)).toBe(-9);
  });
});

describe('steering', () => {
  /*
   * Ten degrees a second while digging against eighty-six above ground. A bore
   * is a committed shape; the reason this is a separate rate rather than the
   * same one is that the same stick doing the same thing at the same speed in
   * both modes makes a tunnel impossible to place.
   */
  it('turns far more slowly while digging', () => {
    const above = new BoreRig();
    run(above, 1, { yaw: 1, forward: 1 });
    expect(above.heading).toBeCloseTo(YAW_RATE, 2);

    const below = new BoreRig();
    below.toggleDig();
    run(below, 1, { yaw: 1, forward: 1 });
    expect(below.heading).toBeCloseTo(DIG_YAW_RATE, 2);
    expect(DIG_YAW_RATE * 180 / Math.PI).toBeCloseTo(10, 6);
  });

  it('cannot steer a tunnel except while advancing along it', () => {
    for (const input of [{ yaw: 1, forward: 0 }, { yaw: 1, forward: -1 }]) {
      const rig = new BoreRig();
      rig.toggleDig();
      run(rig, 2, input);
      expect(rig.heading).toBe(0);
    }
  });

  it('keeps the heading in range however long it is spun', () => {
    const rig = new BoreRig();
    run(rig, 100, { yaw: 1, forward: 1 });
    expect(Math.abs(rig.heading)).toBeLessThanOrEqual(Math.PI + 1e-9);
  });
});

describe('the stroke', () => {
  it('finishes once begun, even after the joystick is released', () => {
    const rig = new BoreRig();
    rig.toggleDig();
    rig.step(1 / 60, AHEAD);
    let bites = 0;
    for (let i = 0; i < 60; i += 1) if (rig.step(1 / 60, HOLD).bite) bites += 1;
    expect(bites).toBe(1);
    expect(rig.striking).toBe(false);
  });

  it('dips deepest exactly where the bite lands', () => {
    expect(dipAt(0)).toBe(0);
    expect(dipAt(1)).toBe(0);

    let peak = 0;
    let peakAt = 0;
    for (let t = 0; t <= 1; t += 0.001) {
      if (dipAt(t) > peak) { peak = dipAt(t); peakAt = t; }
    }
    expect(peak).toBeCloseTo(1, 6);
    // The scrape is quick and dragging the load out is not, so the peak sits
    // past the middle of the stroke.
    expect(peakAt).toBeGreaterThan(0.5);

    const rig = new BoreRig();
    rig.toggleDig();
    let biteAt = -1;
    for (let i = 0; i < 400; i += 1) {
      const step = rig.step(1 / 600, AHEAD);
      if (step.bite) { biteAt = step.stroke; break; }
    }
    expect(biteAt).toBeGreaterThan(0);
    expect(Math.abs(biteAt - peakAt)).toBeLessThan(0.02);
  });
});
