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

/**
 * The body's own axes, for a walk that is not on level ground.
 *
 * Everything in this stepper is relative geometry — a foot trails behind its
 * shoulder, a stride sweeps fore and aft, a swing lifts away from the surface —
 * and none of it mentions the world's vertical anywhere except through the
 * frame it runs in. On flat soil that frame is derived from the heading and
 * world up; on the flank of a tree it is handed in, with `up` the surface
 * normal, and every rule works unchanged because no rule ever knew which way
 * gravity pointed in the first place.
 */
export interface Frame {
  right: Vec3;
  up: Vec3;
  forward: Vec3;
}

/** What the body is doing this frame. */
export interface Stride {
  /** Body position in world space. */
  position: Vec3;
  /** Heading in radians; 0 faces +Z, matching the rest of the scene. */
  heading: number;
  /** Planar speed, only used to decide whether she is walking at all. */
  speed: number;
  /**
   * The body's axes when she is NOT walking on level ground — climbing, where
   * up is the surface normal. When absent, the frame is built from `heading`
   * and world up, which reproduces the level walk exactly.
   */
  frame?: Frame;
}

/** Ground height at a world x and z. The stepper puts feet ON the ground. */
export type GroundAt = (x: number, z: number) => number;

/**
 * Project a point onto the surface along the frame's down, for walks where
 * the ground is not a heightfield — a trunk, a crater wall. Null when there
 * is nothing within reach, which is an answer rather than an error: a foot
 * aimed past the edge of a treetop has nowhere to land, and the stepper
 * retreats it toward home instead.
 */
export type SurfaceAt = (point: Vec3, up: Vec3) => Vec3 | null;

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

