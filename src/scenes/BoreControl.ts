/**
 * Driving a digging ant like a boring machine.
 *
 * The model, in the words it was specified in: you SET a pitch, you TOGGLE the
 * dig on, and then the joystick moves you along that pitch. Forward at minus
 * forty-five digs down; leave the pitch alone and pull back and you reverse up
 * the same slope at plus forty-five. The dig button never moves you by itself.
 *
 * The version this replaces got all three of those wrong at once. It was
 * hold-to-dig, it crept you forward on its own so the ant "moved when it wasn't
 * supposed to", and movement ignored the pitch entirely — so the pitch gauge
 * read minus seventy-seven while she scraped a shallow trench along the
 * surface, because the only thing pitch touched was the direction of the bite.
 *
 * Free of three.js and of the scene, because the whole of it is a small state
 * machine and a few angles, and both are worth checking without a renderer.
 */

/** Radians per second the heading swings when NOT digging. */
export const YAW_RATE = 1.5;

/**
 * Radians per second the heading swings while digging, at full deflection.
 *
 * Ten degrees a second, against eighty-six above ground. A tunnel is a
 * committed shape and a boring head does not pivot; this is the difference
 * between steering a bore and waving it around.
 */
export const DIG_YAW_RATE = 10 * Math.PI / 180;

/**
 * Pitch is set in whole steps, not swept — straight down to straight UP, in
 * tens.
 *
 * The ceiling used to be level, on the reasoning that nothing wants to bore
 * into its own roof. That reasoning is right about the roof and wrong about the
 * game: dig a shaft, arrive at the bottom, and the only directions available
 * are level and further down. There is no way back to the surface, and being
 * unable to leave is a worse property than being able to make a silly tunnel.
 *
 * An ant that digs down can dig up. The dial is symmetric.
 */
export const PITCH_STEP = 10 * Math.PI / 180;
export const PITCH_MIN = -Math.PI / 2;
export const PITCH_MAX = Math.PI / 2;

/**
 * Seconds for one stroke of the head.
 *
 * A bite is taken at the BOTTOM of the stroke rather than on the button, which
 * is what ties the animation to the act: soil leaves at the moment her jaws
 * arrive. It also rate-limits digging to something a body could do.
 */
export const STROKE_SECONDS = 0.42;

/** Where in the stroke the jaws are deepest, as a fraction of it. */
const STRIKE_AT = 0.55;

export interface BoreInput {
  /** -1, 0 or 1: steer left, hold, steer right. */
  yaw: number;
  /** -1, 0 or 1: reverse, hold, advance. */
  forward: number;
}

export interface BoreStep {
  heading: number;
  pitch: number;
  /** Is the dig toggle on? */
  digging: boolean;
  /** 0..1 along the current stroke, for the head animation. */
  stroke: number;
  /** How deep the head is dipped, 0..1 — a smooth arc over the stroke. */
  dip: number;
  /** True on exactly the frame the jaws reach the bottom of the stroke. */
  bite: boolean;
}

export class BoreRig {
  heading: number;
  /** Radians, 0 down to -PI/2. Negative is downward — there is no aiming up. */
  pitch = 0;
  /** The dig toggle. Latched, not held. */
  digging = false;
  /** Seconds into the current stroke, or -1 when the head is at rest. */
  private phase = -1;

  constructor(heading = 0) {
    this.heading = heading;
  }

  get striking(): boolean {
    return this.phase >= 0;
  }

  /** Press the dig control. Toggles; the caller sends the press, not the hold. */
  toggleDig(): void {
    this.digging = !this.digging;
    if (!this.digging) this.phase = -1;
  }

  /**
   * Swing the heading directly, for the first-person look.
   *
   * From her own eyes a look-drag is not a camera orbit, it is her turning —
   * so it moves the same heading the joystick moves, rather than a separate
   * camera angle that would let the view and the bore disagree about which way
   * she is pointed.
   */
  turn(radians: number): void {
    this.heading += radians;
    if (this.heading > Math.PI) this.heading -= Math.PI * 2;
    if (this.heading < -Math.PI) this.heading += Math.PI * 2;
  }

  /**
   * Aim one step further down or up. Discrete, because the specification is in
   * ten-degree increments and a swept angle cannot be read off a gauge or
   * repeated between runs.
   */
  aim(steps: number): void {
    const raw = Math.round(this.pitch / PITCH_STEP) + steps;
    this.pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, raw * PITCH_STEP));
  }

  step(dt: number, input: BoreInput): BoreStep {
    /*
     * Steering is slow while digging and only counts while ADVANCING. You
     * cannot turn a tunnel by standing in it, and you certainly cannot turn one
     * by backing out of it — reversing follows the hole that is already there.
     */
    const advancing = input.forward > 0;
    const rate = this.digging ? (advancing ? DIG_YAW_RATE : 0) : YAW_RATE;
    this.heading += input.yaw * rate * dt;
    if (this.heading > Math.PI) this.heading -= Math.PI * 2;
    if (this.heading < -Math.PI) this.heading += Math.PI * 2;

    /*
     * Strokes run only while digging AND advancing. The dig toggle arms her; it
     * is the joystick that drives the head into the face. That is the whole of
     * "pressing Dig will not automatically move you", and it is why the old
     * automatic creep had to go rather than merely be slowed down.
     */
    let bite = false;
    const working = this.digging && advancing;
    if (this.phase < 0) {
      if (working) this.phase = 0;
    } else {
      const before = this.phase;
      this.phase += dt;
      const strike = STROKE_SECONDS * STRIKE_AT;
      bite = before < strike && this.phase >= strike;
      // A stroke that has begun always finishes, so letting go mid-lunge does
      // not snap the head back or swallow the bite it was about to take.
      if (this.phase >= STROKE_SECONDS) this.phase = working ? this.phase - STROKE_SECONDS : -1;
    }

    const stroke = this.phase < 0 ? 0 : this.phase / STROKE_SECONDS;
    return {
      heading: this.heading,
      pitch: this.pitch,
      digging: this.digging,
      stroke,
      dip: dipAt(stroke),
      bite,
    };
  }
}

/**
 * The head's dip over one stroke: down fast, out slow.
 *
 * A symmetric curve reads as a nod. Scraping is not symmetric — the strike is
 * quick and the recovery is the animal dragging its load back out — so the peak
 * sits after the middle and the return is the longer half.
 */
export function dipAt(stroke: number): number {
  if (stroke <= 0 || stroke >= 1) return 0;
  if (stroke < STRIKE_AT) {
    const t = stroke / STRIKE_AT;
    return t * t * (3 - 2 * t);
  }
  const t = (stroke - STRIKE_AT) / (1 - STRIKE_AT);
  return 1 - t * t * (3 - 2 * t);
}
