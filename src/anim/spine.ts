/**
 * THE TRAIN: head is the locomotive, thorax the car, gaster the caboose.
 *
 * An ant crossing a ridge is not a plank. Her head lifts before she reaches
 * the rise, her thorax follows as she gets there, and her abdomen is still
 * pointing down the last slope for a moment after. Cresting runs the same
 * sequence in reverse — head levels first, then thorax, then gaster.
 *
 * Nothing here knows about three.js, terrain, or which way is up in the
 * world. It takes three ELEVATIONS measured along her own up — ahead of
 * her, under her, behind her — and returns three pitches in her own frame.
 * That is what makes it work on a trunk and upside down without a special
 * case: the caller measures in her frame, so the answers are in her frame.
 *
 * The ordering is not scripted. It falls out of three different follow
 * rates over the same targets: the head chases hard, the thorax less, the
 * gaster least. Anything that changes the terrain therefore reaches them in
 * that order, whichever direction it changes in.
 */

/** Where the three probes sit, as fractions of her body length. */
export interface ProbeLayout {
  /** Ahead of her centre — what her head is about to meet. */
  ahead: number;
  /** Behind her centre — what her abdomen is still on. */
  behind: number;
}

/**
 * A fifth of a body length either way.
 *
 * Fractions rather than millimetres so a major and a minim probe in
 * proportion to themselves. A fifth is about 1.8 mm on the queen: far
 * enough ahead to start lifting before her face arrives, near enough that
 * she is not reacting to terrain she will never touch.
 */
export const PROBES: ProbeLayout = { ahead: 0.22, behind: 0.22 };

/** How far each section may bend, and how hard it chases. */
export interface SpineLimits {
  /** Radians either way from level, per section. */
  headMax: number;
  thoraxMax: number;
  gasterMax: number;
  /**
   * Exponential follow rates, per second. HEAD > THORAX > GASTER is the
   * whole mechanism — see the header. Making them equal removes the train.
   */
  headRate: number;
  thoraxRate: number;
  gasterRate: number;
}

/**
 * Anatomical, not expressive.
 *
 * An ant hinges; she does not fold, and she is not a snake. Thirty degrees
 * at the neck is a lot on a body this size, the thorax barely moves against
 * her own axis, and the gaster swings more than the thorax because that is
 * the part that visibly trails on a real one.
 */
export const SPINE_LIMITS: SpineLimits = {
  headMax: (30 * Math.PI) / 180,
  thoraxMax: (14 * Math.PI) / 180,
  gasterMax: (22 * Math.PI) / 180,
  headRate: 11,
  thoraxRate: 6.5,
  gasterRate: 3.8,
};

/**
 * How close a body section may come to solid ground before the posture is
 * biased away from it, in the caller's own units.
 *
 * A FLOOR, not the trigger. Ordinary anticipation starts a fifth of a body
 * length out; this is what catches the case anticipation missed, and it is
 * deliberately tiny — by the time anything is this close, the only useful
 * response is to get away from it.
 */
export const SPINE_CLEARANCE = 0.05;

/** What the three probes found, as elevations along HER up. */
export interface SpineReading {
  /** Surface elevation ahead of her, relative to under her. */
  aheadRise: number;
  /** Surface elevation behind her, relative to under her. */
  behindRise: number;
  /** How far the head section is from solid — see `SPINE_CLEARANCE`. */
  headGap: number;
  /** How far the gaster section is from solid. */
  gasterGap: number;
}

/** Pitches in her own frame: positive is nose-up. */
export interface SpinePose {
  head: number;
  thorax: number;
  gaster: number;
}

const clamp = (v: number, lim: number): number => Math.min(lim, Math.max(-lim, v));

/**
 * The posture the terrain is asking for, before any smoothing.
 *
 * Each section reads the slope it is ACTUALLY over rather than one shared
 * number — that is what lets the head be climbing while the abdomen is
 * still descending, which is the moment on a crest that reads as an ant.
 */
export function posture(
  read: SpineReading,
  aheadDist: number,
  behindDist: number,
  limits: SpineLimits = SPINE_LIMITS,
  clearance: number = SPINE_CLEARANCE,
): SpinePose {
  const ahead = aheadDist > 1e-9 ? Math.atan2(read.aheadRise, aheadDist) : 0;
  /* Behind her, a rise means the ground she LEFT was higher, so her tail
   * should still be pitched up — hence the sign. */
  const behind = behindDist > 1e-9 ? Math.atan2(-read.behindRise, behindDist) : 0;
  /* The whole body's slope, for the middle: nose-to-tail across both. */
  const span = aheadDist + behindDist;
  const through = span > 1e-9
    ? Math.atan2(read.aheadRise - read.behindRise, span)
    : 0;

  /*
   * THE PROXIMITY FLOOR. Something is about to be inside the ground and
   * anticipation did not catch it, so lift that end away — proportionally,
   * so it is a bias and not a snap.
   */
  const headBias = read.headGap < clearance
    ? (1 - Math.max(0, read.headGap) / clearance) * limits.headMax
    : 0;
  const gasterBias = read.gasterGap < clearance
    ? (1 - Math.max(0, read.gasterGap) / clearance) * limits.gasterMax
    : 0;

  return {
    head: clamp(ahead + headBias, limits.headMax),
    thorax: clamp(through, limits.thoraxMax),
    gaster: clamp(behind + gasterBias, limits.gasterMax),
  };
}

/**
 * The train itself: three pitches, each chasing its target at its own rate.
 *
 * Holds state between frames and nothing else. The caller owns the probes,
 * the caller owns the bones; this owns the lag that makes it a train.
 */
export class Spine {
  private readonly now: SpinePose = { head: 0, thorax: 0, gaster: 0 };

  constructor(private limits: SpineLimits = SPINE_LIMITS) {}

  /** Swap the anatomy out — a major bends differently from a minim. */
  retune(limits: SpineLimits): void { this.limits = limits; }

  get pose(): SpinePose { return this.now; }

  /** Snap to a posture with no lag — a respawn, a teleport, a first frame. */
  set(to: SpinePose): void {
    this.now.head = to.head;
    this.now.thorax = to.thorax;
    this.now.gaster = to.gaster;
  }

  /**
   * Advance one frame toward `want`.
   *
   * Exponential rather than linear so nothing snaps when she crosses a
   * terrain triangle and the target steps: the response to a step is a
   * smooth approach whose slope is largest at the start, which is exactly
   * the "reacts quickly, settles gently" the body wants.
   */
  follow(want: SpinePose, dt: number): SpinePose {
    const l = this.limits;
    const ease = (from: number, to: number, rate: number): number =>
      from + (to - from) * (1 - Math.exp(-rate * Math.max(0, dt)));
    this.now.head = ease(this.now.head, clamp(want.head, l.headMax), l.headRate);
    this.now.thorax = ease(this.now.thorax, clamp(want.thorax, l.thoraxMax), l.thoraxRate);
    this.now.gaster = ease(this.now.gaster, clamp(want.gaster, l.gasterMax), l.gasterRate);
    return this.now;
  }
}
