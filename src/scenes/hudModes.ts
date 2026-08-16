/**
 * WHAT THE HUD SHOWS, AND WHEN — one table, not a drift of conditionals.
 *
 * THE REPORT THIS EXISTS FOR: ten action plates on screen at once — TILT,
 * RIDE, VIEW, WALK, INTERACT, CARRY, STING, BITE, DODGE, DIG — every one of
 * them at the same volume, in every situation. Normal exploration does not
 * need a sting button. It is busy to look at, and worse than that it EATS
 * THE SCREEN: the camera is driven by dragging the world, and a wall of
 * plates across the lower right is a wall of things that swallow the drag.
 * The clutter and the missing camera space are the same bug.
 *
 * WHY A TABLE RATHER THAN `if`s. The old rule was three modes deep and
 * already spread across a dozen call sites — a `railPart` here, a
 * `style.display` there, a `refreshCombatChips` that lit two plates by
 * hand. Every new mode multiplies those. Declaring the whole matrix in one
 * place means a mode is a ROW you can read, a test can assert the row, and
 * `applyHudMode` becomes a loop rather than a ladder.
 *
 * PURE, and deliberately so: no DOM, no THREE, no scene. It takes what is
 * TRUE about the ant and returns what should be ON SCREEN. That is the part
 * worth unit-testing, and `tests/hudModes.test.ts` does.
 */

/** The situations the HUD dresses for. */
export type HudMode = 'explore' | 'dig' | 'combat' | 'carry' | 'pose';

/** Every control the mode table may place. Names match the plate art. */
export type HudPart =
  | 'dig' | 'scoop' | 'instruments' | 'aim' | 'roll' | 'heading' | 'depth'
  | 'view' | 'dodge' | 'bite' | 'sting' | 'carry' | 'interact'
  | 'pace' | 'ride' | 'tilt' | 'poseRow';

/**
 * How loudly a part appears in a given mode.
 *
 * `contextual` is the one that carries weight: it means "this mode ALLOWS
 * it, and something else decides whether it is true right now" — INTERACT
 * when there is something in reach, CARRY when her jaws are full. Splitting
 * that from `hidden` is what stops a contextual control being confused with
 * an irrelevant one.
 */
export type HudRank = 'primary' | 'secondary' | 'contextual' | 'hidden';

export interface HudLayout {
  /** The hero. One per mode — the thing this mode is FOR. */
  readonly primary: HudPart;
  /** Present and normal-weight. */
  readonly secondary: readonly HudPart[];
  /** Allowed here, but only when its own condition holds. */
  readonly contextual: readonly HudPart[];
}

/*
 * THE TABLE.
 *
 * Read a row as: this is what she can reasonably do NOW. Anything not named
 * is hidden, which is the default and is not written out — a list of
 * absences is a list that goes stale.
 *
 * DIG IS IN EXPLORE and SCOOP is not: arming the shovel is an explore-time
 * decision, and the stroke only exists once it is armed. DIG stays visible
 * inside `dig` too, because it is also the way OUT — a mode you can enter
 * and not leave is the bug that put a ceiling on the old rail.
 *
 * CARRY IS CONTEXTUAL EVERYWHERE, including in combat. She can be holding a
 * beetle when another one arrives, and a DROP that vanished because the HUD
 * decided this was a fight would strand the load.
 */
