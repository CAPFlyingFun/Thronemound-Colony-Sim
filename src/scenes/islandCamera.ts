/**
 * THE CAMERA — every path that decides where the lens goes, and the guards
 * that keep it out of the dirt.
 *
 * Split out of `IslandScene` because that file had reached six thousand
 * lines and the camera is the largest piece of it that answers one
 * question: given where she is and what the thumb has asked for, where does
 * the picture go? Three placements — her own eyes, the underground chase,
 * the shoulder orbit — and a stack of clearance tests they all share.
 *
 * WHY A HOST INTERFACE RATHER THAN A CLASS.
 *
 * The camera reads a great deal of the scene (her seat, her facing, the
 * soil, the walker) and writes a little of it back. Wrapping that in a
 * class would mean either handing it the whole scene anyway or copying
 * state in and out every frame, and the second of those is how a camera
 * starts lagging a frame behind the body it is following.
 *
 * So these stay free functions over an explicitly declared surface. The
 * interface below IS the seam: it is the complete list of what the camera
 * is allowed to touch, and it is checked by the compiler. `IslandScene`
 * hands itself over with one cast at three call sites, which keeps `private`
 * meaningful for the other two hundred members that are none of the
 * camera's business.
 */
import * as THREE from 'three';
import type { QueenModel } from '../anim/QueenModel';
import type { SurfaceWalker } from '../world/surfaceWalk';
import type { IslandSoil } from '../world/islandSoil';
import { CELL_SIZE, MM } from '../world/worldScape';
import { chamberBox, chamberNorm, type ChamberBox } from './ChamberMovement';
import {
  CAMERA_SKIN, EYE_SKIN, EYE_RISE, EYE_FORWARD, EYE_SNAP,
  EYE_FOLLOW_MS, EYE_FOLLOW_RATE, EYE_ROLL_RATE, EYE_MARCH_STEPS,
  EYE_BISECTIONS, FPV_LIFT_RAD, FPV_LIFT_SOFT_MM, FPV_LIFT_HARD_MM,
  FPV_LIFT_RATE, HEAD_PROBE_AT, HEAD_PROBE_DIR, HEAD_PROBE_RIGHT,
  HEAD_PROBE_REACH, HEAD_PROBE_BISECTIONS, HEAD_PITCH_RATE,
  FAN_SWING, FAN_RISE, CHASE_MIN, LOOK_HOLD_S, LOOK_RETURN_RATE,
  CHASE_PITCH, CHASE_PITCH_MIN, CHASE_PITCH_MAX, CHASE_GROUND_CLEAR,
  CHASE_REACH, RIDE, BONE_FWD, CHAMBER_CAM_FAR, CHAMBER_CAM_NEAR,
  S_CENTER, S_FWD, S_LENS_CORNER, S_LENS_FWD, S_LENS_OUT, S_LENS_RIGHT,
  S_LENS_STEP, S_LENS_UP, S_NOSE, S_PERP, S_RAD, S_RIGHT, S_ROLL,
  S_TARGET, S_UP,
} from './islandTuning';

/**
 * EVERYTHING THE CAMERA MAY TOUCH, and nothing else.
 *
 * Deliberately explicit rather than `IslandScene`: naming the surface is
 * the point of the split. A camera that starts needing a fourteenth field
 * has to say so here, in a diff someone will read.
 */
export interface CameraHost {
  /* --- read only in practice: where she is and how she is standing --- */
  readonly camera: THREE.PerspectiveCamera;
  readonly queen: QueenModel;
  readonly at: THREE.Vector3;
  readonly up: THREE.Vector3;
  readonly fwd: THREE.Vector3;
  readonly crosshair: HTMLElement;
  queenReady: boolean;
  walker: SurfaceWalker | null;
  soil: IslandSoil | null;
  aimPitch: number;
  digMode: boolean;
  firstPerson: boolean;
  underground: boolean;
  chamberCam: number;
  lookPointer: number | null;

  /* --- the camera's own state, which is all written here --- */
  camPitch: number;
  camDist: number;
  camWant: THREE.Vector3 | null;
  camLook: THREE.Vector3 | null;
  camRoll: THREE.Vector3;
  eyeAt: THREE.Vector3 | null;
  readonly eyeFwd: THREE.Vector3;
  readonly eyeRoll: THREE.Vector3;
  readonly lookDir: THREE.Vector3;
  lookYaw: number;
  lookPitch: number;
  lookIdle: number;
  fpvLift: number;
  /** Her neck's eased angle — the damper on the head clamp. */
  headPitchNow: number;
  headClearMm: number;
  lensWorstMm: number;

  /* --- the soil, asked the scene's way so the cache is shared --- */
  walkGroundAt(x: number, z: number): number;
  soilSolidAt(x: number, y: number, z: number): boolean;
  soilDensityAt(x: number, y: number, z: number): number;
}

/**
 * HOW FAR THE PICTURE REACHES PAST THE LENS — the radius the guards
 * actually have to keep clear, and the reason they were not keeping it.
 *
 * Every clearance test here asked whether the camera's own POINT was in
 * air. A camera is not a point: it draws everything past its near plane,
 * whose four corners stand off to the side of that point. At the dig
 * view's 100-degree field on a phone's aspect that corner is 1.5 mm from
 * the lens, while the margins being defended were EYE_SKIN 0.5 mm and
 * CAMERA_SKIN 0.15 mm — so a lens sitting a legal half-millimetre off the
 * bark still had a millimetre of wood inside its own frustum, and drew
 * it. That is the terrain coming through the picture while every guard
 * reports itself satisfied.
 *
 * Derived from the live camera rather than typed as a constant, because
 * arming DIG swaps the field of view to 100 and a rotation changes the
 * aspect: the number this has to beat moves while she plays.
 */
export function lensClearance(host: CameraHost): number {
  const cam = host.camera;
  const halfH = cam.near * Math.tan((cam.fov * Math.PI) / 360);
  const halfW = halfH * cam.aspect;
  return Math.hypot(cam.near, halfH, halfW) + CAMERA_SKIN;
}

