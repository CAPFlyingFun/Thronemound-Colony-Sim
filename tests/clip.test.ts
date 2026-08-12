import { describe, expect, it } from 'vitest';

import { QUEEN_RIG } from '../src/anim/hexapod';
import {
  dropKey, emptyClip, keyAt, neededDuration, putKey, sampleClip,
} from '../src/anim/clip';
import type { AntPose, PoseQuat } from '../src/anim/pose';

const TAIL = QUEEN_RIG.gaster[0]!;
const LEG = QUEEN_RIG.legs[0]!.bones[0]!;

/** A pose turning one bone `y` about Y. */
const turn = (bone: string, y: number): AntPose => ({
  name: 'k',
  rotations: { [bone]: [0, y, 0, Math.sqrt(Math.max(0, 1 - y * y))] as PoseQuat },
});

const yOf = (pose: AntPose | null, bone: string): number => pose?.rotations[bone]?.[1] ?? 0;

describe('keys on a timeline', () => {
  it('keeps them in time order however they are dropped', () => {
    let clip = emptyClip('walk');
    clip = putKey(clip, 1, turn(TAIL, 0.3));
    clip = putKey(clip, 0.25, turn(TAIL, 0.1));
    clip = putKey(clip, 0.5, turn(TAIL, 0.2));
    expect(clip.keys.map((k) => k.t)).toEqual([0.25, 0.5, 1]);
  });

  it('keying twice at the same moment REPLACES rather than stacks', () => {
    /* Keying again is a correction, not a second opinion. Stacking leaves
     * invisible duplicates fighting over one instant. */
    let clip = emptyClip('walk');
    clip = putKey(clip, 0.5, turn(TAIL, 0.1));
    clip = putKey(clip, 0.505, turn(TAIL, 0.4));
    expect(clip.keys).toHaveLength(1);
    expect(yOf(clip.keys[0]!.pose, TAIL)).toBeCloseTo(0.4, 9);
  });

  it('drops the key nearest a moment, and nothing when there is none near', () => {
    let clip = emptyClip('walk');
    clip = putKey(clip, 0.5, turn(TAIL, 0.1));
    clip = putKey(clip, 1.5, turn(TAIL, 0.2));
    expect(dropKey(clip, 1.505).keys.map((k) => k.t)).toEqual([0.5]);
    expect(dropKey(clip, 1.0).keys).toHaveLength(2);
  });

  it('finds the key under the playhead, for an editor to light up', () => {
    let clip = emptyClip('walk');
    clip = putKey(clip, 0.5, turn(TAIL, 0.1));
    expect(keyAt(clip, 0.51)).not.toBeNull();
    expect(keyAt(clip, 0.9)).toBeNull();
  });

  it('never keys at a negative time', () => {
    const clip = putKey(emptyClip('walk'), -3, turn(TAIL, 0.1));
    expect(clip.keys[0]!.t).toBe(0);
  });

  it('says how long it needs to be to reach its last key', () => {
    let clip = emptyClip('walk', 2);
    clip = putKey(clip, 3.5, turn(TAIL, 0.1));
    expect(neededDuration(clip)).toBeCloseTo(3.5, 9);
  });
});

