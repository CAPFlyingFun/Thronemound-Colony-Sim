/**
 * THE FLICK, AND THE BURST IT BUYS.
 *
 * Two separate jobs, kept apart on purpose:
 *
 *   1. reading a gesture — was that a pan or a flick, and which way
 *   2. the movement it starts — how far, how fast, for how long
 *
 * Neither knows anything about three.js, the scene, or an ant. The gesture
 * half sees four numbers off a pointer; the movement half hands back a
 * direction IN HER OWN FRAME and a speed, and the scene feeds those to the
 * same leg drive the joystick feeds. That is the whole reason it is shaped
 * this way: a dodge is not a second way of moving, it is the ordinary way of
 * moving with different numbers in it — so it inherits the surface walking,
 * the collision, the foot clipping and the measured-speed gait for free, and
 * on a vertical trunk "left" means along the bark without anything here
 * knowing a tree exists.
 *
 * The tuning is a plain object rather than constants so the RPG layer can
 * take it over later — species, maturity, stamina, cooldown, an evade window
 * — without touching the gesture reader or the scene.
 */

/** Which way a flick was aimed, in her own frame. */
export type DodgeDir = 'left' | 'right' | 'forward' | 'back';

/**
 * What separates a flick from a pan.
 *
 * STARTING VALUES, meant to be tuned on a real phone. A pan is slow and
 * long; a flick is short and fast, and all three have to agree — distance
 * alone catches a fast pan, duration alone catches a twitch that went
 * nowhere, and velocity alone catches a 4 px jitter between two samples.
 */
export const FLICK = {
  /** Longer than this and it was a look, however far it went. */
  maxMs: 220,
  /** Shorter than this and it was a twitch, however fast. */
  minPx: 35,
  /** Slower than this and it was a pan that happened to be brief. */
  minPxPerSec: 450,
  /**
   * How much longer the dominant axis has to be before it wins outright.
   *
   * A thumb flick is never square to an axis. Without a bias a 46/44 swipe
   * is decided by two pixels of noise, and the same gesture gives left one
   * time and forward the next. Requiring the winner to be a fifth longer
   * makes near-diagonals settle consistently; a true 45 falls through to
   * the vertical rule below, which is the safer guess on a thumb that
   * mostly moves up and down.
   */
  axisBias: 1.2,
};

/**
 * Everything the movement half needs, and everything the RPG layer will
 * want to put its hands on later.
 *
 * The distances are in MILLIMETRES because that is the unit the design is
 * argued in — a nine-millimetre ant, an eleven-millimetre side step. The
 * scene converts.
 */
export interface DodgeTuning {
  /** Sideways, in mm. */
  lateralMm: number;
  /** A burst along her nose — longer, because it is the way she is built. */
  forwardMm: number;
  /** Backing off — shorter, because reversing is not what six legs do best. */
  backMm: number;
  /** How long the whole thing takes. */
  seconds: number;
  /**
   * The last share of `seconds` spent handing control back to the stick,
   * 0..1. Without it the burst ends on a step change and she jerks.
   */
  releaseShare: number;
  /** Seconds before another dodge is allowed. Zero disables it. */
  cooldownSeconds: number;

  /*
   * DECLARED, NOT YET USED — the shape the RPG layer will fill in. They are
   * here so that adding them later is a change to one object rather than to
   * the gesture reader, the scene and the movement all at once.
   */
  /** Stamina a dodge costs. Nothing reads this yet. */
  staminaCost: number;
  /** Multiplies distance and speed — a major dodges further than a minim. */
  speciesScale: number;
  /** Multiplies distance and speed — a callow worker is slower. */
  maturityScale: number;
  /** Seconds of the dodge during which she counts as evading. Unread. */
  evadeSeconds: number;
}

/**
 * The prototype numbers, against a 9 mm ant walking at 7.5 mm/s.
 *
 * Eleven millimetres in a quarter of a second is 44 mm/s — about six times
 * her walk and three times her run, held for a quarter second. That reads as
 * a burst rather than a teleport, which is the line being walked here: far
 * enough to get out of the way, short enough that you can see her do it.
 */
export const DEFAULT_DODGE: DodgeTuning = {
  lateralMm: 11,
  forwardMm: 14,
  backMm: 8,
  seconds: 0.26,
  releaseShare: 0.35,
  cooldownSeconds: 0,
  staminaCost: 0,
  speciesScale: 1,
  maturityScale: 1,
  evadeSeconds: 0,
};

/** What a pointer did between going down and coming up. */
export interface Swipe {
  dx: number;
  dy: number;
  /** Total path length, which is NOT `hypot(dx, dy)` — a there-and-back
   *  drag covers ground without displacing, and is not a flick. */
  travelPx: number;
  ms: number;
}

/**
 * Was that a flick, and which way?
 *
 * `null` for everything else, which is most things — the default answer has
 * to be "that was a pan", or looking around becomes a minefield.
 *
 * Judged on DISPLACEMENT, not path: a flick is a throw in one direction, so
 * a gesture that wandered out and back has gone nowhere however fast it did
 * it. The path length is still required to be in the same neighbourhood, or
 * a circular scrub with a lucky endpoint would qualify.
 */
export function readFlick(s: Swipe, t: typeof FLICK = FLICK): DodgeDir | null {
  if (s.ms <= 0 || s.ms > t.maxMs) return null;
  const reach = Math.hypot(s.dx, s.dy);
  if (reach < t.minPx) return null;
  /* Straight enough: a flick's displacement is most of its path. */
  if (s.travelPx > reach * 1.6) return null;
  if ((reach / s.ms) * 1000 < t.minPxPerSec) return null;
  return aimOf(s.dx, s.dy, t);
}

