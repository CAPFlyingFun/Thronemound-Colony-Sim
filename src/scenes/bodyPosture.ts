/**
 * HER BODY'S HEIGHT AND ATTITUDE, ON THE STICK.
 *
 * "ants have brains and can adjust their body positions and legs on the spot
 * because it knows, and we don't really have a 'Brain' that can know I am
 * climbing up a tree or there is a steep incline, so I need to adjust."
 *
 * That is the right diagnosis, and this is the first half of the answer: an
 * explicit place where a body height and a body attitude LIVE, separate from
 * the terrain that suggested them. Today a thumb writes them. Later the
 * postural controller writes them from what her feet are telling her, and
 * the thumb becomes the override and the debug view of what the controller
 * chose. Nothing downstream needs to change when that happens, which is the
 * whole reason this is its own file rather than three more fields on the
 * scene.
 *
 * ## Why the rig can already do this
 *
 * Two hooks were already there and were being driven by the gait alone:
 *
 *   - `walker.tune.ride` seats her origin at `contact + normal * ride`, so
 *     adding to it raises her whole body off the surface she is on;
 *   - `bodyLean` / `bodyBank` post-multiply a rotation onto her root about
 *     her OWN right and forward, and — as the note there says — "her feet do
 *     not hear about it: they are anchored in the world, so the legs simply
 *     take up the difference".
 *
 * That last sentence is the entire feature. Feet stay planted, the body
 * swings on them, the legs re-solve. A helicopter's hub on its rotor mast,
 * which is exactly the control the design asked for.
 *
 * ## Positional, not rate
 *
 * A held stick does NOT wind the value up like a trim wheel. Half a stick is
 * half a crouch, every time, and letting go leaves it where it was put. The
 * reason is that this is a measuring instrument before it is a control: the
 * point of posing her by hand is to find the numbers the automatic version
 * should target, and a rate control gives a different number every time your
 * thumb lingers. Reproducible beats smooth here.
 *
 * ## Holding, and coming home
 *
 * Lifting the stick HOLDS the pose — otherwise you could never set an
 * attitude and then walk with it, which is the case the crease fix needs.
 * Coming back to neutral is a deliberate act (a long press), never a
 * side effect of releasing.
 */

/** Which of the two controls owns the stick, if either. */
export type PostureMode = 'off' | 'ride' | 'tilt';

export const POSTURE_LIMITS = {
  /**
   * How far she may rise, in millimetres along her own up.
   *
   * Bounded by her LEGS, not by taste: the rig rests its feet 0.26 units
   * below her origin and reaches 1.1-1.8 mm downward, so a rise much past a
   * millimetre lifts the soles off their anchors and every leg starts
   * groping. 1.2 mm is a visible eighth of her body length and still leaves
   * the tripod something to stand on.
   */
  riseMm: 1.2,
  /**
   * And how far she may crouch. Less than the rise, because down is where
   * the ground is: `groundGuard` will bodily lift her out of soil she has
   * been pushed into, and a crouch deep enough to trip that guard fights it
   * every frame instead of looking like a crouch.
   */
  crouchMm: 0.9,
  /**
   * Cyclic authority, radians. 22 degrees across a 9 mm body moves each end
   * about 1.7 mm — enough to lift a gaster clear of a wall it is scraping,
   * which is the measurement this exists to chase.
   */
  tiltRad: (22 * Math.PI) / 180,
  /**
   * How fast the body eases to what the stick is asking for. Fast enough to
   * feel connected to the thumb, slow enough that it is a posture rather
   * than a flinch — and slow enough that the walker's re-seat can follow it
   * without the two arguing, which is the failure mode every other tilt in
   * this scene has had.
   */
  easeRate: 9,
};

/**
 * WHICH WAY THE STICK MEANS.
 *
 * Kept as named numbers because handedness in this rig has been wrong twice
 * (v0.0.95 — "every left was her right"), and when it is wrong again the fix
 * should be a sign here rather than a hunt through a quaternion.
 *
 * `pitch` is about her own right, where a POSITIVE angle carries her nose
 * toward her feet — so pushing the stick forward (a positive y) putting her
 * nose down is a straight +1.
 *
 * `roll` is about her own forward. A positive rotation there takes her right
 * side UP, so pushing the stick right and wanting that side to DROP is a -1.
 */
