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
import type { AntStrength } from './mandibleReach';

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
  /*
   * BOTH TRUE, and DROP is true without a plate of its own. `built` asks
   * whether the GAME does the thing, not whether some ant has a button for
   * it — and the game drops: CARRY wears DROP's art while she is loaded,
   * because the rail fits four action plates and the test below pins that.
   */
  carry: { id: 'carry', art: 'carry', label: 'Carry', built: true },
  drop: { id: 'drop', art: 'drop', label: 'Drop', built: true },
  /* Climbing WORKS — she walks up a trunk without being asked. What does
   * not exist is a control for it, which is a different thing, and the
   * reason this is false rather than true. It is also why it gave up its
   * rail slot to INTERACT: a dimmed plate for a thing that needs no button
   * is worth less than a lit one for a thing that does. */
  climb: { id: 'climb', art: 'climb', label: 'Climb', built: false },
  /* Wears the SENSE plate until it has one of its own — same picture, its
   * own class, because the utility corner draws SENSE at 56 and the action
   * cluster draws at 62. Two sizes, one image. */
  scout: { id: 'scout', art: 'scout', label: 'Scout', built: false },
  interact: { id: 'interact', art: 'interact', label: 'Interact', built: true },
  eat: { id: 'eat', art: 'eat', label: 'Eat', built: false },
  drink: { id: 'drink', art: 'drink', label: 'Drink', built: false },
  attack: { id: 'attack', art: 'attack', label: 'Attack', built: false },
};

/**
 * HOW FAST THE GAME'S CLOCK RUNS against the one on the wall.
 *
 * THIRTY. A full day of hers is 48 minutes of play, which is the number
 * that makes a day something a session actually contains — morning, heat,
 * evening and night can all happen while you are out — without it being a
 * strobe you turn your back on and lose a week to.
 *
 * It started at fifteen, and fifteen was wrong for a reason worth keeping:
 * a 96-minute day pushed every survival bar past the length of a session,
 * which had thirst compressed twice over to compensate. At thirty the
 * biology's own endurances land in the right place on their own — a day of
 * water is 48 minutes and two days of energy is 96 — and nothing has to be
 * fudged to make them felt.
 */
export const GAME_MINUTES_PER_REAL_MINUTE = 30;

/** Real seconds in one hour of hers. */
export const REAL_SECONDS_PER_GAME_HOUR = (60 * 60) / GAME_MINUTES_PER_REAL_MINUTE;

/** A pool that empties over `hours` of her time, as a per-real-second rate. */
export function drainPerGameHours(max: number, hours: number): number {
  return max / (hours * REAL_SECONDS_PER_GAME_HOUR);
}

/**
 * THE FIRE ANT — and a correction to what this file said in v0.1.22.
 *
 * WATER BEFORE ENERGY still stands, and it is the best-sourced thing here:
 * at a long foraging distance many workers come back dehydrated and with
 * no sugar load at all, and the authors concluded water balance rather
 * than energy limits foraging RANGE under unsaturated humidity. That is
 * why thirst is coupled to exertion and shelter rather than to a clock,
 * and why the nest is a refuge — 60-80% humidity inside against 40-60%
 * out. See `WATER_CURVE`.
 *
 * WHAT WAS WRONG: "3-7 days without water, 4-10 without food" came from
 * pest-control pages, not from the literature, and it should never have
 * been encoded as a constant. The controlled work is size-dependent and
 * measured under severe stress — at about 23.5% relative humidity, small
 * workers reach 50% mortality in roughly 14-16 hours and large ones in
 * 43-47. That is not a thirst clock; it is a desiccation experiment, and
 * a worker in humid nest air is in a different situation entirely. Which
 * is precisely why the curve, not the number, is doing the work now.
 *
 * ALSO WRONG: this file claimed workers are about two thirds inactive and
 * that inactive ants relieve tiring ones. The two-thirds is from the
 * general ant-inactivity literature, not from Solenopsis, and the relief
 * mechanism was a SIMULATION result stated as an observation. Fire ants
 * specifically sleep in micro-naps — on the order of 250 episodes a day
 * averaging about a minute, some 4.8 hours in total — with most of the
 * workforce doing something at any given moment. So stamina is NOT a
 * fatigue-over-a-day meter and never was: it is short-term burst capacity,
 * which is what the model already implemented and what the comment got
 * wrong about why.
 */