/**
 * THE WORST OF THE FOUR CORNERS the picture actually starts at, tested as
 * POINTS rather than inferred from a radius.
 *
 * v0.0.78 defended a sphere of `lensClearance` around the lens, on the
 * assumption that the soil field's magnitude is a distance. It is not.
 * Measured at a failing frame: the lens sat clear by the full margin
 * while a corner 1.51 mm away read +1.18 mm INSIDE — density had swung
 * 2.84 mm over 1.51 mm of travel, a gradient of 1.9, because this field
 * is a blend of a heightfield, a carved window and the tree's own solid
 * and none of them promise unit slope. A radius argued in density units
 * is therefore not the millimetres it claims to be, and the only honest
 * test of "is soil in frame" is to ask at the corners themselves.
 *
 * Four probes, and they replace the guesswork rather than adding to it.
 */
export function frustumWorstAt(
  host: CameraHost,
  at: THREE.Vector3, fwd: THREE.Vector3, up: THREE.Vector3,
): number {
  let worst = host.soilDensityAt(at.x, at.y, at.z);
  for (let i = 0; i < 4; i += 1) {
    const c = lensCorner(host, at, fwd, up, i);
    const d = host.soilDensityAt(c.x, c.y, c.z);
    if (d > worst) worst = d;
  }
  return worst;
}

/** One near-plane corner, i in 0..3. */
export function lensCorner(
  host: CameraHost,
  at: THREE.Vector3, fwd: THREE.Vector3, up: THREE.Vector3, i: number,
): THREE.Vector3 {
  const cam = host.camera;
  const halfH = cam.near * Math.tan((cam.fov * Math.PI) / 360);
  const halfW = halfH * cam.aspect;
  const right = S_LENS_RIGHT.crossVectors(fwd, up).normalize();
  return S_LENS_CORNER.copy(at)
    .addScaledVector(fwd, cam.near)
    .addScaledVector(right, halfW * (i < 2 ? -1 : 1))
    .addScaledVector(up, halfH * (i % 2 === 0 ? -1 : 1));
}

/*
 * TRIED AND REJECTED, recorded so it is not tried twice: running this
 * guard on `soilSolidAt` instead: a rounded lattice read is three times
 * cheaper than the interpolated one, and five reads per probe is the
 * guard's whole cost. It measured no faster than the noise — the
 * expense is the tree and scrub unions inside either query, not the
 * interpolation — and it broke the thing the guard is for: rounding
 * disagrees with the surface the mesher actually draws, so the boolean
 * came back clear while the picture still had dirt in it. Escapes in
 * the dig scenario went from 9 frames of 300 to 78. The guard reads the
 * same field the geometry is built from, or it guards nothing.
 */

/**
 * The lens's own basis for the guard, which cannot read the camera's
 * matrix: the guard runs BEFORE `lookAt`, so `matrixWorld` still holds
 * last frame's orientation. First person hands in the ray it is about to
 * look down; the chase hands in the line to her.
 */
export function lensBasis(
  host: CameraHost,
  fwdOut: THREE.Vector3, upOut: THREE.Vector3, look?: THREE.Vector3,
): void {
  if (look) fwdOut.copy(look).normalize();
  else fwdOut.copy(host.at).sub(host.camera.position);
  if (fwdOut.lengthSq() < 1e-12) fwdOut.set(0, 0, 1);
  fwdOut.normalize();
  upOut.copy(host.camera.up);
  upOut.addScaledVector(fwdOut, -upOut.dot(fwdOut));
  if (upOut.lengthSq() < 1e-12) upOut.set(0, 1, 0).addScaledVector(fwdOut, -fwdOut.y);
  upOut.normalize();
}

/**
 * GUARD THE TARGET, SMOOTH THE LENS — and the order is the whole fix.
 *
 * This used to run on `camera.position` AFTER the two-pole smoothing
 * had already placed it, so every frame the guard answered a different
 * intermediate position with a different instantaneous shove. Panning
 * down to line up a dig is the case that exposes it: the drag drives
 * `lookPitch`, the chase arm's elevation is `CHASE_PITCH - lookPitch`
 * so the arm FALLS, the falling arm brings the lens toward the ground,
 * and the guard pushes it back — pan, shove, pan, shove, at frame rate.
 * Reported from the phone as the camera fighting itself, and correctly
 * blamed on panning down rather than on digging.
 *
 * Neither half was wrong. The arm is right to fall and the guard is
 * right to push; what was missing is that the push was never smoothed
 * by anything. Cleared on the TARGET, the correction goes through the
 * same filters the arm already has and arrives as part of the camera's
 * motion instead of on top of it.
 */
/**
 * The lens is never under the dirt, whichever camera placed it.
 *
 * Three paths put the camera somewhere — her own eyes, the underground
 * chase, the shoulder orbit — and each had its own idea of clearance or
 * none at all. This runs after all of them: lift to a floor's own skin
 * depth, then, if the point is still INSIDE something (a roof, a wall
 * it swung into), climb until it is not.
 */
