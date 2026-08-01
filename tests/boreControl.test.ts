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

const IDLE = { yaw: 0, forward: 0, dig: false };
const DIG = { yaw: 0, forward: 0, dig: true };

function run(rig: BoreRig, seconds: number, input = DIG, dt = 1 / 60) {
  let bites = 0;
  let maxDip = 0;
  for (let i = 0; i < Math.round(seconds / dt); i += 1) {
    const step = rig.step(dt, input);
    if (step.bite) bites += 1;
    maxDip = Math.max(maxDip, step.dip);
  }
  return { bites, maxDip };
}

describe('the dig button', () => {
  /*
   * The button IS the drive now — held is dug, released is stopped. This is
   * the second specification of this control, made after playing both: the
   * latch was asked for, built, and then the dig room's press-to-dig played
   * better and won. These tests state the CURRENT spec so the next reversal
   * is a decision with a diff, not a drift.
   */
  it('digs for exactly as long as it is held', () => {
    const rig = new BoreRig();
    expect(rig.digging).toBe(false);
    expect(run(rig, 3, DIG).bites).toBeGreaterThan(3);
    expect(rig.digging).toBe(true);
    // At most the stroke already in flight lands — one begun always finishes,
    // so releasing mid-lunge does not swallow the bite it was about to take —
    // and after that the head is at rest.
    expect(run(rig, 3, IDLE).bites).toBeLessThanOrEqual(1);
    expect(rig.striking).toBe(false);
    expect(rig.digging).toBe(false);
  });

  it('does nothing while only the pad is pushed', () => {
    // Walking is walking. The pad must never cut soil on its own — that is
    // the whole of "press dig to actually dig and not forward to dig".
    const rig = new BoreRig();
    const { bites, maxDip } = run(rig, 4, { yaw: 0, forward: 1, dig: false });
    expect(bites).toBe(0);
    expect(maxDip).toBe(0);
  });

  it('bites at the same rate however fast the frames come', () => {
    const rig = new BoreRig();
    const slow = run(rig, 6, DIG, 1 / 30).bites;
    const fast = run(new BoreRig(), 6, DIG, 1 / 144).bites;
    expect(Math.abs(slow - fast)).toBeLessThanOrEqual(1);
  });
});

describe('aiming', () => {
  it('steps in ten-degree increments between straight up and straight down', () => {
    const rig = new BoreRig();
    expect(rig.pitch).toBe(0);

    rig.aim(-1);
    expect(rig.pitch * 180 / Math.PI).toBeCloseTo(-10, 9);
    rig.aim(-3);
    expect(rig.pitch * 180 / Math.PI).toBeCloseTo(-40, 9);
    rig.aim(2);
    expect(rig.pitch * 180 / Math.PI).toBeCloseTo(-20, 9);

    /*
     * Straight UP is the ceiling, not level. Level was the old limit and it
     * trapped you: at the bottom of a shaft the only aims on offer were level
     * and further down, so there was no way back to the surface. Anything that
     * can dig itself in has to be able to dig itself out.
     */
    for (let i = 0; i < 30; i += 1) rig.aim(1);
    expect(rig.pitch).toBeCloseTo(PITCH_MAX, 9);
    expect(PITCH_MAX * 180 / Math.PI).toBeCloseTo(90, 9);
    expect(Math.round(PITCH_MAX / PITCH_STEP)).toBe(9);

    // Straight down is the floor, and reachable — a shaft is a normal thing.
    for (let i = 0; i < 20; i += 1) rig.aim(-1);
    expect(rig.pitch).toBeCloseTo(PITCH_MIN, 9);
    expect(PITCH_MIN * 180 / Math.PI).toBeCloseTo(-90, 9);
    expect(Math.round(PITCH_MIN / PITCH_STEP)).toBe(-9);
  });
});

describe('steering', () => {
  /*
   * Ten degrees a second while the dig is held against eighty-six walking. A
   * bore is a committed shape; the same stick at the same speed in both modes
   * makes a tunnel impossible to place.
   */
  it('turns far more slowly while the dig is held', () => {
    const above = new BoreRig();
    run(above, 1, { yaw: 1, forward: 1, dig: false });
    expect(above.heading).toBeCloseTo(YAW_RATE, 2);

    const below = new BoreRig();
    run(below, 1, { yaw: 1, forward: 0, dig: true });
    expect(below.heading).toBeCloseTo(DIG_YAW_RATE, 2);
    expect(DIG_YAW_RATE * 180 / Math.PI).toBeCloseTo(10, 6);
  });

  it('keeps the heading in range however long it is spun', () => {
    const rig = new BoreRig();
    run(rig, 100, { yaw: 1, forward: 1, dig: false });
    expect(Math.abs(rig.heading)).toBeLessThanOrEqual(Math.PI + 1e-9);
  });
});

describe('the aim follows the look', () => {
  it('aims continuously and clamps to the poles', () => {
    const rig = new BoreRig();
    rig.aimTo(-0.7);
    expect(rig.pitch).toBeCloseTo(-0.7, 9);
    rig.aimTo(-9);
    expect(rig.pitch).toBeCloseTo(PITCH_MIN, 9);
    rig.aimTo(9);
    expect(rig.pitch).toBeCloseTo(PITCH_MAX, 9);
  });
});

describe('the stroke', () => {
  it('finishes once begun, even after the button is released', () => {
    const rig = new BoreRig();
    rig.step(1 / 60, DIG);
    let bites = 0;
    for (let i = 0; i < 60; i += 1) if (rig.step(1 / 60, IDLE).bite) bites += 1;
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
    let biteAt = -1;
    for (let i = 0; i < 400; i += 1) {
      const step = rig.step(1 / 600, DIG);
      if (step.bite) { biteAt = step.stroke; break; }
    }
    expect(biteAt).toBeGreaterThan(0);
    expect(Math.abs(biteAt - peakAt)).toBeLessThan(0.02);
  });
});
