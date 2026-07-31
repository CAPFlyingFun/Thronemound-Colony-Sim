/**
 * The walk, driven by the BODY rather than by a clock.
 *
 * Every version of this gait until now was a function of time: a phase advanced
 * each frame and the legs were posed from it. That is why her feet skated. A
 * clock does not know how far the ground has gone past, so the two only agree
 * when they are tuned to agree, and they stop agreeing the instant she
 * accelerates — measured as her legs ripping through a dozen cycles in one
 * frame when the throttle opened.
 *
 * Here a planted foot has a position in the WORLD and simply stays there. The
 * body moves; the foot does not. Sliding is not reduced, it is impossible: a
 * stance foot's ground speed is zero because nothing ever moves it. What the
 * clock used to decide — when to pick a foot up — is now decided by geometry:
 * a leg that has trailed far enough behind its shoulder has to step, and the
 * distance it has trailed is exactly how far the body has travelled.
 *
 * The tripods are the ones an ant actually uses. Numbering her legs down the
 * left and right sides:
 *
 *     1  2      front
 *     3  4      middle
 *     5  6      rear
 *
 * she steps 1/4/5 together and 2/3/6 together — front and rear of one side
 * with the middle leg of the other. Three feet are always down and they are
 * never three in a row, so her centre of mass is inside the triangle they make
 * and she is statically stable at every instant of the walk. That is why an ant
 * can stop dead mid-stride and not fall over.
 *
 * Free of three.js, so the stepping rules can be checked without a renderer.
 */

export type Vec3 = [number, number, number];

/** Which tripod a leg belongs to. Slot names come from the rig maps. */
export const TRIPOD_A = ['frontLeft', 'midRight', 'rearLeft'] as const;
export const TRIPOD_B = ['frontRight', 'midLeft', 'rearRight'] as const;

export function tripodOf(slot: string): 0 | 1 {
  return (TRIPOD_A as readonly string[]).includes(slot) ? 0 : 1;
}

/**
 * How far back a leg may trail before its tripod must step, as an angle at the
 * shoulder.
 *
 * Expressed in degrees because that is how the sweep is actually thought about
 * — the leg swings forward to +YAW, plants, and is carried back to -YAW as the
 * body passes over it. The distance that corresponds to is a function of how
 * long the leg is, which is measured from the rig rather than assumed, so the
 * same number gives the queen and a worker each their own stride.
 *
 * Twenty-two degrees is a stride of about a third of a leg's reach. Ants take
 * short, quick steps; a wide sweep reads as a spider.
 */
export const STEP_YAW = 22 * Math.PI / 180;

/**
 * The longest a foot may spend in the air, in seconds.
 *
 * A ceiling rather than a fixed duration, and it has to be: a swing is the one
 * part of the walk the clock still owns, and at a run a fixed one eats the
 * whole cycle. Measured at four voxels a second, a 0.13 s swing is 70% of the
 * time between steps — so one tripod was still in the air when the other was
 * already overdue, the stepper serialised them, and she was never not swinging.
 * A walk with no stance phase is a scramble.
 */
export const SWING_SECONDS = 0.13;

/**
 * The most of one stride's time a foot may spend off the ground.
 *
 * Under a half, so there is always a moment with all six down between tripods.
 * This is what makes the swing shorten as she speeds up, the way a real gait
 * does — she does not lengthen her stride to run, she turns it over faster.
 */
export const SWING_DUTY = 0.45;

/** How high a foot lifts mid-swing, as a fraction of the step length. */
export const SWING_LIFT = 0.42;

export interface Leg {
  slot: string;
  /**
   * Where this foot sits when the leg is neutral, in the BODY's frame:
   * x to her right, z forward, y down to the ground. Measured from the rig.
   */
  home: readonly [number, number, number];
  /** Hip-to-tip reach, which sets how far this leg's stride can be. */
  reach: number;
}

export interface LegState {
  slot: string;
  /** Where the solver should put this foot, in world space. */
  target: Vec3;
  /** True while the foot is in the air. */
  swinging: boolean;
  /** 0..1 through the swing, for anything that wants to lead the lift. */
  phase: number;
}

/** What the body is doing this frame. */
export interface Stride {
  /** Body position in world space. */
  position: Vec3;
  /** Heading in radians; 0 faces +Z, matching the rest of the scene. */
  heading: number;
  /** Planar speed, only used to decide whether she is walking at all. */
  speed: number;
}

