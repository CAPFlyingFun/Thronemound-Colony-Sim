import { describe, expect, it } from 'vitest';
import {
  RouteTrace, TRACE_CAP, TRACE_JUMP_MM, TRACE_STEP_MM,
} from '../src/scenes/routeTrace';

/*
 * THE ROUTE TRACE'S PROMISES, pinned:
 *
 * 1. THE WHOLE ROUTE ALWAYS FITS. A trace that forgets its beginning
 *    cannot show a loop, and the loop is the blindness the panel exists
 *    for — a player heading UP who believed she was heading down.
 *
 * 2. WALKING BACK STILL ADDS ROUTE. Distance is monotonic; only depth
 *    comes back up. That is what makes a loop a legible shape instead of
 *    a line that retraces itself into nothing.
 *
 * 3. A TELEPORT IS NOT TRAVEL. A probe's hand or a reload must not draw
 *    a wall across the profile.
 */

/** Walk it: n frames of the same step and depth-per-step. */
function walk(t: RouteTrace, frames: number, stepMm: number, depthAt: (i: number) => number): void {
  for (let i = 0; i < frames; i += 1) t.add(stepMm, depthAt(i));
}

describe('sampling the route', () => {
  it('keeps a line, not a frame log — samples land every step, not every add', () => {
    const t = new RouteTrace();
    walk(t, 100, 1, (i) => i * 0.5);
    /* 100 mm of travel at a 4 mm step is ~25 samples plus the start. */
    expect(t.samples.length).toBeGreaterThan(20);
    expect(t.samples.length).toBeLessThan(30);
    expect(t.lengthMm).toBeCloseTo(100, 5);
  });

  it('records a plumb shaft, because travel is 3D distance, not floor plan', () => {
    /* The caller hands in the full step she moved; a shaft's steps are as
     * real as a gallery's. This pins that the trace itself has no notion
     * of "horizontal" to lose them to. */
    const t = new RouteTrace();
    walk(t, 50, 1, (i) => i);
    expect(t.lengthMm).toBeCloseTo(50, 5);
    expect(t.samples[t.samples.length - 1]!.depth).toBeGreaterThan(40);
  });

  it('walking back up your own tunnel extends the line and raises it', () => {
    const t = new RouteTrace();
    walk(t, 100, 1, (i) => i);          // down 100 mm over 100 mm
    walk(t, 100, 1, (i) => 100 - i);    // and back up the way she came
    expect(t.lengthMm).toBeCloseTo(200, 5);
    const last = t.samples[t.samples.length - 1]!;
    expect(last.depth).toBeLessThan(10);
    /* Distance never rewinds — each sample is further along than the one
     * before it, whichever way she was facing. */
    for (let i = 1; i < t.samples.length; i += 1) {
      expect(t.samples[i]!.d).toBeGreaterThan(t.samples[i - 1]!.d);
    }
  });

  it('a teleport is refused; the walk on either side of it survives', () => {
    const t = new RouteTrace();
    walk(t, 40, 1, () => 20);
    t.add(TRACE_JUMP_MM * 3, 90);
    walk(t, 40, 1, () => 22);
    expect(t.lengthMm).toBeCloseTo(80, 5);
    for (const s of t.samples) expect(s.depth).toBeLessThan(30);
  });

  it('never grows past the cap, and the ends survive the coarsening', () => {
    const t = new RouteTrace();
    /* Far past the cap: 40 metres of tunnel at 1 mm a frame. */
    walk(t, 40000, 1, (i) => 30 + 20 * Math.sin(i / 500));
    expect(t.samples.length).toBeLessThanOrEqual(TRACE_CAP + 1);
    expect(t.samples[0]!.d).toBe(0);
    expect(t.lengthMm).toBeCloseTo(40000, -1);
    /* Still ordered after however many decimations that took. */
    for (let i = 1; i < t.samples.length; i += 1) {
      expect(t.samples[i]!.d).toBeGreaterThan(t.samples[i - 1]!.d);
    }
  });

  it('clear() is a fresh instrument, resolution included', () => {
    const t = new RouteTrace();
    walk(t, 40000, 1, () => 30);
    t.clear();
    expect(t.samples.length).toBe(0);
    expect(t.lengthMm).toBe(0);
    /* The step must reset with it — a cleared trace that kept a coarse
     * step would draw the NEXT tunnel at the old tunnel's resolution. */
    walk(t, 100, 1, () => 10);
    expect(t.samples.length).toBeGreaterThan(100 / TRACE_STEP_MM - 2);
  });
});
