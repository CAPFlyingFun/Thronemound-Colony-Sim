/**
 * WHAT KEEPS HER GOING — health, stamina, energy and water.
 *
 * The first of the four systems the HUD has been drawing hatched bars for
 * since v0.1.12, and it goes in ahead of combat on purpose: a sting makes
 * DAMAGE, and damage needs somewhere to land. Building the jaws first would
 * mean inventing a health field inside the combat module and moving it out
 * afterwards, which is the churn the file split was meant to end.
 *
 * THE RULE THIS FILE IS BUILT AROUND: a bar may only move if there is a way
 * to move it BACK.
 *
 * Stamina has one — she rests. So stamina is fully live: running spends it,
 * dodging costs a lump of it, and standing still or crawling pays it back.
 *
 * Health has a floor and an API and nothing that can lower it yet, which is
 * not a lie: she IS unhurt, and the bar says so accurately. It is here so
 * that STING has a real place to write to on the day it exists.
 *
 * ENERGY, NOT FOOD, and the difference is the whole fire-ant point. An
 * adult worker runs on liquid carbohydrate — nectar, honeydew, whatever a
 * nestmate hands her mouth to mouth. Solid prey is not her dinner; it is
 * the COLONY'S, carried home and given to fourth-instar larvae, which are
 * the nest's digestive system and hand back liquid the adults can use. So
 * her bar is her own working energy and the colony's food store is a
 * separate number in a separate strip, which is why they are drawn apart.
 *
 * AND SHE DOES NOT EAT AT ALL WHILE SHE IS FOUNDING. A newly mated fire
 * ant queen seals herself in and raises the first brood on her own body —
 * fat, crop, and the flight muscles she no longer needs, broken down. She
 * takes nothing from outside until the first workers eclose. So `feeding`
 * is off until the colony can feed her, and that is not a placeholder for
 * a missing mechanic: it is the mechanic.
 *
 * Pure arithmetic on purpose: no THREE, no DOM, no scene. It is the easiest
 * kind of thing to get subtly wrong and the easiest kind to test.
 */

/** The numbers, in one object so a species or a maturity can take them over. */
export interface VitalsTuning {
  /** Stamina is a 0..100 pool; the others are the same scale for symmetry. */
  staminaMax: number;
  /** Spent per second at a run. */
  runDrain: number;
  /** Paid back per second walking — she recovers ON THE MOVE, slowly. */
  walkRecover: number;
  /** Paid back per second at a crawl or a standstill. */
  restRecover: number;
  /** One dodge, as a lump. */
  dodgeCost: number;
  /**
   * Once empty she may not run again until this much is back.
   *
   * WITHOUT IT the pace latch stutters: stamina hits zero, sprint is
   * refused, one frame of walking pays back a fraction, sprint is allowed,
   * it is spent again on the same frame. The player sees a run that flickers
   * rather than a run that ended.
   */
  secondWind: number;

  healthMax: number;
  /** Her own working energy, which is NOT the colony's food store. */
  energyMax: number;
  waterMax: number;
  /**
   * Per second at an ordinary walk, before `effortRate`.
   *
   * Zero while she is founding — see `feeding` — rather than zero because
   * the mechanic is missing.
   */
  energyDrain: number;
  waterDrain: number;
  /** Health a second once a bar is empty. */
  deprivedDamage: number;
}

export const DEFAULT_VITALS: VitalsTuning = {
  staminaMax: 100,
  /*
   * About seven seconds of running from full, and about ten to earn it
   * back at a walk. An ant's sprint is a burst rather than a gear, so a
   * number that makes you SPEND it deliberately is closer to the animal
   * than one you can leave latched — but it is a first guess on a phone
   * nobody has held yet, and it is one field to change.
   */
  runDrain: 14,
  walkRecover: 10,
  restRecover: 18,
  dodgeCost: 10,
  secondWind: 25,

  healthMax: 100,
  energyMax: 100,
  waterMax: 100,
  energyDrain: 0,
  waterDrain: 0,
  deprivedDamage: 1.5,
};

/** How hard she is working this frame — everything `tick` needs to know. */
export interface Effort {
  /** True while the pace latch is asking for a run AND she is moving. */
  running: boolean;
  /** Roughly how fast she is actually going, 0..1 of a walk. */
  moving: number;
  /** Crawling: the slow gait, which counts as a rest. */
  crawling: boolean;
  /** Jaws in the soil. */
  digging: boolean;
  /** Off the flat — a trunk, a wall, a steep bank. */
  climbing: boolean;
  /**
   * IN THE NEST, or deep enough in a tunnel to be in its air.
   *
   * The single biggest lever on thirst, and the reason it is here: a fire
   * ant nest sits at 60-80% humidity against 40-60% outside, and water
   * balance rather than energy is what limits how far a forager will go.
   * Shelter is not a bonus, it is the difference between the two states
   * the animal actually lives in.
   */
  sheltered: boolean;
}