export function liftCameraClear(host: CameraHost, look?: THREE.Vector3, point?: THREE.Vector3): void {
  const p = point ?? host.camera.position;
  const walker = host.walker;
  if (!walker) return;
  /*
   * THE CHEAP QUESTION FIRST. The corner test costs five field reads
   * and the march can cost fifty; the lens spends most of the game
   * nowhere near soil, and ONE read settles those frames. The bound is
   * deliberately generous because this field's magnitude is not a
   * distance (see `frustumWorstAt`) — the steepest gradient measured
   * was 1.9, so three times the clearance has margin to spare.
   *
   * It buys nothing while she digs, where the lens is at the working
   * face by definition. It buys everything in the other 95% of play.
   */
  const clear = lensClearance(host);
  const middle = host.soilDensityAt(p.x, p.y, p.z);
  if (middle < -clear * 3) { host.lensWorstMm = middle * MM; return; }
  /* The four corners the picture starts at — see `frustumWorstAt`. */
  const fwd = S_LENS_FWD;
  const up = S_LENS_UP;
  lensBasis(host, fwd, up, look);
  host.lensWorstMm = frustumWorstAt(host, p, fwd, up) * MM;
  if (host.lensWorstMm <= 0) return;
  /*
   * OUT ALONG THE SOIL'S OWN NORMAL — the shortest way to air, and the
   * only direction that works on every surface.
   *
   * This used to climb in +Y, which is the way out of a floor and the way
   * further INTO a ceiling: pressed against the roof of a tunnel it
   * marched the lens deeper the whole length of its search and gave up
   * still buried, which is the ground coming through the picture. The
   * gradient points out of whatever it is actually inside, so a roof, a
   * wall and a floor are one case.
   */
  /* Its OWN scratch, never the caller's — see `S_LENS_OUT`. */
  const out = S_LENS_OUT.set(0, 1, 0);
  walker.normalAt(p, out);
  /*
   * A COARSE WALK, THEN A BISECTION — not forty-five fine steps.
   *
   * The old march advanced one CAMERA_SKIN at a time and paid five
   * field reads at every one of them, which is most of what the guard
   * cost. Eight strides find the boundary and four halvings put it back
   * within a skin, for a twelfth of the reads and the same answer.
   */
  const span = RIDE * 4 + clear;
  const step = span / 8;
  const probe = S_LENS_STEP;
  /*
   * BEST EFFORT, NOT ALL OR NOTHING. A bore barely wider than the
   * frustum has no spot where all four corners come clear, and the old
   * rule — walk the whole march, then jump to her centre — threw away
   * every partial improvement it had already found and put the lens
   * inside her instead. Remembering the least-bad offset means a tunnel
   * too tight to satisfy still gets the emptiest picture available, and
   * the fallback to her position only wins when it is genuinely better.
   */
  for (let i = 1; i <= 8; i += 1) {
    const d = step * i;
    probe.copy(p).addScaledVector(out, d);
    /* The whole frustum has to come clear, not just the lens: stopping
     * when the POINT escapes is what left a corner in the soil. */
    if (frustumWorstAt(host, probe, fwd, up) <= 0) {
      /* Somewhere between the last stride and this one it came clear.
       * Four halvings land within a skin of the true boundary, so the
       * lens still sits as close to her as the soil allows. */
      let lo = d - step;
      let hi = d;
      for (let k = 0; k < 4; k += 1) {
        const mid = (lo + hi) / 2;
        probe.copy(p).addScaledVector(out, mid);
        if (frustumWorstAt(host, probe, fwd, up) > 0) lo = mid; else hi = mid;
      }
      p.addScaledVector(out, hi + CAMERA_SKIN);
      host.lensWorstMm = frustumWorstAt(host, p, fwd, up) * MM;
      return;
    }
  }
  /* Nothing clear anywhere along the normal — a bore no wider than the
   * picture. Her own position is provably open, because she is standing
   * in it, so the lens goes there rather than staying in the wall. */
  p.copy(host.at);
  host.lensWorstMm = frustumWorstAt(host, p, fwd, up) * MM;

  /* Buried deeper than the search — the only place certainly in air is
   * where she is, so fall back on her and let the next frame ease out. */
  p.copy(host.at);
}

/**
 * THE BACKSTOP FORGETS ITS OWN CORRECTION — and that, not a missing
 * damper, is the jitter.
 *
 * A first cut here eased this correction like everything else in the
 * file, on the reasoning below about why it fires every frame instead of
 * rarely. Measured against `probe-lens`, that was WRONG: it cost the one
 * guarantee this backstop exists for — 32 frames out of 1,200 came back
 * with soil inside the picture, where the un-eased original had never
 * once, in any scenario, in this file's whole history. A correction that
 * takes several frames to complete is a correction that shows the thing
 * it exists to hide, for those frames. Smoothing it was never safe.
 *
 * The real fault is `settleEye` (below): it keeps its OWN memory of the
 * lens position, `eyeAt`, and copies that into `camera.position` every
 * single frame. This backstop was correcting `camera.position` alone —
 * so the instant it fixed the picture, the NEXT frame's `settleEye` call
 * overwrote the fix with the stale, uncorrected `eyeAt` and dragged the
 * lens straight back into the soil, and the backstop fired again to
 * correct it again. Every individual frame's FINAL position was clean,
 * which is why `probe-lens` — which only ever samples the settled end of
 * a frame — saw nothing wrong for as long as this file has existed. A
 * human eye sees the whole sequence, not just its end, and a full-strength
 * correction repeating every frame is indistinguishable from a shake.
 * That is what "needs a damper of sorts" was actually describing.
 *
 * So the fix is not to slow the correction down; it is to stop
 * forgetting it. The correction stays instant — `probe-lens` is the
 * proof that it must — and `eyeAt` is written through at the same time,
 * so next frame's filter starts from where the picture actually is
 * rather than from where it was a frame before the backstop last moved
 * it. With nothing left to silently undo, the backstop simply does not
 * need to fire again next frame, and the repeat-every-frame shake — not
 * the correction itself — is what stops.
 */
export function settleLensBackstop(host: CameraHost, look?: THREE.Vector3): void {
  const p = host.camera.position;
  if (host.soilDensityAt(p.x, p.y, p.z) <= 0) return;
  liftCameraClear(host, look, p);
  if (host.eyeAt) host.eyeAt.copy(p);
}

