/**
 * WHAT KIND OF ANT SHE IS — and therefore what she can do.
 *
 * The HUD used to name its own buttons: three `plate('bite', …)` calls in a
 * row, hardcoded, which is fine for one ant and becomes an `if` ladder the
 * moment there are two. This is the table instead, and it is deliberately
 * shaped like `RIGS` in `hexapod.ts` — the codebase already keeps a
 * per-ant table, it just describes SKELETONS. This one describes abilities
 * and the numbers behind them, so there is one place to look up "what is
 * this ant" rather than two that can disagree.
 *
 * BUILT IS NOT THE SAME AS HAS. A species may list an ability the game has
 * not written yet; that plate is drawn dimmed rather than hidden, which is
 * the promise the HUD has been making since the first sheet landed. The
 * distinction lives on the ABILITY (does the game do this?) and the list
 * lives on the KIND (does this ant do this?), so a fire ant's sting and a
 * twig ant's lack of one are a data difference and not a code one.
 */
import { DEFAULT_VITALS, type VitalsTuning } from './islandVitals';

export type AbilityId =
  | 'bite' | 'sting' | 'carry' | 'drop' | 'climb' | 'scout'
  | 'interact' | 'eat' | 'drink' | 'attack';

export interface Ability {
  id: AbilityId;
  /** The plate art, which is also the file in `public/ui`. */
  art: string;
  label: string;
  /**
   * Has the GAME built this? A plate flips to true in the same commit as
   * the thing it does — BITE and STING did, in v0.1.23. The rest are still
   * honestly false.
   */
  built: boolean;
}

export const ABILITIES: Record<AbilityId, Ability> = {
  bite: { id: 'bite', art: 'bite', label: 'Bite', built: true },
  sting: { id: 'sting', art: 'sting', label: 'Sting', built: true },
  carry: { id: 'carry', art: 'carry', label: 'Carry', built: false },
  drop: { id: 'drop', art: 'drop', label: 'Drop', built: false },
  /* Climbing WORKS — she walks up a trunk without being asked. What does
   * not exist is a control for it, which is a different thing, and the
   * reason this is false rather than true. */
  climb: { id: 'climb', art: 'climb', label: 'Climb', built: false },
  /* Wears the SENSE plate until it has one of its own — same picture, its
   * own class, because the utility corner draws SENSE at 56 and the action
   * cluster draws at 62. Two sizes, one image. */
  scout: { id: 'scout', art: 'scout', label: 'Scout', built: false },
  interact: { id: 'interact', art: 'interact', label: 'Interact', built: false },
  eat: { id: 'eat', art: 'eat', label: 'Eat', built: false },
  drink: { id: 'drink', art: 'drink', label: 'Drink', built: false },
  attack: { id: 'attack', art: 'attack', label: 'Attack', built: false },
};

/**
 * HOW FAST THE GAME'S CLOCK RUNS against the one on the wall.
 *
 * Fifteen, as asked. One minute of play is a quarter of an ant's hour, so
 * a full ant day is 96 minutes of play — which is a good length for a day
 * and a bad length for a hunger bar, and the note on `FIRE_ANT_VITALS`
 * says what was done about that.
 */
export const GAME_MINUTES_PER_REAL_MINUTE = 15;

/** Real seconds in one hour of hers. */
export const REAL_SECONDS_PER_GAME_HOUR = (60 * 60) / GAME_MINUTES_PER_REAL_MINUTE;

/** A pool that empties over `hours` of her time, as a per-real-second rate. */
export function drainPerGameHours(max: number, hours: number): number {
  return max / (hours * REAL_SECONDS_PER_GAME_HOUR);
}

/**
 * THE FIRE ANT, from the literature — and where the literature had to give.
 *
 * WATER BEFORE FOOD, and that is not a guess. Water balance, not energy,
 * is what limits how far a fire ant forager will go from the nest, and a
 * worker dies somewhere between 36% and 50% of its body water lost. Ants
 * generally last 3-7 days without water against 4-10 without food, so
 * thirst is the roughly-twice-as-urgent of the two and it is coupled to
 * EXERTION rather than to the clock — which is also why the nest is a
 * refuge in this game as it is in the ground: a fire ant nest is kept at
 * 60-80% humidity against 40-60% outside.
 *
 * WHERE IT GAVE: four days of thirst at fifteen times real speed is six
 * and a half hours of play, and a bar that cannot move inside a session is
 * not a mechanic. So the biological RATIO is kept — water at about half
 * food's endurance, both weighted by effort — and the absolute is
 * compressed again, to roughly one of her days of ordinary surface work.
 * Stated plainly because it is a design decision wearing a research
 * finding's clothes, and the next person should know which is which.
 *
 * STAMINA is the one the biology mostly agreed with already. Colony time
 * budgets put workers at about two thirds inactive, and inactive workers
 * are the reserve that replaces active ones AS THEY TIRE — so resting has
 * to pay back faster than working spends, and a crawl has to count as
 * rest. Sustained walking is very nearly free, which the model already
 * had: an ant forages for tens of minutes at a stretch, and only the
 * bursts are expensive.
 */
export const FIRE_ANT_VITALS: VitalsTuning = {
  ...DEFAULT_VITALS,

  /* Seven seconds of running, and about the same again at a standstill to
   * earn it back — a rest-to-work ratio near the two-thirds the field
   * studies report, without making a burst feel like a punishment. */
  runDrain: 14,
  walkRecover: 8,
  restRecover: 14,
  dodgeCost: 10,
  secondWind: 25,

  /*
   * ZERO, STILL, AND ON PURPOSE. The rates below them are the researched
   * ones and they are what these fields become the day EAT and DRINK
   * exist. Until then a thirst clock is a countdown to a state the player
   * cannot leave, which is worse than an honest empty frame — see the rule
   * at the top of `islandVitals.ts`.
   */
  foodDrain: 0,
  waterDrain: 0,
};

/** What `foodDrain` and `waterDrain` become when there is a way to refill. */
export const FIRE_ANT_APPETITE = {
  /** One of her days of ordinary surface work. */
  waterDrain: drainPerGameHours(DEFAULT_VITALS.waterMax, 24),
  /** Two of them — the literature's roughly 2:1 against thirst. */
  foodDrain: drainPerGameHours(DEFAULT_VITALS.foodMax, 48),
} as const;

export interface AntKind {
  id: string;
  name: string;
  /** In the order they should sit on the rail, biggest job first. */
  abilities: AbilityId[];
  vitals: VitalsTuning;
}

export const FIRE_ANT: AntKind = {
  id: 'fire',
  name: 'Fire ant',
  abilities: ['bite', 'sting', 'carry', 'climb'],
  vitals: FIRE_ANT_VITALS,
};

/**
 * The one she was filmed as — a Graceful Twig Ant, from the video that got
 * the per-leg footing built. No sting; it is a slender arboreal ant that
 * lives on bark, so it scouts and climbs where the fire ant burns.
 *
 * Here to prove the table does what it is for: a second ant is a data
 * entry, not a branch in the HUD.
 */
export const TWIG_ANT: AntKind = {
  id: 'twig',
  name: 'Graceful twig ant',
  abilities: ['bite', 'scout', 'carry', 'climb'],
  vitals: DEFAULT_VITALS,
};

export const ANT_KINDS: Record<string, AntKind> = {
  fire: FIRE_ANT,
  twig: TWIG_ANT,
};
