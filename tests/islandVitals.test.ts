/*
 * WHAT KEEPS HER GOING.
 *
 * Pure arithmetic, which is the point of putting it in its own file: the
 * drains, the recovery, the hysteresis and the refusals are all things that
 * are easy to get subtly wrong and easy to pin.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VITALS, ENERGY_CURVE, Vitals, WATER_CURVE, effortRate, stageOf,
  type Effort, type VitalsTuning,
} from '../src/scenes/islandVitals';

/** An ordinary surface effort, unless a test says otherwise. */
const effort = (over: Partial<Effort> = {}): Effort => ({
  running: false, moving: 1, crawling: false, digging: false,
  climbing: false, sheltered: false, ...over,
});

const run = (v: Vitals, seconds: number, over: Partial<Effort> = {}): void => {
  const e = effort(over);
  for (let t = 0; t < seconds; t += 1 / 60) v.tick(1 / 60, e);
};

describe('stamina', () => {
  it('starts full and drains at a run', () => {
    const v = new Vitals();
    expect(v.fractionOf('stamina')).toBe(1);
    run(v, 2, { running: true });
    expect(v.stamina).toBeLessThan(DEFAULT_VITALS.staminaMax);
    expect(v.stamina).toBeGreaterThan(0);
  });

  it('does NOT drain while sprint is held but she is not moving', () => {
    /* Holding the latch against a wall is not running, and a drain the
     * player cannot see the cause of is the worst kind. */
    const v = new Vitals();
    run(v, 3, { running: true, moving: 0 });
    expect(v.stamina).toBe(DEFAULT_VITALS.staminaMax);
  });

  it('recovers faster at rest than at a walk', () => {
    const walked = new Vitals();
    const rested = new Vitals();
    walked.spend(60); rested.spend(60);
    run(walked, 2);
    run(rested, 2, { moving: 0 });
    expect(rested.stamina).toBeGreaterThan(walked.stamina);
  });

  it('never goes below nought or above its maximum', () => {
    const v = new Vitals();
    run(v, 60, { running: true });
    expect(v.stamina).toBe(0);
    run(v, 600, { moving: 0 });
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
    run(v, 60, { running: true });
    expect(v.canRun).toBe(false);
    run(v, 0.5, { moving: 0 });
    expect(v.stamina).toBeGreaterThan(0);
    expect(v.canRun).toBe(false);
    run(v, 3, { moving: 0 });
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

const hungry: VitalsTuning = {
  ...DEFAULT_VITALS, waterDrain: 10, energyDrain: 5,
};

describe('the founding, when she eats nothing at all', () => {
  /*
   * A claustral fire ant queen seals herself in and raises the first brood
   * on her own flight muscles, taking nothing from outside until the
   * nanitics eclose. So `feeding` false is the ANIMAL, not a stub — and it
   * happens to keep the rule this file has always kept, that a bar may
   * only move if there is a way to move it back.
   */
  it('does not drain water or energy before the first worker', () => {
    const v = new Vitals(hungry);
    run(v, 300);
    expect(v.water).toBe(hungry.waterMax);
    expect(v.energy).toBe(hungry.energyMax);
  });

  it('starts the clock once the colony can feed her', () => {
    const v = new Vitals(hungry);
    v.feeding = true;
    run(v, 2, { moving: 0 });
    expect(v.water).toBeLessThan(hungry.waterMax);
    expect(v.energy).toBeLessThan(hungry.energyMax);
  });

  it('is refilled mouth to mouth, both at once', () => {
    /* Trophallaxis passes a FLUID carrying sugar — there is no separate
     * drinking fountain in a nest, so one handover feeds and waters. */
    const v = new Vitals(hungry);
    v.feeding = true;
    run(v, 30, { moving: 0 });
    v.trophallaxis(1000);
    expect(v.water).toBe(hungry.waterMax);
    expect(v.energy).toBe(hungry.energyMax);
  });
});

describe('thirst answers to where she is, not to the clock', () => {
  it('costs far less in the nest than on the surface', () => {
    const out = new Vitals(hungry); out.feeding = true;
    const inside = new Vitals(hungry); inside.feeding = true;
    run(out, 5);
    run(inside, 5, { sheltered: true });
    expect(hungry.waterMax - inside.water)
      .toBeLessThan((hungry.waterMax - out.water) * 0.5);
  });

  it('ranks the efforts the way the curve says', () => {
    const rate = (o: Partial<Effort>): number => effortRate(effort(o), WATER_CURVE);
    expect(rate({ sheltered: true })).toBeLessThan(rate({ moving: 0 }));
    expect(rate({ moving: 0 })).toBeLessThan(rate({ crawling: true }));
    expect(rate({ crawling: true })).toBeLessThan(rate({}));
    expect(rate({})).toBeLessThan(rate({ climbing: true }));
    expect(rate({ climbing: true })).toBeLessThan(rate({ digging: true }));
    expect(rate({ digging: true })).toBeLessThan(rate({ running: true }));
  });

  it('lets shelter beat effort outright rather than multiplying', () => {
    /* She is in still humid air; what she is doing in it matters much less
     * than the fact of being in it. */
    expect(effortRate(effort({ sheltered: true, running: true, digging: true }),
      WATER_CURVE)).toBe(WATER_CURVE.sheltered);
  });

  it('is harsher on water than on energy for the same work', () => {
    expect(effortRate(effort({ running: true }), WATER_CURVE))
      .toBeGreaterThan(effortRate(effort({ running: true }), ENERGY_CURVE));
  });
});

describe('going short is a slope, not a cliff', () => {
  it('bands the need rather than switching at zero', () => {
    expect(stageOf(1)).toBe(0);
    expect(stageOf(0.4)).toBe(1);
    expect(stageOf(0.2)).toBe(2);
    expect(stageOf(0.05)).toBe(3);
  });

  it('lowers her stamina ceiling and slows her recovery as she runs short', () => {
    const v = new Vitals(hungry);
    v.feeding = true;
    expect(v.staminaCeiling).toBe(hungry.staminaMax);
    v.water = hungry.waterMax * 0.05;
    expect(v.strain).toBe(3);
    expect(v.staminaCeiling).toBeLessThan(hungry.staminaMax);
    /* And she can STILL walk home: parched is slower, never stopped. */
    expect(v.staminaCeiling).toBeGreaterThan(0);
  });

  it('only takes health once a bar is actually empty', () => {
    const v = new Vitals(hungry);
    v.feeding = true;
    v.water = 1;
    run(v, 0.05, { moving: 0 });
    expect(v.health).toBe(hungry.healthMax);
    v.water = 0;
    run(v, 2, { moving: 0 });
    expect(v.health).toBeLessThan(hungry.healthMax);
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

describe('she mends', () => {
  /*
   * Asked for directly: "all ants need to passively gain HP back over time."
   *
   * It is also what makes combat damage legal under this file's own rule —
   * a bar may only move if there is a way to move it back. These are the
   * assertions that keep the way back real.
   */
  const idle: Effort = {
    moving: 0, running: false, crawling: false,
    digging: false, climbing: false, sheltered: false,
  };

  it('climbs back after damage', () => {
    const v = new Vitals();
    v.damage(40);
    expect(v.absOf('health').now).toBe(60);
    for (let i = 0; i < 60; i += 1) v.tick(1 / 60, idle);
    /* One second of 0.6 a second, and it must be a real gain rather than a
     * rounding artefact of the readout. */
    expect(v.absOf('health').now).toBe(61);
  });

  it('mends while she is working, not only while she rests', () => {
    /* Deliberate: tying it to standing still makes "walk away and wait" the
     * winning answer to every fight. Stamina is the bar graded by effort. */
    const busy: Effort = { ...idle, moving: 1, running: true };
    const v = new Vitals();
    v.damage(50);
    for (let i = 0; i < 120; i += 1) v.tick(1 / 60, busy);
    expect(v.absOf('health').now).toBeGreaterThan(50);
  });

  it('never climbs past full', () => {
    const v = new Vitals();
    v.damage(1);
    for (let i = 0; i < 600; i += 1) v.tick(1 / 60, idle);
    expect(v.absOf('health').now).toBe(v.absOf('health').max);
  });

  it('does not resurrect her from nothing', () => {
    /* Regen is a floor she climbs, not a get-out. Downed is a state the
     * scene owns; this only asserts the bar cannot be relied on to undo a
     * kill within a frame of it. */
    const v = new Vitals();
    v.damage(1000);
    expect(v.absOf('health').now).toBe(0);
    v.tick(1 / 60, idle);
    expect(v.absOf('health').now).toBeLessThan(1);
  });
});

describe('a spent sprint recovers while she keeps walking', () => {
  /*
   * THE BUG THIS PINS. `readEffort` passed the raw sprint LATCH as
   * `running`, not whether she was actually sprinting. Once she bottomed
   * out, `canRun` went false and she was moved at walking pace — but this
   * still read "running", so `tick` took the drain branch and the recovery
   * in its `else` never ran. She walked, paid a walk's costs, and got
   * nothing back.
   *
   * Reported as: "you have to stop after it drains to gain some which is
   * annoying". She did, and nothing on screen said why.
   *
   * The scene now decides `sprinting` in one place and hands the ANSWER
   * here, so these two cases are the contract that keeps it honest.
   */
  const moving = (running: boolean): Effort => ({
    moving: 1, running, crawling: false,
    digging: false, climbing: false, sheltered: false,
  });

  it('gives nothing back while she is genuinely sprinting', () => {
    const v = new Vitals();
    for (let i = 0; i < 60; i += 1) v.tick(1 / 60, moving(true));
    expect(v.absOf('stamina').now).toBeLessThan(v.absOf('stamina').max);
  });

  it('recovers on the move once the sprint is spent', () => {
    const v = new Vitals();
    /* Run her flat out until she is winded. */
    for (let i = 0; i < 60 * 30 && v.canRun; i += 1) v.tick(1 / 60, moving(true));
    expect(v.canRun).toBe(false);
    const bottom = v.absOf('stamina').now;

    /*
     * Now she is walking — `running` is FALSE because she cannot run, which
     * is exactly what the fix makes true — and she must climb without ever
     * standing still.
     */
    for (let i = 0; i < 60; i += 1) v.tick(1 / 60, moving(false));
    expect(v.absOf('stamina').now).toBeGreaterThan(bottom);
  });

  it('would have stalled if the latch were passed instead', () => {
    /* The regression, stated: hold `running` true past the bottom and she
     * never climbs, however long she walks. */
    const v = new Vitals();
    for (let i = 0; i < 60 * 30 && v.canRun; i += 1) v.tick(1 / 60, moving(true));
    const bottom = v.absOf('stamina').now;
    for (let i = 0; i < 60 * 5; i += 1) v.tick(1 / 60, moving(true));
    expect(v.absOf('stamina').now).toBe(bottom);
  });
});
