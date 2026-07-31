import * as THREE from 'three';

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
    const right = new THREE.Vector3().crossVectors(up, forward).normalize();
    const wanted = this.onboard
      // Her frame, so the offset means the same thing whichever way she faces
      // and whatever she is standing on.
      ? this.target.clone()
        .addScaledVector(right, this.eye.x)
        .addScaledVector(up, this.eye.y)
        .addScaledVector(forward, this.eye.z)
      : this.target.clone().addScaledVector(back, Math.max(clear, this.options.minDistance));

    /*
     * Smoothed, except the first frame and the frame the mode changes on.
     * Easing in from wherever the camera was constructed is a swoop across the
     * map; easing between a shot from behind her and a shot from her own head
     * travels straight through her body.
     */
    if (!this.settled || this.onboard !== this.wasOnboard) {
      this.smoothed.copy(wanted);
      this.settled = true;
    } else {
      this.smoothed.lerp(wanted, 1 - Math.exp(-this.options.ease * dt));
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
    this.camera.up.copy(up);
    /*
     * From her head, look along the BORE rather than at her own body — the
     * target is inside the camera at that point, and looking at a point you
     * are standing on produces a degenerate view matrix.
     */
    if (this.onboard) {
      this.camera.lookAt(
        this.smoothed.clone().addScaledVector(forward, 1)
          .addScaledVector(up, -Math.sin(this.pitch)),
      );
    } else {
      this.camera.lookAt(this.target);
    }
  }
}
