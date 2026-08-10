/**
 * The legs drive the ant. The player drives the legs.
 *
 * The framing is a tank: the stick is the steering wheel and the throttle,
 * the ant is the vehicle, and the legs are the wheels. Which means the body
 * does not travel and drag its feet along behind it — the feet lock to the
 * world, and the body goes wherever the locked feet will let it.
 *
 * That inversion is worth the trouble because it makes three separate hacks
 * unnecessary. Gripping a wall is not a special case: a foot locked to a
 * wall simply holds. Walking the underside is not a special case either.
 * And an animal who cannot find anything to stand on does not slide — she
 * paddles and stays put, which is what should happen on a smooth overhang.
 *
 * ## Two references, one answer
 *
 * The first version of this file guessed at the two hard parts — what bounds
 * a stance leg, and what turning even is — and got both wrong in the same
 * way: it treated them as separate problems. A walking-robot firmware
 * (JiroRobotics/Hexapod_v4) and the wider literature on foot-driven vehicles
 * turn out to agree, and to agree with each other:
 *
 * 1. **A step goes on a circle about the foot's home.** Hexapod_v4 places
 *    each swing target at `homePos + radius·(cos θ, sin θ)` and then walks
 *    the stance feet along a straight line until they leave that same circle
 *    — `lineCircleIntersect`, solved as a quadratic. CSIRO's OpenSHC does
 *    the same thing with a per-bearing "walkspace" radius map. The circle is
 *    the bound. Not, as this file had it, hip-to-foot-plus-spare, which is
 *    four to five millimetres and therefore never binds on anything.
 *
 * 2. **Turning is not a mode.** Both compute a per-leg travel direction from
 *    one body twist: `stride = v + ω × r`, where `r` is that leg's offset
 *    from the body origin. Spinning on the spot is `v = 0` down the very
 *    same path. The outer legs stride further than the inner ones because
 *    `ω × r` is larger out there — nobody codes a differential, it falls
 *    out. Hexapod_v4 writes the same thing as a per-leg mounting angle added
 *    to a shared step bearing, and applies its yaw matrix to the STANCE legs
 *    only, which is what "the legs turn her" means when the feet are the
 *    things holding still.
 *
 * 3. **The gait is triggered by geometry, not by a clock.** A tripod lifts
 *    when the feet carrying her have reached the back of their circles. That
 *    is the whole timing system, and it is why she steps in proportion to
 *    ground covered and takes no steps at all when she is blocked.
 *
 * The literature adds one caution worth writing down: with three-jointed
 * legs and the feet locked, the body is NOT determined by the feet — it is
 * a free platform that each leg absorbs independently, and only the legs'
 * workspace limits couple them. So proposing a body motion and then
 * clipping it against those limits is not an approximation of a "real"
 * solve. It is the formulation.
 *
 * ## How the loop runs
 *
 * 1. The stick PROPOSES a twist: a translation and a yaw.
 * 2. The planted feet CONSTRAIN it, together, as a single fraction of that
 *    twist — so a foot that is out of room stops the turn as well as the
 *    walk, which is the case a translation-only clamp used to miss.
 * 3. What survives is her real displacement.
 * 4. When nothing is in the air and the most-spent stance foot has reached
 *    the back of its circle, the other tripod lifts and steps to the FRONT
 *    of its own circles, along its own `v + ω × r`.
 * 5. A swing leg that finds nothing to stand on STAYS UP and keeps reaching.
 *
 * ## And one thing the tripod cannot do
 *
 * A tripod cannot start a climb. Step 4 lifts THREE feet, and at the foot of
 * a wall two of them have nowhere to go; step 5's question — the nearest
 * solid along her own up — cannot see a wall at all until a foot's home is
 * already inside it. So `cornerTurn.ts` sits between steps 1 and 2 as a
 * QUEUE: while it is running, step 4 releases ONE foot rather than three,
 * and a foot it has scheduled takes its landing from the new surface instead
 * of from `nearest`. Everything else — the stride, the clip, the swing arc,
 * the anchoring — is the same code doing the same job. It arms only where a
 * front foot can genuinely reach, and a room that cannot answer its one
 * extra question never arms it at all.
 *
 * ## The numbers are measured, not chosen
 *
 * Reach comes from the rig: see `scripts/probe-legs.mjs`, which measures
 * each leg hip to FOOT in the pose she stands in, and again with every bone
 * up to that foot pulled straight. The difference is all a leg has spare
 * for reaching down past a lip — 1.12 mm at the front, 1.10 in the middle,
 * 1.83 at the back, and NOT the three to five millimetres it is tempting to
 * assume. A leg asked for reach it does not have does not stretch; the
 * solver drags the body down instead, which reads as sinking.
 *
 * "Foot" is `limbTip`, the last bone with geometry on it. The first version
 * of that probe measured to the last bone in the CHAIN and reported the
 * front legs 1.2 mm longer than they are, because every leg here ends in
 * two auto-rig terminals that carry no vertices and point back up above the
 * claw. Measuring to a marker floating above her foot is the same mistake
 * that once had the solver planting one.
 */

import * as THREE from 'three';
import {
  CORNER_TUNING, CornerTurn, rowsFromHomes,
  type CornerReport, type SurfaceContact,
} from './cornerTurn';

export type { SurfaceContact } from './cornerTurn';

/** Millimetres per world unit. */
const MM = 5;

/** The two tripods: 1-4-5 and 2-3-6. */
export const TRIPOD_A = ['frontLeft', 'midRight', 'rearLeft'];
export const TRIPOD_B = ['frontRight', 'midLeft', 'rearRight'];

/**
 * How far a foot travels fore and aft of its home, per gait — the diameter
 * of the circle a step goes on, so half of each number is its radius.
 *
 * One table, so the modes are compared rather than scattered. Turning takes
 * short steps because a spin on the spot is many small placements, and long
 * ones would have her lurching round in quarters. The two are BLENDED, at
 * the BODY and not per leg, by how much of her motion is rotation rather
 * than translation — there is no moment where she stops walking and starts
 * turning, and all six legs must share one stroke. See `radius`.
 */