export const HUD_LAYOUTS: Record<HudMode, HudLayout> = {
  explore: {
    primary: 'dig',
    secondary: ['view', 'pace'],
    /*
     * HER WEAPONS RIDE ON HER HIP NOW, and this is a change of mind worth
     * stating because a test used to pin the opposite ("exploration does
     * not need a sting button"). Asked for since: "add bite and sting
     * button available for the worker and major, only bite for queen" —
     * the player wants the jaws at hand BEFORE the HUD decides a fight is
     * on, not only once a beetle crosses `FIGHT_NOTICE`.
     *
     * CONTEXTUAL, not secondary, which is what keeps this honest: the
     * plates sit dimmed until there is something living in reach (BITE)
     * or a grip to sting from (STING), exactly the language INTERACT and
     * CARRY already speak. Which CASTE sees which plate is not decided
     * here at all — the rail gates every plate on the ant's own ability
     * list, so the queen's rail shows BITE and never STING because her
     * list says so. Data, not a branch.
     */
    contextual: ['interact', 'carry', 'bite', 'sting'],
  },
  dig: {
    primary: 'scoop',
    /*
     * The instruments are the dig's readouts — pitch, roll, bearing,
     * depth. They are not clutter here; they are the reason the mode is
     * legible: reported from the device as thinking she was still heading
     * DOWN while actually curling back up to the surface in a loop, which
     * is exactly the blindness a full attitude panel exists to cure.
     *
     * AND VIEW HAS LEFT, which is a change of mind worth stating because
     * the test used to demand it in every mode. That demand was written
     * for COMBAT — a mode something ELSE drops her into, where a camera
     * she had a second ago must not vanish unchosen. Dig is the opposite
     * case: SHE armed it, arming it IS choosing the first-person aiming
     * eye (the look is the aim — see `aimTo`), and a VIEW plate here is a
     * button whose only effect is to break the mode's own premise. The
     * way out of first person is the way out of the dig: the DIG plate,
     * which stays.
     */
    secondary: ['dig', 'instruments', 'aim', 'roll', 'heading', 'depth'],
    contextual: [],
  },
  combat: {
    primary: 'bite',
    /*
     * AND STING IS BACK, because a stinging caste is playable now.
     *
     * The note below said this in as many words — "if a stinging caste
     * becomes playable, six needs re-measuring rather than re-arguing" —
     * and the founding handing the player a worker is that. The cluster
     * holds FIVE, measured, so the sixth could not simply be added and
     * DODGE is the plate that left.
     *
     * AND NOTHING LEFT TO MAKE ROOM. Dropping dodge was the first answer
     * and it was withdrawn on measurement: combat was dodge's ONLY mode, so
     * taking its seat did not move it elsewhere, it removed dodging from
     * the HUD altogether. On a phone that is the mechanic gone, whatever
     * the table says about the mechanic.
     *
     * So this is six, and six was re-measured rather than re-argued — see
     * `probe:hudmodes` and the cap in the test. The plates are smaller than
     * they were when five was found, which is why the answer changed.
     *
     * VIEW IS BACK, and the seat it needed came from STING leaving.
     *
     * It was pulled as the sixth plate: six wrapped the cluster to a second
     * row and the far end of the arc landed on the quest text, and the
     * reasoning was that nobody switches camera mid-fight. Reported from the
     * device, and it is the better argument: "realized VIEW wasn't available
     * when I was attacking the beetle, but should allow both 1st and 3rd
     * person." Fighting is exactly when you want to choose whether you are
     * looking down your own mandibles or watching yourself do it, and a mode
     * you can be dropped INTO by a beetle wandering up must not silently
     * take away a camera you had a moment ago.
     *
     * It fit at first because the queen had no sting — see `FIRE_ANT` — so
     * that was five plates where it had been six, and the plate that left
     * was the one she could not use anyway. That is no longer why it fits;
     * see the note above. The `partsIn` count test below is what holds the
     * five either way.
     */
    secondary: ['sting', 'view', 'dodge', 'pace'],
    contextual: ['carry'],
  },
  carry: {
    /* Wearing DROP's face, which is the point: the primary action while
     * loaded is putting it down. */
    primary: 'carry',
    secondary: ['view', 'pace'],
    contextual: ['interact', 'dig'],
  },
  /*
   * POSE has no plates of its own any more. TILT and RIDE moved into the
   * DEV drawer — the blueprint's action list does not include them and a
   * device report named them among the ten that were eating the camera
   * drag — so what this mode does is get everything ELSE out of the way
   * while the stick is driving her body, and show the numbers it is
   * driving. See the note in `islandHud.ts` for the move and its cost.
   */
  pose: {
    primary: 'view',
    secondary: ['poseRow', 'instruments', 'aim'],
    contextual: [],
  },
};

/** What the ant is doing, as far as the HUD needs to know. */
export interface HudSignals {
  /** The shovel is armed. An explicit choice, so it outranks everything. */
  digging: boolean;
  /** A posture rig is armed. Also explicit. */
  posed: boolean;
  /** Something worth fighting is close enough to matter. */
  fighting: boolean;
  /** Her jaws are full. */
  carrying: boolean;
}

/**
 * WHICH MODE, and the order matters more than the list does.
 *
 * The two the PLAYER chose come first — arming the shovel or a posture rig
 * is a deliberate act, and a HUD that overrode it because a beetle wandered
 * past would be taking the controls away mid-task. After that the world
 * gets a say: a fight is more urgent than a load, because a load can wait
 * and can still be dropped (CARRY is contextual in `combat` for exactly
 * that reason).
 */
export function pickMode(s: HudSignals): HudMode {
  if (s.digging) return 'dig';
  if (s.posed) return 'pose';
  if (s.fighting) return 'combat';
  if (s.carrying) return 'carry';
  return 'explore';
}

/** How this part should appear in this mode. */
export function rankOf(mode: HudMode, part: HudPart): HudRank {
  const layout = HUD_LAYOUTS[mode];
  if (layout.primary === part) return 'primary';
  if (layout.secondary.includes(part)) return 'secondary';
  if (layout.contextual.includes(part)) return 'contextual';
  return 'hidden';
}

/**
 * Everything this mode can put on screen, contextual parts included.
 *
 * The ceiling rather than the count — what is actually up also depends on
 * the contextual conditions. Used by the probe to assert no mode can ever
 * show the whole set.
 */
export function partsIn(mode: HudMode): HudPart[] {
  const layout = HUD_LAYOUTS[mode];
  return [layout.primary, ...layout.secondary, ...layout.contextual];
}