export function aimCamera(host: CameraHost, dt: number): void {
  /* In her eyes her own body would fill the frame — hidden there, shown
   * everywhere else (and only once her model has actually loaded). */
  host.queen.root.visible = host.queenReady && !host.firstPerson;
  host.crosshair.style.display = host.firstPerson ? '' : 'none';
  /*
   * THE ORBIT'S PITCH IS EASED ONCE, FOR EVERY VIEW — before either the
   * first-person or the underground return, so every camera that reads
   * `camPitch` reads a live one.
   */
  /*
   * THE PAN DECAYS, and the camera's elevation is its OWN number.
   *
   * It used to be `0.28 - aimPitch`, which tied the chase arm's height to
   * the dig aim — and `aimPitch` never returns to anything, so a single
   * vertical drag left the third-person view permanently off its neutral
   * with no way back. Reported as being locked at a few degrees and
   * unable to sit directly behind her. The pan is now an offset that
   * comes home; the aim is left to the shovel.
   *
   * Digging holds the pan indefinitely: there the look IS the aim.
   */
  if (host.lookPointer !== null || host.digMode) host.lookIdle = 0;
  else host.lookIdle += dt;
  if (host.lookIdle > LOOK_HOLD_S) {
    const home = 1 - Math.exp(-LOOK_RETURN_RATE * dt);
    host.lookYaw -= host.lookYaw * home;
    host.lookPitch -= host.lookPitch * home;
  }
  /*
   * ONE ANGLE, ONE OWNER. `aimPitch` is what her head is POSED with and
   * what the third-person shovel cuts along; the pan is what the player
   * asked for. Keeping them equal here means there is exactly one place
   * the number is decided, and her head visibly follows the look in both
   * views instead of staring level while the camera tips.
   */
  host.aimPitch = host.lookPitch;
  /*
   * MINUS, as it always was. `0.28 - pan` is what the third-person view
   * has done since it was written: drag DOWN and the camera climbs, so
   * you end up looking along the line she would cut. Writing it as
   * `0.28 + pan` inverted the vertical drag and squeezed its useful range
   * against the low clamp — reported as the view being messed up and the
   * movement limited. The pan is the new part; the law is not.
   */
  const wantPitch = Math.min(CHASE_PITCH_MAX,
    Math.max(CHASE_PITCH_MIN, CHASE_PITCH - host.lookPitch));
  host.camPitch += (wantPitch - host.camPitch) * Math.min(1, dt * 6);
  /*
   * The lens's flinch is FIRST-PERSON STATE, and a view change is a hard
   * cut everywhere in this rig — so the lift is dropped the frame the view
   * leaves her head, rather than surviving in a corner to greet the next
   * first-person frame with a five-degree tilt the clearance no longer
   * asks for. (Code review's catch, not a report.)
   */
  if (!host.firstPerson) host.fpvLift = 0;
  if (host.firstPerson) {
    /* Her own eyes: at the head, looking where she faces; the mouse (or
     * right-half drag) turns HER, and pitch is a look, not an orbit. On
     * the rail the eyes follow the BORE's axis — looking up a vertical
     * shaft means looking up it, not at its wall. */
    /*
     * THE EYE LOOKS DOWN THE CUT'S OWN RAY.
     *
     * `boreAim` is the line the shovel works along, so the camera takes
     * it whole — same origin, same direction — and the crosshair then
     * covers exactly what the next stroke removes. The eye used to sit
     * a little above and ahead of her on her FACING instead, which is a
     * different ray, and the two disagreed by more the further out you
     * looked.
     */
    /*
     * HER FRAME, because the eye is IN HER HEAD.
     *
     * A world frame here rolls the whole view ninety degrees the moment
     * she is on a trunk — her up is horizontal and the lens insists on
     * the sky's, so the bark ends up down one side of the screen and a
     * left-right pan swings around an axis that is nothing to do with
     * her. Reported exactly that way. The dial still reads against the
     * world; only the picture rides her body.
     */
    /*
     * THE BONE GIVES THE LENS ITS PLACE, AND NOTHING ELSE.
     *
     * Mounting the ORIENTATION on the head bone as well was an
     * over-reach, and it cost twice. Her head carries the gait's own
     * movement, which arrived at the lens as shake; and her head's up is
     * the surface normal under her, which rolled the horizon on every
     * slope — reported as the view being tilted when it should be
     * straight ahead. Neither is what "put the camera in her head"
     * asked for. The POSITION still comes off the bone, which is the
     * part that was wanted: the lens sits where her eyes are and goes
     * where they go.
     *
     * So the frame is hers-the-animal's again — the body her legs and
     * the walker maintain, which is smooth by construction and already
     * measured dead still at rest — with the player's pan on top.
     */
    const fwd = S_FWD.copy(host.fwd);
    const upv = S_UP.copy(host.up);
    /*
     * THE BONE TAKES THE WHEEL WHEN THE THUMB LETS GO. Left alone for
     * `LOOK_HOLD_S`, the lens's frame eases from the body's onto the
     * HEAD BONE's own facing and up — so her gait's nod, the climb's
     * tilt, the spine's posture all reach the picture — through the
     * same exponential filters that already keep the bone's shake out.
     * The moment the player drags, the share collapses to zero: the
     * look is theirs, and her head is POSED to follow it (the pose
     * reads the same angles), which is the exact handshake asked for —
     * head drives camera at rest, camera drives head under a thumb.
     */
    const boneShare = Math.min(1, Math.max(0,
      (host.lookIdle - LOOK_HOLD_S) / 0.8));
    if (boneShare > 0 && host.queenReady
      && host.queen.eyeForwardWorld(BONE_FWD)) {
      /* The bone's FACING only — its nod and its glance. Its roll stays
       * the body's: the head's up is the surface normal under her, and
       * following it tips the horizon on every slope (the v0.0.64
       * report, and the probe still pins it). */
      fwd.lerp(BONE_FWD, boneShare).normalize();
    }
    host.eyeFwd.lerp(fwd, 1 - Math.exp(-EYE_ROLL_RATE * dt));
    if (host.eyeFwd.lengthSq() < 1e-9) host.eyeFwd.copy(fwd);
    host.eyeRoll.lerp(upv, 1 - Math.exp(-EYE_ROLL_RATE * dt));
    if (host.eyeRoll.lengthSq() < 1e-9) host.eyeRoll.copy(upv);
    const baseFwd = S_NOSE.copy(host.eyeFwd).normalize();
    const baseUp = S_ROLL.copy(host.eyeRoll)
      .addScaledVector(baseFwd, -host.eyeRoll.dot(baseFwd)).normalize();
    /*
     * The pan is applied HERE rather than being read off her head, so a
     * glance is exact and instant. Her head is posed with the same angle,
     * so she still visibly looks where the player is looking.
     */
    const right = S_RIGHT.crossVectors(baseFwd, baseUp).normalize();
    /*
     * THE LENS FLINCHES BEFORE THE GROUND DOES — a few degrees of
     * camera-only up-tilt as her head's measured clearance closes.
     *
     * Rounding a corner in first person, the head rides within a
     * millimetre of the surface while the body rotates, and a lens that
     * close with a level view puts the terrain across the bottom third
     * of the frame — reported as the view being thirty percent
     * underground. Her HEAD is not tilted for it (the pose is the
     * animation's business and it is already flinching); only the
     * picture lifts, the way a person walking at a wall raises their
     * eyes before their chin. Keyed to the same measured clearance the
     * spine's flinch uses, so it fires at any speed and either corner
     * direction, and EASED because the clearance probe reads in
     * half-millimetre steps that would otherwise pop the horizon.
     */
    const closeness = Number.isFinite(host.headClearMm)
      ? THREE.MathUtils.clamp((FPV_LIFT_SOFT_MM - host.headClearMm)
        / (FPV_LIFT_SOFT_MM - FPV_LIFT_HARD_MM), 0, 1)
      : 0;
    host.fpvLift += (closeness * FPV_LIFT_RAD - host.fpvLift)
      * (1 - Math.exp(-FPV_LIFT_RATE * dt));
    const viewPitch = host.lookPitch + host.fpvLift;
    const dir = S_RAD.copy(baseFwd).applyAxisAngle(right, viewPitch).normalize();
    const steadyFwd = S_NOSE.copy(dir);
    const steadyUp = S_ROLL.copy(baseUp).applyAxisAngle(right, viewPitch).normalize();
    /* The dig reads this: the crosshair is the centre of the frame, so
     * the cut has to run down the line the frame was built on. */
    host.lookDir.copy(dir);
    /*
     * Forward of her centre so her own back does not fill the frame —
     * but ALONG THE AIM, so the eye stays on the cut's line. And never
     * through the wall: the offset walks back until the lens is in air
     * with a little to spare, and her centre is always air, so there is
     * always somewhere to retreat to.
     *
     * The rise is off HER back, along her own up: an ant's eyes are at
     * the top of her head, and a lens on her centre-line reads as looking
     * out of her chest. On a ceiling that rise points at the floor, which
     * is where the top of her head actually is.
     */
    /*
     * THE ANCHOR IS HER HEAD, not a point invented from her root.
     *
     * `root + up * EYE_RISE` inherits every sub-millimetre re-seat the
     * walker makes, undamped, and knows nothing about where her face
     * actually is. The rig does. `eyeWorldPosition` is the head joint
     * raised and pushed forward by the head's own measured radius; the
     * old sum stays as the fallback for the second before the model has
     * loaded, which is the only time it is right about anything.
     */
    const base = S_CENTER;
    if (!(host.queenReady && host.queen.eyeWorldPosition(base))) {
      base.copy(host.at).addScaledVector(upv, EYE_RISE);
    }
    /*
     * THE RETREAT IS CONTINUOUS NOW, and that was a real bug.
     *
     * It used to step `t` down from 1 in fifths, so the lens had five
     * legal positions and near a wall the accepted one flipped between
     * neighbours frame to frame — a hard pop of a fifth of `EYE_FORWARD`,
     * every frame, which is the shaking AND the ground coming through the
     * lens. Bisecting finds the furthest clear point on the line instead,
     * so the eye slides in and out of cover smoothly and lands somewhere
     * different only when the world is actually different.
     */
    const eye = S_TARGET.copy(base);
    /* The eye's own retreat clears the FRUSTUM too — see `lensClearance`.
     * EYE_SKIN alone let the lens stop half a millimetre off a wall the
     * near plane was already a millimetre inside of. */
    /*
     * THE MARCH ASKS "IS THIS A WALL", NOT "IS THIS ROOMY" — and that
     * distinction is the shake.
     *
     * This test used to defend `max(EYE_SKIN, lensClearance(host))`, about
     * 1.0 mm, on the reasoning that the lens should not stop half a
     * millimetre off a wall the near plane is already inside of. True aim,
     * wrong place. A bore is barely wider than the clearance by
     * construction, so demanding a full millimetre of air EVERYWHERE along
     * a 1.3 mm line puts the predicate permanently on a tangency: the
     * density along the ray humps up to graze the threshold near her head
     * and falls away again further out.
     *
     * A grazing threshold has no continuous answer. `first crossing` jumps
     * from "just past her head" to "the whole line is fine" the instant the
     * hump moves by a micron — and her idle re-seat moves the head anchor
     * by microns every frame. Measured, standing perfectly still, aimed 70
     * degrees down in a dig: the solver alternated between `firstBlocked =
     * 0.25` and `firstBlocked = -1` on strictly alternating frames, a
     * 1.08 mm swing in the eye target, forever, which the filter turned
     * into a 0.17 mm two-frame buzz. That is the "camera shakes when
     * pointing down, worse while digging" report, and it is why the
     * previous fix — making the retreat continuous by bisecting — did not
     * hold: the bisection was sharpening a boundary that was itself
     * appearing and vanishing.
     *
     * So the march defends EYE_SKIN, which is a WALL test and has better
     * than a millimetre of margin here, and the clearance the near plane
     * wants is left to `liftCameraClear` below — which owns exactly that
     * question, measures the whole frustum rather than one ray, and runs on
     * this same point a few lines down. One concern, one owner.
     *
     * The second read this used to AND in — taken a whole skin FURTHER
     * along a line only 1.3 mm long — goes with it. It vouched for a point
     * 77% of the line beyond the one being tested, so the predicate was not
     * even monotonic in `t`.
     */
    const skin = EYE_SKIN;
    const clearAt = (t: number): boolean => host.soilDensityAt(
      base.x + dir.x * EYE_FORWARD * t,
      base.y + dir.y * EYE_FORWARD * t,
      base.z + dir.z * EYE_FORWARD * t) <= -skin;
    /*
     * MARCHED, NOT JUST TESTED AT THE END — the lens must stay in HER air.
     *
     * `clearAt(1)` alone asks only whether the far END of the line is in
     * air, and through the thin wall of a bore the answer is yes: the line
     * punches the crust and lands in the open air beyond it, the camera
     * sets up outside the world looking back in, and the player sees the
     * sky box through the dirt — reported, with a screenshot, from inside
     * a dig. So the line is walked in short steps from her head outward
     * and stops at the last clear point BEFORE the first solid one; the
     * bisection then only sharpens that boundary. The eye can no longer
     * be anywhere she could not poke her own head.
     */
    let lastClear = 0;
    let firstBlocked = -1;
    for (let i = 1; i <= EYE_MARCH_STEPS; i += 1) {
      const t = i / EYE_MARCH_STEPS;
      if (clearAt(t)) lastClear = t;
      else { firstBlocked = t; break; }
    }
    if (firstBlocked < 0) {
      eye.addScaledVector(dir, EYE_FORWARD);
    } else {
      let lo = lastClear;
      let hi = firstBlocked;
      for (let i = 0; i < EYE_BISECTIONS; i += 1) {
        const mid = (lo + hi) / 2;
        if (clearAt(mid)) lo = mid; else hi = mid;
      }
      eye.addScaledVector(dir, EYE_FORWARD * lo);
    }
    /*
     * AND THEN IT IS FILTERED — the POSITION only.
     *
     * Her root is re-seated against a lattice every frame and her up is a
     * density gradient, so the eye target carries sub-millimetre noise
     * however good the anchor is. A short lag on the position removes it.
     * The LOOK is not filtered at all: it comes straight off the aim,
     * which is player input, so turning stays instant. That split is the
     * whole design — filter the body, never the intent.
     */
    /* Cleared BEFORE the filter, for the reason spelled out on
     * `liftCameraClear`: a correction applied after the smoothing is a
     * correction nothing smooths. */
    liftCameraClear(host, dir, eye);
    settleEye(host, eye, dt);
    /*
     * THE EYE'S OWN UP, TURNED WITH THE PITCH — not the world's.
     *
     * Handing `lookAt` a fixed up and a look parallel to it leaves the
     * roll undefined, and three.js picks whatever falls out of a
     * degenerate cross product. Straight down is exactly that case, and
     * digging aims her straight down all the time. Rotating the up by
     * the same pitch keeps it perpendicular to the look by construction
     * — their dot is `-cos*sin + sin*cos`, zero at every angle.
     */
    /*
     * ROTATED BY THE AIM ITSELF, not by a copy of it.
     *
     * There was a second field, `fpPitch`, written only by the look-drag.
     * Anything else that moved the aim — a key, a test, a scripted view —
     * left it behind, and a stale up is not a cosmetic problem: this
     * rotation exists precisely so that up stays perpendicular to the
     * look at the poles, where `lookAt` has no other way to choose a
     * roll. Measured with the dial at ninety, up and look were PARALLEL,
     * which is the degenerate case it was written to avoid. One number.
     */
    /*
     * Built from the same head frame and turned by the same pan, so up
     * and look cannot disagree about which body they belong to — and her
     * head's roll IS the camera's roll, which is what makes rounding onto
     * a trunk read as her leaning rather than the world tipping.
     */
    host.camera.up.copy(steadyUp);
    /* The same backstop the chase keeps, and now writing its correction
     * through to `eyeAt` too — see `settleLensBackstop`. */
    settleLensBackstop(host, dir);
    /* Aim from where the lens ACTUALLY ended up. The guard above may have
     * nudged it out of a roof, and looking at a target measured from the
     * old spot tilts the whole view by however far it moved — a pitch
     * that drifts on its own every time she brushes a ceiling. */
    const lens = host.camera.position;
    host.camera.lookAt(lens.x + dir.x, lens.y + dir.y, lens.z + dir.z);
    return;
  }
  /* The drag swings the arm off her tail and it decays back to zero, so
   * the camera returns behind her without ever holding an absolute world
   * bearing — which is the thing that stops meaning anything on a wall. */
  /* The pan's own return is handled once, for both views, in `aimCamera`
   * — it holds for `LOOK_HOLD_S` first, which this did not. */
  chaseCamera(host, dt);
}

