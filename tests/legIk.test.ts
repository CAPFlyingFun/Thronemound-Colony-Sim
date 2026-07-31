/**
 * Six feet on ground that is not flat.
 *
 * `footTarget` is the rule and `aimRotation` is the geometry; between them
 * they are the whole of the terrain solver except for the loop, which lives in
 * `QueenModel` because only it has a bone hierarchy. Both are checked here
 * because both have a failure mode that renders as something other than what
 * it is: a bad target reads as a shuffling walk, and a bad rotation reads as
 * the ant vanishing, because one NaN loose in a skeleton takes the whole mesh
 * with it.
 */

import { describe, it, expect } from 'vitest';
import { aimRotation, distanceToPolyline, footTarget, type Vec3 } from '../src/anim/legIk';

/** Rodrigues, so the returned axis and angle can be checked by using them. */
function rotate(point: Vec3, pivot: Vec3, axis: Vec3, angle: number): Vec3 {
  const v: Vec3 = [point[0] - pivot[0], point[1] - pivot[1], point[2] - pivot[2]];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dot = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2];
  const cross: Vec3 = [
    axis[1] * v[2] - axis[2] * v[1],
    axis[2] * v[0] - axis[0] * v[2],
    axis[0] * v[1] - axis[1] * v[0],
  ];
  return [
    v[0] * c + cross[0] * s + axis[0] * dot * (1 - c) + pivot[0],
    v[1] * c + cross[1] * s + axis[1] * dot * (1 - c) + pivot[1],
    v[2] * c + cross[2] * s + axis[2] * dot * (1 - c) + pivot[2],
  ];
}

const dist = (a: Vec3, b: Vec3): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('where a foot belongs', () => {
  const CLEAR = 0.002;
  const BAND = 0.12;

  it('never leaves a foot under the soil', () => {
    // Buried by a whole body height, grazing it, and exactly on it.
    for (const gaitY of [-1, -0.05, -1e-9, 0]) {
      expect(footTarget(gaitY, 0, CLEAR, BAND)).toBe(CLEAR);
    }
    // And it is the GROUND it clears, not zero — the terrain moves.
    expect(footTarget(2.1, 2.4, CLEAR, BAND)).toBeCloseTo(2.4 + CLEAR, 12);
  });

  /*
   * The band is the whole reason this is a function and not a clamp. Clamping
   * alone stops the clipping and leaves her walking above a downhill slope,
   * because the gait plants a foot at the height her BODY expects and the
   * ground has since fallen away.
   */
  it('plants a foot that is trying to stand, and leaves a swinging one alone', () => {
    // Just above the ground: she means to stand there, so put her on it.
    expect(footTarget(0.05, 0, CLEAR, BAND)).toBe(CLEAR);
    // Clearly lifted: mid-swing, and overriding it turns a walk into a shuffle.
    expect(footTarget(0.4, 0, CLEAR, BAND)).toBe(0.4);
    // The boundary belongs to the swing, so the plant can never grab a foot
    // that the gait has deliberately raised past the band.
    expect(footTarget(BAND + CLEAR, 0, CLEAR, BAND)).toBe(BAND + CLEAR);
  });
});

describe('how fat a limb is', () => {
  /*
   * The measurement that decides how far above the soil a bone has to sit. A
   * skeleton is a set of lines and a leg is a tube drawn round them, so a foot
   * bone resting exactly on the ground puts half the tube through it — which
   * is what 5,875 buried leg vertices turned out to be.
   */
  it('measures to the segments, not to the joints', () => {
    const bone: Vec3[] = [[0, 0, 0], [10, 0, 0]];
    // A point beside the MIDDLE of a long bone is one unit from the bone, and
    // five from either end. Measuring to joints would call this a five-unit
    // limb and stand her an inch off the ground.
    expect(distanceToPolyline([5, 1, 0], bone)).toBeCloseTo(1, 12);
    expect(distanceToPolyline([5, 0, 0], bone)).toBeCloseTo(0, 12);
  });

  it('clamps to the ends rather than running off them', () => {
    const bone: Vec3[] = [[0, 0, 0], [1, 0, 0]];
    // Past the end, the nearest point on the segment IS the end.
    expect(distanceToPolyline([4, 0, 0], bone)).toBeCloseTo(3, 12);
    expect(distanceToPolyline([-3, 0, 0], bone)).toBeCloseTo(3, 12);
  });

  it('takes the nearest of several bones and survives a zero-length one', () => {
    const chain: Vec3[] = [[0, 0, 0], [1, 0, 0], [1, 0, 0], [1, 2, 0]];
    expect(distanceToPolyline([1, 1, 0.5], chain)).toBeCloseTo(0.5, 12);
    expect(Number.isFinite(distanceToPolyline([0, 0, 0], [[0, 0, 0]]))).toBe(true);
  });
});

