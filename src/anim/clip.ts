/**
 * A CLIP — poses on a timeline, and the sampling between them.
 *
 * The pose editor could hold one shape at a time; this is what makes it an
 * animator. A clip is a list of KEYS, each a time and a whole pose, and
 * sampling it is finding the two keys either side of a moment and blending
 * between them. Nothing here draws, stores or plays anything: it is the
 * arithmetic, so the parts worth being sure of can be tested without a
 * browser, a canvas or a skeleton.
 *
 * WHOLE POSES AT EACH KEY, rather than per-bone tracks. Per-bone tracks are
 * what a general animation format needs, and they are the right answer when
 * different limbs are keyed at different times. Here the author works in
 * fourteen handles and drops a key when the whole animal looks right, so a
 * key IS a pose — which makes every operation obvious (a key is what you see;
 * deleting one cannot leave a limb behind) and makes the file trivially the
 * same shape as the poses already saved. If per-limb timing is ever wanted,
 * this is the thing to revisit, and the comment is here so it is a decision
 * rather than a discovery.
 *
 * See `pose.ts` for why a pose carries rotations and never a position.
 */

import { blendInto, type AntPose, type PoseQuat } from './pose';

export interface ClipKey {
  /** Seconds from the start of the clip. */
  t: number;
  pose: AntPose;
}

export interface AntClip {
  name: string;
  /** Seconds. Keys past it are kept but never reached — trimming is a choice
   *  the author makes, not one the format makes for them. */
  duration: number;
  loop: boolean;
  keys: ClipKey[];
}

/** Keys within this many seconds of each other are the same key. */
export const KEY_EPS = 0.02;

export function emptyClip(name: string, duration = 2): AntClip {
  return {
    name, duration, loop: true, keys: [],
  };
}

/** Keys in time order — the invariant everything below relies on. */
function sorted(keys: ClipKey[]): ClipKey[] {
  return [...keys].sort((a, b) => a.t - b.t);
}

/**
 * Drop a key, replacing any already at that moment.
 *
 * Replacing rather than adding is what a person means by keying twice at the
 * same time: they are correcting, not stacking. Without it a timeline
 * accumulates invisible duplicates that fight over the same instant and
 * whichever sorts first wins.
 */
export function putKey(clip: AntClip, t: number, pose: AntPose): AntClip {
  const at = Math.max(0, t);
  const kept = clip.keys.filter((k) => Math.abs(k.t - at) > KEY_EPS);
  return { ...clip, keys: sorted([...kept, { t: at, pose }]) };
}

/** Remove the key nearest `t`, if there is one within `KEY_EPS`. */
export function dropKey(clip: AntClip, t: number): AntClip {
  let best = -1;
  let bestGap = KEY_EPS;
  clip.keys.forEach((k, i) => {
    const gap = Math.abs(k.t - t);
    if (gap <= bestGap) { bestGap = gap; best = i; }
  });
  if (best < 0) return clip;
  return { ...clip, keys: clip.keys.filter((_, i) => i !== best) };
}

/** The key nearest `t` within `KEY_EPS`, for an editor to highlight. */
export function keyAt(clip: AntClip, t: number): ClipKey | null {
  return clip.keys.find((k) => Math.abs(k.t - t) <= KEY_EPS) ?? null;
}

/**
 * The pose at a moment.
 *
 * Held before the first key and after the last rather than fading to rest:
 * an author who keys a sting at half a second means her to be neutral until
 * then only if they said so, and easing toward a rest pose nobody asked for
 * is the sort of helpfulness that looks like a bug. A LOOPING clip is the
 * exception — it wraps the last key round to the first, because that is what
 * a loop is.
 *
 * Returns null for a clip with no keys at all, which is not the same as a
 * clip that says "rest": there is nothing to draw, so the caller should leave
 * whatever is posing her alone.
 */
export function sampleClip(clip: AntClip, time: number): AntPose | null {
  const keys = sorted(clip.keys);
  if (keys.length === 0) return null;
  if (keys.length === 1) return keys[0]!.pose;

  const span = Math.max(1e-6, clip.duration);
  const t = clip.loop
    ? ((time % span) + span) % span
    : Math.min(Math.max(0, time), span);

  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  if (t <= first.t) {
    if (!clip.loop) return first.pose;
    /* Before the first key of a loop, she is on her way round from the last
     * one — the gap across the seam, not a hold. */
    const gap = (span - last.t) + first.t;
    if (gap <= 1e-6) return first.pose;
    return mix(last.pose, first.pose, ((span - last.t) + t) / gap, clip.name);
  }
  if (t >= last.t) {
    if (!clip.loop) return last.pose;
    const gap = (span - last.t) + first.t;
    if (gap <= 1e-6) return last.pose;
    return mix(last.pose, first.pose, (t - last.t) / gap, clip.name);
  }

  let a = keys[0]!;
  let b = keys[1]!;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (t >= keys[i]!.t && t <= keys[i + 1]!.t) { a = keys[i]!; b = keys[i + 1]!; break; }
  }
  const gap = b.t - a.t;
  return gap <= 1e-6 ? b.pose : mix(a.pose, b.pose, (t - a.t) / gap, clip.name);
}

/**
 * Blend two poses.
 *
 * The UNION of their bones, which is the part worth getting right: a bone
 * named by only one of the two must still move, from or to its rest, or a
 * limb keyed in one pose and left alone in the next snaps at the key instead
 * of travelling. `blendInto` already starts a bone it has never seen from
 * rest, so seeding with `a` and blending `b` over it does exactly that.
 */
function mix(a: AntPose, b: AntPose, k: number, name: string): AntPose {
  const live = new Map<string, PoseQuat>(
    Object.entries(a.rotations) as [string, PoseQuat][],
  );
  /* Bones only `a` names must travel back toward rest, not stay put. */
  for (const bone of Object.keys(a.rotations)) {
    if (!(bone in b.rotations)) {
      blendInto(live, { name, rotations: { [bone]: [0, 0, 0, 1] } }, k);
    }
  }
  blendInto(live, b, k);
  return { name, rotations: Object.fromEntries(live) };
}

/** How long the clip actually needs to be to reach its last key. */
export function neededDuration(clip: AntClip): number {
  return clip.keys.reduce((m, k) => Math.max(m, k.t), 0);
}
