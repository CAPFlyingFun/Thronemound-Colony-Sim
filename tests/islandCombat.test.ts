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
  CASTE_COMBAT, Combat, DEFAULT_COMBAT, necrosis, type Quarry,
} from '../src/scenes/islandCombat';

/*
 * A WORKER, for anything about stinging. The default caste is the queen and
 * she has no sting — see `CASTE_COMBAT` and `FIRE_ANT.abilities` — so a
 * sting test built on the default is testing a caste that cannot do it.
 */
const stinger = (): Combat => new Combat('worker');

const dummy = (over: Partial<Quarry> = {}): Quarry => ({
  id: 'dummy',
  at: { x: 0, y: 0, z: 0 },
  radius: 1,
  alive: true,
  hp: 100,
  venomLoad: 0,
  venomRate: 0,
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
    const c = stinger();
    expect(c.sting()).toBe(false);
    expect(c.phase).toBe('free');
  });

  it('stings once she has hold', () => {
    const c = stinger();
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
    const c = stinger();
    const q = dummy();
    c.grip(q, rich);
    c.sting();
    frames(c, DEFAULT_COMBAT.sequenceStings * DEFAULT_COMBAT.stingInterval + 0.5);
    const stings = c.drain().filter((e) => e.kind === 'sting').length;
    expect(stings).toBe(DEFAULT_COMBAT.sequenceStings);
    /* Still holding on — she re-grips to sting again, she does not fall off. */
    expect(c.phase).toBe('gripped');
    /* The dose is the CASTE's now: rate times seconds, per sting. */
    const w = CASTE_COMBAT.worker;
    expect(q.venomLoad)
      .toBeCloseTo(DEFAULT_COMBAT.sequenceStings * w.venomRate * w.venomSeconds, 4);
    expect(q.venomRate).toBe(w.venomRate);
  });

  it('refuses a caste that has no sting', () => {
    /* The queen. Her button went in v0.1.44; this is the mechanic agreeing
     * with the UI instead of quietly dosing nothing. */
    const c = new Combat('queen');
    const q = dummy();
    c.grip(q, rich);
    expect(c.venomous).toBe(false);
    expect(c.sting()).toBe(false);
    frames(c, 3);
    expect(q.venomLoad).toBe(0);
  });
});

describe('venom is a reserve, not a cooldown', () => {
  it('carries about thirty-two stings and then runs dry', () => {
    const c = stinger();
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
    const c = stinger();
    c.venom = 0;
    frames(c, 30);
    expect(c.venom).toBeGreaterThan(0);
    expect(c.venom).toBeLessThan(1);
  });
});

