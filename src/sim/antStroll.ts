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

type Phase = 'walking' | 'pausing' | 'avoiding';

export class AntStroll {
  private phase: Phase = 'walking';

  private left = 0;

  /** Which way she peels off an obstacle; held for the whole avoid. */
  private avoidSign = 1;

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

    /*
     * THE WALL COMES FIRST, whatever she was doing. A pause that ends with
     * her nose against the glass should not spend a stride walking into it,
     * and a stroll that reaches the glass mid-leg should not finish the leg.
     */
    if (this.phase !== 'avoiding' && !senses.groundAhead(heading, this.lookAhead)) {
      this.phase = 'avoiding';
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
    }

    if (this.phase === 'avoiding') {
      /* Turning on the spot until the way ahead is clear again. Not walking
       * while she does it: a wall is exactly where a forward stride cannot
       * go, and pressing into one is the scrabbling this avoids. */
      if (senses.groundAhead(heading, this.lookAhead)) {
        this.phase = 'walking';
        this.left = this.span(LEG_SECONDS);
        return { walk: 1, turn: 0 };
      }
      return { walk: 0, turn: AVOID_TURN * this.avoidSign };
    }

    if (this.left > 0) {
      return this.phase === 'walking'
        ? { walk: 1, turn: 0 }
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
     * teleported heading — she is an animal, not a turret. */
    this.phase = 'walking';
    this.left = this.span(LEG_SECONDS);
    return { walk: 1, turn: (this.rand() * 2 - 1) * 0.6 };
  }
}