export const STRIDE_MM = { walk: 2.0, turn: 0.8 } as const;

/**
 * How far below its home a foot may reach for ground, per leg, in
 * millimetres — the measured spare reach and nothing more.
 */
export const REACH_DOWN_MM: Record<string, number> = {
  frontLeft: 1.12, frontRight: 1.12,
  midLeft: 1.10, midRight: 1.08,
  rearLeft: 1.83, rearRight: 1.83,
};

/**
 * And how far ABOVE home it may plant, which is bounded by folding the leg
 * rather than by stretching it and is therefore roomier. Two and a half
 * millimetres is a working figure rather than a measured one — the fold
 * limit belongs to the IK's joint limits, and estimating it here would be
 * inventing a number in a file whose whole point is not to.
 */
export const REACH_UP_MM = 2.5;

/**
 * The body keeps this much daylight under it, or the stance legs push it up.
 *
 * A SAFETY, engaged only when the ground rises into her — it is not part of
 * how high she rests. Folding it into the resting height was one of the two
 * reasons her feet hovered: it lifted the whole animal a quarter of a
 * millimetre before the IK's own clearance lifted the feet again.
 */
export const RIDE_CLEARANCE_MM = 0.25;

/**
 * And how far a DRAWN foot is held off the soil, which is a different
 * question and the one that was visibly wrong.
 *
 * The block room handed the IK its cell size, 0.5 mm, as this number — 50
 * times what the colony sim uses (`FOOT_CLEARANCE`, 0.01 mm) and 100 times
 * what a foot that is meant to be touching should have. That is the gap
 * under her in the report. Five thousandths of a millimetre is not zero on
 * purpose: a foot solved to exactly the surface z-fights the soil it stands
 * on, and at this scale five microns is invisible and cheap.
 */
export const FOOT_CLEARANCE_MM = 0.005;

/** Fraction of a swing after which the foot is down and locked. */
const LOCK_AT = 0.9;
/** Peak lift of a swinging foot, as a fraction of the stride. */
const SWING_LIFT = 0.35;
/** Seconds a swing takes when she is moving at all. */
const SWING_SECONDS = 0.16;
/** Bisection steps used to clip the proposed twist. Ten is 0.1% of it. */
const CLIP_STEPS = 10;

export interface LegSetup {
  slot: string;
  /** Rest position of the foot, in her body frame. */
  home: THREE.Vector3;
  /** Hip to foot in that pose, as the rig measures it. */
  reach: number;
}

/** What the room must answer for the legs to work. */
export interface Ground {
  /**
   * The nearest solid point to `at`, searching along `-up` and `+up` within
   * the band. Null when there is nothing to stand on, which is a real
   * answer and not a failure — the leg stays up.
   */
  nearest(at: THREE.Vector3, up: THREE.Vector3, down: number, rise: number): THREE.Vector3 | null;
  /**
   * OPTIONAL, and additive on purpose: the first solid along `dir` within
   * `maxDistance`, with the surface normal there.
   *
   * `nearest` searches along the body's existing up, which is the right
   * question for the ground she is on and cannot answer for the one she is
   * not. Measured on the island: from a front foot's home, at gaps of 14
   * down to 5 mm from a trunk, it returns SOIL every frame while a ray along
   * her forward finds bark 10.1 to 1.1 mm away. And closer in it returns
   * something worse — its own origin, 2.5 mm inside the wood, because a cast
   * that starts in solid reports a hit at zero range.
   *
   * A room that cannot answer this simply omits it, and the corner scheduler
   * never arms. Nothing existing changes: no caller of `nearest` is touched,
   * and there is no second collision world — the island answers this off the
   * same unioned field.
   *
   * MUST return null when `origin` is already solid. See above.
   */
  probeContact?(
    origin: THREE.Vector3, dir: THREE.Vector3, maxDistance: number,
  ): SurfaceContact | null;
}

interface Leg {
  slot: string;
  home: THREE.Vector3;
  /** World point the foot is locked to. Meaningless unless planted. */
  anchor: THREE.Vector3;
  planted: boolean;
  /** Swing endpoints and progress, used while not planted. */
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  /** Where the foot is right now, planted or mid-swing. */
  at: THREE.Vector3;
  /** True while it is reaching and has found nothing: held up. */
  groping: boolean;
  /** Spare downward reach, in world units. See `REACH_DOWN_MM`. */
  down: number;
  /**
   * How far the foot may be dragged sideways from home before the leg is
   * out of leg — the STRAIN limit, past the gait circle. See `spread`.
   */
  spread: number;
  /**
   * Which way this foot is travelling over the ground, unit, world. Held
   * from the frame it was planted so the excursion is measured against the
   * stroke it was actually placed for.
   */
  dir: THREE.Vector3;
}

export interface BodyPose {
  at: THREE.Vector3;
  up: THREE.Vector3;
  forward: THREE.Vector3;
}

