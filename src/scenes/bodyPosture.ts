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

import { REACH_DOWN_MM } from '../anim/legDrive';

/** Which of the two controls owns the stick, if either. */
export type PostureMode = 'off' | 'ride' | 'tilt';

/*
 * WHY THE RISE IS BOUNDED BY `REACH_DOWN_MM` AND NOT A ROUND NUMBER.
 *
 * The first cut used 1.2 mm, picked as "a visible eighth of her body
 * length". Played, it stuck: raising her whole body raises every leg's HOME
 * by the same amount, and each leg has to reach further DOWN to keep its
 * foot on the same ground it was just standing on — the identical demand a
 * downward lip makes on a walking leg, from `legDrive.ts`'s own measurement:
 * "a leg asked for reach it does not have does not stretch; the solver
 * drags the body down instead". Front (1.12 mm) and middle (1.08-1.10 mm)
 * are the tight ones; 1.2 mm asked them for more than they have, on EVERY
 * full-stick rise, before any terrain lip was added on top — so on the very
 * ground this control exists to help with, there was nothing left in the
 * budget and the foot held its old anchor while the body kept rising.
 *
 * So the ceiling is derived from that same table rather than guessed a
 * second time, with a margin reserved so a rise and a lip can still both be
 * asked of a leg at once. The rear legs (1.83 mm spare) have far more room
 * than this uses — which is exactly the asymmetry the corner posture (rear
 * stretched, front lowered) is built to spend, rather than the uniform rise
 * this manual control gives every leg alike.
 */
const TIGHTEST_DOWN_REACH_MM = Math.min(...Object.values(REACH_DOWN_MM));
/** Left over for a terrain lip once the manual rise has taken its share. */
const RISE_TERRAIN_MARGIN = 0.35;

export const POSTURE_LIMITS = {
  /**
   * How far she may rise, in millimetres along her own up. See above.
   */
  riseMm: Math.max(0, TIGHTEST_DOWN_REACH_MM - RISE_TERRAIN_MARGIN),
  /**
   * And how far she may crouch — asked for, by measurement, at 0.6 mm:
   * enough for the downhill side of a 90° bend without the sink `↕` was
   * originally letting her ask for. `groundGuard` still backstops this: it
   * will bodily lift her out of any soil the crouch pushes her into, so the
   * number only has to be a sensible crouch, not a proof against every
   * floor.
   */
  crouchMm: 0.6,
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
 * `roll` is about her own forward, and this is the third time handedness has
 * been wrong in this rig — reported from the glass: "I have left stick and
 * it's rotating to the right." The -1 was reasoned from an assumption about
 * which side a positive rotation about her forward raises, and the assumption
 * was simply backwards. Measured on a real screen it is +1, so a stick pushed
 * left banks her left, the way a cyclic does.
 *
 * Worth noting the pitch axis was right first time and is untouched: the two
 * were never wrong together, which is exactly why they are two numbers.
 */
export const POSTURE_SIGN = { pitch: 1, roll: 1 };

/**
 * The body's height and attitude, and the only thing allowed to hold them.
 *
 * No DOM, no three.js, no scene: what a stick deflection means, what a limit
 * is, and how a pose eases toward its target are all decisions worth testing
 * without a browser in the way.
 */
/**
 * HOW FAR SHE IS BANKED, read against the world.
 *
 * The roll instrument's question is "which way is up?", and the honest
 * answer comes from her actual body frame — the up her feet negotiated —
 * measured against the up gravity insists on. Level for this heading is
 * the world's up with the forward component removed; the bank is the
 * signed angle from that to her own up, about her forward.
 *
 * POSITIVE DROPS HER LEFT SIDE, because that is what a positive rotation
 * about her forward DOES to the applied basis (right is up×forward, and
 * turning right toward up raises the right flank) — and the involuntary
 * bank agrees: a LEFT turn measures a positive rate about her up and
 * banks positive, into the turn. This function's first draft said the
 * opposite in its comment, which would have made the fourth wrongly-
 * signed roll in this file's history; the sign was settled by reading the
 * rotation actually applied in the scene, not by assuming — see the
 * contract test that rolls a real up vector about a real forward.
 *
 * Null when she is plumb — nose straight up or down — because a vertical
 * forward leaves no horizon to bank against, the same degeneracy the
 * bearing holds its last value through. The caller keeps the old reading,
 * which is what an instrument on a gimbal would do. Null too for inputs
 * that are not numbers at all: an instrument fed garbage should hold,
 * not display it.
 */
export function bankOf(
  fwd: { x: number; y: number; z: number },
  up: { x: number; y: number; z: number },
): number | null {
  if (![fwd.x, fwd.y, fwd.z, up.x, up.y, up.z].every(Number.isFinite)) {
    return null;
  }
  const fy = Math.max(-1, Math.min(1, fwd.y));
  if (Math.abs(fy) > 0.99) return null;
  /* World up, less its share along forward: "level" for this heading. */
  const u0x = -fwd.x * fy;
  const u0y = 1 - fy * fy;
  const u0z = -fwd.z * fy;
  const n = Math.hypot(u0x, u0y, u0z);
  /* sin from cross(level, up)·fwd, cos from up·level — an atan2 pair, so
   * the answer is honest all the way round to upside-down (±180°), and
   * the cross is ordered so a positive rotation about forward reads
   * positive. */
  const cx = u0y * up.z - u0z * up.y;
  const cy = u0z * up.x - u0x * up.z;
  const cz = u0x * up.y - u0y * up.x;
  const sin = (cx * fwd.x + cy * fwd.y + cz * fwd.z) / n;
  const cos = (up.x * u0x + up.y * u0y + up.z * u0z) / n;
  return Math.atan2(sin, cos);
}

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