export const FIRE_ANT_VITALS: VitalsTuning = {
  ...DEFAULT_VITALS,

  /*
   * Eleven seconds of running, and about eight at a standstill to earn it
   * back. Longer than the seven it shipped with: an ant sustains ordinary
   * locomotion for a long time and only BURSTS are expensive, so the bar
   * should punish sprinting rather than punish being an ant.
   */
  runDrain: 9,
  walkRecover: 8,
  restRecover: 13,
  dodgeCost: 10,
  secondWind: 25,

  /*
   * LIVE NOW, and gated by biology rather than by a missing mechanic:
   * `Vitals.feeding` is false through the founding, because a claustral
   * queen eats nothing until her first workers eclose. These rates are
   * what she spends once they do.
   *
   * A day of hers for water, two for energy — the 2:1 the foraging work
   * implies — measured at an ordinary walk and then bent by `WATER_CURVE`
   * and `ENERGY_CURVE`. At 30x that is 48 real minutes of surface
   * wandering for a full water bar, about 26 of hard digging, and better
   * than three hours if she stays in the nest.
   */
  waterDrain: drainPerGameHours(DEFAULT_VITALS.waterMax, 24),
  energyDrain: drainPerGameHours(DEFAULT_VITALS.energyMax, 48),
};

export interface AntKind {
  id: string;
  name: string;
  /** In the order they should sit on the rail, biggest job first. */
  abilities: AbilityId[];
  vitals: VitalsTuning;
  /*
   * WHICH ROW OF `STRENGTH` THIS ANT LIFTS BY. Data, exactly like `vitals`
   * — so a major out-hauling a worker is a table entry rather than a branch,
   * which is the same promise the ability list makes.
   *
   * It sits on the KIND today because the island has one playable ant. It
   * belongs to the CASTE, and should move there the moment the roster does:
   * the queen, her first nanitic and a major are three sets of limits on
   * one species, not three species.
   */
  strength: AntStrength;
}

export const FIRE_ANT: AntKind = {
  id: 'fire',
  name: 'Fire ant',
  /*
   * INTERACT TAKES CLIMB'S SLOT. The rail fits four and the test below pins
   * it, so a fifth plate is not a decision anybody gets to make — and of
   * the two, CLIMB is the one that already happens without being asked
   * while INTERACT is a verb the player has no other way to reach.
   */
  /*
   * NO STING, BECAUSE THIS LIST IS THE QUEEN'S.
   *
   * Reported from the device: "the queen can't sting and need to remove that
   * from the queen as I saw it as another bug." A control that is offered and
   * does nothing is worse than one that is absent — that is this file's own
   * rule, one line up from here.
   *
   * Worth being precise about what is being said, because the mechanic is
   * NOT being deleted: `islandCombat` still implements grip, sting and venom
   * in full, and `ABILITIES.sting.built` stays true. What changes is who has
   * it. A fire-ant WORKER stings and it is most of what she is for; a
   * founding queen is sealed in a chamber with no colony and nothing to
   * sting, and the ant being played is her.
   *
   * (Biologically a mated Solenopsis queen does keep a functional sting —
   * every female aculeate does. She has essentially no occasion to use it
   * during claustral founding, so this is a GAME decision about the founding
   * phase rather than a claim about the animal.)
   *
   * The comment on `strength` above already says this list belongs on the
   * CASTE rather than the kind. This is the first place that actually bites:
   * when the roster lands, sting comes back on the worker caste rather than
   * being re-added here.
   */
  abilities: ['bite', 'carry', 'interact'],
  vitals: FIRE_ANT_VITALS,
  /* The one being played is her, and she is a queen. */
  strength: 'queen',
};