/*
 * The little vector algebra the frame needs, on plain tuples. Three.js stays
 * out of this file so the stepping rules keep their renderer-free tests.
 */
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 =>
  [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

/** The frame a stride is walking in — given, or derived from the heading. */
function frameOf(stride: Stride): Frame {
  if (stride.frame) return stride.frame;
  const sin = Math.sin(stride.heading);
  const cos = Math.cos(stride.heading);
  return { right: [cos, 0, -sin], up: [0, 1, 0], forward: [sin, 0, cos] };
}

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

  /**
   * Put a would-be foothold ON the surface.
   *
   * The scalar `groundAt` is the level-ground spelling — replace the point's
   * height with the ground's. `surfaceAt`, when given, is the general one: it
   * may fail, and a failed projection retreats toward `home` in steps, the
   * way a real foot feels back toward footing it knows exists — the body is
   * standing on some, or it would not be here. The last resort is home
   * itself at the body's own plane, which keeps the leg in shape even when
   * the world refuses to offer it anything.
   */
  private plant(
    wanted: Vec3, home: Vec3, frame: Frame, groundAt: GroundAt, surfaceAt?: SurfaceAt,
  ): Vec3 {
    if (!surfaceAt) {
      return [wanted[0], groundAt(wanted[0], wanted[2]), wanted[2]];
    }
    for (const back of [0, 0.35, 0.7]) {
      const at = back === 0 ? wanted : addScaled(wanted, [
        home[0] - wanted[0], home[1] - wanted[1], home[2] - wanted[2],
      ] as Vec3, back);
      const found = surfaceAt(at, frame.up);
      /*
       * Reachable means near the plane her body stands on. A projection is a
       * cast, and a cast from the rim of a treetop finds the soil a body
       * length below — a real point, on a real surface, that no leg of hers
       * can stand on. Half a reach either way covers every slope she walks.
       */
      if (found && Math.abs(dot([
        found[0] - home[0], found[1] - home[1], found[2] - home[2],
      ] as Vec3, frame.up)) <= this.legs[0]!.reach * 0.75) {
        return found;
      }
    }
    return [...home] as Vec3;
  }

  /** Drop every foot where it stands. Call on a teleport, or the first frame. */
  reset(stride: Stride, groundAt: GroundAt, surfaceAt?: SurfaceAt): void {
    const frame = frameOf(stride);
    for (const leg of this.legs) {
      const home = this.homeOf(leg, stride);
      const planted = this.plant(home, home, frame, groundAt, surfaceAt);
      this.anchor.set(leg.slot, planted);
      this.from.set(leg.slot, [...planted] as Vec3);
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
  step(dt: number, stride: Stride, groundAt: GroundAt, surfaceAt?: SurfaceAt): LegState[] {
    if (!this.started) this.reset(stride, groundAt, surfaceAt);

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
    /*
     * Whichever tripod needs it most goes, preferring the one whose turn it is.
     *
     * Strict alternation deadlocks, and the case that finds it is turning on
     * the spot. A pivot swings the hips a long way while the body's own travel
     * stays near zero, so `trail` — which is measured along her heading — reads
     * nothing, and the only rule left is the out-of-reach one. Asking that
     * question of the DUE tripod alone means a leg strung out in the other one
     * is never seen: the due tripod has no reason to move, so nothing steps and
     * the stretched leg stays stretched. Measured over a ten-second pivot, a
     * front leg reached 0.97 of its own length and 12% of frames had some foot
     * past the limit it is supposed to be held inside.
     */
    if (!airborne) {
      const due = this.last === 0 ? 1 : 0;
      if (this.urgency(due, stride) >= 1) this.begin(due, stride, groundAt, surfaceAt);
      else if (this.urgency(due === 0 ? 1 : 0, stride) >= 1) {
        this.begin(due === 0 ? 1 : 0, stride, groundAt, surfaceAt);
      }
    }

    return this.legs.map((leg) => this.stateOf(leg, stride, groundAt, surfaceAt));
  }

  /**
   * Keep hold of a foothold, or skid to one she can still hold.
   *
   * The trigger fires the instant a foot reaches its limit, but a tripod may
   * not leave the ground while the other one is still in the air — so a foot
   * that comes due mid-swing has to wait, and the body keeps moving while it
   * does. Turning on the spot is the worst of it: measured over a pivot, a
   * front foot was dragged to 0.97 of its own leg length, well past the 0.9 it
   * is supposed to be held inside, purely in the frames it spent waiting.
   *
   * Rather than let the solver strain at an anchor out of range — which either
   * drags the claw through the soil or leaves the leg straightened into a
   * spike — the claw slips toward its shoulder. A skid is what a real claw does
   * when it loses purchase, and at five millimetres to the world unit it is
   * invisible. A leg stretched past its own length is not.
   */
  private hold(leg: Leg, stride: Stride, groundAt: GroundAt, surfaceAt?: SurfaceAt): Vec3 {
    const anchor = this.anchor.get(leg.slot);
    if (!anchor) return this.homeOf(leg, stride);
    const limit = leg.reach * OVERREACH;
    const home = this.homeOf(leg, stride);
    const frame = frameOf(stride);
    const span = this.spanOf(anchor, home, frame);
    if (span <= limit) return anchor;
    // Slip toward the shoulder IN THE SURFACE PLANE, then put the result back
    // on the surface — a skid stays a ground contact the whole way.
    const pull = 1 - limit / span;
    const slipped = addScaled(anchor, [
      home[0] - anchor[0], home[1] - anchor[1], home[2] - anchor[2],
    ] as Vec3, pull);
    const skidded = this.plant(slipped, home, frame, groundAt, surfaceAt);
    this.anchor.set(leg.slot, skidded);
    return skidded;
  }

  /** Distance from home in the SURFACE plane — the part the leg must span. */
  private spanOf(anchor: Vec3, home: Vec3, frame: Frame): number {
    const v: Vec3 = [anchor[0] - home[0], anchor[1] - home[1], anchor[2] - home[2]];
    const rise = dot(v, frame.up);
    const flat = addScaled(v, frame.up, -rise);
    return Math.hypot(flat[0], flat[1], flat[2]);
  }

  /**
   * How badly one tripod needs to step, normalised so that 1.0 always means
   * "now" whichever of the two reasons got it there.
   *
   * Both reasons are a distance over the distance at which that reason becomes
   * urgent, so they are directly comparable and a single `>= 1` covers them:
   *
   *   - the foot has trailed a full half-sweep behind its shoulder, which is
   *     the ordinary walking trigger and the thing that makes a stride a
   *     function of ground covered rather than of time; and
   *   - the foot is nearly as far from where it hangs as the leg is long,
   *     which is not a walking condition at all. She reaches it by turning on
   *     the spot, and by surfacing from a burrow, where the stepper restarts
   *     metres from where her feet were left and she comes up with her legs
   *     stretched out behind her like a landed spider.
   *
   * One number for the WHOLE tripod — the worst of its three legs. Stepping
   * legs individually as each passes its own limit is a smoother-looking rule
   * and a worse one: the three feet drift out of step, and once they do there
   * is no instant at which a clean triangle is on the ground.
   */
  private urgency(tripod: 0 | 1, stride: Stride): number {
    const sweep = this.strideOf(this.legs[0]!);
    let worst = 0;
    for (const leg of this.legs) {
      if (tripodOf(leg.slot) !== tripod) continue;
      worst = Math.max(worst, -this.trail(leg, stride) / sweep);
      worst = Math.max(worst, this.strain(leg, stride));
    }
    return worst;
  }

  /** Where this leg's foot naturally sits right now, in world space. */
  private homeOf(leg: Leg, stride: Stride): Vec3 {
    // Her local x is to the right of her heading, y toward her own up, z along
    // her heading — whatever direction each of those happens to point in the
    // world. On level ground this reduces to the yaw rotation it always was.
    const frame = frameOf(stride);
    let at: Vec3 = [...stride.position] as Vec3;
    at = addScaled(at, frame.right, leg.home[0]);
    at = addScaled(at, frame.up, leg.home[1]);
    at = addScaled(at, frame.forward, leg.home[2]);
    return at;
  }

  /**
   * How stranded this foot is: how far it sits from where the leg hangs, as a
   * fraction of the furthest it is allowed to sit. One means it is exactly at
   * the limit and the leg must step.
   *
   * Measured in the horizontal plane, since a step is a step whichever
   * direction the foot has been left in — which is the point. This is the one
   * rule that is blind to heading, and so the only one that can see a foot
   * strung out sideways by a pivot.
   */
  private strain(leg: Leg, stride: Stride): number {
    const anchor = this.anchor.get(leg.slot);
    if (!anchor) return 0;
    const home = this.homeOf(leg, stride);
    return this.spanOf(anchor, home, frameOf(stride)) / (leg.reach * OVERREACH);
  }

  /** Signed distance of the anchor ahead of home, along her heading. */
  private trail(leg: Leg, stride: Stride): number {
    const anchor = this.anchor.get(leg.slot);
    if (!anchor) return 0;
    const home = this.homeOf(leg, stride);
    return dot([
      anchor[0] - home[0], anchor[1] - home[1], anchor[2] - home[2],
    ] as Vec3, frameOf(stride).forward);
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

  private begin(tripod: 0 | 1, stride: Stride, groundAt: GroundAt, surfaceAt?: SurfaceAt): void {
    const frame = frameOf(stride);
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
      const landing = this.plant(
        addScaled(home, frame.forward, ahead), home, frame, groundAt, surfaceAt,
      );
      this.anchor.set(leg.slot, landing);
      this.swing.set(leg.slot, 0);
    }
    this.last = tripod;
  }

  private stateOf(leg: Leg, stride: Stride, groundAt: GroundAt, surfaceAt?: SurfaceAt): LegState {
    const phase = this.swing.get(leg.slot) ?? 1;
    if (phase >= 1) {
      /*
       * Planted. The target is a world position and nothing moves it, which is
       * the entire reason there is no sliding — with the one exception in
       * `hold`, where a foot the body has dragged past its own reach gives way
       * rather than let the leg straighten into a spike.
       */
      return {
        slot: leg.slot,
        target: this.hold(leg, stride, groundAt, surfaceAt),
        swinging: false,
        phase: 1,
      };
    }
    const anchor = this.anchor.get(leg.slot) ?? this.homeOf(leg, stride);
    const from = this.from.get(leg.slot) ?? anchor;
    // Eased across, so the foot leaves and lands slowly and crosses quickly.
    const t = phase * phase * (3 - 2 * phase);
    // The lift is away from the SURFACE, whichever way that faces here.
    const lift = Math.sin(Math.PI * phase) * this.strideOf(leg) * SWING_LIFT;
    const across: Vec3 = [
      from[0] + (anchor[0] - from[0]) * t,
      from[1] + (anchor[1] - from[1]) * t,
      from[2] + (anchor[2] - from[2]) * t,
    ];
    return {
      slot: leg.slot,
      target: addScaled(across, frameOf(stride).up, lift),
      swinging: true,
      phase,
    };
  }
}