/** Ground height at a world x and z. The stepper puts feet ON the ground. */
export type GroundAt = (x: number, z: number) => number;

/**
 * Below this she counts as standing, for pacing a swing only.
 *
 * It used to gate the STEP TRIGGER too, and that was wrong twice over. A foot
 * that has trailed past its limit needs to move whatever the speedometer says,
 * and the speedometer is her walking velocity — which reads near zero while
 * she is being carried by gravity or pushed out of a shaft, exactly the moments
 * her feet were left behind. The geometry already knows when she is standing
 * still: nothing trails, so nothing steps. A separate speed test could only
 * ever disagree with it.
 */
const IDLE_SPEED = 0.05;

/**
 * How much of a leg's length its foot may stray from the shoulder before the
 * step is forced. Just under one, so a leg is never asked to reach further than
 * it is long.
 */
const OVERREACH = 0.9;

export class TripodGait {
  private readonly legs: Leg[];
  private readonly anchor = new Map<string, Vec3>();
  private readonly from = new Map<string, Vec3>();
  private readonly swing = new Map<string, number>();
  /** Which tripod stepped most recently, so they alternate. */
  private last: 0 | 1 = 1;
  private started = false;

  constructor(legs: Leg[]) {
    this.legs = legs;
  }

  /** Drop every foot where it stands. Call on a teleport, or the first frame. */
  reset(stride: Stride, groundAt: GroundAt): void {
    for (const leg of this.legs) {
      const home = this.homeOf(leg, stride);
      home[1] = groundAt(home[0], home[2]);
      this.anchor.set(leg.slot, home);
      this.from.set(leg.slot, [...home] as Vec3);
      this.swing.set(leg.slot, 1);
    }
    this.started = true;
  }

  /**
   * Advance the walk and return where every foot wants to be.
   *
   * The order matters: finish any swing in progress first, then decide whether
   * a new one starts. Deciding first would let a tripod be told to step while
   * the other one is still in the air, and for a moment she would have no feet
   * on the ground at all — which is the difference between a walk and a hop.
   */
  step(dt: number, stride: Stride, groundAt: GroundAt): LegState[] {
    if (!this.started) this.reset(stride, groundAt);

    const swingSeconds = this.swingSeconds(stride.speed);
    let airborne = false;
    for (const leg of this.legs) {
      const at = (this.swing.get(leg.slot) ?? 1) + dt / swingSeconds;
      this.swing.set(leg.slot, Math.min(1, at));
      if (at < 1) airborne = true;
    }

    /*
     * The trigger, and the whole of the idea: how far has this foot trailed
     * behind the shoulder it hangs from? Measured ALONG HER HEADING, because a
     * leg that has drifted sideways has not taken a step — she may have turned,
     * or be walking a slope, and neither is a reason to pick a foot up.
     */
    if (!airborne) {
      const due = this.last === 0 ? 1 : 0;
      let worst = 0;
      let stranded = false;
      for (const leg of this.legs) {
        if (tripodOf(leg.slot) !== due) continue;
        worst = Math.max(worst, -this.trail(leg, stride));
        stranded = stranded || this.outOfReach(leg, stride);
      }
      /*
       * A foot further from its shoulder than the leg is long has to move NOW,
       * whichever way it is trailing and whether or not she is walking.
       *
       * Nothing in the normal rules covers it, because the normal rules assume
       * she got here by walking: the anchor drifts backwards a little each
       * frame and trips the trigger long before it is out of range. Surfacing
       * from a burrow is not walking — the stepper is off underground and
       * restarts when she comes up, and she can be metres from where her feet
       * were left. She came out of a hole with her legs stretched out behind
       * her like a landed spider.
       */
      if (stranded) { this.begin(due, stride, groundAt); return this.legs.map((l) => this.stateOf(l, stride)); }
      /*
       * One number for the whole tripod. Stepping legs individually as each
       * one passes its own limit is a smoother-looking rule and a worse one:
       * the three feet drift out of step, and once they do there is no instant
       * at which a clean triangle is on the ground.
       */
      if (worst >= this.strideOf(this.legs[0]!)) this.begin(due, stride, groundAt);
    }

    return this.legs.map((leg) => this.stateOf(leg, stride));
  }

