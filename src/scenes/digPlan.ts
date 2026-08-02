/**
 * A tunnel written down before it is dug: a queue of pieces, each one a pitch,
 * a turn, a roll and a length.
 *
 * The shape is borrowed from a coaster builder, and it earns its keep twice.
 * The same list that drives HER through the soil is a path any other ant can
 * be given later, and the tunnel she leaves behind IS the floor they walk on —
 * one description, three uses, which is why it is worth having a description
 * at all rather than just steering by hand.
 *
 * Three conventions, and they are not the same as each other on purpose:
 *
 *   PITCH is ABSOLUTE, against world horizontal, nose-up positive. It is the
 *   same number the gyro holds, and it has to be absolute or it compounds —
 *   a relative pitch stacked piece on piece rolls the whole plan over inside
 *   a few segments. "Down fifteen" means down fifteen, wherever she came from.
 *
 *   TURN is RELATIVE and spread across the LENGTH, not applied at the joint.
 *   Snapping to a new heading at a piece boundary would have her pivot on the
 *   spot and chew out a sphere instead of a bend; distributed over the run it
 *   is a constant-radius curve, which is what a tunnel and a coaster both
 *   actually are. Left is positive.
 *
 *   ROLL is RELATIVE to the surface she is on — the bank. Counterclockwise
 *   positive, seen from behind her.
 *
 * Pacing is one millimetre of tunnel per second, which is what makes digging
 * cost something. She can walk eight times that, so the runner throttles her
 * to the plan rather than letting her outrun it.
 */

/** One piece of the plan. Angles in degrees, length in millimetres. */
export interface DigPiece {
  /** World grade to fly, nose-up positive. */
  pitch: number;
  /** Heading change across the whole piece, left positive. */
  turn: number;
  /** Bank off the surface, counterclockwise positive. */
  roll: number;
  /** How much tunnel this piece is, in millimetres. */
  length: number;
}

/** Millimetres of tunnel per second. The cost of digging, as a rate. */
export const PLAN_SPEED_MM_S = 1;

/**
 * How far ahead of schedule she is allowed to get before the throttle shuts.
 * A tight band, because the point of the pacing is that it is felt.
 */
const PACE_BAND_MM = 0.15;

/** The limits the builder offers, and the runner enforces. */
export const PIECE_LIMITS = {
  pitch: { min: -75, max: 75, step: 15 },
  turn: { min: -90, max: 90, step: 15 },
  roll: { min: -90, max: 90, step: 15 },
  length: { min: 1, max: 10, step: 1 },
} as const;

export function clampPiece(piece: DigPiece): DigPiece {
  const fit = (v: number, k: keyof typeof PIECE_LIMITS): number => Math.min(
    PIECE_LIMITS[k].max, Math.max(PIECE_LIMITS[k].min, v),
  );
  return {
    pitch: fit(piece.pitch, 'pitch'),
    turn: fit(piece.turn, 'turn'),
    roll: fit(piece.roll, 'roll'),
    length: fit(piece.length, 'length'),
  };
}

/** What the body should be doing this frame to fly the plan. */
export interface PlanStep {
  /** Grade to hold, radians, nose-up positive. */
  pitch: number;
  /** Bank to hold, radians, counterclockwise positive. */
  roll: number;
  /** Heading to add THIS STEP, radians, left positive. */
  turnDelta: number;
  /** How hard to walk, 0 to 1. */
  walk: number;
  /** True once every piece has been run. */
  finished: boolean;
}

const DEG = Math.PI / 180;

/**
 * Runs a plan, one frame at a time, against how far she ACTUALLY got.
 *
 * Fed real distance rather than assumed distance on purpose: she is walking
 * through soil she is still chewing, and a piece that is finished by the clock
 * rather than by the ground is a piece that did not get dug. Progress is
 * distance; the clock only sets the pace she is allowed to make it at.
 */
export class DigPlanRunner {
  private index = 0;
  /** Millimetres travelled within the current piece. */
  private travelled = 0;
  /** Seconds spent on the current piece. */
  private elapsed = 0;

  constructor(private readonly pieces: readonly DigPiece[]) {}

  get pieceIndex(): number { return this.index; }
  get piece(): DigPiece | null { return this.pieces[this.index] ?? null; }
  get finished(): boolean { return this.index >= this.pieces.length; }
  /** How far into the current piece she is, 0 to 1. */
  get progress(): number {
    const piece = this.piece;
    return piece ? Math.min(1, this.travelled / piece.length) : 1;
  }
  /** Millimetres of plan still to dig, across every remaining piece. */
  get remainingMm(): number {
    let left = 0;
    for (let i = this.index; i < this.pieces.length; i += 1) {
      left += this.pieces[i]!.length;
    }
    return left - this.travelled;
  }

  step(dt: number, movedMm: number): PlanStep {
    const piece = this.pieces[this.index];
    if (!piece) return { pitch: 0, roll: 0, turnDelta: 0, walk: 0, finished: true };

    /*
     * The turn is charged against DISTANCE, not time, so a piece that goes
     * slowly through hard going still comes out of the bend pointing the right
     * way. Charged against time it would over-rotate whenever she was held up.
     */
    const advanced = Math.max(0, Math.min(movedMm, piece.length - this.travelled));
    const turnDelta = piece.length > 0
      ? piece.turn * DEG * (advanced / piece.length)
      : 0;

    this.travelled += advanced;
    this.elapsed += dt;

    // Throttle to the plan's pace: she can walk eight times this.
    const owed = this.elapsed * PLAN_SPEED_MM_S - this.travelled;
    const walk = Math.max(0, Math.min(1, owed / PACE_BAND_MM));

    const out: PlanStep = {
      pitch: piece.pitch * DEG,
      roll: piece.roll * DEG,
      turnDelta,
      walk,
      finished: false,
    };

    if (this.travelled >= piece.length - 1e-9) {
      this.index += 1;
      this.travelled = 0;
      this.elapsed = 0;
      out.finished = this.index >= this.pieces.length;
      if (out.finished) out.walk = 0;
    }
    return out;
  }
}