export interface DriveInput {
  /** -1..1 along her forward. */
  walk: number;
  /**
   * -1..1 ACROSS her forward — a side step, not a turn.
   *
   * An ant does not have to point where it is going, and a player steering
   * with the camera does not want her to: the nose stays where the view is
   * and the body slides. It rides the same clip as the walk and the spin,
   * because a foot with no room left has no more room for a side step than
   * for anything else.
   *
   * POSITIVE IS THE RIGHT OF THE SCREEN, and that is `forward x up`, NOT
   * the `up x forward` this file calls `right` elsewhere. That axis is the
   * model's own +X and it points to her LEFT on screen — settled by
   * `scripts/shot-hands.mjs`, which dots her travel against the camera's
   * own +X column rather than against another of the code's conventions.
   * The first cut used the file's `right` and shipped backwards.
   */
  strafe?: number;
  /** -1..1 about her up. */
  yaw: number;
  speed: number;
  yawRate: number;
  /**
   * Whether this drive APPLIES the spin, or only accounts for it. Default
   * true.
   *
   * A caller may already own the heading — the island's bore rig integrates
   * the stick into a heading and rotates her nose with it — and then this
   * applying the spin as well turns her twice. Measured: 1.5 rad/s from the
   * rig plus 2.4 from here, a stick that asked for one of them and got
   * 223 degrees a second.
   *
   * `yaw` is still read when this is false, because the gait needs it: the
   * stride table blends on how much of a foot's travel is rotation, and a
   * turn the legs do not know about is a turn they cannot step for.
   */
  spin?: boolean;
  /**
   * Whether the LEGS are allowed to set her height. Default true.
   *
   * A room that seats the body itself must say no, and the block room does.
   * Two systems both deciding how high she rides do not average out, they
   * FIGHT. `BlockScene.hold()` seats her origin 0.26 mm inside the contact,
   * because her rig's foot homes sit ABOVE her origin and that is where her
   * own feet say she belongs. Step 6 below then read 0.26 mm of penetration
   * against a wanted 0.25 mm of daylight, shoved her half a millimetre out,
   * and hold() hauled her straight back the next frame.
   *
   * The oscillation costs her nothing in position — she drifts 0.0004 mm —
   * but it registers as 6.5 mm/s of SPEED, four fifths of a walk, on an ant
   * standing perfectly still. The gait believed it and ran the walk cycle at
   * full tilt: 162 degrees per second of coxa rotation with the stick
   * untouched. That is the wiggle, and this is half of why.
   */
  settle?: boolean;
  /**
   * May a corner transition ARM this frame? Default true.
   *
   * A veto for the caller, not a mode for the drive. A dodge is the ordinary
   * movement with different numbers in it — the drive is handed a walk and a
   * strafe and cannot tell a burst from a thumb on a stick — so a flick that
   * happens to point at a wall must not stage a climb. An active dig stroke
   * is the same case. See `cornerTurn.ts`.
   */
  mayTransition?: boolean;
}

export interface DriveReport {
  /** How far the body actually moved, after the feet had their say. */
  movedMm: number;
  /** How much of the proposal the feet refused. */
  heldBackMm: number;
  planted: number;
  groping: number;
  /** Daylight under her body at the end of the step. */
  clearanceMm: number;
  /**
   * The most-spent stance foot, as a fraction of its gait circle. Reaches 1
   * and the tripod swaps; goes past 1 only when she is straining because
   * the swing legs have nothing to land on.
   */
  strain: number;
  /** Fraction of the proposed twist that survived the feet, 0..1. */
  allowed: number;
  /** What the corner scheduler is doing, if anything. See `cornerTurn.ts`. */
  corner: CornerReport;
}

/**
 * How far a foot may be dragged sideways from home before the leg runs out.
 *
 * The measured spare (`REACH_DOWN_MM`) is spare along the leg — what is
 * left when it is pulled straight DOWN. Sideways is a different triangle:
 * the foot sits `reach` from the hip, and the worst case for a horizontal
 * drag is that it is square to the hip, so the budget is the other side of
 * a right triangle whose hypotenuse is the straightened leg. For the front
 * legs that is √(4.10² − 2.98²) = 2.82 mm, and for the rear 4.28 mm — real
 * room, and still well outside the 1 mm gait circle that does the work.
 */
function spread(reach: number, spare: number): number {
  const straight = reach + spare;
  return Math.sqrt(Math.max(0, straight * straight - reach * reach));
}

/**
 * How long the ordinary tripod trigger stays muzzled after a corner.
 *
 * TWO FRAMES, and it was two swings — thirty-two hundredths of a second —
 * on the reasoning that coming off a transition her homes are computed in a
 * body frame that has swung ninety degrees, so every excursion is large at
 * once and the first ordinary frame could read a spent tripod and lift three
 * feet together. The risk is real; the length was over-insurance, and it
 * cost something measurable. Over the sixty frames after the handoff she
 * covered 6.86 mm/s of a commanded 7.50 with the long muzzle and the full
 * 7.50 with this one, and the first ordinary tripod came at frame 8 instead
 * of frame 26. Neither setting ever released more than one foot on the two
 * frames that matter.
 *
 * Narrowing this came from the `chatgpt/continuous-corner-climb` branch. Two
 * frames rather than the one it used because this counter is in SECONDS and
 * is decremented on the same frame it is set: a single frame's worth is
 * already zero by the first ordinary frame, which is precisely the frame it
 * exists to guard.
 */
export const HANDOFF_GRACE = 2 / 60;

/** Where a scheduled swing is aiming, this frame. Copied out immediately. */
const SCRATCH_AIM = new THREE.Vector3();

/** A re-step's foothold on the new surface. Copied out immediately. */
const SCRATCH_CONTACT: SurfaceContact = {
  point: new THREE.Vector3(), normal: new THREE.Vector3(),
};

export class LegDrive {
  private readonly legs: Leg[] = [];
  /** Mean distance of a foot from her turn axis. See `radius`. */
  private stanceRadius = 1;

  /**
   * The corner scheduler. It never moves a foot; it says which ONE may move
   * next and where it must land, and everything below obeys it exactly as it
   * obeys the tripod trigger the rest of the time. See `cornerTurn.ts`.
   */
  private readonly corner: CornerTurn;

  /** Seconds left of the post-corner muzzle. See `HANDOFF_GRACE`. */
  private grace = 0;

  constructor(setup: LegSetup[]) {
    for (const leg of setup) {
      const spare = (REACH_DOWN_MM[leg.slot] ?? 1) / MM;
      this.legs.push({
        slot: leg.slot,
        home: leg.home.clone(),
        anchor: new THREE.Vector3(),
        planted: false,
        from: new THREE.Vector3(),
        to: new THREE.Vector3(),
        t: 1,
        at: new THREE.Vector3(),
        groping: false,
        down: spare,
        // `reach` arrives in world units: the rig is scaled before it is
        // measured, so it is already in the same units as `home`.
        spread: spread(leg.reach || leg.home.length(), spare),
        dir: new THREE.Vector3(0, 0, 1),
      });
    }
    /*
     * How far a foot sits from the axis she spins about — her own up through
     * her centre — so a yaw rate can be compared against a walking speed in
     * the same units. Mean rather than per leg, on purpose: see `radius`.
     */
    if (this.legs.length > 0) {
      this.stanceRadius = this.legs.reduce(
        (sum, l) => sum + Math.hypot(l.home.x, l.home.z), 0,
      ) / this.legs.length;
    }
    /* Rows from the MEASURED homes, leading first — so "the front pair" is a
     * fact about this animal rather than a list of names, and a caste with a
     * different number of legs rows up the same way. */
    this.corner = new CornerTurn(rowsFromHomes(this.legs));
  }

