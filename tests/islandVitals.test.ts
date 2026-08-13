/*
 * WHAT KEEPS HER GOING.
 *
 * Pure arithmetic, which is the point of putting it in its own file: the
 * drains, the recovery, the hysteresis and the refusals are all things that
 * are easy to get subtly wrong and easy to pin.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_VITALS, Vitals, type VitalsTuning } from '../src/scenes/islandVitals';

const run = (v: Vitals, seconds: number, running = true, moving = 1): void => {
  for (let t = 0; t < seconds; t += 1 / 60) v.tick(1 / 60, { running, moving });
};

describe('stamina', () => {
  it('starts full and drains at a run', () => {
    const v = new Vitals();
    expect(v.fractionOf('stamina')).toBe(1);
    run(v, 2);
    expect(v.stamina).toBeLessThan(DEFAULT_VITALS.staminaMax);
    expect(v.stamina).toBeGreaterThan(0);
  });

  it('does NOT drain while sprint is held but she is not moving', () => {
    /* Holding the latch against a wall is not running, and a drain the
     * player cannot see the cause of is the worst kind. */
    const v = new Vitals();
    run(v, 3, true, 0);
    expect(v.stamina).toBe(DEFAULT_VITALS.staminaMax);
  });

  it('recovers faster at rest than at a walk', () => {
    const walked = new Vitals();
    const rested = new Vitals();
    walked.spend(60); rested.spend(60);
    run(walked, 2, false, 1);
    run(rested, 2, false, 0);
    expect(rested.stamina).toBeGreaterThan(walked.stamina);
  });

  it('never goes below nought or above its maximum', () => {
    const v = new Vitals();
    run(v, 60);
    expect(v.stamina).toBe(0);
    run(v, 600, false, 0);
    expect(v.stamina).toBe(DEFAULT_VITALS.staminaMax);
  });
});

describe('being winded', () => {
  /*
   * THE HYSTERESIS IS THE FEATURE. Without it the pace latch stutters:
   * empty, run refused, one frame of walking pays back a sliver, run
   * allowed, spent again on the same frame — a run that flickers rather
   * than a run that ended.
   */
  it('refuses a run until the second wind is back', () => {
    const v = new Vitals();
    run(v, 60);
    expect(v.canRun).toBe(false);
    run(v, 0.5, false, 0);
    expect(v.stamina).toBeGreaterThan(0);
    expect(v.canRun).toBe(false);
    run(v, 3, false, 0);
    expect(v.stamina).toBeGreaterThanOrEqual(DEFAULT_VITALS.secondWind);
    expect(v.canRun).toBe(true);
  });
});

describe('spending a lump', () => {
  it('refuses rather than going into credit', () => {
    const v = new Vitals();
    expect(v.spend(30)).toBe(true);
    expect(v.spend(1000)).toBe(false);
    expect(v.stamina).toBe(DEFAULT_VITALS.staminaMax - 30);
  });

  it('winds her if the lump empties her', () => {
    const v = new Vitals();
    expect(v.spend(DEFAULT_VITALS.staminaMax)).toBe(true);
    expect(v.stamina).toBe(0);
    expect(v.canRun).toBe(false);
  });
});

describe('the bars with nothing behind them', () => {
  /*
   * Food and water are plumbed and must NOT move: there is nothing to eat
   * and nothing to drink, so a hunger clock is a countdown to a state the
   * player cannot leave. This is the assertion that stops someone turning
   * them on before the way back exists.
   */
  it('does not drain food or water while there is no way to refill them', () => {
    const v = new Vitals();
    run(v, 300, false, 1);
    expect(v.food).toBe(DEFAULT_VITALS.foodMax);
    expect(v.water).toBe(DEFAULT_VITALS.waterMax);
  });

  it('drains them the moment a rate is given, so the plumbing is real', () => {
    const fed: VitalsTuning = { ...DEFAULT_VITALS, foodDrain: 10, waterDrain: 5 };
    const v = new Vitals(fed);
    run(v, 2, false, 0);
    expect(v.food).toBeLessThan(fed.foodMax);
    expect(v.water).toBeLessThan(fed.waterMax);
    v.eat(1000); v.drink(1000);
    expect(v.food).toBe(fed.foodMax);
    expect(v.water).toBe(fed.waterMax);
  });
});

describe('health', () => {
  it('starts full, takes damage and heals, and stays in range', () => {
    const v = new Vitals();
    expect(v.fractionOf('health')).toBe(1);
    v.damage(30);
    expect(v.health).toBe(70);
    v.heal(1000);
    expect(v.health).toBe(DEFAULT_VITALS.healthMax);
    v.damage(1e6);
    expect(v.health).toBe(0);
  });
});
