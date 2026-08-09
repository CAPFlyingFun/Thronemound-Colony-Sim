/**
 * THE TRAIN, without a renderer.
 *
 * The claim worth pinning is the ORDER: head first, thorax next, gaster
 * last, on the way up a slope AND on the way off one. It is not scripted —
 * it falls out of three follow rates over the same targets — so a test that
 * checks the ordering is really checking that nobody has quietly equalised
 * the rates and turned her back into a plank.
 */

import { describe, expect, it } from 'vitest';
import {
  CLEARANCE_MM, posture, PROBES, Spine, SPINE_LIMITS,
} from '../src/anim/spine';

const AHEAD = 0.4;
const BEHIND = 0.4;
/* Clear of everything, which is the ordinary case: the proximity bias must
 * contribute nothing at all here or it is not a proximity bias. */
const flat = {
  aheadRise: 0, behindRise: 0, headClear: Infinity, gasterClear: Infinity,
};

describe('the posture the terrain asks for', () => {
  it('is level on level ground', () => {
    const p = posture(flat, AHEAD, BEHIND);
    expect(p.head).toBeCloseTo(0, 9);
    expect(p.thorax).toBeCloseTo(0, 9);
    expect(p.gaster).toBeCloseTo(0, 9);
  });

  it('pitches her nose UP at a rise ahead, before she is on it', () => {
    const p = posture({ ...flat, aheadRise: 0.2 }, AHEAD, BEHIND);
    expect(p.head).toBeGreaterThan(0.2);
    /* The middle feels it too, but less — it is averaging across her. */
    expect(p.thorax).toBeGreaterThan(0);
    expect(p.thorax).toBeLessThan(p.head);
    /* And her tail knows nothing about it yet. */
    expect(p.gaster).toBeCloseTo(0, 9);
  });

  it('pitches her nose DOWN at a drop ahead', () => {
    const p = posture({ ...flat, aheadRise: -0.2 }, AHEAD, BEHIND);
    expect(p.head).toBeLessThan(-0.2);
    expect(p.thorax).toBeLessThan(0);
  });

  it('keeps her tail up while she is leaving a rise', () => {
    /* Cresting: flat ahead, higher ground behind. Her abdomen is still on
     * the slope she came off, and should still be pitched to it. */
    const p = posture({ ...flat, behindRise: 0.2 }, AHEAD, BEHIND);
    expect(p.gaster).toBeLessThan(0);
    expect(p.head).toBeCloseTo(0, 9);
  });

  it('never folds — every section is clamped to its own anatomy', () => {
    const cliff = {
      aheadRise: 50, behindRise: -50, headClear: Infinity, gasterClear: Infinity,
    };
    const p = posture(cliff, AHEAD, BEHIND);
    expect(p.head).toBeCloseTo(SPINE_LIMITS.headMax, 9);
    expect(p.thorax).toBeCloseTo(SPINE_LIMITS.thoraxMax, 9);
    expect(p.gaster).toBeCloseTo(SPINE_LIMITS.gasterMax, 9);
    /* And in the other direction. */
    const q = posture({ ...cliff, aheadRise: -50, behindRise: 50 }, AHEAD, BEHIND);
    expect(q.head).toBeCloseTo(-SPINE_LIMITS.headMax, 9);
    expect(q.gaster).toBeCloseTo(-SPINE_LIMITS.gasterMax, 9);
  });

  it('lifts a section that is about to be inside the ground', () => {
    /* At the hard shell, the full limit. */
    const tight = { ...flat, headClear: CLEARANCE_MM.hard };
    expect(posture(tight, AHEAD, BEHIND).head)
      .toBeCloseTo(SPINE_LIMITS.headMax, 6);
    /* Halfway across the band, about half of it — a lean, not a snap. */
    const mid = (CLEARANCE_MM.soft + CLEARANCE_MM.hard) / 2;
    const half = posture({ ...flat, headClear: mid }, AHEAD, BEHIND).head;
    expect(half).toBeGreaterThan(SPINE_LIMITS.headMax * 0.4);
    expect(half).toBeLessThan(SPINE_LIMITS.headMax * 0.6);
    /* At the soft edge and beyond, NOTHING. This is the case that used to
     * fire on 89% of walking frames and slam her head to the clamp. */
    expect(posture({ ...flat, headClear: CLEARANCE_MM.soft }, AHEAD, BEHIND).head)
      .toBeCloseTo(0, 9);
    expect(posture({ ...flat, headClear: CLEARANCE_MM.soft * 10 }, AHEAD, BEHIND).head)
      .toBeCloseTo(0, 9);
    expect(posture(flat, AHEAD, BEHIND).head).toBeCloseTo(0, 9);
  });

  it('never derives clearance from the SIGN of a rise', () => {
    /*
     * The regression this whole rewrite exists for. An uphill rise and a
     * downhill drop of the same size must produce the same PROXIMITY
     * contribution — the difference between them belongs entirely to the
     * slope term. Before, an uphill rise made the pseudo-gap exactly zero
     * and added the full 30-degree limit; a drop added nothing.
     */
    const up = posture({ ...flat, aheadRise: 0.02 }, AHEAD, BEHIND);
    const down = posture({ ...flat, aheadRise: -0.02 }, AHEAD, BEHIND);
    expect(up.head).toBeCloseTo(-down.head, 9);
    expect(Math.abs(up.head)).toBeLessThan(SPINE_LIMITS.headMax * 0.5);
  });

  it('probes in proportion to her body, over a long enough baseline', () => {
    /*
     * The baseline is the DENOMINATOR of every slope this produces, so a
     * short one magnifies the terrain's own quantisation into head angle.
     * At a fifth of a body one lattice step read as two degrees; a real
     * ant's look-ahead is most of her own length anyway.
     */
    for (const p of [PROBES.ahead, PROBES.behind]) {
      expect(p).toBeGreaterThan(0.35);
      expect(p).toBeLessThan(0.7);
    }
  });
});

