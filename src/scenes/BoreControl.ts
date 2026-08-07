/**
 * Driving a digging ant the way the dig room does: HOLD to dig.
 *
 * The control has now been specified twice, in opposite directions, both by
 * the person playing it — which is worth recording so the next reversal is a
 * decision rather than an accident. The first spec was a latch: press once to
 * arm, and the joystick drives you along the pitch, because hold-to-dig
 * "fought the joystick" when both hands were doing continuous work. Then the
 * dig room shipped with press-to-dig and played better, and the verdict came
 * back: make it work like the dig room. So the button is the drive again —
 * hold it and she advances along the aim at jaw pace, cutting; release and
 * she stops. The pad only ever walks her, and reversing out of a bore is the
 * pad pulling back with the dig released.
 *
 * What survives from the latch era is everything that made it honest: pitch
 * steers the TRAVEL and not just the bite, bites land at the bottom of a
 * stroke so soil leaves when the jaws arrive, and a tunnel cannot be steered
 * like a mouse camera.
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

/**
 * Seconds from a cold press to the FIRST bite. The full wind-up puts the
 * strike 0.23 s after the button, which reads as the button not working —
 * a tap appeared to do nothing, and players pressed three times for one
 * bite. A stroke already in flight keeps the honest cadence; only the
 * first from rest starts mid-dip so soil leaves almost on the press.
 */
const FIRST_BITE_S = 0.08;

export interface BoreInput {
  /** -1, 0 or 1: steer left, hold, steer right. */
  yaw: number;
  /** -1, 0 or 1: reverse, hold, advance. */
  forward: number;
  /** Is the dig button held? Held is dug: the button IS the drive. */
  dig: boolean;
}

export interface BoreStep {
  heading: number;
  pitch: number;
  /** Is the dig button held this frame? */
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
  /** Radians; negative pitches down, positive up, clamped to a half turn. */
  pitch = 0;
  /** Mirrors the last step's `dig` input, for everything that reads state. */
  digging = false;
  /** Seconds into the current stroke, or -1 when the head is at rest. */
  private phase = -1;

  constructor(heading = 0) {
    this.heading = heading;
  }

  get striking(): boolean {
    return this.phase >= 0;
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

  /**
   * Aim exactly here, for the first-person look.
   *
   * Continuous where `aim` is stepped, because the look IS the aim now: the
   * camera's pitch and the dig's pitch are one number, and a drag that moved
   * the view in tens would judder. The keyboard keeps its ten-degree taps.
   */
  aimTo(radians: number): void {
    this.pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, radians));
  }

  step(dt: number, input: BoreInput): BoreStep {
    /*
     * Steering is slow while digging and only counts while ADVANCING. You
     * cannot turn a tunnel by standing in it, and you certainly cannot turn one
     * by backing out of it — reversing follows the hole that is already there.
     */
    /*
     * Holding the dig IS advancing, so the slow committed steering applies
     * the whole time it is held. Released, she steers at walking rate — in a
     * tunnel the walls constrain her far harder than any rate limit could.
     */
    this.digging = input.dig;
    const rate = this.digging ? DIG_YAW_RATE : YAW_RATE;
    this.heading += input.yaw * rate * dt;
    if (this.heading > Math.PI) this.heading -= Math.PI * 2;
    if (this.heading < -Math.PI) this.heading += Math.PI * 2;

    /*
     * Strokes run while the button is down. The button is the drive: soil
     * leaves at the bottom of each stroke and the scene advances her at jaw
     * pace for exactly as long as this is held.
     */
    let bite = false;
    const working = this.digging;
    if (this.phase < 0) {
      // From rest, start mid-dip: the first bite lands FIRST_BITE_S after
      // the press instead of a full wind-up later.
      if (working) this.phase = Math.max(0, STROKE_SECONDS * STRIKE_AT - FIRST_BITE_S);
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