/**
 * WHAT AN ACTIVITY COSTS IN WATER, against an ordinary walk.
 *
 * Game tuning INSPIRED BY the biology rather than measured from it — the
 * desiccation studies put workers under severe dry-air stress, which is a
 * different question from what a minute of digging costs. What the
 * literature does support is the SHAPE: shelter is worth far more than
 * effort, and effort is worth something.
 */
export interface DrainCurve {
  sheltered: number;
  resting: number;
  crawling: number;
  walking: number;
  climbing: number;
  digging: number;
  running: number;
}

export const WATER_CURVE: DrainCurve = {
  sheltered: 0.2,
  resting: 0.35,
  crawling: 0.5,
  walking: 1,
  climbing: 1.25,
  digging: 1.5,
  running: 1.85,
};

/** Energy is flatter: everything she does costs some, and shelter is not
 *  the refuge from hunger that it is from thirst. */
export const ENERGY_CURVE: DrainCurve = {
  sheltered: 0.5,
  resting: 0.5,
  crawling: 0.7,
  walking: 1,
  climbing: 1.2,
  digging: 1.3,
  running: 1.6,
};

/**
 * Which multiplier this frame earns.
 *
 * Shelter WINS OUTRIGHT rather than multiplying: she is in still, humid
 * air, and what she is doing in it matters much less than the fact of
 * being in it. Above ground the hardest thing she is doing sets the rate —
 * a sprint while digging is a sprint, not a sprint times a dig.
 */
export function effortRate(e: Effort, curve: DrainCurve): number {
  if (e.sheltered) return curve.sheltered;
  const still = e.moving <= 0.05;
  if (still && !e.digging) return curve.resting;
  let rate = e.crawling ? curve.crawling : curve.walking;
  if (still) rate = curve.resting;
  if (e.climbing) rate = Math.max(rate, curve.climbing);
  if (e.digging) rate = Math.max(rate, curve.digging);
  if (e.running && !still) rate = Math.max(rate, curve.running);
  return rate;
}

/**
 * HOW BADLY SHE NEEDS IT — four bands, not a cliff.
 *
 * 0 comfortable, 1 noticing, 2 suffering, 3 failing. The point of the
 * bands is that a survival bar should change how she plays long before it
 * kills her, and should never behave like an execution timer: at 3 she is
 * slower and tires faster and CAN still walk home, and only an empty bar
 * takes health.
 */
export type NeedStage = 0 | 1 | 2 | 3;

export function stageOf(fraction: number): NeedStage {
  if (fraction > 0.5) return 0;
  if (fraction > 0.25) return 1;
  if (fraction > 0.1) return 2;
  return 3;
}

export class Vitals {
  health: number;

  stamina: number;

  energy: number;

  water: number;

  /**
   * Does anything feed her yet?
   *
   * False through the founding, when she is living off her own flight
   * muscles and eats nothing — so thirst and hunger do not run, because
   * the animal's do not. It turns on with the first worker, who is also
   * the way back up: see `trophallaxis`.
   */
  feeding = false;

  /** True while she is winded and may not run — see `secondWind`. */
  private winded = false;

  constructor(private tuning: VitalsTuning = DEFAULT_VITALS) {
    this.health = tuning.healthMax;
    this.stamina = tuning.staminaMax;
    this.energy = tuning.energyMax;
    this.water = tuning.waterMax;
  }

  /** Swap the numbers out — where a species or a maturity will hook in. */
  retune(tuning: VitalsTuning): void { this.tuning = tuning; }

  /** May she run right now? The pace latch asks this every frame. */
  get canRun(): boolean { return !this.winded && this.stamina > 0; }

  /** 0..1 for the HUD, which should never do arithmetic on a max. */
  fractionOf(what: 'health' | 'stamina' | 'energy' | 'water'): number {
    const t = this.tuning;
    const max = what === 'health' ? t.healthMax
      : what === 'stamina' ? t.staminaMax
        : what === 'energy' ? t.energyMax : t.waterMax;
    return max <= 0 ? 0 : Math.max(0, Math.min(1, this[what] / max));
  }

  /**
   * The absolute pair — what she has and what she can hold.
   *
   * `fractionOf` is what a BAR needs; a readout needs the numbers. The
   * approved HUD reference prints them over the bar, and printing a
   * percentage instead would be inventing a unit the game does not use.
   */
  absOf(what: 'health' | 'stamina' | 'energy' | 'water'): { now: number; max: number } {
    const t = this.tuning;
    const max = what === 'health' ? t.healthMax
      : what === 'stamina' ? t.staminaMax
        : what === 'energy' ? t.energyMax : t.waterMax;
    return { now: Math.round(this[what]), max: Math.round(max) };
  }

  get thirst(): NeedStage { return stageOf(this.fractionOf('water')); }

