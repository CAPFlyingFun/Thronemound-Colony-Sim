/**
 * THE OBSERVER'S CAMERA — because the player is not an ant any more.
 *
 * Thronemound's new identity puts the player outside the glass: "I build a
 * habitat, introduce a Queen, and watch." Watching is the verb, so the
 * camera is not a convenience here, it is the entire interface. A lab you
 * cannot look around in is a lab whose ant you cannot judge, which makes
 * this a requirement of reviewing Milestone 0 rather than an extra.
 *
 * IT DOES NOT STEER THE ANT, and that distinction is the one the milestone's
 * "no player input required" line is about. Nothing here reaches the
 * simulation; it moves a point of view. She walks whether anyone is looking
 * or not.
 *
 * ORBIT, NOT FLY. A formicarium is a box on a table and the natural way to
 * look at one is to walk around it: drag to swing, pinch or wheel to come
 * closer, and the pivot stays in the tank. A free-flying camera in a world
 * 48 cm across mostly finds the outside of the glass.
 *
 * PROVISIONAL, on purpose. Lab 08 owns the real camera work — cutaway soil,
 * underground framing, inspecting an ant. This is the minimum that makes the
 * habitat reviewable, and it is one small file so replacing it is a deletion
 * rather than an excavation.
 */

import * as THREE from 'three';

/** How far the pitch may swing, in radians — just under straight down and
 *  just above the horizon, so the world never flips. */
/**
 * HOW FAR UNDER THE TANK THE VIEW MAY GO.
 *
 * Was 0.08 — a hair above the horizon, so the tray could be circled and
 * never looked UNDER. That was fine while everything happened on the
 * surface; it is not fine now that she digs to the bottom of it. Joshua:
 * "would be nice ... to move all around from top to bottom to see when they
 * dig underneath the tank."
 *
 * Stops just short of straight up from below for the same reason `PITCH_MAX`
 * stops short of straight down: at the pole the yaw has nothing to swing
 * about and the view spins on its own axis.
 */
const PITCH_MIN = -(Math.PI / 2 - 0.05);
const PITCH_MAX = Math.PI / 2 - 0.05;

/** Zoom rails, in world units (one unit is five millimetres). */
const DIST_MIN = 4;
const DIST_MAX = 400;

/** How fast the view eases toward where it has been asked to be. */
const EASE = 9;

/** Radians of swing per pixel dragged. */
const DRAG_SENSITIVITY = 0.006;

export class ObserverCamera {
  /** What the camera looks at. */
  readonly pivot = new THREE.Vector3();

  /** Where it is asked to look — eased toward, so a follow does not snap. */
  private readonly want = new THREE.Vector3();

  private yaw = Math.PI * 0.25;

  private pitch = 0.62;

  private distance = 60;

  private wantDistance = 60;

  /** A live target to keep in the middle, or null to hold still. */
  follow: (() => THREE.Vector3 | null) | null = null;

  private readonly pointers = new Map<number, { x: number; y: number }>();

  /** The pinch span at the last frame, for two-finger zoom. */
  private pinch = 0;

  private gone = false;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly dom: HTMLElement,
  ) {
    dom.addEventListener('pointerdown', this.onDown);
    dom.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    /* The canvas owns the gesture: without this a drag scrolls the page on a
     * phone and the camera never sees the second half of it. */
    dom.style.touchAction = 'none';
  }

  /** Point it at something, from a sensible distance. */
  frame(at: THREE.Vector3, distance = this.wantDistance): void {
    this.pivot.copy(at);
    this.want.copy(at);
    this.distance = distance;
    this.wantDistance = distance;
    this.apply();
  }

  /**
   * FIT A BOX ON SCREEN — and this is what "recentre on rotation" means.
   *
   * A portrait phone turned landscape does not merely get wider: its
   * VERTICAL field of view is unchanged while the horizontal grows, so a
   * subject framed to fill a tall screen sits half off a wide one. Deriving
   * the distance from the box, the lens and the CURRENT aspect is the only
   * way the same tank fills both, and it is why this takes an aspect rather
   * than remembering a number that was right once.
   */
  fit(centre: THREE.Vector3, radius: number, aspect: number): void {
    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    /* Whichever axis is tighter decides — the narrow one is what clips. */
    const need = radius / Math.sin(Math.min(vFov, hFov) / 2);
    this.wantDistance = THREE.MathUtils.clamp(need, DIST_MIN, DIST_MAX);
    this.distance = this.wantDistance;
    this.want.copy(centre);
    this.pivot.copy(centre);
    this.apply();
  }

  update(dt: number): void {
    const live = this.follow?.();
    if (live) this.want.copy(live);
    /* Eased rather than snapped: a camera pinned to a walking ant jitters
     * with her gait, and the gait is the thing being looked at. */
    const k = 1 - Math.exp(-EASE * dt);
    this.pivot.lerp(this.want, k);
    this.distance += (this.wantDistance - this.distance) * k;
    this.apply();
  }

  private apply(): void {
    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      this.pivot.x + Math.sin(this.yaw) * cp * this.distance,
      this.pivot.y + Math.sin(this.pitch) * this.distance,
      this.pivot.z + Math.cos(this.yaw) * cp * this.distance,
    );
    this.camera.lookAt(this.pivot);
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (this.gone) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) this.pinch = this.span();
    this.dom.setPointerCapture?.(e.pointerId);
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (this.gone) return;
    const was = this.pointers.get(e.pointerId);
    if (!was) return;
    const dx = e.clientX - was.x;
    const dy = e.clientY - was.y;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size >= 2) {
      /* Two fingers is a zoom, and only a zoom — swinging the world at the
       * same time as pinching it reads as the view fighting the hand. */
      const now = this.span();
      if (this.pinch > 0 && now > 0) this.zoom(this.pinch / now);
      this.pinch = now;
      return;
    }
    this.yaw -= dx * DRAG_SENSITIVITY;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + dy * DRAG_SENSITIVITY, PITCH_MIN, PITCH_MAX,
    );
    this.apply();
  };

  private readonly onUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = 0;
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (this.gone) return;
    e.preventDefault();
    this.zoom(Math.exp(e.deltaY * 0.001));
  };

  private zoom(factor: number): void {
    this.wantDistance = THREE.MathUtils.clamp(
      this.wantDistance * factor, DIST_MIN, DIST_MAX,
    );
  }

  /** The distance between the two live pointers, for a pinch. */
  private span(): number {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /* ------------------------------------------------------------- probes */

  reportForTest(): { yaw: number; pitch: number; distance: number;
    pivot: { x: number; y: number; z: number } } {
    return {
      yaw: this.yaw,
      pitch: this.pitch,
      distance: this.distance,
      pivot: { x: this.pivot.x, y: this.pivot.y, z: this.pivot.z },
    };
  }

  dispose(): void {
    this.gone = true;
    this.dom.removeEventListener('pointerdown', this.onDown);
    this.dom.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onUp);
    this.dom.removeEventListener('wheel', this.onWheel);
  }
}