  /** Where this leg's foot naturally sits right now, in world space. */
  private homeOf(leg: Leg, stride: Stride): Vec3 {
    const sin = Math.sin(stride.heading);
    const cos = Math.cos(stride.heading);
    // Her local x is to the right of her heading and local z is along it.
    return [
      stride.position[0] + leg.home[0] * cos + leg.home[2] * sin,
      stride.position[1] + leg.home[1],
      stride.position[2] - leg.home[0] * sin + leg.home[2] * cos,
    ];
  }

  /**
   * Is this foot stranded — further from where the leg hangs than the leg can
   * stretch? Measured in the horizontal plane, since a step is a step whichever
   * direction the foot has been left in.
   */
  private outOfReach(leg: Leg, stride: Stride): boolean {
    const anchor = this.anchor.get(leg.slot);
    if (!anchor) return false;
    const home = this.homeOf(leg, stride);
    const span = Math.hypot(anchor[0] - home[0], anchor[2] - home[2]);
    return span > leg.reach * OVERREACH;
  }

  /** Signed distance of the anchor ahead of home, along her heading. */
  private trail(leg: Leg, stride: Stride): number {
    const anchor = this.anchor.get(leg.slot);
    if (!anchor) return 0;
    const home = this.homeOf(leg, stride);
    return (anchor[0] - home[0]) * Math.sin(stride.heading)
      + (anchor[2] - home[2]) * Math.cos(stride.heading);
  }

  /** Half the sweep, in world units: how far the foot travels either side of home. */
  private strideOf(leg: Leg): number {
    return leg.reach * Math.sin(STEP_YAW);
  }

  /**
   * How long this swing gets: the fixed comfortable one, or a fraction of the
   * time a whole stride will take, whichever is shorter. See `SWING_DUTY`.
   */
  private swingSeconds(speed: number): number {
    const pace = Math.abs(speed);
    if (pace <= IDLE_SPEED) return SWING_SECONDS;
    const strideTime = 2 * this.strideOf(this.legs[0]!) / pace;
    return Math.min(SWING_SECONDS, strideTime * SWING_DUTY);
  }

  private begin(tripod: 0 | 1, stride: Stride, groundAt: GroundAt): void {
    for (const leg of this.legs) {
      if (tripodOf(leg.slot) !== tripod) continue;
      const anchor = this.anchor.get(leg.slot);
      if (anchor) this.from.set(leg.slot, [...anchor] as Vec3);
      /*
       * The new anchor is placed AHEAD of home by the same distance the old one
       * had fallen behind it, so the foot sweeps symmetrically about the
       * shoulder — forward to +YAW, back to -YAW — rather than creeping
       * further back with every stride.
       *
       * Plus where the shoulder will have GOT TO by the time the foot lands.
       * Aiming at the shoulder's position now means the body has walked out
       * from under the target during the swing, so every foot touches down
       * already behind where it was aimed — measured as a sweep running from
       * +0.11 to -0.37 instead of evenly about zero, which is a limp. Real feet
       * are placed where the animal is going, not where it is.
       */
      const home = this.homeOf(leg, stride);
      const ahead = this.strideOf(leg) + stride.speed * this.swingSeconds(stride.speed);
      const landing: Vec3 = [
        home[0] + Math.sin(stride.heading) * ahead,
        0,
        home[2] + Math.cos(stride.heading) * ahead,
      ];
      landing[1] = groundAt(landing[0], landing[2]);
      this.anchor.set(leg.slot, landing);
      this.swing.set(leg.slot, 0);
    }
    this.last = tripod;
  }

  private stateOf(leg: Leg, stride: Stride): LegState {
    const anchor = this.anchor.get(leg.slot) ?? this.homeOf(leg, stride);
    const phase = this.swing.get(leg.slot) ?? 1;
    if (phase >= 1) {
      // Planted. The target is a world position and nothing moves it, which is
      // the entire reason there is no sliding.
      return { slot: leg.slot, target: anchor, swinging: false, phase: 1 };
    }
    const from = this.from.get(leg.slot) ?? anchor;
    // Eased across, so the foot leaves and lands slowly and crosses quickly.
    const t = phase * phase * (3 - 2 * phase);
    const lift = Math.sin(Math.PI * phase) * this.strideOf(leg) * SWING_LIFT;
    return {
      slot: leg.slot,
      target: [
        from[0] + (anchor[0] - from[0]) * t,
        from[1] + (anchor[1] - from[1]) * t + lift,
        from[2] + (anchor[2] - from[2]) * t,
      ],
      swinging: true,
      phase,
    };
  }
}