/**
 * THE CHASE: find the open air behind her, and sit in the middle of it.
 *
 * There were two of these — a tunnel chase that followed her walked path
 * and a shoulder orbit that swung a fixed arm — and the seam between them
 * is where the camera got stuck. Stepping from the hill onto the trunk is
 * not underground and it is not open country either: the arm swung into a
 * metre of solid wood, the guard hauled it back onto her, and the view sat
 * under the ant with nothing to show. Switching to first person "fixed" it
 * because first person does not use the arm.
 *
 * So there is one camera, and instead of one arm it CASTS A FAN of them —
 * a spread of directions around where it would like to be — and asks each
 * how far it gets before it meets something. The answer is the weighted
 * mean of where those rays ended: a spot in the middle of whatever open
 * space actually exists behind her, whether that is a tunnel, the gap
 * between the trunk and the hillside, or the whole sky. Nothing about it
 * knows what a tree is, or a tunnel, which is exactly why it cannot have a
 * seam between them.
 *
 * The mean is what makes it steady. Picking the single best ray snaps
 * between candidates as she turns; averaging a dozen of them moves
 * continuously, because one ray losing its clearance only shifts the
 * average by its own share.
 */
export function chaseCamera(host: CameraHost, dt: number): void {
  const ideal = S_PERP.copy(orbitBack(host, S_RAD));
  /* A basis to sweep the fan in: across her, and the third axis. */
  const across = S_RIGHT.crossVectors(ideal, host.up);
  if (across.lengthSq() < 1e-8) across.set(ideal.z, ideal.x, ideal.y);
  across.normalize();
  const over = S_FWD.crossVectors(across, ideal).normalize();

  /*
   * THE FAN IS A FALLBACK, NOT THE RULE.
   *
   * When it always ran, it always won: in open country the downward rays
   * of the fan hit the ground within a few millimetres and the upward
   * ones ran free, so the weighted mean sat at whatever elevation the
   * ground allowed and barely moved when the drag changed the ideal.
   * That is the reported bug — the third-person view would swing left and
   * right and refuse to pitch. If the arm the player actually asked for
   * is clear, it is the answer, and the search never runs.
   */
  /*
   * ABOVE GROUND the chase is the classic one, and only that: the arm
   * the player asked for, shortened to whatever run is actually clear
   * (blocked means CLOSER to her, never a different direction), and
   * then ridden at a fixed height over the terrain — the standard
   * third-person ground rule the field asked for by name. The fan is
   * a tunnel instrument; in open country its ground-hugging rays vetoed
   * every downward pitch, which was the "limited, won't go around"
   * report.
   */
  if (!host.underground) {
    /*
     * FULL ARM FIRST, then lifted, then shortened — that order is the
     * whole fix. Shortening to the first soil hit collapsed the camera
     * onto her back whenever the ground rose behind her (which on a
     * mound is always), and the pan read as nearly dead. Instead the
     * arm keeps the distance the player owns, rides a fixed clearance
     * over whatever terrain stands under it, and only slides in toward
     * her when a ridge actually blocks the SIGHT LINE between them.
     */
    const pos = S_TARGET;
    for (const t of CHASE_REACH) {
      pos.copy(host.at).addScaledVector(ideal, host.camDist * t);
      const floor = host.walkGroundAt(pos.x, pos.z) + CHASE_GROUND_CLEAR;
      if (pos.y < floor) pos.y = floor;
      /* Sight line: her head to the lens, sampled past her own body. */
      let open = true;
      for (let i = 3; i <= 12; i += 1) {
        const k = i / 12;
        if (host.soilSolidAt(
          host.at.x + (pos.x - host.at.x) * k,
          host.at.y + 0.4 + (pos.y - host.at.y - 0.4) * k,
          host.at.z + (pos.z - host.at.z) * k,
        )) { open = false; break; }
      }
      if (open) break;
    }
    settleChase(host, pos, dt);
    return;
  }

  const straight = clearRun(host, ideal, host.camDist);
  if (straight > host.camDist * 0.92) {
    settleChase(host, S_TARGET.copy(host.at).addScaledVector(ideal, straight), dt);
    return;
  }

  const want = S_TARGET.set(0, 0, 0);
  let weight = 0;
  let bestRun = 0;
  const dir = S_CENTER;
  for (const swing of FAN_SWING) {
    for (const rise of FAN_RISE) {
      dir.copy(ideal).multiplyScalar(Math.cos(swing) * Math.cos(rise))
        .addScaledVector(across, Math.sin(swing))
        .addScaledVector(over, Math.sin(rise))
        .normalize();
      const run = clearRun(host, dir, host.camDist);
      if (run < CHASE_MIN) continue;
      if (run > bestRun) bestRun = run;
      /*
       * Weighted by how much room it found AND how close it is to where
       * the camera wanted to be. Squaring the room makes a ray that got
       * the whole way worth far more than one that got a third, so the
       * mean sits in the open rather than being dragged into a corner by
       * a crowd of stubs.
       */
      const aim = 0.3 + 0.7 * Math.max(0, dir.dot(ideal));
      const w = run * run * aim;
      want.addScaledVector(dir, run * w);
      weight += w;
    }
  }
  if (weight > 0) {
    want.multiplyScalar(1 / weight).add(host.at);
  } else {
    /*
     * Nowhere to stand at all — wedged in a crack barely her own size. Sit
     * off her back at whatever the ceiling allows and look at her; that is
     * the honest picture of being stuck, and it is never under her.
     */
    want.copy(host.at).addScaledVector(host.up, Math.max(CHASE_MIN, bestRun));
  }

  /*
   * THE ROOM CAMERA still rides on top: from a few millimetres outside a
   * chamber the view eases onto a post under its ceiling, so a room reads
   * as a PLACE the camera inhabits rather than another stretch of tube.
   */
  let roomShare = 0;
  let roomBox: ChamberBox | null = null;
  for (const node of host.soil?.plan.nodes ?? []) {
    if (node.kind !== 'chamber') continue;
    const box = chamberBox(node.x / MM, node.y / MM, node.z / MM, node.radiusMm / MM);
    const u = chamberNorm(box, host.at.x, host.at.y, host.at.z);
    const t = Math.min(1, Math.max(0,
      (CHAMBER_CAM_FAR - u) / (CHAMBER_CAM_FAR - CHAMBER_CAM_NEAR)));
    if (t > roomShare) { roomShare = t; roomBox = box; }
  }
  host.chamberCam += (roomShare - host.chamberCam) * Math.min(1, dt * 3);
  if (roomBox && host.chamberCam > 0.01) {
    want.lerp(S_UP.set(roomBox.cx, roomBox.cy + roomBox.ry * 0.55, roomBox.cz),
      host.chamberCam);
  }

  settleChase(host, want, dt);
}