  /**
   * The corner's pre-tilt, passed through for whoever seats the body —
   * fills `out` with the new face and returns the share. See
   * `CornerTurn.leanToward`.
   */
  cornerLean(out: THREE.Vector3): number {
    return this.corner.leanToward(out);
  }

  /** Where each foot should be drawn this frame, for the IK. */
  anchorFor(slot: string): readonly [number, number, number] | null {
    const leg = this.legs.find((l) => l.slot === slot);
    if (!leg) return null;
    return [leg.at.x, leg.at.y, leg.at.z];
  }

  /** Home, in the world, for a given body pose. */
  private homeWorld(leg: Leg, body: BodyPose, into: THREE.Vector3): THREE.Vector3 {
    const right = new THREE.Vector3().crossVectors(body.up, body.forward).normalize();
    return into.copy(body.at)
      .addScaledVector(right, leg.home.x)
      .addScaledVector(body.up, leg.home.y)
      .addScaledVector(body.forward, leg.home.z);
  }

  /**
   * Where this leg's ground contact is travelling, and how fast — the one
   * twist, evaluated at this leg: `v + ω × r`.
   *
   * `into` comes back unit (or zero when she is not commanding anything).
   * The return is the speed, and `turn` is how much of that speed is the
   * rotation term, which is what blends the stride table.
   */
  private travel(
    leg: Leg, body: BodyPose, input: DriveInput, into: THREE.Vector3,
  ): number {
    const right = new THREE.Vector3().crossVectors(body.up, body.forward).normalize();
    const offset = new THREE.Vector3()
      .addScaledVector(right, leg.home.x)
      .addScaledVector(body.up, leg.home.y)
      .addScaledVector(body.forward, leg.home.z);
    const linear = body.forward.clone().multiplyScalar(input.speed * input.walk)
      /* Minus, because this file's `right` is screen-LEFT — see `strafe`. */
      .addScaledVector(right, -input.speed * (input.strafe ?? 0));
    const angular = new THREE.Vector3()
      .crossVectors(body.up, offset)
      .multiplyScalar(input.yawRate * input.yaw);
    into.copy(linear).add(angular);
    const speed = into.length();
    if (speed > 1e-9) into.divideScalar(speed);
    return speed;
  }

  /**
   * ONE gait circle, shared by all six legs.
   *
   * It was per leg, blended by each leg's own ratio of rotation to travel,
   * and that is what had the back feet dancing. The rear legs sit furthest
   * from her turn axis, so their `ω × r` is the largest, so on any yaw at
   * all — and a thumb on a stick is never at exactly zero yaw — they scored
   * the most "turning" and got the SHORTEST circle. Short circle, frequent
   * steps: the back end fidgeting while the front strode.
   *
   * Both references size the circle once for the machine and vary only the
   * DIRECTION per leg. So the blend is taken at the body, using the mean
   * distance from her turn axis as the one stance radius, and every leg gets
   * the same stroke.
   */
  private radius(body: BodyPose, input: DriveInput): number {
    const linear = Math.hypot(input.speed * input.walk, input.speed * (input.strafe ?? 0));
    const rotational = Math.abs(input.yawRate * input.yaw) * this.stanceRadius;
    const total = linear + rotational;
    const turn = total > 1e-9 ? rotational / total : 0;
    const mm = STRIDE_MM.walk + (STRIDE_MM.turn - STRIDE_MM.walk) * turn;
    return mm / 2 / MM;
  }

  /**
   * Put every foot on the ground under its home. Call once, on spawn.
   *
   * The tripods are STAGGERED by half a stroke — 1-4-5 under their homes,
   * 2-3-6 a radius ahead of theirs — because six feet planted in lockstep
   * all run out of stroke on the same frame, and the first thing she would
   * do is stretch three legs past their circle waiting for the other three
   * to land. Half a stroke apart, one tripod always has room while the
   * other is in the air, which is what a tripod gait is for.
   */
  plantAll(body: BodyPose, ground: Ground): void {
    /* A fresh plant is a respawn or a teleport, and both invalidate the two
     * surfaces a transition is held between. See `CornerTurn.reset`. */
    this.corner.reset();
    this.grace = 0;
    const home = new THREE.Vector3();
    const lead = STRIDE_MM.walk / 2 / MM;
    for (const leg of this.legs) {
      this.homeWorld(leg, body, home);
      const want = TRIPOD_B.includes(leg.slot)
        ? home.clone().addScaledVector(body.forward, lead)
        : home.clone();
      const hit = ground.nearest(want, body.up, leg.down, REACH_UP_MM / MM)
        ?? ground.nearest(home, body.up, leg.down, REACH_UP_MM / MM);
      leg.planted = !!hit;
      leg.groping = !hit;
      leg.anchor.copy(hit ?? home);
      leg.at.copy(leg.anchor);
      leg.t = 1;
      leg.dir.copy(body.forward);
    }
  }

  /**
   * How far this foot is from home, measured ACROSS her up — the component
   * that eats the gait circle. The vertical part is a leg reaching down a
   * ledge, which is bounded separately and at plant time.
   */
  private excursion(leg: Leg, home: THREE.Vector3, up: THREE.Vector3): THREE.Vector3 {
    const d = home.clone().sub(leg.anchor);
    return d.addScaledVector(up, -d.dot(up));
  }

