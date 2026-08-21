/**
 * A REASON TO WALK — the whole of Milestone 0's ant brain.
 *
 * Deliberately almost nothing. The colony simulator's ants dig, forage,
 * carry and fight, and none of that is here: this milestone exists to prove
 * that an ant can stand on voxel soil and move over it under her own
 * direction, with no hand on her. A brain that did more would make a failure
 * ambiguous — was it the walking, or was it the wanting?
 *
 * WHAT IT OWNS, AND ONLY THIS: what she WANTS to do, as a walk and a turn in
 * -1..1. It does not move her, it does not touch her legs, and it does not
 * know what a voxel is. That separation is the point of the milestone —
 * `AntBody` moves her, `LegDrive` poses her — and it is the rule the project
 * brief puts first.
 *
 * IT SENSES, THOUGH, and that is not the same as acting. She is inside a
 * glass tank; an animal that walks into the wall for ever and calls it
 * autonomy is not what anybody wants to watch. `groundAhead` is the one
 * question she asks the world, and turning away from a bad answer is a
 * decision, which is hers to make.
 *
 * DETERMINISTIC BY CONSTRUCTION. The randomness arrives as a function, so a
 * test can hand it a counter and a probe can hand it a seed and both get the
 * same ant every run. Nothing here calls `Math.random`.
 */

/** What she wants, in the units the movement system takes. */
export interface StrollIntent {
  /** -1..1 along her nose. */
  walk: number;
  /** -1..1 about her up; positive turns the way `LegDrive` calls positive. */
  turn: number;
  /**
   * 0..1 of DIGGING EFFORT — how far her head is dipped into the work.
   *
   * Optional, and the stroller never sets it: a wandering ant has nothing to
   * dip into. It lives on the intent rather than in a second channel because
   * it is the same kind of thing as `walk` and `turn` — something she WANTS,
   * in a unit her body knows how to act on — and splitting it out would give
   * two brains two different ways to ask for one pose.
   *
   * It is not decoration. Standing on flat soil her mandibles are 1.121 mm
   * ABOVE the ground; the dip brings them to 0.070 mm, which is the only
   * reason a bite taken at the jaw reaches the soil at all. Without it a
   * digger walks to her work, faces it, and can never touch it — measured,
   * before this field existed: eleven sites armed, zero bites taken.
   */
  dig?: number;
}

/** The one question she asks the world. */
export interface StrollSenses {
  /**
   * Is there somewhere to put a foot, `probe` units ahead along `heading`?
   *
   * A heading rather than "ahead of you" so she can look before she turns —
   * which is what stops her turning into the next wall along.
   */
  groundAhead(headingRad: number, probe: number): boolean;
}

/**
 * How far ahead she looks, in voxels (one voxel is five millimetres).
 *
 * A little over one body length for the queen, who is about 12 mm. Shorter
 * and she commits to a step before she can see the wall; much longer and she
 * turns away from ground she could happily have crossed.
 */
export const LOOK_AHEAD = 3;

/** How long one leg of a stroll lasts, in seconds, before she reconsiders. */
export const LEG_SECONDS = { min: 1.6, max: 4.5 } as const;

/** And how long she stands still when she does. */
export const PAUSE_SECONDS = { min: 0.4, max: 1.6 } as const;

/**
 * How sharply she comes off a wall, in -1..1 of turn.
 *
 * Hard, and not a nudge. A shallow turn against a flat pane means several
 * seconds of scraping along it, which reads as being stuck rather than as
 * choosing to go elsewhere.
 */
export const AVOID_TURN = 0.85;

/**
 * How much further she must see before she calls a wall cleared, as a
 * multiple of `lookAhead` — the HYSTERESIS, and it is not a refinement.
 *
 * Without it, the test that ends an avoid is the same test that began it, and
 * one frame of avoid-turn is 1.3 degrees — enough to flip `groundAhead` back
 * to true. Measured at the tray edge: 239 turn impulses in 30 seconds, of
 * which almost every one lasted a single frame, as she flipped between
 * walking and avoiding at frame rate and ground along the boundary instead of
 * leaving it. Her x/z never got further from the glass than the margin.
 *
 * Requiring a LONGER sightline to resume has a plain meaning — do not walk on
 * until you can see past the thing that stopped you — and it costs one extra
 * sense call on the frames she is already turning.
 */
export const CLEAR_AHEAD = 1.8;

/**
 * The shortest an avoid may last, in seconds.
 *
 * Hysteresis on the PROBE was not enough, and the trace says why: one frame
 * of avoid-turn moves her 1.3 degrees, which swings a probe three body
 * lengths ahead by about a third of a millimetre — and near the tray's edge
 * that is the difference between ground and no ground. So she entered the
 * avoid, turned once, found the way clear, and left. Four times a minute,
 * each one a single-frame turn impulse of 0.85.
 *
 * Widening the probes chases that; committing to the decision ends it. An
 * animal that has decided to turn away from something turns away from it —
 * it does not re-open the question 16 milliseconds later. This is the one
 * fix that does not depend on how sharp the sensor happens to be.
 */
export const AVOID_MIN_SECONDS = 0.3;

/**
 * How long a new-bearing turn is HELD, in seconds.
 *
 * The turn used to be returned on one frame and then dropped, which meant the
 * comment below — "a turn over the next leg rather than a teleported heading"
 * — described something the code did not do. One frame of 0.6 turn is 0.9
 * degrees, so striking off on a new bearing changed her course by about a
 * degree and she carried on essentially straight until she met the glass.
 *
 * Seconds rather than radians because this module is deliberately unit-free:
 * it says what she WANTS in -1..1 and has no idea how fast a turn of 1 is.
 * At the body's current rate this sweeps roughly 20 to 60 degrees.
 */