export const POSTURE_SIGN = { pitch: 1, roll: -1 };

/**
 * The body's height and attitude, and the only thing allowed to hold them.
 *
 * No DOM, no three.js, no scene: what a stick deflection means, what a limit
 * is, and how a pose eases toward its target are all decisions worth testing
 * without a browser in the way.
 */
export class BodyPosture {
  /** Which control the stick is driving, if any. */
  mode: PostureMode = 'off';

  /** Millimetres along her own up. Positive raises her. */
  rideMm = 0;

  /** Radians about her own right. Positive puts her nose down, tail up. */
  pitch = 0;

  /** Radians about her own forward. Positive drops her right side. */
  roll = 0;

  private wantRide = 0;

  private wantPitch = 0;

  private wantRoll = 0;

  /** True when she is standing the way her gait alone would stand her. */
  get neutral(): boolean {
    return Math.abs(this.wantRide) < 1e-4
      && Math.abs(this.wantPitch) < 1e-5
      && Math.abs(this.wantRoll) < 1e-5;
  }

  /** True when the stick belongs to posture rather than to walking. */
  get armed(): boolean {
    return this.mode !== 'off';
  }

  /**
   * Arm a control, or disarm if it is already the armed one.
   *
   * Disarming deliberately does NOT centre her: the pose is the point, and
   * you set one in order to walk around with it.
   */
  toggle(mode: Exclude<PostureMode, 'off'>): void {
    this.mode = this.mode === mode ? 'off' : mode;
  }

  disarm(): void {
    this.mode = 'off';
  }

  /**
   * The stick, both axes in -1..1, y positive FORWARD.
   *
   * Read whole rather than per-axis because the tilt is a cyclic: pushing
   * diagonally is a pitch and a roll at once, and splitting that into two
   * calls invites one of them to be forgotten at a call site.
   */
  command(x: number, y: number): void {
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    const cx = clamp(x);
    const cy = clamp(y);
    if (this.mode === 'ride') {
      /*
       * FORWARD IS DOWN, as asked for — "forward on the stick as down, down
       * as up". It reads as pushing the body down onto its legs rather than
       * as driving a value up, and the two directions get different limits
       * because rising and crouching are bounded by different things (leg
       * reach one way, the ground the other).
       */
      this.wantRide = cy > 0
        ? -cy * POSTURE_LIMITS.crouchMm
        : -cy * POSTURE_LIMITS.riseMm;
    } else if (this.mode === 'tilt') {
      this.wantPitch = POSTURE_SIGN.pitch * cy * POSTURE_LIMITS.tiltRad;
      this.wantRoll = POSTURE_SIGN.roll * cx * POSTURE_LIMITS.tiltRad;
    }
  }

  /** Back to however her gait would have stood her, eased not snapped. */
  centre(): void {
    this.wantRide = 0;
    this.wantPitch = 0;
    this.wantRoll = 0;
  }

  /** Snap — a respawn or a first frame, where easing from a stale pose is wrong. */
  reset(): void {
    this.mode = 'off';
    this.centre();
    this.rideMm = 0;
    this.pitch = 0;
    this.roll = 0;
  }

  /** Ease toward what was asked for. Call once a frame, always. */
  update(dt: number): void {
    const k = 1 - Math.exp(-POSTURE_LIMITS.easeRate * Math.max(0, dt));
    this.rideMm += (this.wantRide - this.rideMm) * k;
    this.pitch += (this.wantPitch - this.pitch) * k;
    this.roll += (this.wantRoll - this.roll) * k;
  }

  /** What the chip says, so the numbers a good pose was found at can be read off. */
  readout(): string {
    const deg = (r: number) => ((r * 180) / Math.PI).toFixed(0);
    return `${this.rideMm >= 0 ? '+' : ''}${this.rideMm.toFixed(2)}mm `
      + `${deg(this.pitch)}° ${deg(this.roll)}°`;
  }
}
