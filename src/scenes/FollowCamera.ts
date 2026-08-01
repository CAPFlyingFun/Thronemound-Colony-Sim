import * as THREE from 'three';

/** The horizon. First person is stabilised against it, never against her. */
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * How much snappier the first-person eye is than the follow rig.
 *
 * Easing is right for a camera trailing an animal and is lag on its head: you
 * look, and the view arrives afterwards. Not zero, because the stance solver
 * moves her a hundredth of a millimetre most frames and a rigid eye shows every
 * one of them.
 */
const FIRST_PERSON_SNAP = 12;

/**
 * How far the first-person eye stays clear of soil, in world units — 0.6 mm.
 *
 * Several times the near plane, because the near plane is the thing being
 * avoided: a surface closer than it is simply not drawn, and an undrawn wall is
 * a hole. Small enough that cutting a face barely shortens the offset.
 */
const EYE_CLEARANCE = 0.12;

/**
 * A third-person camera that follows an ant into a hole.
 *
 * This replaces `OrbitControls`, and the reason is not preference. Orbit
 * controls own the camera's position and derive their state FROM it, so a
 * collision fix — shortening the arm to keep the camera out of the soil — is
 * read back as the player having zoomed in, and one trip down a burrow
 * permanently shrinks the view. Working around that means keeping a shadow
 * copy of the intended distance and restoring it before every update, which is
 * two sources of truth for one number and behaved exactly as badly as that
 * usually does.
 *
 * Here the camera has no position of its own to corrupt. Every frame it is
 * computed from what the player asked for — a heading, a pitch, a distance —
 * and then shortened by whatever the world is in the way of. The player's
 * intent is never overwritten, because it is never stored in the same place as
 * the result.
 */
export interface FollowCameraOptions {
  /** How far back the camera sits when nothing is in the way, in world units. */
  distance: number;
  /**
   * Closest the world may push the arm before the rig gives up on third
   * person. It has to clear the ANIMAL, not just avoid the soil: pulled to
   * 4 mm behind a 9 mm queen the camera sat inside her thorax and rendered the
   * inside of her.
   */
  minDistance: number;
  /** Height above her the eye sits when the rig falls back to first person. */
  eyeHeight: number;
  maxDistance: number;
  /** Starting first-person eye offset in her frame. See `FollowCamera.eye`. */
  eye?: { x: number; y: number; z: number };
  /** Clearance kept between the camera and the soil. */
  clearance: number;
  /** How fast the rig catches up, per second. */
  ease: number;
}

/**
 * Which view the player wants.
 *
 * `auto` is the one worth explaining: third person above ground, where seeing
 * her walk is the point, and first person the moment she is under it, where
 * seeing her is impossible anyway and what you need is to know where the jaws
 * are pointed. Digging from behind her shoulder means aiming a tunnel you
 * cannot see the end of.
 */
export type CameraMode = 'first' | 'auto' | 'third';

export class FollowCamera {
  /** Where the camera looks. The caller keeps this on the ant. */
  readonly target = new THREE.Vector3();
  /**
   * Where the first-person eye hangs from — her BODY, not the look target.
   *
   * The two are different points and it matters underground. `target` is lifted
   * clear of her so a third-person shot frames the animal rather than her feet,
   * and inside a four-millimetre bore that lift puts it in the ROOF. Hanging
   * the eye off it therefore started every first-person frame inside the soil,
   * with the collision walk-out having nowhere clear to walk from.
   */
  readonly body = new THREE.Vector3();
  /** Which way is up for the rig — the ant's own up, so it rolls with her. */
  readonly up = new THREE.Vector3(0, 1, 0);
  /**
   * Where the first-person eye sits, IN HER FRAME: x to her right, y up, z
   * forward along her heading.
   *
   * Adjustable at runtime rather than tuned in the source, because "on the
   * queen's head" is not a number anyone can derive — it depends on the model,
   * on how much of her you want in shot, and on taste. The rig is a different
   * shape at every caste, so a constant here would be wrong for two of the
   * three ants that will eventually use it.
   */
  readonly eye = new THREE.Vector3(0, 0.55, 0.35);
  /**
   * The view the player has chosen, and whether she is currently underground.
   * `auto` reads both.
   */
  mode: CameraMode = 'auto';
  submerged = false;
  /**
   * Where the first-person view points, as a pitch from the world horizon.
   *
   * The caller sets it to the bore's angle, so looking and digging are the same
   * direction — the whole reason to be in her head is to see where the tunnel
   * is about to go.
   */
  aimPitch = 0;