describe('the train', () => {
  /** Hold a posture for `seconds` and report the pitches on the way. */
  const run = (spine: Spine, want: ReturnType<typeof posture>, seconds: number) => {
    const dt = 1 / 120;
    const track: Array<{ t: number; head: number; thorax: number; gaster: number }> = [];
    for (let t = 0; t < seconds; t += dt) {
      const p = spine.follow(want, dt);
      track.push({ t, head: p.head, thorax: p.thorax, gaster: p.gaster });
    }
    return track;
  };

  it('moves the head FIRST, then the thorax, then the gaster', () => {
    const spine = new Spine();
    const uphill = posture({ ...flat, aheadRise: 0.3, behindRise: -0.3 }, AHEAD, BEHIND);
    const track = run(spine, uphill, 0.6);
    /* How long each took to cover half its own final travel. */
    const halfway = (pick: (r: typeof track[number]) => number, end: number) =>
      track.find((r) => Math.abs(pick(r)) >= Math.abs(end) * 0.5)?.t ?? Infinity;
    const last = track[track.length - 1]!;
    const tHead = halfway((r) => r.head, last.head);
    const tThorax = halfway((r) => r.thorax, last.thorax);
    const tGaster = halfway((r) => r.gaster, last.gaster);
    expect(tHead).toBeLessThan(tThorax);
    expect(tThorax).toBeLessThan(tGaster);
  });

  it('levels in the same order when she crests', () => {
    const spine = new Spine();
    const uphill = posture({ ...flat, aheadRise: 0.3, behindRise: -0.3 }, AHEAD, BEHIND);
    run(spine, uphill, 2);
    const bent = { ...spine.pose };
    /* Now the ground goes flat under her — the crest. */
    const track = run(spine, posture(flat, AHEAD, BEHIND), 0.6);
    const settled = (pick: (r: typeof track[number]) => number, from: number) =>
      track.find((r) => Math.abs(pick(r)) <= Math.abs(from) * 0.5)?.t ?? Infinity;
    expect(settled((r) => r.head, bent.head))
      .toBeLessThan(settled((r) => r.thorax, bent.thorax));
    expect(settled((r) => r.thorax, bent.thorax))
      .toBeLessThan(settled((r) => r.gaster, bent.gaster));
  });

  it('gets there in the end, and stays', () => {
    const spine = new Spine();
    const want = posture({ ...flat, aheadRise: 0.2 }, AHEAD, BEHIND);
    run(spine, want, 3);
    expect(spine.pose.head).toBeCloseTo(want.head, 3);
    expect(spine.pose.thorax).toBeCloseTo(want.thorax, 3);
    expect(spine.pose.gaster).toBeCloseTo(want.gaster, 3);
  });

  it('does not snap when a target steps — the response is smooth', () => {
    const spine = new Spine();
    const step = posture({ ...flat, aheadRise: 5 }, AHEAD, BEHIND);
    const dt = 1 / 120;
    let previous = 0;
    let worst = 0;
    for (let i = 0; i < 120; i += 1) {
      const p = spine.follow(step, dt);
      worst = Math.max(worst, Math.abs(p.head - previous));
      previous = p.head;
    }
    /* Crossing a terrain triangle must not throw her head across its whole
     * range in one frame. A tenth of the clamp per frame is plenty. */
    expect(worst).toBeLessThan(SPINE_LIMITS.headMax * 0.1);
  });

  it('can be snapped deliberately, for a respawn', () => {
    const spine = new Spine();
    spine.set({ head: 0.3, thorax: 0.1, gaster: -0.2 });
    expect(spine.pose.head).toBe(0.3);
    expect(spine.pose.gaster).toBe(-0.2);
  });

  it('is a train only because the rates differ', () => {
    /* The ordering is emergent. If these ever become equal the body goes
     * back to being a plank, and every ordering test above would still
     * pass by a hair — so the relationship is asserted directly. */
    expect(SPINE_LIMITS.headRate).toBeGreaterThan(SPINE_LIMITS.thoraxRate);
    expect(SPINE_LIMITS.thoraxRate).toBeGreaterThan(SPINE_LIMITS.gasterRate);
  });

  it('clamps whatever it is handed, not just what posture() produced', () => {
    const spine = new Spine();
    spine.follow({ head: 99, thorax: 99, gaster: 99 }, 10);
    expect(spine.pose.head).toBeLessThanOrEqual(SPINE_LIMITS.headMax + 1e-9);
    expect(spine.pose.thorax).toBeLessThanOrEqual(SPINE_LIMITS.thoraxMax + 1e-9);
    expect(spine.pose.gaster).toBeLessThanOrEqual(SPINE_LIMITS.gasterMax + 1e-9);
  });
});