export const BEARING_SECONDS = { min: 0.35, max: 1.1 } as const;

type Phase = 'walking' | 'pausing' | 'avoiding';

export class AntStroll {
  private phase: Phase = 'walking';

  private left = 0;

  /** Which way she peels off an obstacle; held for the whole avoid. */
  private avoidSign = 1;

  /** How long the current avoid has run. See `AVOID_MIN_SECONDS`. */
  private avoiding = 0;

  /** Seconds of the current bearing sweep still to run, and how hard. */
  private turning = 0;

  private turnRate = 0;

  constructor(
    private readonly rand: () => number = Math.random,
    private readonly lookAhead = LOOK_AHEAD,
  ) {
    this.left = this.span(LEG_SECONDS);
  }

  private span(range: { min: number; max: number }): number {
    return range.min + this.rand() * (range.max - range.min);
  }

  /** For probes and tests: what she is doing, in one word. */
  get state(): string { return this.phase; }

  /**
   * One tick of wanting something. `heading` is her current bearing, so she
   * can ask about the direction she is about to face rather than the one she
   * is leaving.
   */
  step(dt: number, heading: number, senses: StrollSenses): StrollIntent {
    this.left -= dt;
    this.turning -= dt;
    if (this.phase === 'avoiding') this.avoiding += dt;

    /*
     * THE WALL COMES FIRST, whatever she was doing. A pause that ends with
     * her nose against the glass should not spend a stride walking into it,
     * and a stroll that reaches the glass mid-leg should not finish the leg.
     */
    if (this.phase !== 'avoiding' && !senses.groundAhead(heading, this.lookAhead)) {
      this.phase = 'avoiding';
      this.avoiding = 0;
      /*
       * Peel toward whichever side has ground. Asked at a quarter turn
       * either way — far enough to be a different direction, near enough
       * that she does not spin past the gap she is standing next to.
       */
      const q = Math.PI / 2;
      const rightOk = senses.groundAhead(heading + q, this.lookAhead);
      const leftOk = senses.groundAhead(heading - q, this.lookAhead);
      if (rightOk && !leftOk) this.avoidSign = 1;
      else if (leftOk && !rightOk) this.avoidSign = -1;
      /* Both or neither: keep turning the way she already was, so a corner
       * does not become a place she oscillates in. */
      this.left = 0;
      /*
       * The bearing sweep is LEFT ALONE. Cancelling it here was tidier to
       * read and it manufactured the exact fault `turnRuns` exists to catch:
       * a sweep that had just started, killed on its second frame, is a
       * one-frame turn impulse — and those are what snapped her gaster. The
       * avoid below returns its own turn while it is active, so it already
       * takes precedence; by the time it ends the sweep has usually expired
       * on its own, and if it has not, resuming it is what she was doing.
       */
    }

    if (this.phase === 'avoiding') {
      /* Turning on the spot until the way ahead is clear again. Not walking
       * while she does it: a wall is exactly where a forward stride cannot
       * go, and pressing into one is the scrabbling this avoids. */
      /*
       * Cleared only when she can see past the thing that stopped her AND
       * the near ground is good — see `CLEAR_AHEAD` for why the far probe
       * exists, and note that the far one ALONE is not enough.
       *
       * Blocked near and clear far is a real reading, not a contradiction:
       * a lip a body-length ahead with open tray beyond it answers exactly
       * that. Leaving on the far probe alone let her enter the avoid and
       * leave it on the next frame, which is a one-frame turn impulse — the
       * very thing `turnRuns` counts and the gaster snap it causes. Three of
       * them in sixty seconds, measured.
       *
       * Entering on the near probe and leaving on both is the hysteresis
       * stated properly: harder to leave than to enter, in both directions.
       */
      if (this.avoiding >= AVOID_MIN_SECONDS
        && senses.groundAhead(heading, this.lookAhead)
        && senses.groundAhead(heading, this.lookAhead * CLEAR_AHEAD)) {
        this.phase = 'walking';
        this.left = this.span(LEG_SECONDS);
        return { walk: 1, turn: 0 };
      }
      return { walk: 0, turn: AVOID_TURN * this.avoidSign };
    }

    if (this.left > 0) {
      /* Part-way through a leg — and possibly still part-way through the
       * bearing sweep that started it. */
      return this.phase === 'walking'
        ? { walk: 1, turn: this.turning > 0 ? this.turnRate : 0 }
        : { walk: 0, turn: 0 };
    }

    /* The leg ran out: walk after a pause, and after a walk either pause or
     * strike off on a new bearing. */
    if (this.phase === 'pausing') {
      this.phase = 'walking';
      this.left = this.span(LEG_SECONDS);
      return { walk: 1, turn: 0 };
    }
    if (this.rand() < 0.35) {
      this.phase = 'pausing';
      this.left = this.span(PAUSE_SECONDS);
      return { walk: 0, turn: 0 };
    }
    /* A new bearing, taken as a turn over the next leg rather than as a
     * teleported heading — she is an animal, not a turret. HELD, now: see
     * `BEARING_SECONDS` for why one frame of it was not a bearing change. */
    this.phase = 'walking';
    this.left = this.span(LEG_SECONDS);
    this.turnRate = (this.rand() * 2 - 1) * 0.6;
    this.turning = this.span(BEARING_SECONDS);
    return { walk: 1, turn: this.turnRate };
  }
}