describe('aiming a joint', () => {
  it('puts the effector on the ray to the target', () => {
    const joint: Vec3 = [0, 0, 0];
    const effector: Vec3 = [1, 0, 0];
    const target: Vec3 = [0, 1, 0];
    const { axis, angle } = aimRotation(joint, effector, target);
    expect(angle).toBeCloseTo(Math.PI / 2, 12);
    // Applying it lands the effector exactly on the target, because here they
    // happen to be the same distance from the joint.
    expect(dist(rotate(effector, joint, axis, angle), target)).toBeLessThan(1e-12);
  });

  /*
   * A joint can only ROTATE, so it cannot change how far the effector is from
   * it. The correct result is the effector on the ray toward the target, at
   * its own radius — closing the remaining gap is the next joint's job, and
   * the reason cyclic coordinate descent iterates at all.
   */
  it('keeps the effector at its own radius from the joint', () => {
    const joint: Vec3 = [0.4, -1.2, 0.9];
    const effector: Vec3 = [1.9, -1.0, 0.3];
    const target: Vec3 = [0.4, 3.7, 0.9];
    const { axis, angle } = aimRotation(joint, effector, target);
    const moved = rotate(effector, joint, axis, angle);
    expect(dist(moved, joint)).toBeCloseTo(dist(effector, joint), 12);

    // On the ray: the angle between (moved - joint) and (target - joint) is 0.
    const a: Vec3 = [moved[0] - joint[0], moved[1] - joint[1], moved[2] - joint[2]];
    const b: Vec3 = [target[0] - joint[0], target[1] - joint[1], target[2] - joint[2]];
    const cosine = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2])
      / (Math.hypot(...a) * Math.hypot(...b));
    expect(cosine).toBeCloseTo(1, 10);
  });

  /*
   * The degenerate cases, which are not hypothetical: a leg folded flat puts
   * the effector on the joint, and a target directly along the bone makes the
   * cross product vanish. Either one produces a NaN axis if it is allowed
   * through, and a single NaN in a bone quaternion propagates to every vertex
   * skinned to it — so the symptom is the entire ant disappearing, which reads
   * as a loading failure rather than as a leg problem.
   */
  it('returns no rotation rather than a NaN for degenerate geometry', () => {
    const cases: Array<[Vec3, Vec3, Vec3]> = [
      [[0, 0, 0], [0, 0, 0], [1, 0, 0]],       // effector on the joint
      [[0, 0, 0], [1, 0, 0], [0, 0, 0]],       // target on the joint
      [[0, 0, 0], [1, 0, 0], [3, 0, 0]],       // already pointing at it
      [[0, 0, 0], [1, 0, 0], [-2, 0, 0]],      // pointing exactly away
    ];
    for (const [joint, effector, target] of cases) {
      const { axis, angle } = aimRotation(joint, effector, target);
      expect(Number.isFinite(angle)).toBe(true);
      expect(axis.every(Number.isFinite)).toBe(true);
      expect(angle).toBe(0);
    }
  });

  /*
   * Convergence, on a chain rather than one joint — this is the property the
   * solver actually relies on, and a sign error in the axis passes every
   * single-joint check above while walking the foot steadily AWAY.
   */
  it('converges a chain onto a reachable target', () => {
    const JOINTS = 4;
    const SEGMENT = 1;
    let chain: Vec3[] = [];
    for (let i = 0; i <= JOINTS; i += 1) chain.push([i * SEGMENT, 0, 0]);
    const target: Vec3 = [1.6, 2.2, 0.8];

    const before = dist(chain[chain.length - 1]!, target);
    for (let pass = 0; pass < 24; pass += 1) {
      for (let j = chain.length - 2; j >= 0; j -= 1) {
        const joint = chain[j]!;
        const { axis, angle } = aimRotation(joint, chain[chain.length - 1]!, target);
        if (angle < 1e-12) continue;
        chain = chain.map((p, i) => (i > j ? rotate(p, joint, axis, angle) : p));
      }
    }
    const after = dist(chain[chain.length - 1]!, target);
    expect(after).toBeLessThan(before);
    expect(after).toBeLessThan(1e-6);
  });
});
