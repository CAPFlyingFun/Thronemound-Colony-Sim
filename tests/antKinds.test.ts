/*
 * THE ANT TABLE. Data, so the tests are about the data being coherent —
 * which is the whole reason it is a table and not an `if` ladder.
 */
import { describe, expect, it } from 'vitest';
import {
  ABILITIES, ANT_KINDS, FIRE_ANT, GAME_MINUTES_PER_REAL_MINUTE,
  REAL_SECONDS_PER_GAME_HOUR, TWIG_ANT, drainPerGameHours,
} from '../src/scenes/antKinds';
import { STRENGTH } from '../src/scenes/mandibleReach';
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

  /*
   * This began life as "nothing is built", designed to fail the day a
   * mechanic landed. It did, and the grip and the sting are the two that
   * landed — so it becomes the list, which fails the same way next time.
   */
  it('marks exactly the abilities that have a mechanic behind them', () => {
    const built = Object.values(ABILITIES).filter((a) => a.built).map((a) => a.id);
    expect(built.sort()).toEqual(['bite', 'carry', 'drop', 'interact', 'sting']);
  });
});

describe('two ants differ in DATA, not in code', () => {
  it('gives every kind a strength row to lift by', () => {
    /* The queen-to-worker-to-major handoff is a table lookup or it is a
     * pile of branches. This is the assertion that keeps it the former. */
    for (const kind of Object.values(ANT_KINDS)) {
      expect(STRENGTH[kind.strength]).toBeDefined();
    }
    /* And the two that exist differ, or the table is decoration. */
    expect(FIRE_ANT.strength).not.toBe(TWIG_ANT.strength);
  });

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
  it('makes one of her days 48 minutes of play', () => {
    /* Thirty, not the fifteen it shipped with: a 96-minute day pushed
     * every survival bar past the length of a session. */
    expect(GAME_MINUTES_PER_REAL_MINUTE).toBe(30);
    const realMinutesPerDay = (24 * 60) / GAME_MINUTES_PER_REAL_MINUTE;
    expect(realMinutesPerDay).toBe(48);
    expect(REAL_SECONDS_PER_GAME_HOUR).toBe(120);
  });

  it('converts an endurance in her hours into a rate per real second', () => {
    const rate = drainPerGameHours(100, 24);
    /* A full pool over one of her days, in real seconds. */
    expect(100 / rate).toBeCloseTo(24 * REAL_SECONDS_PER_GAME_HOUR, 6);
  });
});

describe('thirst before hunger, as the foraging work has it', () => {
  it('drains water about twice as fast as energy', () => {
    expect(FIRE_ANT.vitals.waterDrain / FIRE_ANT.vitals.energyDrain)
      .toBeCloseTo(2, 6);
  });

  it('empties a full water bar over about 48 minutes of ordinary walking', () => {
    const minutes = (FIRE_ANT.vitals.waterMax / FIRE_ANT.vitals.waterDrain) / 60;
    expect(minutes).toBeCloseTo(48, 0);
  });

  it('keeps the fire ant a harder worker than the default', () => {
    expect(FIRE_ANT.vitals.restRecover).toBeGreaterThan(FIRE_ANT.vitals.walkRecover);
    expect(FIRE_ANT.vitals.staminaMax).toBe(DEFAULT_VITALS.staminaMax);
  });
});