  /**
   * The player's look, as an offset from her heading rather than as a world
   * angle. Dragging looks around HER; letting go leaves it where it was. An
   * absolute angle would make her turns spin the camera, which reads as the
   * world lurching every time she changes direction.
   */
  private yawOffset = 0;
  private pitch = 0.42;
  private distance: number;
  /** The smoothed position actually used, so the rig never jumps. */
  private readonly smoothed = new THREE.Vector3();
  private settled = false;
  /** True while the rig has given up on third person and is riding her head. */
  private onboard = false;
  private wasOnboard = false;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly options: FollowCameraOptions,
  ) {
    this.distance = options.distance;
    if (options.eye) this.eye.set(options.eye.x, options.eye.y, options.eye.z);
  }

  /** Radians per pixel is the caller's business; this takes radians. */
  orbit(deltaYaw: number, deltaPitch: number): void {
    this.yawOffset += deltaYaw;
    // Stopped short of straight down and of the horizon. Straight down loses
    // the heading entirely — the camera's forward becomes her up and the yaw
    // has nothing left to mean.
    this.pitch = THREE.MathUtils.clamp(this.pitch + deltaPitch, -0.35, 1.35);
  }

  zoom(factor: number): void {
    this.distance = THREE.MathUtils.clamp(
      this.distance * factor, this.options.minDistance, this.options.maxDistance,
    );
  }

  get armLength(): number {
    return this.distance;
  }

  /** Is the rig riding her head because there was no room behind her? */
  get firstPerson(): boolean {
    return this.onboard;
  }

  /**
   * The first-person eye, pulled back out of any soil it would be inside.
   *
   * The third-person arm has always marched out to the last clear point and the
   * eye had no such check, which was fine while first person was a fallback for
   * being in a tunnel — you are inside her head inside a hole, and that is the
   * shot. It stops being fine the moment the eye is offset FORWARD onto her
   * face: four millimetres ahead of her, while she is boring, is inside the
   * working face she has not dug yet, and the view renders from within the
   * terrain looking out through it.
   *
   * So the offset is walked from her body outward and stops short of solid.
   * Losing a little of the forward offset while cutting is much better than
   * losing the world.
   */
  private eyePoint(
    solidAt: (point: THREE.Vector3) => boolean,
    eyeRight: THREE.Vector3,
    flat: THREE.Vector3,
    step: number,
  ): THREE.Vector3 {
    const full = new THREE.Vector3()
      .addScaledVector(eyeRight, this.eye.x)
      .addScaledVector(WORLD_UP, this.eye.y)
      .addScaledVector(flat, this.eye.z);
    const reach = full.length();
    const at = new THREE.Vector3();
    if (reach < 1e-6) return this.body.clone();
    const direction = full.clone().divideScalar(reach);
    let usable = reach;
    /*
     * Marched PAST where the eye wants to sit, and the last sample is always
     * the far end.
     *
     * `d <= reach` steps in fixed increments, so unless the offset happens to
     * be a whole number of steps the endpoint is never tested — the loop stops
     * short and reports the gap clear on the strength of a sample before it.
     * Measured mid-bore at minus forty: her body clear of soil, every sampled
     * point clear, and the eye resting inside the wall between two of them.
     *
     * Going a clearance further also means the resting point keeps its margin
     * rather than merely being on the right side of a surface.
     */
    const probe = reach + EYE_CLEARANCE;
    const samples = Math.max(1, Math.ceil(probe / step));
    for (let i = 1; i <= samples; i += 1) {
      // Clamped, so the LAST sample is always the far end however the step
      // divides into it. Counting samples rather than accumulating a distance
      // is also what keeps this terminating.
      const d = Math.min(i * step, probe);
      at.copy(this.body).addScaledVector(direction, d);
      /*
       * Stopped a CLEARANCE short of the soil, not at the last sample that
       * happened to be clear. The third-person arm has always kept a margin and
       * this kept none, so the eye came to rest a fifth of a millimetre from a
       * wall — inside the near plane, which draws nothing and turns the wall
       * into a window. A margin several times the near plane is the difference
       * between being in a tunnel and seeing through one.
       */
      if (solidAt(at)) { usable = Math.max(0, d - step - EYE_CLEARANCE); break; }
    }
    return this.body.clone().addScaledVector(direction, usable);
  }

  /**
   * Place the camera for this frame.
   *
   * `solidAt` decides where the world is. The arm is shortened to the last
   * clear point along it rather than being lifted out of the ground: lifting
   * leaves the camera on the rim staring into the bank with the ant somewhere
   * below and out of frame, which is a different way of seeing nothing.
   */
  update(
    dt: number,
    heading: number,
    solidAt: (point: THREE.Vector3) => boolean,
    step: number,
  ): void {
    const yaw = heading + this.yawOffset;

    /*
     * Built in the ant's frame, not the world's. Her up is the tunnel floor's
     * normal, so on a slope or in a shaft the camera banks with her instead of
     * insisting on a vertical that stopped being meaningful underground.
     */
    const up = this.up.clone().normalize();
    const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    forward.addScaledVector(up, -forward.dot(up));
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, 1);
    forward.normalize();

    const back = forward.clone().negate()
      .multiplyScalar(Math.cos(this.pitch))
      .addScaledVector(up, Math.sin(this.pitch))
      .normalize();

    /*
     * How far along that arm the world lets us go, starting clear of HER.
     *
     * The march used to begin half a millimetre from the target, which on open
     * ground is inside the soil her feet are standing on — so the arm read as
     * blocked at once and the rig dropped to first person before she had dug
     * anything. Soil within a body length of her is not what the camera is
     * trying to avoid; it is the floor.
     */
    let clear = this.distance;
    const probe = new THREE.Vector3();
    for (let d = this.options.minDistance * 0.5; d <= this.distance; d += step) {
      probe.copy(this.target).addScaledVector(back, d);
      if (solidAt(probe)) {
        clear = d - this.options.clearance;
        break;
      }
    }

    /*
     * When there is not enough room behind her for a view OF her, ride her
     * head instead of squeezing closer.
     *
     * Squeezing is what the rig did, and in a tunnel it ends with the camera
     * inside the animal — a screen of blurred chitin, which is not a smaller
     * version of the third-person shot but a different and useless one. Down a
     * bore, over her shoulder is where you want to be anyway: it is the view
     * the thing being driven actually has.
     */
    /*
     * Three ways to end up in first person, and they are not the same thing.
     * The player may have asked for it outright; `auto` gives it to them the
     * moment she goes under; and whatever the setting, there may simply be no
     * room for a shot of her — that last one is the fallback the rig has always
     * had, and it stays, because "third person" cannot be honoured inside a
     * 4 mm tunnel however firmly it is requested.
     */
    const noRoom = clear < this.options.minDistance;
    this.onboard = this.mode === 'first'
      || (this.mode === 'auto' && this.submerged)
      || noRoom;

    /*
     * First person gets a LEVEL frame, not her body's.
     *
     * Her frame is the honest place to hang a camera off a third-person rig and
     * the wrong place to put an eye. It rolls with the terrain normal, tips
     * with the dig train, and settles on a lerp — so riding it, every pebble
     * she walked over banked the horizon and every stroke of the head nodded
     * the whole view. Reported as her body moving too much to look at.
     *
     * A head-mounted camera in any game that ships is stabilised. This one
     * keeps her heading and the angle she is AIMING at, and throws away the
     * rest of her motion: level horizon, no roll, no bob.
     */
    const flat = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const eyeRight = new THREE.Vector3().crossVectors(WORLD_UP, flat).normalize();
    const right = new THREE.Vector3().crossVectors(up, forward).normalize();
    const wanted = this.onboard
      ? this.eyePoint(solidAt, eyeRight, flat, step)
      : this.target.clone().addScaledVector(back, Math.max(clear, this.options.minDistance));

    /*
     * Smoothed, except the first frame and the frame the mode changes on.
     * Easing in from wherever the camera was constructed is a swoop across the
     * map; easing between a shot from behind her and a shot from her own head
     * travels straight through her body.
     */
    /*
     * And first person is barely smoothed at all.
     *
     * Easing is right for a rig trailing an animal — it is what stops the
     * camera snapping about as she turns. On her head it is lag: you look, and
     * the view arrives afterwards, which reads as swimming. Twelve times the
     * follow rate puts the eye within a frame of where it belongs while still
     * absorbing the single-frame jitter of the stance solver.
     */
    const ease = this.onboard ? this.options.ease * FIRST_PERSON_SNAP : this.options.ease;
    if (!this.settled || this.onboard !== this.wasOnboard) {
      this.smoothed.copy(wanted);
      this.settled = true;
    } else {
      this.smoothed.lerp(wanted, 1 - Math.exp(-ease * dt));
    }
    this.wasOnboard = this.onboard;

    /*
     * The SMOOTHED position gets the collision test too. Easing toward a clear
     * point still travels through whatever lies between, so a rig that only
     * checked its destination dipped through the lip of a shaft on the way
     * down — a frame or two of the inside of the world, once per descent.
     */
    if (!this.onboard && solidAt(this.smoothed)) this.smoothed.copy(wanted);

    this.camera.position.copy(this.smoothed);
    /*
     * From her head, look down the BORE — the direction she will actually dig,
     * built on the WORLD horizon so the dial and the view agree. Looking at her
     * own body instead is degenerate anyway: the target is inside the camera.
     *
     * The camera's up is world up here, not hers. Rolling the horizon with the
     * ground she stands on is a nice touch over her shoulder and motion
     * sickness from inside her head.
     */
    if (this.onboard) {
      const look = flat.clone().multiplyScalar(Math.cos(this.aimPitch))
        .addScaledVector(WORLD_UP, Math.sin(this.aimPitch));
      /*
       * Straight up and straight down are the two aims where world up cannot be
       * the camera's up: the look direction is parallel to it, `lookAt` has no
       * way to resolve the roll, and the view rolls to whatever the arithmetic
       * happens to produce. Both are reachable now that she can dig herself out
       * of a shaft, and a shaft is exactly where you are looking at one of them.
       *
       * Near vertical, the ground-plane heading takes over as up — so looking
       * straight down a shaft puts the way she is facing at the top of the
       * screen, which is the convention every map and every cockpit uses.
       */
      const vertical = Math.abs(look.dot(WORLD_UP));
      this.camera.up.copy(vertical > 0.999 ? flat : WORLD_UP);
      this.camera.lookAt(this.smoothed.clone().add(look));
    } else {
      this.camera.up.copy(up);
      this.camera.lookAt(this.target);
    }
  }
}