describe('sampling a clip', () => {
  it('is nothing at all when there are no keys', () => {
    /* Not "rest" — there is nothing to draw, so whoever is posing her should
     * be left alone. */
    expect(sampleClip(emptyClip('empty'), 0.5)).toBeNull();
  });

  it('is that pose everywhere when there is one key', () => {
    const clip = putKey(emptyClip('one'), 0.5, turn(TAIL, 0.3));
    expect(yOf(sampleClip(clip, 0), TAIL)).toBeCloseTo(0.3, 9);
    expect(yOf(sampleClip(clip, 9), TAIL)).toBeCloseTo(0.3, 9);
  });

  it('lands exactly on a key at its own time', () => {
    let clip = emptyClip('two', 2);
    clip = putKey(clip, 0, turn(TAIL, 0));
    clip = putKey(clip, 1, turn(TAIL, 0.5));
    expect(yOf(sampleClip(clip, 1), TAIL)).toBeCloseTo(0.5, 6);
  });

  it('travels between two keys', () => {
    let clip = emptyClip('two', 2);
    clip = putKey(clip, 0, turn(TAIL, 0));
    clip = putKey(clip, 1, turn(TAIL, 0.5));
    const half = yOf(sampleClip(clip, 0.5), TAIL);
    expect(half).toBeGreaterThan(0.05);
    expect(half).toBeLessThan(0.45);
    /* And monotonically — a blend that overshoots reads as a twitch. */
    expect(yOf(sampleClip(clip, 0.25), TAIL)).toBeLessThan(half);
    expect(yOf(sampleClip(clip, 0.75), TAIL)).toBeGreaterThan(half);
  });

  it('holds at the ends when it does not loop', () => {
    let clip = { ...emptyClip('once', 2), loop: false };
    clip = putKey(clip, 0.5, turn(TAIL, 0.2));
    clip = putKey(clip, 1.5, turn(TAIL, 0.6));
    expect(yOf(sampleClip(clip, 0), TAIL)).toBeCloseTo(0.2, 6);
    expect(yOf(sampleClip(clip, 5), TAIL)).toBeCloseTo(0.6, 6);
  });

  it('wraps across the seam when it loops', () => {
    /* The gap from the last key round to the first IS part of the clip; a
     * loop that snaps there is the commonest way an otherwise good cycle
     * looks broken. */
    let clip = emptyClip('cycle', 2);
    clip = putKey(clip, 0, turn(TAIL, 0));
    clip = putKey(clip, 1, turn(TAIL, 0.6));
    const mid = yOf(sampleClip(clip, 1.5), TAIL);
    expect(mid).toBeGreaterThan(0.05);
    expect(mid).toBeLessThan(0.55);
  });

  it('wraps time round rather than running off the end', () => {
    let clip = emptyClip('cycle', 2);
    clip = putKey(clip, 0, turn(TAIL, 0));
    clip = putKey(clip, 1, turn(TAIL, 0.6));
    expect(yOf(sampleClip(clip, 4), TAIL)).toBeCloseTo(yOf(sampleClip(clip, 0), TAIL), 6);
    /* Including backwards, which a scrubber can produce. */
    expect(yOf(sampleClip(clip, -1), TAIL)).toBeCloseTo(yOf(sampleClip(clip, 1), TAIL), 6);
  });

  it('moves a bone that only ONE key names, instead of snapping at it', () => {
    /*
     * THE ONE THAT MATTERS for authoring. Key her tail at 0 and her leg at 1,
     * and both must TRAVEL: the leg from rest toward its pose, the tail from
     * its pose back toward rest. A blend over the union of the two poses does
     * that; a blend over only the shared bones leaves the leg at rest until
     * the moment it snaps into place.
     */
    let clip = { ...emptyClip('mixed', 2), loop: false };
    clip = putKey(clip, 0, turn(TAIL, 0.6));
    clip = putKey(clip, 1, turn(LEG, 0.6));
    const mid = sampleClip(clip, 0.5);
    expect(yOf(mid, LEG)).toBeGreaterThan(0.05);
    expect(yOf(mid, LEG)).toBeLessThan(0.55);
    expect(yOf(mid, TAIL)).toBeGreaterThan(0.05);
    expect(yOf(mid, TAIL)).toBeLessThan(0.55);
    /* And each arrives where its own key put it. */
    expect(yOf(sampleClip(clip, 1), LEG)).toBeCloseTo(0.6, 6);
    expect(yOf(sampleClip(clip, 0), TAIL)).toBeCloseTo(0.6, 6);
  });

  it('keeps every sampled rotation a unit quaternion', () => {
    let clip = emptyClip('cycle', 2);
    clip = putKey(clip, 0, turn(TAIL, 0));
    clip = putKey(clip, 1, turn(TAIL, 0.7));
    for (const t of [0, 0.3, 0.5, 0.99, 1.4, 1.9]) {
      const q = sampleClip(clip, t)!.rotations[TAIL]!;
      expect(Math.hypot(q[0], q[1], q[2], q[3])).toBeCloseTo(1, 6);
    }
  });

  it('carries no position, whatever it is sampled at', () => {
    let clip = emptyClip('cycle', 2);
    clip = putKey(clip, 0, turn(TAIL, 0.2));
    clip = putKey(clip, 1, turn(TAIL, 0.5));
    expect(Object.keys(sampleClip(clip, 0.5)!).sort()).toEqual(['name', 'rotations']);
  });
});
