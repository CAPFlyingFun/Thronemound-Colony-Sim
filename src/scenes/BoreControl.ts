/**
 * Steering a digging ant like a boring machine.
 *
 * Aiming with the camera put the crater wherever the view happened to be
 * pointing, which is fine for poking at a bank and hopeless for driving a
 * tunnel: the same tap gives a different hole depending on where you last
 * dragged. A tunnel is a shape you commit to over many bites, so what it
 * wants is a HEADING and a PITCH you set and hold — the way a cable-laying
 * bore is driven, and the way a submarine is: you do not aim a submarine by
 * looking at things.
 *
 * The whole of it is here, free of three.js and of the scene, because the
 * interesting part is a small state machine and a couple of angles and both
 * are worth testing without a renderer.
 */

/** Radians per second the heading and pitch swing under a held control. */
export const YAW_RATE = 1.5;
export const PITCH_RATE = 1.1;

/**
 * How far she can aim above and below level.
 *
 * Not symmetric, because digging is not. Straight down is a shaft and she
 * should be able to sink one; aiming far UP means boring into the ceiling of
 * her own tunnel and dropping it on herself, so it stops a little above level
 * — enough to climb out of a shaft, not enough to mine the roof.
 */
export const PITCH_MIN = -1.35;
export const PITCH_MAX = 0.45;

/**
 * Seconds for one stroke of the head.
 *
 * A bite is taken at the BOTTOM of the stroke rather than on the button, which
 * is what ties the animation to the act: soil leaves at the moment her jaws
 * arrive, so the crater and the lunge cannot disagree. It also rate-limits the
 * digging to something a body could do — mashing the button used to fire as
 * fast as the hand could move, which is both wrong to look at and how you ask
 * for twenty milliseconds of remeshing per tap.
 */
export const STROKE_SECONDS = 0.42;

/** Where in the stroke the jaws are deepest, as a fraction of it. */
const STRIKE_AT = 0.55;

export interface BoreInput {
  /** -1, 0 or 1: turn left, hold, turn right. */
  yaw: number;
  /** -1, 0 or 1: aim down, hold, aim up. */
  pitch: number;
  /** Is the dig control held? */
  boring: boolean;
}

export interface BoreStep {
  /** Radians, absolute. Her heading and the direction she bores. */
  heading: number;
  pitch: number;
  /** 0..1 along the current stroke, for the head animation. */
  stroke: number;
  /** How deep the head is dipped, 0..1 — a smooth arc over the stroke. */
  dip: number;
  /** True on exactly the frame the jaws reach the bottom of the stroke. */
  bite: boolean;
}

/**
 * The rig's state between frames. Small enough to be plain data, which keeps
 * the stepping function pure and therefore checkable.
 */
export class BoreRig {
  heading: number;
  pitch = 0;
  /** Seconds into the current stroke, or -1 when the head is at rest. */
  private phase = -1;

  constructor(heading = 0) {
    this.heading = heading;
  }

  /** True while a stroke is still running, even after the control is let go. */
  get striking(): boolean {
    return this.phase >= 0;
  }

  step(dt: number, input: BoreInput): BoreStep {
    this.heading += input.yaw * YAW_RATE * dt;
    // Wrapped, so a player who spins in one direction for a minute does not
    // accumulate a heading with no precision left in it.
    if (this.heading > Math.PI) this.heading -= Math.PI * 2;
    if (this.heading < -Math.PI) this.heading += Math.PI * 2;

    this.pitch = Math.min(
      PITCH_MAX, Math.max(PITCH_MIN, this.pitch + input.pitch * PITCH_RATE * dt),
    );

    /*
     * A stroke that has begun always finishes. Letting go halfway would snap
     * the head back from wherever it was, and — worse — could cancel the frame
     * the bite was going to be taken on, so a tap that looked like a dig would
     * sometimes remove nothing.
     */
    let bite = false;
    if (this.phase < 0) {
      if (input.boring) this.phase = 0;
    } else {
      const before = this.phase;
      this.phase += dt;
      const strike = STROKE_SECONDS * STRIKE_AT;
      bite = before < strike && this.phase >= strike;
      if (this.phase >= STROKE_SECONDS) this.phase = input.boring ? this.phase - STROKE_SECONDS : -1;
    }

    const stroke = this.phase < 0 ? 0 : this.phase / STROKE_SECONDS;
    return { heading: this.heading, pitch: this.pitch, stroke, dip: dipAt(stroke), bite };
  }
}

/**
 * The head's dip over one stroke: down fast, out slow.
 *
 * A symmetric curve reads as a nod. Scraping is not symmetric — the strike is
 * quick and the recovery is the animal dragging its load back out — so the
 * peak sits after the middle and the return is the longer half.
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
