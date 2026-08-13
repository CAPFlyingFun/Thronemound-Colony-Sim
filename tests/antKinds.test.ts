/*
 * THE ANT TABLE. Data, so the tests are about the data being coherent —
 * which is the whole reason it is a table and not an `if` ladder.
 */
import { describe, expect, it } from 'vitest';
import {
  ABILITIES, ANT_KINDS, FIRE_ANT, FIRE_ANT_APPETITE, GAME_MINUTES_PER_REAL_MINUTE,
  REAL_SECONDS_PER_GAME_HOUR, TWIG_ANT, drainPerGameHours,
} from '../src/scenes/antKinds';
import { DEFAULT_VITALS } from '../src/scenes/islandVitals';

describe('every kind is buildable', () => {
  it('names only abilities the registry knows', () => {
    for (const kind of Object.values(ANT_KINDS)) {
      for (const id of kind.abilities) expect(ABILITIES[id]).toBeDefined();
    }
  });

  it('gives every ability a plate to wear', () => {
    /* A missing art file is an EMPTY BOX on the rail — the exact failure a
     * data-driven cluster invites, and the reason this is pinned. */
    for (const a of Object.values(ABILITIES)) {
      expect(a.art).toMatch(/^[a-z-]+$/);
      expect(a.label.length).toBeGreaterThan(0);
    }
  });

  it('has no ability claiming to be built while nothing is', () => {
    /* This test is meant to FAIL the day a mechanic lands, as the reminder
     * to flip the flag in the same commit. */
    expect(Object.values(ABILITIES).every((a) => !a.built)).toBe(true);
  });
});

describe('two ants differ in DATA, not in code', () => {
  it('gives the fire ant a sting and the twig ant a scout', () => {
    expect(FIRE_ANT.abilities).toContain('sting');
    expect(FIRE_ANT.abilities).not.toContain('scout');
    expect(TWIG_ANT.abilities).toContain('scout');
    expect(TWIG_ANT.abilities).not.toContain('sting');
  });

  it('gives them the same cluster size, so the rail cannot outgrow itself', () => {
    /* The rail was measured to fit four action plates. A species that
     * quietly wants six would push VIEW off the bottom edge again. */
    for (const kind of Object.values(ANT_KINDS)) {
      expect(kind.abilities.length).toBeLessThanOrEqual(4);
    }
  });
});

describe('the clock', () => {
  it('makes one of her days 96 minutes of play', () => {
    expect(GAME_MINUTES_PER_REAL_MINUTE).toBe(15);
    const realMinutesPerDay = (24 * 60) / GAME_MINUTES_PER_REAL_MINUTE;
    expect(realMinutesPerDay).toBe(96);
    expect(REAL_SECONDS_PER_GAME_HOUR).toBe(240);
  });

  it('converts an endurance in her hours into a rate per real second', () => {
    const rate = drainPerGameHours(100, 24);
    /* A full pool over one of her days: 24 * 240 real seconds. */
    expect(100 / rate).toBeCloseTo(24 * 240, 6);
  });
});

describe('thirst before hunger, as the literature has it', () => {
  it('drains water about twice as fast as food', () => {
    expect(FIRE_ANT_APPETITE.waterDrain / FIRE_ANT_APPETITE.foodDrain).toBeCloseTo(2, 6);
  });

  /*
   * AND NEITHER IS SWITCHED ON. The researched rates are ready; the fields
   * that use them are zero until there is a way to eat and drink. Same rule
   * as `islandVitals`, pinned here as well because this is the file where
   * someone would be tempted to wire them straight through.
   */
  it('leaves the live tuning at zero until there is a way to refill', () => {
    expect(FIRE_ANT.vitals.foodDrain).toBe(0);
    expect(FIRE_ANT.vitals.waterDrain).toBe(0);
    expect(FIRE_ANT_APPETITE.waterDrain).toBeGreaterThan(0);
  });

  it('keeps the fire ant a harder worker than the default', () => {
    expect(FIRE_ANT.vitals.restRecover).toBeGreaterThan(FIRE_ANT.vitals.walkRecover);
    expect(FIRE_ANT.vitals.staminaMax).toBe(DEFAULT_VITALS.staminaMax);
  });
});