  /**
   * One step of the whole arrangement. Mutates `body`, returns what happened.
   */
  step(dt: number, body: BodyPose, input: DriveInput, ground: Ground): DriveReport {
    const from = body.at.clone();
    const forward0 = body.forward.clone();
    const home = new THREE.Vector3();
    const dir = new THREE.Vector3();

    /*
     * 1. The stick proposes ONE twist — a shove and a spin. They are clipped
     *    together below, because a foot with no room left has no more room
     *    for the turn than it does for the walk.
     */
    const right = new THREE.Vector3().crossVectors(body.up, body.forward).normalize();
    const shove = body.forward.clone().multiplyScalar(input.speed * input.walk * dt)
      /* Minus, because this file's `right` is screen-LEFT — see `strafe`. */
      .addScaledVector(right, -input.speed * (input.strafe ?? 0) * dt);
    /* Zero when someone else owns the heading — see `DriveInput.spin`. The
     * clip below must see the same zero, or it constrains a rotation that
     * is never going to happen and holds back the walk for nothing. */
    const spin = (input.spin ?? true) ? input.yawRate * input.yaw * dt : 0;
    const wanted = shove.length();
    const radius = this.radius(body, input);

    /*
     * 1b. THE CORNER SCHEDULER, if the room can answer its one question.
     *
     * It reads the world and its own state and answers with at most ONE
     * slot: the foot that may leave its surface this frame, and where it
     * must land. While it is active the tripod trigger below is PAUSED —
     * paused, not removed: the group logic, the stride, the clip and the
     * swing interpolation are the same code doing the same job, and the only
     * thing suspended is the rule that a spent foot takes its whole tripod
     * with it. That rule is exactly wrong at a corner.
     *
     * A room with no `probeContact` never arms this at all, which is how the
     * block room and every existing test keep the behaviour they had.
     */
    const cornerGround = ground.probeContact
      ? { probeContact: ground.probeContact.bind(ground) }
      : null;
    const corner = this.corner.update(
      dt, body, { ...input, radius }, cornerGround, this.legs,
    );
    if (corner.handedOff) this.grace = HANDOFF_GRACE;
    this.grace = Math.max(0, this.grace - dt);
    /** Is the corner scheduler, or its aftermath, in charge of the queue? */
    const staged = corner.active || this.grace > 0;

    if (corner.release) {
      const leg = this.legs.find((l) => l.slot === corner.release);
      if (leg?.planted) {
        leg.planted = false;
        leg.t = 0;
        leg.from.copy(leg.at);
      }
    }

    /*
     * 2. A FOOT THAT IS OUT OF LEG LETS GO.
     *
     * Before anything is constrained, because this is what stops a
     * constraint becoming a trap. `BlockScene.hold()` runs after this
     * function and eases her onto whatever face she has reached, moving her
     * position AND rotating her up — and the anchors know nothing about it.
     * Rounding a corner therefore hands the legs six feet that are suddenly
     * a long way from where they belong, measured across a new up.
     *
     * That is the glue trap. The old code fed those feet to the clip with a
     * limit of "no worse than they already are", which froze her exactly
     * where she stood, and the only thing that could have freed her — a
     * tripod lifting — could not fire either. A leg stretched past what it
     * physically has does not hold on and win. It lets go.
     */
    /*
     * DURING A TRANSITION, THE SAME RULE, ONE FOOT PER FRAME.
     *
     * A corner moves her a long way in a frame or two and swings her up with
     * it, so several old feet can run out of leg at once — and letting them
     * all go is the giant tripod again, wearing different clothes. Releasing
     * the worst one per frame escapes the glue trap just as well (a frame is
     * a sixtieth of a second; four strung-out feet are freed in four of
     * them) while keeping the promise the whole file makes at a corner: one
     * foot moves at a time.
     *
     * And it waits for an empty sky. `standing` is counted after the
     * scheduler has had its release, so requiring all of them down means the
     * two paths into the air can never both fire on one frame — which they
     * did, and it read as two feet let go together at a corner. A leg held
     * past its reach for a few frames is a leg that steps next; two in the
     * air on a wall is most of a fall.
     */
    let worst: Leg | null = null;
    let worstBy = 0;
    let standing = 0;
    for (const leg of this.legs) if (leg.planted) standing += 1;
    for (const leg of this.legs) {
      if (!leg.planted) continue;
      this.homeWorld(leg, body, home);
      const over = this.excursion(leg, home, body.up).length() - leg.spread;
      if (over <= 0) continue;
      if (!staged) {
        leg.planted = false;
        leg.t = 0;
        leg.from.copy(leg.at);
        standing -= 1;
        continue;
      }
      if (over > worstBy) { worstBy = over; worst = leg; }
    }
    if (worst && standing >= this.legs.length
      && standing - 1 >= CORNER_TUNING.minPlanted) {
      worst.planted = false;
      worst.t = 0;
      worst.from.copy(worst.at);
    }

    /*
     * 3. The planted feet constrain what is left. Every stance foot must stay
     *    inside its own reach; the largest fraction of the twist that keeps
     *    all of them inside is the one she gets. Bisection rather than
     *    algebra because the yaw makes it non-linear, and ten halvings of a
     *    frame's motion is far below anything visible.
     */
    const limits: Array<{ leg: Leg; limit: number }> = [];
    for (const leg of this.legs) {
      if (!leg.planted) continue;
      limits.push({ leg, limit: leg.spread });
    }
    const probe: BodyPose = {
      at: new THREE.Vector3(), up: body.up, forward: new THREE.Vector3(),
    };
    /*
     * AND, AT A CORNER, ONE MORE CONSTRAINT IN THE SAME BISECTION.
     *
     * A leading-row foot that has not crossed yet must keep its HOME on the
     * air side of the target face. Without it she simply walks past the only
     * place she could have gripped from: measured, the second front foot's
     * home ended up 3.8 mm inside the wall, its probe started in solid, and
     * no foothold could ever be found again — while the walker turned her
     * ninety degrees on the one grip she had. See `CornerCommand.hold`.
     *
     * It belongs HERE rather than in a clamp of its own because it is the
     * same kind of statement as every other line in this step: the body may
     * go as far as the feet allow and no further. The clip already knows how
     * to find that fraction.
     */
    const hold = corner.hold;
    const holdLegs = hold
      ? this.legs.filter((l) => hold.slots.includes(l.slot))
      : [];
    const fits = (s: number): boolean => {
      probe.at.copy(from).addScaledVector(shove, s);
      probe.forward.copy(forward0);
      if (Math.abs(spin * s) > 1e-12) probe.forward.applyAxisAngle(body.up, spin * s).normalize();
      for (const { leg, limit } of limits) {
        this.homeWorld(leg, probe, home);
        if (this.excursion(leg, home, body.up).length() > limit) return false;
      }
      if (hold) {
        for (const leg of holdLegs) {
          this.homeWorld(leg, probe, home);
          if (home.sub(hold.point).dot(hold.normal) < CORNER_TUNING.browLift) return false;
        }
      }
      return true;
    };
    let allowed = 1;
    if ((limits.length > 0 || holdLegs.length > 0) && !fits(1)) {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < CLIP_STEPS; i += 1) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid; else hi = mid;
      }
      allowed = lo;
    }

    body.at.copy(from).addScaledVector(shove, allowed);
    if (Math.abs(spin * allowed) > 1e-12) {
      body.forward.applyAxisAngle(body.up, spin * allowed).normalize();
    }
    const moved = from.distanceTo(body.at);

    /*
     * 4. The gait is triggered by the feet, not by a timer. When nothing is
     *    in the air and the most-spent stance foot has been dragged to the
     *    back of its circle, the OTHER tripod lifts. That is the whole of
     *    the timing: she steps because her feet ran out of stroke, so a
     *    blocked ant takes no steps and a fast one takes them faster.
     *
     *    "Spent" is measured along where the foot is travelling NOW, not
     *    along the direction it was planted for. The stored direction was
     *    the other half of the glue trap: round a corner her up swings 90°
     *    and her forward re-flattens against the new face, so every stored
     *    direction pointed somewhere she was no longer going. A stroke
     *    measured against it sat near zero however far she strained — the
     *    HUD read "stroke -29%" with six feet down and nothing moving — so
     *    the swap could never fire. OpenSHC recomputes the same quantity
     *    every tick from the moving tip, and for the same reason.
     */
    let strain = 0;
    let spentest: Leg | null = null;
    /*
     * The most-spent foot the OVERLAP may take while a crossing is in the
     * air. A foot already across may renew itself under any transfer past
     * the front row — the drive lands it through the corner's own foothold
     * probe, see `restepAim`. A foot still on the old surface may creep only
     * while the MIDDLE row is going: in `transferRear` the only old feet
     * left are the rear pair themselves, and creeping one along the surface
     * it should be leaving stalled the rear row for forty-frame stretches.
     */
    let strainOv = -Infinity;
    let spentestOv: Leg | null = null;
    const phase = this.corner.phase;
    const overlapOk = (leg: Leg): boolean => {
      if (!this.corner.active) return false;
      if (phase === 'acquireFront' || phase === 'recover' || phase === 'settle') return false;
      return this.corner.ownerOf(leg.slot) === 'new'
        ? true
        : phase === 'transferMiddle';
    };
    let inTransit = false;
    /* Counted HERE rather than reused from step 2: the releases above have
     * happened since, and a stale count is how a rule that says "only with
     * an empty sky" ends up firing with a foot already in it. */
    let onFoot = 0;
    for (const leg of this.legs) {
      if (leg.planted) onFoot += 1;
      if (!leg.planted) {
        /*
         * A leg on its way to a spot it has FOUND blocks the swap — she may
         * not lift the tripod carrying her while the other one is still in
         * the air. A leg that has found nothing does NOT block it. That
         * distinction is the whole of walking off a lip: the front feet
         * reach into space and stay reaching, and if they counted as "in
         * the air" the gait would wait for them forever while the legs
         * still on top stretched to their limit and stopped her dead at the
         * edge. Which is exactly what she did, at z = 64.3 mm.
         */
        if (!leg.groping) inTransit = true;
        continue;
      }
      this.homeWorld(leg, body, home);
      const speed = this.travel(leg, body, input, dir);
      // Where she is going now; only when she is going nowhere, where it was
      // planted, so a foot at rest does not read as spent by accident.
      if (speed <= 1e-9) dir.copy(leg.dir);
      // Signed along the stroke: -1 just planted ahead, +1 fully spent.
      const spent = this.excursion(leg, home, body.up).dot(dir) / radius;
      if (!spentest || spent > strain) {
        strain = spent;
        spentest = leg;
      }
      if (overlapOk(leg) && spent > strainOv) {
        strainOv = spent;
        spentestOv = leg;
      }
    }
    /*
     * PAUSED, NOT DESTROYED — and the pause has two reasons behind it.
     *
     * During a transition the whole point is that one foot moves at a time,
     * and "the most-spent foot releases its entire tripod" would take three
     * at once, two of which have nowhere to go. After one, the homes have
     * been recomputed in a body frame that swung ninety degrees, so every
     * excursion is large SIMULTANEOUSLY and the first normal frame would
     * read a spent tripod and lift three feet together. The grace lets the
     * spread rule bring them back one at a time instead. See `HANDOFF_GRACE`.
     */
    if (!staged && !inTransit && spentest && strain >= 1) {
      /*
       * Lift the tripod that the most-spent foot belongs to. Alternation is
       * not bookkept: a group that has just stepped is fresh by definition,
       * so the other one is always the spent one, and at a lip — where one
       * tripod is half in space — this picks the group that has somewhere
       * to go instead of taking a blind turn.
       */
      const group = TRIPOD_A.includes(spentest.slot) ? TRIPOD_A : TRIPOD_B;
      for (const leg of this.legs) {
        if (!group.includes(leg.slot) || !leg.planted) continue;
        leg.planted = false;
        leg.t = 0;
        leg.from.copy(leg.at);
      }
    } else if (
      staged && !inTransit && !corner.release && spentest && strain >= 0.7
      && onFoot >= this.legs.length
    ) {
      /*
       * AND DURING A TRANSITION, THE SAME TRIGGER — ONE FOOT, NOT THREE.
       *
       * Without this she stops dead the moment the leading pair grip, and
       * the measurement is unambiguous: two front feet on the bark, four on
       * the soil, all six inside their limits, `allowed` clipped to nothing,
       * and eight hundred and thirty frames in which her gap to the trunk
       * went from 3.98 mm to 3.81. Every foot was AT its boundary, which is
       * where the clip parks them, so the spread rule never fired either —
       * nothing exceeded anything, and nothing could move.
       *
       * The escape on flat ground is this same trigger lifting a tripod. A
       * corner cannot afford three, but it can afford one: the most-spent
       * foot takes an ordinary step on the surface it is already on, with
       * the ordinary swing and the ordinary `nearest`. She creeps into the
       * corner on five feet while the leading pair hold the wall, which is
       * what carries her body round — no pull on the root, nothing bypassing
       * the clip, and no motion that some foot did not first make room for.
       */
      spentest.planted = false;
      spentest.t = 0;
      spentest.from.copy(spentest.at);
    } else if (
      /*
       * OVERLAP: a creep may go out UNDER a crossing in flight.
       *
       * The strictly sequential corner parked her at the clip for the whole
       * of every 0.16 s cross-surface swing — five stance feet all spent, no
       * renewal allowed, nothing able to move. A stance leg taking its
       * ordinary step on its own surface while the grip crosses is what a
       * real ant does, and it is the ONLY overlap allowed, on four gates:
       *
       * - strictly while the corner itself is live, never the handoff grace
       *   (the tripods are re-forming there);
       * - never during `acquireFront` or `recover` — the front grips are the
       *   fragile part, the body has to fold before a hold is real, and
       *   every attempt to hurry that phase has jammed it;
       * - strictly under a genuine crossing, never a returning foot (that is
       *   a recovery already in progress);
       * - and only a foot the ledger still has on the OLD surface. A foot
       *   already across must never take a creep step: `nearest` measures
       *   along an up that belongs to the floor, and worse, a second
       *   airborne foot cannot be adopted while a crossing is in flight, so
       *   the label comes off and the corner can never again observe itself
       *   finished. Measured — armed for an entire 700-frame descent, one
       *   ground foot forever flapping back to 'old'.
       *
       * Four planted is the floor, the same one the scheduler holds itself
       * to when it releases across a creep. See `CornerTurn.update`.
       */
      this.corner.crossingSlot !== null
      && !corner.release
      && spentestOv && strainOv >= 0.7
      && onFoot >= this.legs.length - 1
      && onFoot - 1 >= CORNER_TUNING.minPlanted
    ) {
      spentestOv.planted = false;
      spentestOv.t = 0;
      spentestOv.from.copy(spentestOv.at);
    }

    /*
     * 5. Swing legs reach for the FRONT of the circle, each along its own
     *    `v + ω × r`. On a spin in place that direction is sideways and
     *    opposite across her, which is the whole of turning — there is no
     *    turn branch anywhere in this file.
     */
    let groping = 0;
    let planted = 0;
    for (const leg of this.legs) {
      if (leg.planted) {
        leg.at.copy(leg.anchor);
        planted += 1;
        continue;
      }
      this.homeWorld(leg, body, home);
      const speed = this.travel(leg, body, input, dir);
      /*
       * A leg stepping while she is NOT being driven goes home, not a full
       * radius ahead of it — that is the foot settling after she stops, and
       * placing it at the front of a stroke she is not taking would splay
       * her out on every halt.
       */
      if (speed <= 1e-9) dir.copy(leg.dir);
      const ahead = home.clone().addScaledVector(dir, speed > 1e-9 ? radius : 0);
      /*
       * A SCHEDULED foot aims where the scheduler found real wood, and every
       * other foot asks the ground the same question it always did.
       *
       * The contact is offset along ITS OWN normal rather than along her up,
       * which is the whole difference between a claw resting on bark and one
       * hovering a hundredth of a millimetre off it in the wrong direction.
       * Everything after this line — the arc, the lock, the anchor, the
       * stored travel direction — is the ordinary swing, untouched. There is
       * no reach animation here and there must never be one: a foot arrives
       * because the world was probed and answered, or it does not arrive.
       */
      const scheduled = corner.aimSlot === leg.slot ? corner.aim : null;
      /*
       * A foot ALREADY ACROSS, re-stepping off the queue, lands where the
       * corner's own foothold probe says — `nearest` measures along an up
       * that still belongs to the old surface and would quietly walk it
       * back off the wall. Re-aimed every frame, like a scheduled swing,
       * because the body moves under it. See `CornerTurn.restepAim`.
       */
      const restep = !scheduled
        && this.corner.active
        /*
         * NEVER while the front row is still going. On the descent the
         * first front foot grips the ground while the body is still high
         * on the wood; a fast off-queue re-land puts it down before the
         * body has folded, the spread rule drags it straight back off, and
         * she loops there — the same five-hundred-frame jam every other
         * attempt to hurry `acquireFront` has produced. The scheduler's
         * careful clock owns that phase.
         */
        && this.corner.phase !== 'acquireFront'
        && this.corner.phase !== 'recover'
        && this.corner.swingingSlot !== leg.slot
        && this.corner.ownerOf(leg.slot) === 'new'
        && cornerGround !== null
        && this.corner.restepAim(leg, body, cornerGround, SCRATCH_CONTACT);
      const hit = scheduled
        ? SCRATCH_AIM.copy(scheduled.point)
          .addScaledVector(scheduled.normal, FOOT_CLEARANCE_MM / MM)
        : restep
          ? SCRATCH_AIM.copy(SCRATCH_CONTACT.point)
            .addScaledVector(SCRATCH_CONTACT.normal, FOOT_CLEARANCE_MM / MM)
          : ground.nearest(ahead, body.up, leg.down, REACH_UP_MM / MM);
      if (!hit) {
        /*
         * Nothing to stand on. She keeps the leg raised and keeps reaching —
         * over the lip of a block this is the frame or two before the foot
         * finds the side, and mid-air it is the paddling that is correct.
         */
        leg.groping = true;
        groping += 1;
        leg.at.copy(ahead).addScaledVector(body.up, radius * SWING_LIFT);
        continue;
      }
      leg.groping = false;
      leg.to.copy(hit);
      /*
       * A CORNER SWING KEEPS HER PACE.
       *
       * The 0.16 s swing clock is tuned for the ordinary tripod, where three
       * feet cross together and the stance carries her meanwhile. At a
       * corner the queue makes every step SEQUENTIAL — one foot at a time,
       * body waiting on each — so the fixed clock becomes the speed limit:
       * measured at full sprint she dropped from 22.8 to ~12 mm/s across
       * twenty millimetres either side of the fold, all of it spent parked
       * at the clip while a swing finished. So while the scheduler (or its
       * grace) owns the queue, an ORDINARY step takes the time her own gait
       * implies at the commanded pace — one stroke diameter of travel — and
       * never more than the ordinary clock. The floor keeps a step a step
       * rather than a teleport at silly speeds.
       *
       * A SCHEDULED swing keeps the full clock. Those are the cross-surface
       * grips, and hurrying one is not free: measured on the way DOWN the
       * trunk, fast-clocking the scheduled front foot landed it before the
       * body had folded, the spread rule dragged it straight back off, and
       * she sat in `acquireFront` for five hundred frames four millimetres
       * above the soil. Only the creep steps — same surface, same `nearest`,
       * nothing delicate about them — get the fast clock.
       */
      const paced = input.speed > 1e-9
        ? (2 * radius) / input.speed
        : SWING_SECONDS;
      /*
       * A SCHEDULED swing keeps the full clock, always. Those are the
       * cross-surface grips, and hurrying one is not free: measured on the
       * way DOWN the trunk, fast-clocking the scheduled front foot landed
       * it before the body had folded, the spread rule dragged it straight
       * back off, and she sat in `acquireFront` for five hundred frames
       * four millimetres above the soil — intermittently, which is worse
       * than slow. (A "hurry only when the aim is near home" gate was
       * tried and jammed the same way.) Only the creep steps — same
       * surface, same `nearest`, nothing delicate about them — hurry.
       *
       * "Scheduled" is asked of the SCHEDULER, not of this frame's command:
       * on a frame the foothold re-probe fails, `aimSlot` goes null while
       * the crossing is still in progress, and reading the command alone
       * would hand that foot the fast clock mid-cross — the exact jam the
       * slow clock exists to prevent, on the one frame it matters.
       */
      const crossing = scheduled !== null
        || this.corner.swingingSlot === leg.slot;
      const swingSeconds = staged && !crossing
        ? Math.max(0.06, Math.min(SWING_SECONDS, paced))
        : SWING_SECONDS;
      leg.t = Math.min(1, leg.t + dt / swingSeconds);
      /*
       * The swing LANDS where it lifts off, with no jump at the end.
       *
       * It used to run the arc and the glide on the full 0..1 of the swing
       * but lock the foot at 0.9, which meant that at the instant of locking
       * the foot was still a tenth of the way short of its target AND still
       * sin(0.9π) = 0.31 of the arc off the ground — so it teleported the
       * rest. Six feet doing that a few times a second is the dancing.
       * Retiming both onto 0..LOCK_AT puts the foot exactly on its target
       * with exactly zero lift at the moment it plants.
       */
      const u = Math.min(1, leg.t / LOCK_AT);
      const arc = Math.sin(Math.PI * u) * radius * SWING_LIFT;
      leg.at.lerpVectors(leg.from, leg.to, u).addScaledVector(body.up, arc);
      if (u >= 1) {
        leg.planted = true;
        leg.anchor.copy(leg.to);
        leg.at.copy(leg.anchor);
        leg.dir.copy(dir);
        planted += 1;
      }
    }

    /*
     * 6. Ride height. She keeps a little daylight under her, and when the
     *    ground rises into her the stance legs push down to lift her clear —
     *    bounded by the same spare reach, so on a hard floor she bottoms out
     *    and drags instead of floating through it.
     */
    /*
     * The clearance is always MEASURED, even when the legs are not allowed
     * to act on it — a room that seats her itself still wants the number on
     * its HUD, and reporting the not-measured sentinel there had the block
     * room displaying a flat "-1.00 mm clear" that looked like a real depth.
     */
    const settle = input.settle ?? true;
    const under = ground.nearest(body.at, body.up, 6 / MM, 0.6 / MM);
    /*
     * THE GAUGE, WIDENED — measurement only, and deliberately a second query.
     *
     * The seating probe above looks 6 mm below her and only 0.6 mm ABOVE, so
     * the moment she is more than 0.6 mm under the surface it saturates and
     * every frame reports exactly -0.60. A flight recording full of -0.60 was
     * read as "she sinks 0.6 mm"; what it actually said was "she sinks at
     * least 0.6 mm and this instrument cannot see the bottom".
     *
     * Widening the SEATING probe would change how far the ride-height lift
     * hauls her on the rooms that use it, so the depth gets its own call and
     * the behaviour is untouched. One extra ground query against the six the
     * legs already make, and it is the difference between a gauge and a guess.
     */
    let clearance = Infinity;
    if (under) {
      clearance = body.at.clone().sub(under).dot(body.up);
      const want = RIDE_CLEARANCE_MM / MM;
      if (settle && clearance < want) {
        const budget = Math.min(...this.legs.filter((l) => l.planted).map((l) => l.down), 1);
        const lift = Math.min(want - clearance, Number.isFinite(budget) ? budget : want);
        body.at.addScaledVector(body.up, lift);
        clearance += lift;
      }
    }
    /* Read AFTER any lift, so the number is where she ended the frame. */
    const deep = ground.nearest(body.at, body.up, 6 / MM, 6 / MM);
    const measured = deep ? body.at.clone().sub(deep).dot(body.up) : clearance;

    return {
      movedMm: moved * MM,
      heldBackMm: Math.max(0, wanted - moved) * MM,
      planted,
      groping,
      clearanceMm: Number.isFinite(measured) ? measured * MM : -1,
      strain,
      allowed,
      corner: this.corner.report(this.legs, body.up),
    };
  }
}
