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
 * Getting on for HALF a body length either way, which is a change from a
 * fifth and a measured one.
 *
 * The baseline is the denominator of every slope this produces, so a short
 * one magnifies the terrain's own quantisation: at a fifth of a body — 1.8
 * mm on the queen — one lattice step of a sixteenth of a millimetre came
 * out as two degrees of head, and the ground's ordinary +-0.9 mm swung the
 * target 26 degrees at frame rate. At 0.45 the same step is under a degree.
 *
 * Fractions rather than millimetres so a major and a minim probe in
 * proportion to themselves.
 */
export const PROBES: ProbeLayout = { ahead: 0.45, behind: 0.45 };

/** How far each section may bend, and how hard it chases. */
export interface SpineLimits {
  /** Radians either way from level, per section. */
  headMax: number;
  thoraxMax: number;
  gasterMax: number;
  /** How far the PROXIMITY bias alone may pitch a section. See below. */
  headNudge: number;
  gasterNudge: number;
  /**
   * How far the RIDE-HEIGHT term alone may pitch the gaster — the two-sided
   * one that holds her tail at its resting clearance. See `GASTER_RIDE_MM`.
   */
  gasterRide: number;
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
  /*
   * THIRTY DEGREES AT EACH JOINT, which is not thirty in each of these.
   *
   * These three are ABSOLUTE pitches in her own frame, and `QueenModel`
   * drives the bones with the DIFFERENCES between them — the head bone gets
   * `head - thorax`, the gaster bone gets `gaster - thorax`, and the hub
   * gets the thorax. So equal values are not a bend at all: 30/30/30 pitches
   * her whole body thirty degrees and folds nothing, measured at 2.1 degrees
   * of visible fold against 4.3 for a body doing nothing.
   *
   * A fold is a STAGGER. Thirty degrees at the neck, thirty at the waist and
   * thirty at the sting — the three pieces asked for — is head 60, thorax
   * 30, gaster -30 in this convention, and that is what these clamps now
   * allow. Measured fold at those extremes: 60.5 degrees nose to tail.
   */
  headMax: (60 * Math.PI) / 180,
  thoraxMax: (30 * Math.PI) / 180,
  gasterMax: (30 * Math.PI) / 180,
  /*
   * The proximity bias keeps a MEASURED authority, deliberately. It is an
   * emergency nudge away from something a section is about to touch, not a
   * posture, and giving it the fold's whole headroom would let half a
   * millimetre of terrain throw her head through sixty degrees. Thirty is
   * the head number v0.0.39 settled on. The gaster's grew from twenty-two
   * to forty for the corner's tail sweep: pitched up a wall, the tail
   * hangs toward the floor she is leaving and twenty-two degrees of tuck
   * could not carry it clear — an ant curls her gaster well past that in
   * life, and the bias only ever spends what the measured clearance asks.
   */
  headNudge: (30 * Math.PI) / 180,
  gasterNudge: (40 * Math.PI) / 180,
  /*
   * Twenty degrees, and deliberately the smallest of the three authorities.
   * The ride term is a POSTURE — it is acting most of the time she is off
   * her resting height, so it has to be the gentle one; the emergency shove
   * is `gasterNudge`, which is double it and fires only on a near-miss.
   */
  gasterRide: (20 * Math.PI) / 180,
  headRate: 11,
  thoraxRate: 6.5,
  gasterRate: 5.5,
};

/**
 * PROXIMITY, IN MILLIMETRES, and it is two numbers rather than one.
 *
 * `soft` is where a section starts easing away from what is in front of it;
 * `hard` is the shell it must not cross. Between them the bias ramps, so
 * ordinary terrain produces a lean and only a genuine near-miss produces
 * the full limit.
 *
 * Both are millimetres because that is the unit the design is argued in,
 * and the caller converts ONCE at the boundary. The version this replaces
 * was a bare `0.05` in world units — which at 5 mm to the unit is 0.25 mm,
 * five times what it read as. Naming the unit is the fix for that.
 *
 * Soft is 1.2 mm rather than a hair: at a 15 mm/s run that is a twelfth of
 * a second of travel, and a shell measured in tenths is less than one
 * frame's movement away.
 */
export const CLEARANCE_MM = { soft: 1.2, hard: 0.1 };