/**
 * THE ANT YOU BECOME once the nest exists — and the roster this file has
 * been promising since `strength` was written.
 *
 * Asked for: "when you create your nest, you no longer control the queen
 * and you start as the worker."
 *
 * Which is right for the animal as well as for the game. A claustral queen
 * founds and then never leaves again; everything the rest of the colony's
 * life consists of — foraging, hauling, fighting, digging out — is done by
 * workers. Playing the queen past the founding would mean playing the one
 * ant whose remaining job is to stay in a chamber and lay.
 *
 * STING COMES BACK HERE, exactly as the note on `FIRE_ANT.abilities`
 * predicted it would: the mechanic was never deleted, only taken off the
 * queen, because a founding queen sealed in a chamber has nothing to sting.
 * A fire-ant worker stings and it is most of what she is for. Four
 * abilities is the rail's capacity, which the HUD test pins.
 *
 * THE VITALS ARE THE QUEEN'S FOR NOW, and that is untuned rather than
 * decided. A worker is a fraction of a queen's mass and should not have a
 * queen's pool, but inventing a second table before there is a worker to
 * feel it would be picking numbers to look thorough. It gets its own the
 * moment there is a reason to tell them apart.
 */
export const FIRE_ANT_WORKER: AntKind = {
  id: 'fire-worker',
  name: 'Fire ant worker',
  abilities: ['bite', 'sting', 'carry', 'interact'],
  vitals: FIRE_ANT_VITALS,
  strength: 'worker',
};

/**
 * THE MAJOR, WRITTEN DOWN BEFORE SHE IS PLAYABLE — deliberately.
 *
 * Her rig, her combat row and her strength row all exist already; what did
 * not exist was the answer to "which plates are hers", and that answer was
 * asked for by name: bite and sting for the worker AND the major. Putting
 * her in the table now means the day a major becomes playable is a control
 * handover, not a HUD design session — the same promise this file makes
 * about every caste. Same abilities as the worker, same order, so the rail
 * never shuffles between the two; what differs is the animal behind them
 * (a major bites 9 to a worker's 4 — see `CASTE_COMBAT`).
 */
export const FIRE_ANT_MAJOR: AntKind = {
  id: 'fire-major',
  name: 'Fire ant major',
  abilities: ['bite', 'sting', 'carry', 'interact'],
  vitals: FIRE_ANT_VITALS,
  strength: 'major',
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
  strength: 'worker',
};

/**
 * Every ability any caste the PLAYER can be has, in rail order.
 *
 * The HUD's action rail is built from this once and gated per-frame against
 * whichever kind she currently is, because the rail cannot be rebuilt — see
 * the note in `islandHud`. Derived rather than typed out, so a caste that
 * gains an ability gains its plate with nothing else to remember.
 *
 * Worker order first, because it is the superset: the queen's three are a
 * subset of it in the same order, so neither caste sees its plates shuffle.
 */
export const PLAYABLE_ABILITIES: AbilityId[] = [
  ...FIRE_ANT_WORKER.abilities,
  /* The major's set is the worker's set today, so this line adds nothing —
   * and that is why it is here: the day her set grows, her plates arrive
   * without anyone remembering this list exists. */
  ...FIRE_ANT_MAJOR.abilities.filter((id) => !FIRE_ANT_WORKER.abilities.includes(id)),
  ...FIRE_ANT.abilities.filter((id) => !FIRE_ANT_WORKER.abilities.includes(id)),
];

export const ANT_KINDS: Record<string, AntKind> = {
  fire: FIRE_ANT,
  twig: TWIG_ANT,
};