describe('the venom does the killing, not the sting', () => {
  it('leaves a load that keeps working after she lets go', () => {
    const c = stinger();
    const q = dummy();
    c.grip(q, rich);
    c.sting();
    frames(c, 3);
    c.release();
    /* Three seconds of holding on is three bite beats — the grip IS the
     * attack now, so this is no longer an untouched quarry. What the test
     * is about is the LOAD outliving the grip, which it still does. */
    expect(q.hp).toBe(100 - 3 * CASTE_COMBAT.worker.bite);
    expect(q.venomLoad).toBeGreaterThan(0);

    /* Walked away. It dies anyway, which is the whole point. */
    let felled = false;
    for (let i = 0; i < 60 * 60 && !felled; i += 1) felled = necrosis(q, 1 / 60);
    expect(felled).toBe(true);
    expect(q.hp).toBe(0);
    /*
     * It no longer runs the load exactly to zero, and that is right rather
     * than a loosened assertion: a worker's sequence now doses far more
     * venom than a 100 hp dummy needs, so the quarry dies with some still
     * in it. Insisting the load empty would be insisting she never
     * over-stings anything.
     */
    expect(q.venomLoad).toBeGreaterThanOrEqual(0);
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

describe('the grip IS the attack', () => {
  /*
   * "I would still keep bite = grip" — so there is no attack button, and
   * holding on is what does the damage. Set by caste: 1 a second for the
   * queen, 4 for a worker, 9 for a major.
   */
  it('bleeds the quarry on a beat while she holds it', () => {
    for (const caste of ['queen', 'worker', 'major'] as const) {
      const c = new Combat(caste);
      const q = dummy();
      c.grip(q, rich);
      /* Taking hold is not a free hit — a full beat before the first. */
      frames(c, 0.9);
      expect({ caste, hp: q.hp }).toEqual({ caste, hp: 100 });
      frames(c, 3.2);
      expect({ caste, hp: q.hp })
        .toEqual({ caste, hp: 100 - 4 * CASTE_COMBAT[caste].bite });
    }
  });

  it('does nothing to a quarry she is not holding', () => {
    const c = new Combat('major');
    const q = dummy();
    frames(c, 5);
    expect(q.hp).toBe(100);
  });

  it('cannot be out-damaged by spamming grip and release', () => {
    /*
     * The beat resets on grip, so re-taking hold every half second lands no
     * bites at all where simply holding on lands five. If this inverts, the
     * optimal play becomes mashing one button.
     */
    const held = new Combat('worker');
    const a = dummy();
    held.grip(a, rich);
    frames(held, 5.5);

    const spam = new Combat('worker');
    const b = dummy();
    for (let i = 0; i < 11; i += 1) {
      spam.grip(b, rich);
      frames(spam, 0.5);
      spam.release();
    }
    expect(100 - a.hp).toBeGreaterThan(100 - b.hp);
    expect(b.hp).toBe(100);
  });

  it('fells a quarry by bite alone, and says so', () => {
    const c = new Combat('major');
    const q = dummy({ hp: 20 });
    c.grip(q, rich);
    frames(c, 3.5);
    expect(q.alive).toBe(false);
    expect(q.hp).toBe(0);
    expect(c.drain().some((e) => e.kind === 'felled')).toBe(true);
  });

  it('stops biting once the quarry is down — cargo is not a fight', () => {
    const c = new Combat('major');
    const q = dummy({ hp: 9 });
    c.grip(q, rich);
    frames(c, 1.2);
    expect(q.alive).toBe(false);
    const bites = c.drain().filter((e) => e.kind === 'bite').length;
    frames(c, 5);
    expect(c.drain().filter((e) => e.kind === 'bite').length).toBe(0);
    expect(bites).toBe(1);
  });
});

describe('the venom dose is the caste\'s', () => {
  /* "3HP/s for 10s for the workers, and 6HP/s for 8s for major". */
  it('bleeds at the rate whoever stung it delivered', () => {
    for (const caste of ['worker', 'major'] as const) {
      const { venomRate, venomSeconds } = CASTE_COMBAT[caste];
      const q = dummy({ venomLoad: venomRate * venomSeconds, venomRate });
      /* One second of decay is one second of that caste's rate. */
      necrosis(q, 1);
      expect({ caste, hp: q.hp }).toEqual({ caste, hp: 100 - venomRate });
      /* And the whole dose lasts the seconds it says on the tin. */
      for (let i = 0; i < (venomSeconds - 1) * 60; i += 1) necrosis(q, 1 / 60);
      expect(q.venomLoad).toBeCloseTo(0, 3);
    }
  });

  it('gives a major the harder hit and a worker the longer one', () => {
    /*
     * The shape asked for, from "the smaller fire ants hurt worse than the
     * big ones". The small one's pain LASTS; the big one's is heavier while
     * it is happening. Stated as a test because the totals run the other
     * way and it would otherwise look like a mistake.
     */
    const w = CASTE_COMBAT.worker;
    const m = CASTE_COMBAT.major;
    expect(w.venomSeconds).toBeGreaterThan(m.venomSeconds);
    expect(m.venomRate).toBeGreaterThan(w.venomRate);
  });

  it('gives the queen no venom at all', () => {
    expect(CASTE_COMBAT.queen.venomRate).toBe(0);
  });
});
