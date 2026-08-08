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

export class LegDrive {
  private readonly legs: Leg[] = [];
  /** Mean distance of a foot from her turn axis. See `radius`. */
  private stanceRadius = 1;

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
    for (const leg of this.legs) {
      if (!leg.planted) continue;
      this.homeWorld(leg, body, home);
      if (this.excursion(leg, home, body.up).length() <= leg.spread) continue;
      leg.planted = false;
      leg.t = 0;
      leg.from.copy(leg.at);
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
    const fits = (s: number): boolean => {
      probe.at.copy(from).addScaledVector(shove, s);
      probe.forward.copy(forward0);
      if (Math.abs(spin * s) > 1e-12) probe.forward.applyAxisAngle(body.up, spin * s).normalize();
      for (const { leg, limit } of limits) {
        this.homeWorld(leg, probe, home);
        if (this.excursion(leg, home, body.up).length() > limit) return false;
      }
      return true;
    };
    let allowed = 1;
    if (limits.length > 0 && !fits(1)) {
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
    let inTransit = false;
    for (const leg of this.legs) {
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
    }
    if (!inTransit && spentest && strain >= 1) {
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
      const hit = ground.nearest(ahead, body.up, leg.down, REACH_UP_MM / MM);
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
      leg.t = Math.min(1, leg.t + dt / SWING_SECONDS);
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

    return {
      movedMm: moved * MM,
      heldBackMm: Math.max(0, wanted - moved) * MM,
      planted,
      groping,
      clearanceMm: Number.isFinite(clearance) ? clearance * MM : -1,
      strain,
      allowed,
    };
  }
}