  get hunger(): NeedStage { return stageOf(this.fractionOf('energy')); }

  /** The worse of the two — what her legs and her lungs actually feel. */
  get strain(): NeedStage {
    return Math.max(this.thirst, this.hunger) as NeedStage;
  }

  /**
   * WHAT BEING SHORT COSTS, and it is deliberately never a stop.
   *
   * Recovery slows and the ceiling comes down, so she tires sooner and
   * takes longer to come back — but she can always walk home. A survival
   * bar that immobilises you is a bar that has already killed you and is
   * making you watch.
   */
  private get strainRecover(): number {
    return [1, 0.85, 0.6, 0.4][this.strain] as number;
  }

  private get strainCeiling(): number {
    return [1, 1, 0.85, 0.6][this.strain] as number;
  }

  /** Her usable stamina maximum, which shortage lowers. */
  get staminaCeiling(): number {
    return this.tuning.staminaMax * this.strainCeiling;
  }

  /**
   * Spend a lump, if she has it. Returns whether it went through, so a
   * dodge that cannot be afforded simply does not happen rather than
   * happening on credit.
   */
  spend(amount: number): boolean {
    if (amount <= 0) return true;
    if (this.stamina < amount) return false;
    this.stamina -= amount;
    if (this.stamina <= 0) { this.stamina = 0; this.winded = true; }
    return true;
  }

  /** What a dodge costs, asked rather than assumed by the caller. */
  get dodgeCost(): number { return this.tuning.dodgeCost; }

  damage(amount: number): void {
    this.health = Math.max(0, this.health - Math.max(0, amount));
  }

  heal(amount: number): void {
    this.health = Math.min(this.tuning.healthMax, this.health + Math.max(0, amount));
  }

  eat(amount: number): void {
    this.energy = Math.min(this.tuning.energyMax, this.energy + Math.max(0, amount));
  }

  drink(amount: number): void {
    this.water = Math.min(this.tuning.waterMax, this.water + Math.max(0, amount));
  }

  /**
   * MOUTH TO MOUTH — a nestmate hands her a crop-load.
   *
   * The way a founding queen is fed once her nanitics eclose, and the way
   * an adult fire ant gets almost everything: liquid, shared, from another
   * ant. It refills BOTH, because what is passed is a fluid carrying sugar
   * — there is no separate drinking fountain in a nest.
   */
  trophallaxis(amount: number): void {
    this.eat(amount);
    this.drink(amount);
  }

  /** One frame. */
  tick(dt: number, effort: Effort): void {
    if (!(dt > 0)) return;
    const t = this.tuning;

    if (effort.running && effort.moving > 0.05) {
      this.stamina -= t.runDrain * dt;
      if (this.stamina <= 0) { this.stamina = 0; this.winded = true; }
    } else {
      /*
       * Standing still pays back faster than walking, and a crawl counts as
       * a rest — which is what a crawl IS for an animal that spends most of
       * its life at one. It is also the only reason the pace latch has a
       * third position worth choosing.
       */
      const rate = (effort.moving > 0.05 && !effort.crawling)
        ? t.walkRecover : t.restRecover;
      this.stamina = Math.min(this.staminaCeiling,
        this.stamina + rate * this.strainRecover * dt);
    }
    if (this.winded && this.stamina >= t.secondWind) this.winded = false;
    /* Short of water or energy, the ceiling comes down — and she is
     * clamped to it rather than losing what she had, so the bar falls to
     * meet her rather than her waking up empty. */
    this.stamina = Math.min(this.stamina, this.staminaCeiling);

    /*
     * NOTHING DRAINS DURING THE FOUNDING. She is living off her own flight
     * muscles and takes nothing from outside until the first worker — see
     * `feeding`. It is also, conveniently and not coincidentally, the rule
     * this file has kept since it was written: a bar may only move if
     * there is a way to move it back, and the worker IS the way back.
     */
    if (!this.feeding) return;
    this.water = Math.max(0,
      this.water - t.waterDrain * effortRate(effort, WATER_CURVE) * dt);
    this.energy = Math.max(0,
      this.energy - t.energyDrain * effortRate(effort, ENERGY_CURVE) * dt);

    /* Empty is where it finally bites, and even then it is a slope. */
    const empty = (this.water <= 0 ? 1 : 0) + (this.energy <= 0 ? 1 : 0);
    if (empty > 0) this.damage(t.deprivedDamage * empty * dt);
  }

  /** Everything a probe or a save needs, and nothing it has to compute. */
  report(): Record<string, number> {
    return {
      health: +this.health.toFixed(2),
      stamina: +this.stamina.toFixed(2),
      energy: +this.energy.toFixed(2),
      water: +this.water.toFixed(2),
      winded: this.winded ? 1 : 0,
      feeding: this.feeding ? 1 : 0,
      thirst: this.thirst,
      hunger: this.hunger,
    };
  }
}
