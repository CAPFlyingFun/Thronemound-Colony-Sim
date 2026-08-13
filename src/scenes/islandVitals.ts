/**
 * WHAT KEEPS HER GOING — health, stamina, food and water.
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
 * Food and water are plumbed and DELIBERATELY NOT DRAINING. There is no
 * eating and no drinking on the island, so a hunger clock would be a
 * countdown to a state the player cannot leave — which is worse than an
 * honest empty frame, not better. Their drain rates are zero and the day
 * `islandInteraction` lands, turning them on is two numbers.
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
  foodMax: number;
  waterMax: number;
  /** Per second. Zero until there is something to eat — see the note above. */
  foodDrain: number;
  waterDrain: number;
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
  foodMax: 100,
  waterMax: 100,
  foodDrain: 0,
  waterDrain: 0,
};

/** How hard she is working this frame — everything `tick` needs to know. */
export interface Effort {
  /** True while the pace latch is asking for a run AND she is moving. */
  running: boolean;
  /** Roughly how fast she is actually going, 0..1 of a walk. */
  moving: number;
}

export class Vitals {
  health: number;

  stamina: number;

  food: number;

  water: number;

  /** True while she is winded and may not run — see `secondWind`. */
  private winded = false;

  constructor(private tuning: VitalsTuning = DEFAULT_VITALS) {
    this.health = tuning.healthMax;
    this.stamina = tuning.staminaMax;
    this.food = tuning.foodMax;
    this.water = tuning.waterMax;
  }

  /** Swap the numbers out — where a species or a maturity will hook in. */
  retune(tuning: VitalsTuning): void { this.tuning = tuning; }

  /** May she run right now? The pace latch asks this every frame. */
  get canRun(): boolean { return !this.winded && this.stamina > 0; }

  /** 0..1 for the HUD, which should never do arithmetic on a max. */
  fractionOf(what: 'health' | 'stamina' | 'food' | 'water'): number {
    const t = this.tuning;
    const max = what === 'health' ? t.healthMax
      : what === 'stamina' ? t.staminaMax
        : what === 'food' ? t.foodMax : t.waterMax;
    return max <= 0 ? 0 : Math.max(0, Math.min(1, this[what] / max));
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

  /** Fed and watered, for the day there is anything to feed her. */
  eat(amount: number): void {
    this.food = Math.min(this.tuning.foodMax, this.food + Math.max(0, amount));
  }

  drink(amount: number): void {
    this.water = Math.min(this.tuning.waterMax, this.water + Math.max(0, amount));
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
      const rate = effort.moving > 0.05 ? t.walkRecover : t.restRecover;
      this.stamina = Math.min(t.staminaMax, this.stamina + rate * dt);
    }
    if (this.winded && this.stamina >= t.secondWind) this.winded = false;

    /* Zero today. See the note at the top of the file: a clock she cannot
     * stop is not a feature, it is a countdown. */
    if (t.foodDrain > 0) this.food = Math.max(0, this.food - t.foodDrain * dt);
    if (t.waterDrain > 0) this.water = Math.max(0, this.water - t.waterDrain * dt);
  }

  /** Everything a probe or a save needs, and nothing it has to compute. */
  report(): {
    health: number; stamina: number; food: number; water: number; winded: number;
  } {
    return {
      health: +this.health.toFixed(2),
      stamina: +this.stamina.toFixed(2),
      food: +this.food.toFixed(2),
      water: +this.water.toFixed(2),
      winded: this.winded ? 1 : 0,
    };
  }
}