/**
 * Put the first-person lens on the eye anchor, filtered.
 *
 * One exponential on the position and nothing at all on the aim, so
 * turning has no lag whatever `EYE_FOLLOW_HZ` is set to. `EYE_SNAP`
 * catches the case a filter must never smooth — a respawn, a rail grab,
 * an embed rescue — because easing across a teleport would fly the camera
 * through the island.
 */
export function settleEye(host: CameraHost, want: THREE.Vector3, dt: number): void {
  if (!host.eyeAt) host.eyeAt = want.clone();
  else if (host.eyeAt.distanceTo(want) > EYE_SNAP) host.eyeAt.copy(want);
  else host.eyeAt.lerp(want, 1 - Math.exp(-EYE_FOLLOW_RATE * dt));
  host.camera.position.copy(host.eyeAt);
}

/**
 * Ease the lens onto a chosen spot and point it at her — through three
 * filters rather than none.
 *
 * The order matters. The chosen spot is smoothed FIRST, so the pop when
 * the straight arm gives way to the fan is spread over a few tenths of a
 * second instead of landing in one frame; then the lens eases onto that
 * already-calm target, which is a two-pole filter and reads as a camera
 * rig. The look point and the up get their own, slower filters, because
 * the eye reads a shaking DIRECTION far more harshly than a shaking
 * position — an arm's length of lever turns a 1 mm wobble in her seat
 * into a couple of degrees of picture.
 */
