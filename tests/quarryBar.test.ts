import { describe, expect, it } from 'vitest';

import { barLevel, barWanted } from '../src/scenes/islandQuarryBar';
import type { Quarry } from '../src/scenes/islandCombat';

/**
 * WHEN THE BAR IS ALLOWED ON SCREEN — which is the design, not a detail.
 *
 * Asked for as: "no HP bar over the enemy on attack (doesn't need to always
 * show… only when less than max, or tracking)". The bracket is the whole
 * request, so it is a pure function with a test rather than a condition
 * buried in a render loop.
 */
const q = (over: Partial<Quarry> = {}): Quarry => ({
  id: 'beetle', at: { x: 0, y: 0, z: 0 }, radius: 1,
  alive: true, hp: 100, hpMax: 100, venomLoad: 0, venomRate: 0,
  struggle: 0, breakFree: 0, ...over,
});

describe('when a quarry gets a health bar', () => {
  it('stays off a healthy creature nobody is touching', () => {
    expect(barWanted(q(), null)).toBe(false);
  });

  it('appears the moment it is hurt, held or not', () => {
    expect(barWanted(q({ hp: 99 }), null)).toBe(true);
  });

  it('appears at full health while she has hold of it', () => {
    /* The complaint that prompted this: "I never did see the HP loss in the
     * beetle". At full health, gripped, the bar is what shows the biting
     * working from the very first beat. */
    const beetle = q();
    expect(barWanted(beetle, beetle)).toBe(true);
  });

  it('does not follow a corpse about', () => {
    expect(barWanted(q({ alive: false, hp: 0 }), null)).toBe(false);
    const dead = q({ alive: false, hp: 0 });
    expect(barWanted(dead, dead)).toBe(false);
  });

  it('ignores a DIFFERENT creature she is holding', () => {
    /* Gripping one beetle must not light up every beetle on the island. */
    expect(barWanted(q({ id: 'other' }), q({ id: 'held' }))).toBe(false);
  });
});

describe('how full the bar reads', () => {
  it('is the plain fraction', () => {
    expect(barLevel(q({ hp: 50 }))).toBe(0.5);
    expect(barLevel(q({ hp: 100 }))).toBe(1);
  });

  it('clamps a negative, which venom can produce for a frame', () => {
    /* `necrosis` can carry hp under zero between the hit and the fell, and
     * a negative width is a layout bug rather than a dead beetle. */
    expect(barLevel(q({ hp: -12 }))).toBe(0);
  });

  it('clamps overheal and survives a zero-max creature', () => {
    expect(barLevel(q({ hp: 150 }))).toBe(1);
    expect(barLevel(q({ hp: 5, hpMax: 0 }))).toBe(0);
  });
});