/**
 * THE ABDOMEN'S RIDE HEIGHT — a band she floats inside, not a rail.
 *
 * Asked for from the device, in these words: "can the abdomen try and stay
 * the normal idle height that it's above the ground? Like if it defaults to
 * 0.6 mm, it will float between 0.3 and 0.9 to not be so rigid, but can kind
 * of have a ragdoll body."
 *
 * That is a different law from `CLEARANCE_MM`, which is a proximity bias:
 * one-sided, silent until something is nearly touching, with no notion of a
 * height at all. It can shove the tail away from ground rising into it and
 * it can do nothing else — nothing ever asks the tail to come back DOWN, so
 * over ground falling away behind her it sits wherever the terrain pitch
 * left it. Both laws are wanted: this one holds the height, that one is the
 * emergency underneath it.
 *
 * THE NUMBERS ARE MEASURED, NOT THE ONES IN THE REQUEST. `probe-gaster`
 * puts her resting clearance at 0.79 mm rather than 0.6 — a good guess from
 * watching her, but a band centred on a height she never sits at is a band
 * she fights instead of floats in. So these are the request's own
 * proportions, plus or minus three tenths, about the real default.
 *
 * INSIDE IT NOTHING HAPPENS, and that is the ragdoll half. The tail is left
 * entirely to the terrain pitch and the corner's tail fold, exactly as
 * before; only LEAVING the band is an event.
 */
export const GASTER_RIDE_MM = { low: 0.5, high: 1.1 };

/**
 * What the probes found. TWO KINDS, and conflating them was a real bug.
 *
 * The RISES answer "where should this section point" — they are terrain
 * differences and may be any sign. The CLEARANCES answer "is this section
 * about to touch something" — they are measured distances from the drawn
 * shell to solid, and are never a function of a rise's sign.
 *
 * The first cut derived the clearances as `max(0, -rise)`, which is a
 * category error: any uphill rise at all, however small, made the pseudo-gap
 * exactly zero, which reads as maximally close, which added the FULL head
 * limit. Measured while walking, that fired on 89% of frames and swung the
 * head target over 55 degrees from half a millimetre of terrain. That was
 * the nodding.
 */
export interface SpineReading {
  /** Surface elevation ahead of her, relative to under her. */
  aheadRise: number;
  /** Surface elevation behind her, relative to under her. */
  behindRise: number;
  /**
   * MEASURED distance from the head's shell to solid, in the caller's own
   * units. Negative means already penetrating. Infinity when nothing is
   * near, which is the common case and must produce no bias at all.
   */
  headClear: number;
  /** The same, for the gaster's shell. */
  gasterClear: number;
  /**
   * HOW FAR HER BACK MUST BEND, in radians, nose-up positive.
   *
   * The angle between the surface her FRONT is over and the one her body is
   * still seated on — nought everywhere except at a corner, which is the
   * only place the rises cannot describe. Optional: a caller with no notion
   * of corners omits it and gets exactly the posture it got before.
   */
  fold?: number;
  /**
   * The GASTER'S OWN FOLD, when the tail must not trust the neck's.
   *
   * `fold` is the attitude still to turn, and the head is right to relax
   * as the body comes round — the nose is across by then. The tail is NOT:
   * it is still sweeping over the surface she is leaving, and keying its
   * lift to the shrinking attitude angle sat it down in exactly that sweep
   * — measured with the corner pre-tilt, the gaster shell went from five
   * frames inside the old floor to forty-two, all of them after the crest
   * with `fold` nearly spent. A caller who knows the rear feet have not
   * crossed yet passes the fold the TAIL should still believe. Optional;
   * omitted, the tail believes the neck as it always did.
   */
  tailFold?: number;
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
  /** In the SAME units as the clearances in `read`. */
  clearance: { soft: number; hard: number } = CLEARANCE_MM,
  /** Likewise — the gaster's ride band. See `GASTER_RIDE_MM`. */
  ride: { low: number; high: number } = GASTER_RIDE_MM,
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
   * THE PROXIMITY BIAS, off a MEASURED clearance and ramped across a band.
   *
   * Nought at `soft` and further, full at `hard` and closer, linear
   * between — so ordinary ground produces a lean and only a real near-miss
   * produces the limit. A single threshold could only ever be on or off,
   * and being on 89% of the time is what made her nod.
   */
  const band = Math.max(1e-9, clearance.soft - clearance.hard);
  const nearness = (gap: number): number => {
    if (!Number.isFinite(gap) || gap >= clearance.soft) return 0;
    return Math.min(1, Math.max(0, (clearance.soft - gap) / band));
  };
  const headBias = nearness(read.headClear) * limits.headNudge;
  const gasterBias = nearness(read.gasterClear) * limits.gasterNudge;

