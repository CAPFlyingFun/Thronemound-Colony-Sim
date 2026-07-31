/**
 * Putting six feet on uneven ground.
 *
 * The gait in `hexapod.ts` decides what a leg DOES — swing forward, plant,
 * drive back — from the body's frame alone. It has no idea what the ground is
 * doing, and it cannot: the same walk cycle has to work on a floor, a slope
 * and the wall of a crater. So the gait poses the legs and this bends the last
 * few joints of each until the foot is where the terrain actually is.
 *
 * Two pieces, kept apart on purpose. `footTarget` decides WHERE a foot should
 * be, which is a one-line rule with a lot of judgement in it. `aimRotation` is
 * one step of cyclic coordinate descent — the rotation that swings an end
 * effector about a joint toward a target — which is pure geometry and belongs
 * nowhere near a renderer. `QueenModel` runs the loop, because only it has the
 * bone hierarchy.
 */

export type Vec3 = readonly [number, number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/**
 * Where a foot belongs, given where the gait put it and where the ground is.
 *
 * Two jobs in one rule, and they pull in opposite directions:
 *
 *  - A foot must never be UNDER the soil. Reported as clipping, and it is the
 *    thing you cannot unsee once you have seen it, because a leg that vanishes
 *    into the ground reads as the model floating rather than as the leg being
 *    slightly wrong.
 *  - A foot that is supposed to be standing on the ground must actually touch
 *    it, or she walks a hand's breadth above a downhill slope.
 *
 * The `band` is what separates those cases without the gait having to tell us
 * which legs are in stance. A foot within a band of the ground is trying to
 * stand on it and gets planted; a foot clearly higher is mid-swing and is left
 * exactly where the gait wanted it, because overriding a swinging foot is how
 * a walk cycle turns into a shuffle.
 *
 * `clearance` is the gap left at a planted foot. It exists because zero is not
 * a safe target in floating point — the foot position comes back through a
 * skinned mesh at float32, and a target of exactly the surface lands a hair
 * under it about half the time.
 */
export function footTarget(
  gaitY: number, groundY: number, clearance: number, band: number,
): number {
  const resting = groundY + clearance;
  if (gaitY <= resting) return resting;
  return gaitY - resting < band ? resting : gaitY;
}

/**
 * Distance from a point to a polyline — how fat a limb is around its bones.
 *
 * A skeleton is a set of lines and a leg is a tube drawn around them, so
 * putting the bone on the ground puts half the tube under it. Measured against
 * the SEGMENTS rather than the joint positions: to the nearest joint, a vertex
 * halfway along a bone reads as far away as the bone is long, which would have
 * this ant walking a millimetre in the air.
 */
export function distanceToPolyline(point: Vec3, polyline: readonly Vec3[]): number {
  let best = Infinity;
  for (let i = 0; i < polyline.length; i += 1) {
    const a = polyline[i]!;
    best = Math.min(best, length(sub(point, a)));
    const b = polyline[i + 1];
    if (!b) continue;
    const along = sub(b, a);
    const lengthSquared = dot(along, along);
    if (lengthSquared < 1e-12) continue;
    const t = Math.max(0, Math.min(1, dot(sub(point, a), along) / lengthSquared));
    const near: Vec3 = [
      a[0] + along[0] * t, a[1] + along[1] * t, a[2] + along[2] * t,
    ];
    best = Math.min(best, length(sub(point, near)));
  }
  return best;
}

/**
 * One step of cyclic coordinate descent: the rotation about `joint` that
 * swings `effector` onto the ray toward `target`.
 *
 * Returns an axis and an angle rather than applying anything, so the caller
 * decides how much of it to take and in whose coordinate frame. Taking all of
 * it every frame makes the leg snap; the caller clamps.
 *
 * Degenerate cases return a zero angle rather than a NaN axis, and there are
 * three of them: the effector sitting on the joint, the target sitting on the
 * joint, and the two already being collinear. All three happen in practice —
 * a leg folded flat, a target exactly under the hip — and any one of them
 * silently poisons the whole skeleton with NaN if it is allowed through, which
 * renders as the ant disappearing rather than as a bad leg.
 */
export function aimRotation(
  joint: Vec3, effector: Vec3, target: Vec3,
): { axis: Vec3; angle: number } {
  const NONE = { axis: [0, 1, 0] as Vec3, angle: 0 };
  const from = sub(effector, joint);
  const to = sub(target, joint);
  const fromLength = length(from);
  const toLength = length(to);
  if (fromLength < 1e-9 || toLength < 1e-9) return NONE;

  const axis = cross(from, to);
  const axisLength = length(axis);
  if (axisLength < 1e-9) return NONE;

  const cosine = Math.max(-1, Math.min(1, dot(from, to) / (fromLength * toLength)));
  return {
    axis: [axis[0] / axisLength, axis[1] / axisLength, axis[2] / axisLength],
    angle: Math.acos(cosine),
  };
}
