/*
 * THE GRIP AND THE STING.
 *
 * The mechanic is the animal's: clamp with the mandibles first, then pivot
 * and sting seven or eight times, spending about 3.1% of the venom supply
 * each. These pin the parts that are easy to get subtly wrong — the order,
 * the reserve, and the fact that the damage happens AFTER she has let go.
 */
import { describe, expect, it } from 'vitest';
import {
  Combat, DEFAULT_COMBAT, necrosis, type Quarry,
} from '../src/scenes/islandCombat';

const dummy = (over: Partial<Quarry> = {}): Quarry => ({
  id: 'dummy',
  at: { x: 0, y: 0, z: 0 },
  radius: 1,
  alive: true,
  hp: 100,
  venomLoad: 0,
  struggle: 0,
  breakFree: 0,
  ...over,
});

/** Stamina she always has, so these tests are about the fight only. */
const rich = (): boolean => true;
const noop = (): void => {};
const never = (): number => 1;

const frames = (c: Combat, seconds: number, spend = rich): void => {
  for (let t = 0; t < seconds; t += 1 / 60) c.tick(1 / 60, spend, noop, never);
};

describe('the grip comes first', () => {
  it('refuses to sting anything she is not holding', () => {
    const c = new Combat();
    expect(c.sting()).toBe(false);
    expect(c.phase).toBe('free');
  });

  it('stings once she has hold', () => {
    const c = new Combat();
    expect(c.grip(dummy(), rich)).toBe(true);
    expect(c.phase).toBe('gripped');
    expect(c.sting()).toBe(true);
    expect(c.phase).toBe('stinging');
  });

  it('will not take a second grip while holding the first', () => {
    const c = new Combat();
    c.grip(dummy({ id: 'a' }), rich);
    expect(c.grip(dummy({ id: 'b' }), rich)).toBe(false);
    expect(c.held?.id).toBe('a');
  });

  it('refuses a grip she has not the stamina for', () => {
    const c = new Combat();
    expect(c.grip(dummy(), () => false)).toBe(false);
    expect(c.phase).toBe('free');
  });
});

describe('the sequence', () => {
  it('delivers the number of stings the animal does, then stops', () => {
    const c = new Combat();
    const q = dummy();
    c.grip(q, rich);
    c.sting();
    frames(c, DEFAULT_COMBAT.sequenceStings * DEFAULT_COMBAT.stingInterval + 0.5);
    const stings = c.drain().filter((e) => e.kind === 'sting').length;
    expect(stings).toBe(DEFAULT_COMBAT.sequenceStings);
    /* Still holding on — she re-grips to sting again, she does not fall off. */
    expect(c.phase).toBe('gripped');
    expect(q.venomLoad).toBeCloseTo(DEFAULT_COMBAT.sequenceStings * DEFAULT_COMBAT.stingLoad, 4);
  });
});

describe('venom is a reserve, not a cooldown', () => {
  it('carries about thirty-two stings and then runs dry', () => {
    const c = new Combat();
    expect(c.stingsLeft).toBe(DEFAULT_COMBAT.venomStings);
    const q = dummy();
    /* Four sequences of seven is twenty-eight; she should still have a
     * few and then run out inside the fifth. */
    for (let i = 0; i < 6; i += 1) {
      c.grip(q, rich);
      c.sting();
      frames(c, DEFAULT_COMBAT.sequenceStings * DEFAULT_COMBAT.stingInterval + 0.2);
      c.release();
    }
    expect(c.dry).toBe(true);
    expect(c.sting()).toBe(false);
  });

  it('builds back on its own, whatever she is doing', () => {
    const c = new Combat();
    c.venom = 0;
    frames(c, 30);
    expect(c.venom).toBeGreaterThan(0);
    expect(c.venom).toBeLessThan(1);
  });
});

describe('the venom does the killing, not the sting', () => {
  it('leaves a load that keeps working after she lets go', () => {
    const c = new Combat();
    const q = dummy();
    c.grip(q, rich);
    c.sting();
    frames(c, 3);
    c.release();
    expect(q.hp).toBe(100);
    expect(q.venomLoad).toBeGreaterThan(0);

    /* Walked away. It dies anyway, which is the whole point. */
    let felled = false;
    for (let i = 0; i < 60 * 60 && !felled; i += 1) felled = necrosis(q, 1 / 60);
    expect(q.hp).toBeLessThan(100);
    expect(q.venomLoad).toBeCloseTo(0, 3);
  });

  it('fells a quarry whose load outruns its hit points', () => {
    const q = dummy({ hp: 10, venomLoad: 40 });
    let felled = false;
    for (let i = 0; i < 60 * 60 && !felled; i += 1) felled = necrosis(q, 1 / 60);
    expect(felled).toBe(true);
    expect(q.alive).toBe(false);
    expect(q.hp).toBe(0);
  });

  it('does nothing to something already down', () => {
    const q = dummy({ alive: false, venomLoad: 50, hp: 0 });
    expect(necrosis(q, 1)).toBe(false);
    expect(q.venomLoad).toBe(50);
  });
});

describe('it fights back', () => {
  it('hurts her for as long as she holds on', () => {
    const c = new Combat();
    let taken = 0;
    c.grip(dummy({ struggle: 10 }), rich);
    for (let t = 0; t < 1; t += 1 / 60) {
      c.tick(1 / 60, rich, (n) => { taken += n; }, never);
    }
    expect(taken).toBeCloseTo(10, 0);
  });

  it('shakes her off when its luck is in', () => {
    const c = new Combat();
    c.grip(dummy({ breakFree: 1 }), rich);
    /* `chance` returns 0, which is under any positive break-free rate. */
    c.tick(1 / 60, rich, noop, () => 0);
    expect(c.phase).toBe('free');
    expect(c.drain().some((e) => e.kind === 'shaken')).toBe(true);
  });

  it('drops the grip when she runs out of strength to hold it', () => {
    const c = new Combat();
    c.grip(dummy(), rich);
    c.tick(1 / 60, () => false, noop, never);
    expect(c.phase).toBe('free');
  });

  it('stops struggling once it is down, but stays gripped as cargo', () => {
    const c = new Combat();
    let taken = 0;
    c.grip(dummy({ struggle: 10, alive: false }), rich);
    frames(c, 1);
    c.tick(1 / 60, rich, (n) => { taken += n; }, never);
    expect(taken).toBe(0);
    expect(c.phase).toBe('gripped');
  });
});