export function settleChase(host: CameraHost, want: THREE.Vector3, dt: number): void {
  if (!host.camWant) host.camWant = want.clone();
  /* Faster when the target has run away — squeezing through a gap should
   * not leave the lens lagging inside the wall — but never instant. */
  const jump = host.camWant.distanceTo(want);
  host.camWant.lerp(want, 1 - Math.exp(-(jump > host.camDist ? 12 : 5) * dt));

  /* The clearance is applied HERE, to the smoothed target, so it is
   * carried by the filter below rather than added after it. */
  liftCameraClear(host, undefined, host.camWant);

  const gap = host.camera.position.distanceTo(host.camWant);
  const rate = gap > host.camDist ? 14 : 7;
  host.camera.position.lerp(host.camWant, 1 - Math.exp(-rate * dt));
  /*
   * A BACKSTOP, not a second guard: the lens is somewhere between its
   * old spot and a target already known to be clear, so it can only be
   * inside soil while crossing a thin lip. That is worth correcting and
   * is not worth another full search — and because the target is clear,
   * this fires on a handful of frames instead of every one. Shares first
   * person's fix too, harmlessly: the chase keeps no separate position
   * memory for the correction to be undone by (`camera.position` IS its
   * own memory here), so `settleLensBackstop`'s `eyeAt` write is simply a
   * no-op in this view — see the note on it.
   */
  settleLensBackstop(host);

  const look = S_UP.copy(host.at).addScaledVector(host.up, 0.3);
  if (!host.camLook) host.camLook = look.clone();
  /* A filter is for jitter, not for teleports: if she has been MOVED —
   * a respawn, a rail grab, an embed rescue — following her over half a
   * second would sweep the whole island past the lens. */
  if (host.camLook.distanceTo(look) > host.camDist * 3) host.camLook.copy(look);
  host.camLook.lerp(look, 1 - Math.exp(-9 * dt));
  /*
   * The up is filtered as a DIRECTION and renormalised, so easing it can
   * never shorten it to nothing on the way between two opposed ups —
   * which is what walking round the underside of a branch asks for.
   */
  host.camRoll.lerp(host.up, 1 - Math.exp(-7 * dt));
  if (host.camRoll.lengthSq() < 1e-6) host.camRoll.copy(host.up);
  host.camera.up.copy(host.camRoll).normalize();
  host.camera.lookAt(host.camLook.x, host.camLook.y, host.camLook.z);
}

