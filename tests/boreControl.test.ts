/**
 * Driving the dig like a bore, not like a mouse click.
 *
 * The state machine is small and its failures are all quiet ones: a stroke
 * that fires twice looks like a fast ant, a stroke that fires zero times looks
 * like a missed tap, and neither says anything in a log. So the count is
 * asserted directly, at frame rates that differ by a factor of thirty, because
 * "how many bites per second" must not depend on how well the phone is
 * rendering.
 */

import { describe, it, expect } from 'vitest';
import {
  BoreRig, PITCH_MAX, PITCH_MIN, STROKE_SECONDS, dipAt,
} from '../src/scenes/BoreControl';

/** Run the rig for a while and report what happened. */
function drive(seconds: number, dt: number, input = { yaw: 0, pitch: 0, boring: true }) {
  const rig = new BoreRig();
  let bites = 0;
  let maxDip = 0;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i += 1) {
    const step = rig.step(dt, input);
    if (step.bite) bites += 1;
    maxDip = Math.max(maxDip, step.dip);
  }
  return { bites, maxDip, rig };
}

describe('the boring rig', () => {
  /*
   * The property that matters most, and the one a naive implementation gets
   * wrong: bites are a function of TIME, not of frames. Testing at a single
   * frame rate cannot see the difference — a bite fired every Nth frame passes
   * perfectly at 60 and doubles at 120.
   */
  it('bites at the same rate however fast the frames come', () => {
    const expected = Math.floor(4 / STROKE_SECONDS);
    for (const dt of [1 / 120, 1 / 60, 1 / 30, 1 / 10, 1 / 4]) {
      const { bites } = drive(4, dt);
      expect(Math.abs(bites - expected), `at ${Math.round(1 / dt)} fps`).toBeLessThanOrEqual(1);
    }
  });

  it('does not bite at all until the control is held', () => {
    const { bites, maxDip } = drive(3, 1 / 60, { yaw: 0, pitch: 0, boring: false });
    expect(bites).toBe(0);
    expect(maxDip).toBe(0);
  });

  /*
   * A stroke that has begun finishes. Otherwise letting go snaps the head back
   * from mid-lunge, and a tap released before the strike removes nothing while
   * looking exactly like a dig — the kind of miss a player blames on the game
   * rather than on their thumb.
   */
  it('finishes a stroke that has started, even after the control is let go', () => {
    const rig = new BoreRig();
    // One frame of holding is enough to commit to a stroke.
    rig.step(1 / 60, { yaw: 0, pitch: 0, boring: true });
    let bites = 0;
    for (let i = 0; i < 60; i += 1) {
      if (rig.step(1 / 60, { yaw: 0, pitch: 0, boring: false }).bite) bites += 1;
    }
    expect(bites).toBe(1);
    expect(rig.striking).toBe(false);
  });

  it('aims where it is steered, and stops where it should', () => {
    const rig = new BoreRig();
    for (let i = 0; i < 600; i += 1) rig.step(1 / 60, { yaw: 0, pitch: -1, boring: false });
    expect(rig.pitch).toBeCloseTo(PITCH_MIN, 9);
    for (let i = 0; i < 600; i += 1) rig.step(1 / 60, { yaw: 0, pitch: 1, boring: false });
    expect(rig.pitch).toBeCloseTo(PITCH_MAX, 9);

    // Straight down is reachable — a shaft is a normal thing to want to sink.
    expect(PITCH_MIN).toBeLessThan(-Math.PI / 4);
    // Steeply up is not: that is boring into her own ceiling.
    expect(PITCH_MAX).toBeLessThan(Math.PI / 4);
  });

  it('keeps the heading in range however long it is spun', () => {
    const rig = new BoreRig();
    for (let i = 0; i < 6000; i += 1) rig.step(1 / 60, { yaw: 1, pitch: 0, boring: false });
    expect(Math.abs(rig.heading)).toBeLessThanOrEqual(Math.PI + 1e-9);
  });

  /*
   * The dip drives the head animation and the bite fires at its lowest point,
   * so the two have to agree: a peak in the wrong place shows soil leaving
   * before her jaws arrive.
   */
  it('dips deepest exactly where the bite lands', () => {
    expect(dipAt(0)).toBe(0);
    expect(dipAt(1)).toBe(0);

    let peak = 0;
    let peakAt = 0;
    for (let t = 0; t <= 1; t += 0.001) {
      const d = dipAt(t);
      if (d > peak) { peak = d; peakAt = t; }
    }
    expect(peak).toBeCloseTo(1, 6);

    // Find where a bite actually fires, and check the peak is there.
    const rig = new BoreRig();
    let biteAt = -1;
    for (let i = 0; i < 200; i += 1) {
      const step = rig.step(1 / 600, { yaw: 0, pitch: 0, boring: true });
      if (step.bite) { biteAt = step.stroke; break; }
    }
    expect(biteAt).toBeGreaterThan(0);
    expect(Math.abs(biteAt - peakAt)).toBeLessThan(0.02);
  });

  it('recovers more slowly than it strikes', () => {
    // The scrape is quick and dragging the load back out is not, so the peak
    // sits past the middle of the stroke.
    let peakAt = 0;
    let peak = 0;
    for (let t = 0; t <= 1; t += 0.001) {
      if (dipAt(t) > peak) { peak = dipAt(t); peakAt = t; }
    }
    expect(peakAt).toBeGreaterThan(0.5);
  });
});
