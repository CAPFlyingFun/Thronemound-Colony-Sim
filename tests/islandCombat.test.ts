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
  hpMax: 100,
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
    /*
     * ONE dose for the whole burst, not one per sting. She pivots and
     * stings several times without letting go, but what she delivers is a
     * single envenomation — four full doses is what let one press put
     * 120 hp of venom into a 100 hp beetle.
     */
    const w = CASTE_COMBAT.worker;
    expect(q.venomLoad).toBeCloseTo(w.venomRate * w.venomSeconds, 4);
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
  it('collapses from a full burst to a trickle under sustained fighting', () => {
    /*
     * IT NO LONGER RUNS DRY AND STAYS DRY, and that is the cooldown's doing
     * rather than a weakened reserve.
     *
     * A burst of seven spends 21.9% of a 32-sting tank; the 10-second
     * cooldown that follows refills 4.2% of a 240-second one. So sustained
     * fighting walks her down — 26 stings left, then 21, 16, 11, 5 — until
     * she settles at one or two, where each burst spends exactly what the
     * last cooldown paid back. She is never locked out; she is reduced to a
     * trickle, which is the better shape: an ability that vanishes is a
     * player standing about waiting, and one that thins is a player
     * choosing when to spend it.
     *
     * Measured with a trace, not assumed — the previous version of this
     * test asserted `dry` and would have gone green only by accident.
     */
    const c = stinger();
    expect(c.stingsLeft).toBe(DEFAULT_COMBAT.venomStings);
    const q = dummy({ hp: 1e6 });
    const burst = (): number => {
      c.grip(q, rich);
      c.sting();
      frames(c, DEFAULT_COMBAT.sequenceStings * DEFAULT_COMBAT.stingInterval + 0.2);
      c.release();
      const n = c.drain().filter((e) => e.kind === 'sting').length;
      frames(c, CASTE_COMBAT.worker.venomSeconds + 0.1);
      return n;
    };
    const first = burst();
    expect(first).toBe(DEFAULT_COMBAT.sequenceStings);
    for (let i = 0; i < 6; i += 1) burst();
    expect(c.stingsLeft).toBeLessThanOrEqual(3);
    /* And the trickle is real: a late burst delivers a fraction of the first. */
    expect(burst()).toBeLessThan(first);
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

    /*
     * Walked away, and the load keeps working — which is the whole point,
     * and is still true now the dose is one rather than four.
     *
     * It no longer KILLS a 100 hp dummy on its own, and that is the fix
     * rather than a regression: a worker's single envenomation is 30 hp of
     * damage, so a beetle takes a sting AND a spell of biting. One press
     * used to be the whole fight.
     */
    const before = q.hp;
    for (let i = 0; i < 60 * 60; i += 1) necrosis(q, 1 / 60);
    const w = CASTE_COMBAT.worker;
    expect(before - q.hp).toBeCloseTo(w.venomRate * w.venomSeconds, 3);
    expect(q.alive).toBe(true);
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

describe('the dose IS the cooldown', () => {
  /*
   * Joshua's design: "press sting once and once that 8 or 10 seconds are
   * up, will be the cool down". The venom working and the ability being
   * spent are the same fact, so the cooldown explains itself on screen.
   */
  it('locks the sting out for exactly the dose\'s duration', () => {
    for (const caste of ['worker', 'major'] as const) {
      const c = new Combat(caste);
      const q = dummy({ hp: 1e6 });
      c.grip(q, rich);
      expect({ caste, ready: c.stingReadyIn }).toEqual({ caste, ready: 0 });
      expect(c.sting()).toBe(true);
      expect({ caste, ready: c.stingReadyIn })
        .toEqual({ caste, ready: CASTE_COMBAT[caste].venomSeconds });

      /* A second before it is up: still refused. */
      frames(c, CASTE_COMBAT[caste].venomSeconds - 1);
      expect({ caste, sting: c.sting() }).toEqual({ caste, sting: false });

      /* And past it: ready again. */
      frames(c, 1.2);
      expect({ caste, ready: c.stingReadyIn }).toEqual({ caste, ready: 0 });
      expect({ caste, sting: c.sting() }).toEqual({ caste, sting: true });
    }
  });

  it('runs the cooldown whether or not she still has hold', () => {
    /* It is the venom's clock, not the grip's — letting go must not stall
     * it, or releasing becomes a way to keep the sting on tap. */
    const c = new Combat('major');
    const q = dummy({ hp: 1e6 });
    c.grip(q, rich);
    c.sting();
    c.release();
    frames(c, CASTE_COMBAT.major.venomSeconds + 0.2);
    expect(c.stingReadyIn).toBe(0);
  });

  it('stops one press from being the whole fight', () => {
    /*
     * The hole this closes. A press fires seven stings and each ADDED a
     * full dose, so a worker put 7 x 30 hp of venom into a 100 hp beetle.
     * One press now delivers one envenomation.
     */
    const c = stinger();
    const q = dummy();
    c.grip(q, rich);
    c.sting();
    frames(c, DEFAULT_COMBAT.sequenceStings * DEFAULT_COMBAT.stingInterval + 0.2);
    const w = CASTE_COMBAT.worker;
    expect(q.venomLoad).toBeCloseTo(w.venomRate * w.venomSeconds, 3);
    expect(q.venomLoad).toBeLessThan(q.hp);
  });

  it('never lets a lighter sting shallow out a heavier one', () => {
    /* A worker stinging something a major already hit must not help it. */
    const q = dummy();
    const major = new Combat('major');
    major.grip(q, rich);
    major.sting();
    frames(major, 1);
    const deep = q.venomLoad;
    const worker = new Combat('worker');
    worker.grip(q, rich);
    worker.sting();
    frames(worker, 1);
    expect(q.venomLoad).toBeGreaterThanOrEqual(deep - CASTE_COMBAT.major.venomRate * 2);
    expect(q.venomRate).toBe(CASTE_COMBAT.major.venomRate);
  });
});