/**
 * WHICH WAY A DRAG POINTS — the axis rule, on its own.
 *
 * Pulled out of `readFlick` so the DODGE BUTTON can share it. The button
 * asks a different question about WHETHER a gesture counts (see
 * `readNudge`) and must give the identical answer about which way it went,
 * or the same thumb movement would dodge left off the button and forward
 * off the screen. One rule, two callers.
 */
export function aimOf(dx: number, dy: number, t: typeof FLICK = FLICK): DodgeDir {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax > ay * t.axisBias) return dx > 0 ? 'right' : 'left';
  /* Screen y grows DOWNWARD, so a drag up is negative. */
  return dy < 0 ? 'forward' : 'back';
}

/** How far a thumb must travel off the DODGE plate to mean a direction. */
export const NUDGE_PX = 18;

/**
 * THE BUTTON'S GESTURE, which is deliberately NOT the flick's.
 *
 * The swipe reader has to tell a dodge apart from a look, because they
 * happen on the same patch of glass — hence the speed gate, the duration
 * cap and the straightness test. On a dedicated button none of that
 * ambiguity exists: the finger came down on DODGE, so it already said what
 * it wants and only has left to say which way. Requiring it to also be
 * FAST would reject the deliberate, aimed press this control is for, and
 * "I pressed the dodge button and nothing happened" is the worst outcome
 * available.
 *
 * So: displacement only, small threshold, no clock. `null` if the thumb
 * stayed put — a tap is not a direction, and guessing one would send her
 * somewhere the player did not ask for.
 */
export function readNudge(dx: number, dy: number): DodgeDir | null {
  if (Math.hypot(dx, dy) < NUDGE_PX) return null;
  return aimOf(dx, dy);
}

/** What the scene should be moving her by, this frame. */
export interface DodgeSample {
  active: boolean;
  /** -1..1 along her nose. */
  forward: number;
  /** -1..1 across her, positive to screen-right. */
  side: number;
  /** World units a second, already scaled by species and maturity. */
  speed: number;
  /**
   * How much of the movement is the DODGE's, 0..1 — the rest is whatever
   * the stick is asking for. Falls to zero over `releaseShare` so control
   * comes back smoothly instead of on a step.
   */
  authority: number;
}

const IDLE: DodgeSample = {
  active: false, forward: 0, side: 0, speed: 0, authority: 0,
};

/**
 * One dodge, in flight.
 *
 * Deliberately not a component, a system or a state machine: it is a timer
 * and a direction, because that is all a burst is. The scene asks it once a
 * frame what to move by and mixes that with the stick.
 */
export class Dodge {
  private left = 0;

  private span = 0;

  private dir: DodgeDir = 'left';

  private cool = 0;

  private distance = 0;

  constructor(private tuning: DodgeTuning = DEFAULT_DODGE) {}

  /** Swap the numbers out — where the RPG layer will hook in. */
  retune(tuning: DodgeTuning): void { this.tuning = tuning; }

  get active(): boolean { return this.left > 0; }

  get ready(): boolean { return this.left <= 0 && this.cool <= 0; }

  get direction(): DodgeDir { return this.dir; }

  /**
   * Begin, if she is allowed to. Returns whether it took, so the caller can
   * leave the gesture alone when it did not.
   */
  start(dir: DodgeDir, mmPerUnit: number): boolean {
    if (!this.ready) return false;
    const t = this.tuning;
    const scale = t.speciesScale * t.maturityScale;
    const mm = dir === 'forward' ? t.forwardMm : dir === 'back' ? t.backMm : t.lateralMm;
    this.dir = dir;
    this.span = Math.max(1e-3, t.seconds);
    this.left = this.span;
    this.distance = (mm * scale) / mmPerUnit;
    this.cool = t.cooldownSeconds;
    return true;
  }

  /** Stop dead — a dig arming, a scene pausing, a finger lost. */
  cancel(): void { this.left = 0; }

  /**
   * Advance and report.
   *
   * The speed profile is flat then eased out rather than a constant: a
   * burst that stops instantly looks like a dropped frame, and one that
   * eases in is not a burst. What matters for the animation is that this is
   * a SPEED handed to the same drive the stick uses — the gait still runs
   * off the distance she actually covered, so a dodge into a wall shows her
   * legs working and her body still.
   */
  sample(dt: number): DodgeSample {
    if (this.cool > 0) this.cool = Math.max(0, this.cool - dt);
    if (this.left <= 0) return IDLE;
    this.left = Math.max(0, this.left - dt);

    const done = 1 - this.left / this.span;
    const release = Math.min(0.95, Math.max(0.01, this.tuning.releaseShare));
    /* Eased out over the release tail, flat before it. */
    const shape = done <= 1 - release
      ? 1
      : Math.max(0, (1 - done) / release);
    /* The area under `shape` over the whole span is what carries her the
     * asked distance, so the peak has to be scaled by it. */
    const area = (1 - release) + release / 2;
    const speed = (this.distance / this.span / area) * shape;

    const lateral = this.dir === 'left' ? -1 : this.dir === 'right' ? 1 : 0;
    const along = this.dir === 'forward' ? 1 : this.dir === 'back' ? -1 : 0;
    return {
      active: true,
      forward: along,
      side: lateral,
      speed,
      authority: shape,
    };
  }
}