/**
 * How far a ray out of her centre gets before it meets something, capped
 * at `max`. Her own centre is always air, so this always has an answer.
 */
/**
 * Her head follows the look — but never INTO the hill or the bark.
 * Climbing tips her frame until "ahead" can point straight at the
 * surface she stands on, and posing the neck with the raw look then
 * buries her face in it — reported from the trunk and from cresting a
 * hole. Probe a face-length along the would-be look from her eyes
 * (soil, trunk and scrub all answer through `soilDensityAt`) and back
 * the pitch off by halves until that point is air.
 */
export function clampedHeadPitch(host: CameraHost): number {
  const want = host.lookPitch;
  /*
   * THE PROBE STARTS AT HER NECK, NOT AT HER POSED FACE — and that is the
   * shake, not a detail of where to measure from.
   *
   * This used to probe from `eyeWorldPosition`, which is the head joint
   * AFTER the pose this function decides. So the answer moved the head,
   * and the moved head changed the answer: a closed loop, sampled once a
   * frame, with no damping anywhere in it. Measured standing perfectly
   * still, aimed 70 degrees down in a dig, her head pitch alternated
   * -35 / -70 / -35 / -70 degrees on strictly alternating frames — a
   * 35-degree head flip at 60 Hz — and in first person the lens is
   * mounted on that head. That is the "camera shakes when pointing down,
   * worse while digging" report.
   *
   * Her neck is the PIVOT of the rotation being clamped, so it barely
   * moves when the head pitches, and probing from it makes this a pure
   * question about her body and her aim. The loop is gone rather than
   * damped: nothing this returns can change what it reads next frame.
   *
   * It is the same anchor the eye code falls back to before her model has
   * loaded, for the same reason — it is the one point on her that the
   * head pose provably does not move.
   */
  HEAD_PROBE_AT.copy(host.at).addScaledVector(host.up, EYE_RISE);
  HEAD_PROBE_RIGHT.crossVectors(host.fwd, host.up);
  if (HEAD_PROBE_RIGHT.lengthSq() < 1e-8) return want;
  HEAD_PROBE_RIGHT.normalize();
  const buried = (pitch: number): boolean => {
    HEAD_PROBE_DIR.copy(host.fwd).applyAxisAngle(HEAD_PROBE_RIGHT, pitch);
    return host.soilDensityAt(
      HEAD_PROBE_AT.x + HEAD_PROBE_DIR.x * HEAD_PROBE_REACH,
      HEAD_PROBE_AT.y + HEAD_PROBE_DIR.y * HEAD_PROBE_REACH,
      HEAD_PROBE_AT.z + HEAD_PROBE_DIR.z * HEAD_PROBE_REACH,
    ) > 0;
  };
  if (!buried(want)) return want;
  /*
   * BISECTED, NOT HALVED. Backing off `pitch *= 0.5` gave this four legal
   * answers and nothing in between, so a hair of terrain movement moved
   * her head by tens of degrees. Level is always safe — she cannot bury
   * her face by looking where she is standing — so the furthest pitch
   * that keeps her face in air is bracketed between 0 and the ask, and
   * that boundary is a continuous function of both.
   */
  let lo = 0;
  let hi = want;
  for (let i = 0; i < HEAD_PROBE_BISECTIONS; i += 1) {
    const mid = (lo + hi) / 2;
    if (buried(mid)) hi = mid; else lo = mid;
  }
  return lo;
}

/**
 * Ease her head onto what the soil allows.
 *
 * The clamp above is now loop-free and continuous, so it no longer
 * oscillates on its own — but it is still a geometric answer that can
 * change fast when she crests a lip or breaks through a face, and a neck
 * that snaps tens of degrees in one frame reads as a flinch whether or
 * not it is correct. This is the damper: her head TURNS to the allowed
 * pitch rather than being teleported to it.
 *
 * Rate-limited rather than exponential, so the neck has an honest angular
 * speed instead of a long asymptotic tail that never quite arrives.
 */
export function settleHeadPitch(host: CameraHost, want: number, dt: number): number {
  const swing = HEAD_PITCH_RATE * dt;
  const gap = want - host.headPitchNow;
  host.headPitchNow += Math.max(-swing, Math.min(swing, gap));
  return host.headPitchNow;
}

export function clearRun(host: CameraHost, dir: THREE.Vector3, max: number): number {
  const step = CELL_SIZE * 0.6;
  for (let d = step; d <= max; d += step) {
    if (host.soilSolidAt(
      host.at.x + dir.x * d, host.at.y + dir.y * d, host.at.z + dir.z * d,
    )) return Math.max(0, d - step - CAMERA_SKIN);
  }
  return max;
}

/**
 * The orbit arm, built in HER frame: back along her nose, swung off it by
 * the drag, and raised by the pitch — all about her own up.
 *
 * The old arm was `(sin lookYaw, 0, cos lookYaw)` with a world-vertical
 * rise, which is a rig bolted to the horizon. Underground the horizon is
 * not a thing she has: in a shaft her up is horizontal, and a camera that
 * insists on world vertical sits in the wall looking at dirt.
 */
export function orbitBack(host: CameraHost, into: THREE.Vector3): THREE.Vector3 {
  const nose = S_NOSE.copy(host.fwd).applyAxisAngle(host.up, host.lookYaw);
  return into.copy(nose).negate().multiplyScalar(Math.cos(host.camPitch))
    .addScaledVector(host.up, Math.sin(host.camPitch)).normalize();
}

