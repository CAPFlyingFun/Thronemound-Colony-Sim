import { readFileSync, writeFileSync } from 'node:fs';

const path = 'src/anim/legDrive.ts';
let src = readFileSync(path, 'utf8');

function replaceOnce(from, to, label) {
  const first = src.indexOf(from);
  if (first < 0) throw new Error(`missing patch target: ${label}`);
  if (src.indexOf(from, first + from.length) >= 0) throw new Error(`patch target is not unique: ${label}`);
  src = src.slice(0, first) + to + src.slice(first + from.length);
}

replaceOnce(
`/**
 * How long the ordinary tripod trigger stays muzzled after a corner.
 *
 * Two swings' worth. Coming off a transition her homes are computed from a
 * body frame that has swung ninety degrees, so the excursions the trigger
 * measures are large and ALL of them are large at once — the first normal
 * frame would otherwise read a spent tripod and lift three feet together.
 * Derived from the swing rather than chosen: it is exactly long enough for
 * the spread rule to walk the strung-out feet back under her ONE AT A TIME,
 * which is the same thing the transition was doing and reads as continuous.
 */
export const HANDOFF_GRACE = SWING_SECONDS * 2;
`,
`/**
 * Compatibility/readout for the post-corner guard.
 *
 * This used to be two whole swing durations (0.32 s), which kept the corner's
 * one-foot scheduler alive after the corner was already over and made both
 * gait and speed read as if climbing had become a permanent slow mode. The
 * handoff needs only one protected frame: enough to prevent an immediate
 * three-foot release, not long enough to become locomotion policy.
 */
export const HANDOFF_GRACE = 1 / 60;
const HANDOFF_GUARD_FRAMES = 1;

/**
 * Keep her root on the air side of the target face while the leading pair are
 * still acquiring it. Fifty microns is enough to avoid starting the walker's
 * embedded-rescue path without creating a visible gap at ant scale.
 */
const CORNER_ROOT_SKIN = 0.05 / MM;
`,
'handoff constant',
);

replaceOnce(
`  /** Seconds left of the post-corner muzzle. See \`HANDOFF_GRACE\`. */
  private grace = 0;
`,
`  /** Normal frames left under one-foot scheduling after the corner finishes. */
  private handoffFrames = 0;

  /**
   * Last real target face found by a scheduled corner foot. Held across the
   * one frame between the first foot landing and the second foot being queued,
   * so the body cannot slip through the wall in that bookkeeping gap.
   */
  private readonly cornerPlanePoint = new THREE.Vector3();

  private readonly cornerPlaneNormal = new THREE.Vector3();

  private hasCornerPlane = false;
`,
'handoff fields',
);

replaceOnce(
`    this.corner.reset();
    this.grace = 0;
`,
`    this.corner.reset();
    this.handoffFrames = 0;
    this.hasCornerPlane = false;
`,
'plant reset',
);

replaceOnce(
`    if (corner.handedOff) this.grace = HANDOFF_GRACE;
    this.grace = Math.max(0, this.grace - dt);
    /** Is the corner scheduler, or its aftermath, in charge of the queue? */
    const staged = corner.active || this.grace > 0;
`,
`    if (corner.aim) {
      this.cornerPlanePoint.copy(corner.aim.point);
      this.cornerPlaneNormal.copy(corner.aim.normal).normalize();
      this.hasCornerPlane = true;
    }
    if (corner.handedOff) this.handoffFrames = HANDOFF_GUARD_FRAMES;
    /** Is the corner scheduler, or its one protected handoff frame, in charge? */
    const staged = corner.active || this.handoffFrames > 0;

    /*
     * FEET FIRST, BODY SECOND.
     *
     * v0.0.40 found the wall with the feet but still let the root keep its
     * full forward shove while those first two grips were being acquired.
     * On a concave floor-to-wall corner SurfaceWalker cannot see the wall from
     * its old floor frame, so the root crossed into solid first; only then did
     * its embedded-rescue path extrude her outward and rotate her. On screen
     * that is the reported hop: BODY UP, then feet catch up.
     *
     * A scheduled foothold already gave us an honest point and normal on the
     * new surface. Until two feet actually own that surface, clip only the
     * component of the proposed shove that would carry her root through that
     * tangent plane. Sideways motion and motion away are untouched. This is
     * not a pause or a climb-speed multiplier: she moves continuously right
     * up to the face, while the real front feet finish their 0.16 s swings.
     * Once two grips exist the plane guard releases and the ordinary planted
     * constraints plus SurfaceWalker carry her around the corner.
     */
    const cornerReportBeforeMove = this.corner.report(this.legs);
    if (corner.active && cornerReportBeforeMove.onNew < 2 && this.hasCornerPlane) {
      const clearance = from.clone().sub(this.cornerPlanePoint).dot(this.cornerPlaneNormal);
      const intoFace = shove.dot(this.cornerPlaneNormal);
      if (intoFace < -1e-9 && clearance + intoFace < CORNER_ROOT_SKIN) {
        const room = Math.max(0, clearance - CORNER_ROOT_SKIN);
        const scale = THREE.MathUtils.clamp(room / -intoFace, 0, 1);
        shove.multiplyScalar(scale);
      }
    }
`,
'corner staging and plane guard',
);

replaceOnce(
`     * PAUSED, NOT DESTROYED — and the pause has two reasons behind it.
     *
     * During a transition the whole point is that one foot moves at a time,
     * and "the most-spent foot releases its entire tripod" would take three
     * at once, two of which have nowhere to go. After one, the homes have
     * been recomputed in a body frame that swung ninety degrees, so every
     * excursion is large SIMULTANEOUSLY and the first normal frame would
     * read a spent tripod and lift three feet together. The grace lets the
     * spread rule bring them back one at a time instead. See \`HANDOFF_GRACE\`.
`,
`     * PAUSED, NOT DESTROYED.
     *
     * During a transition the whole point is that one foot moves at a time,
     * and "the most-spent foot releases its entire tripod" would take three
     * at once, two of which may have nowhere to go. The first frame after the
     * final transfer gets the same protection so handoff cannot release three
     * feet on the exact boundary. After that, normal geometry owns cadence
     * again; there is no timed post-climb slow mode.
`,
'gait pause comment',
);

replaceOnce(
`    return {
      movedMm: moved * MM,
`,
`    /* One protected normal frame, then ordinary 3+3 scheduling owns her. */
    if (!corner.active && this.handoffFrames > 0) this.handoffFrames -= 1;
    if (!corner.active && this.handoffFrames === 0) this.hasCornerPlane = false;

    return {
      movedMm: moved * MM,
`,
'handoff decrement',
);

writeFileSync(path, src);
console.log('continuous corner patch applied with all targets asserted');