  /*
   * THE RIDE HEIGHT, which is the proximity bias's missing other half.
   *
   * Positive lifts the tail, negative lets it back down, and between the two
   * edges it is exactly nought — she floats, and the terrain pitch owns her
   * tail as it always did. Two things make it a ride height rather than a
   * second shove:
   *
   *   - it is SIGNED. Above the band it pulls DOWN. Nothing in this file
   *     has ever done that, which is why the tail could ride high over
   *     ground falling away behind her and simply stay there.
   *   - the lift ramps over the distance from the band's floor to CONTACT,
   *     so it is at its gentlest the moment she leaves the band and at full
   *     authority only when the shell is actually touching. Ramping over a
   *     fixed width instead would hand her the whole term for a tenth of a
   *     millimetre of dip.
   *
   * The settle side is deliberately slacker — a tail that is too HIGH is not
   * urgent, it is just stiff-looking, so it is given a whole millimetre to
   * come back over rather than snapping to the band's edge.
   */
  const SETTLE_OVER = 1;
  const rideOf = (gap: number): number => {
    if (!Number.isFinite(gap)) return 0;
    if (gap < ride.low) {
      const fall = Math.max(1e-9, ride.low - clearance.hard);
      return Math.min(1, (ride.low - gap) / fall);
    }
    if (gap > ride.high) return -Math.min(1, (gap - ride.high) / SETTLE_OVER);
    return 0;
  };
  const gasterRide = rideOf(read.gasterClear) * limits.gasterRide;

  /*
   * AND THE FOLD, which is the one thing a rise cannot say.
   *
   * The rises are elevation differences measured along her up, and at a
   * corner there are none: walking straight up a flat trunk, the surface
   * ahead of her is at the same height in her own frame, so both probes read
   * exactly zero. Measured on the island — climbing at 85.6 degrees, ahead
   * and behind both 0.00, head 0.0, thorax 0.0, gaster 19.4, frozen. A
   * plank. A corner is a change of surface NORMAL, and until now nothing in
   * this file could hear about one.
   *
   * `fold` is that angle, and it is spent as a stagger across the three
   * joints — two thirds to the neck, one third to the waist, one third back
   * the other way at the sting — because that is what makes a bend rather
   * than a tilt. See `SPINE_LIMITS`.
   */
  const fold = read.fold ?? 0;

  /*
   * THE EMERGENCY OUTRANKS THE POSTURE, which means it clamps SECOND.
   *
   * These used to be one sum inside one clamp, and at a full corner that
   * silenced the bias entirely: fold 1.5 asks the neck for 57 of its 60
   * degrees, the head hits the anatomical limit, and the proximity nudge —
   * the one term whose whole job is "you are about to touch that" — had
   * nothing left to spend. Measured on the trunk corner: head shell half a
   * millimetre INSIDE the wood for the last two millimetres of approach,
   * bias at full, contributing nought. So the POSTURE (terrain plus fold)
   * takes the anatomical clamp, and the bias adds on top with its own
   * headroom — a neck at ninety degrees for a few frames is a flinch, and
   * a flinch is what this term is. `Spine.follow` grants the same room.
   */
  const headPose = clamp(ahead + (fold * 2) / 3, limits.headMax);
  /*
   * SUBTRACTED, unlike the head's, because the two escape in opposite
   * signs. Positive pitch is nose-up: on the head that lifts the face
   * AWAY from ground beneath it, on the gaster it presses the tip INTO
   * it — tail-up is negative, as the cresting behaviour above and its
   * test both say. This bias shipped ADDED, so the abdomen's emergency
   * lift spent its whole authority pitching the abdomen into the hill it
   * was already touching. Seen from the outside as: her abdomen buries
   * itself on any uphill-behind slope, and nothing seems to care.
   */
  const gasterPose = clamp(behind - (read.tailFold ?? fold) / 3, limits.gasterMax);

  return {
    head: clamp(headPose + headBias, limits.headMax + limits.headNudge),
    thorax: clamp(through + fold / 3, limits.thoraxMax),
    /* Both tail terms subtract, because positive pitch presses the tip DOWN
     * — see the sign note on `gasterBias` above. The clamp is unchanged:
     * the ride term lives INSIDE the headroom the emergency already had
     * rather than widening how far her abdomen can ever swing. */
    gaster: clamp(gasterPose - gasterBias - gasterRide,
      limits.gasterMax + limits.gasterNudge),
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
    /*
     * Head and gaster keep the nudge's headroom here too — `posture` only
     * exceeds the anatomical limit when the proximity bias is spending its
     * own allowance, and re-clamping at the limit here would take it back.
     */
    this.now.head = ease(this.now.head, clamp(want.head, l.headMax + l.headNudge), l.headRate);
    this.now.thorax = ease(this.now.thorax, clamp(want.thorax, l.thoraxMax), l.thoraxRate);
    this.now.gaster = ease(
      this.now.gaster, clamp(want.gaster, l.gasterMax + l.gasterNudge), l.gasterRate,
    );
    return this.now;
  }
}
