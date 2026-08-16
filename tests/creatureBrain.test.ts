/**
 * THE BRAIN, CHECKED WITHOUT A WORLD.
 *
 * The whole reason it is pure functions — Beyond Extinction's own Phase-0
 * rule, carried over with the port. A brain you can only observe by watching
 * a creature for a minute is a brain nobody will ever verify.
 */
import { describe, expect, it } from 'vitest';
import {
  type CreatureKind, type Sighting, IDLE_S, THINK_S, canSee, feed, isPrey, newMind,
  setBehaviour, shouldEngage, shouldFlee, speedMm, think, thinkDue, tickMind,
  wantsToHunt, wound,
} from '../src/scenes/creatureBrain';
import { CREATURE_KINDS, EARTHWORM } from '../src/scenes/creatureKinds';

/** A plain test animal, so a test about the FSM is not a test about worms. */
const KIND = (over: Partial<CreatureKind> = {}): CreatureKind => ({
  id: 'test', temperament: 'neutral', diet: 'carnivore', habitat: 'land',
  size: 1, maxHealth: 100, maxStamina: 100,
  sightMm: 200, aggroMm: 100, attackMm: 20, fovDeg: 210,
  damage: 10, windupS: 0.3, cooldownS: 1.5,
  wanderSpeedMm: 5, chaseSpeedMm: 15,
  leashMm: 500, giveUpMm: 900,
  hungerRate: 1, huntAt: 55, eatTimeS: 4,
  fleeHealth: 0.25, reprovokeS: 6,
  ...over,
});

const SEEN = (over: Partial<Sighting> = {}): Sighting => ({
  distMm: 50, bearing: 0, size: 1, edible: true, ...over,
});

const NOTHING = { threat: null, prey: null, fromHomeMm: 0 };

describe('what a creature can see', () => {
  it('cannot see past its own sight range', () => {
    const k = KIND();
    expect(canSee(k, SEEN({ distMm: k.sightMm - 1 }))).toBe(true);
    expect(canSee(k, SEEN({ distMm: k.sightMm + 1 }))).toBe(false);
  });

  it('cannot see behind itself, unless it has eyes back there', () => {
    /* 210 degrees is a forward arc; something at 150 degrees off the nose is
     * outside it. A creature that reacted to that reads as cheating. */
    const k = KIND({ fovDeg: 210 });
    expect(canSee(k, SEEN({ bearing: Math.PI * 0.4 }))).toBe(true);
    expect(canSee(k, SEEN({ bearing: Math.PI * 0.9 }))).toBe(false);
    /* A worm has no eyes and senses vibration in every direction. */
    expect(canSee(EARTHWORM, SEEN({ distMm: 10, bearing: Math.PI }))).toBe(true);
  });
});

describe('temperament', () => {
  it('keeps neutral from being a second kind of aggressive', () => {
    /*
     * THE BUG THAT CAME WITH THE PORT, already fixed at the source — Beyond
     * Extinction's own note records it as "neutral was at least as
     * aggressive as aggressive". A neutral animal that engages on sight is
     * an aggressive animal with a different label; the tier only means
     * anything if neutral needs a REASON.
     */
    const neutral = KIND({ temperament: 'neutral', aggroMm: 40 });
    const angry = KIND({ temperament: 'aggressive', aggroMm: 40 });
    const far = SEEN({ distMm: 90 });
    expect(shouldEngage(angry, SEEN({ distMm: 30 }), false)).toBe(true);
    /* Seen, well inside sight, but outside its personal space and calm. */
    expect(shouldEngage(neutral, far, false)).toBe(false);
    /* Hit it, and it comes. */
    expect(shouldEngage(neutral, far, true)).toBe(true);
    /* Or corner it. */
    expect(shouldEngage(neutral, SEEN({ distMm: 30 }), false)).toBe(true);
  });

  it('never has passive or skittish start a fight', () => {
    for (const t of ['passive', 'skittish'] as const) {
      const k = KIND({ temperament: t });
      expect(shouldEngage(k, SEEN({ distMm: 1 }), true)).toBe(false);
    }
  });

  it('has skittish run from anything its own size or bigger', () => {
    const k = KIND({ temperament: 'skittish', size: 1, fleeHealth: 0 });
    const mind = newMind(k);
    expect(shouldFlee(k, mind, SEEN({ size: 1 }))).toBe(true);
    expect(shouldFlee(k, mind, SEEN({ size: 0.4 }))).toBe(false);
  });

  it('lets a brave animal fight to the death', () => {
    /* `fleeHealth` of zero is a real choice, not a missing value. */
    const k = KIND({ temperament: 'aggressive', fleeHealth: 0 });
    const mind = newMind(k);
    mind.health = 1;
    expect(shouldFlee(k, mind, null)).toBe(false);
  });

  it('makes anything else run once it is hurt enough', () => {
    const k = KIND({ fleeHealth: 0.25 });
    const mind = newMind(k);
    mind.health = 26;
    expect(shouldFlee(k, mind, null)).toBe(false);
    mind.health = 25;
    expect(shouldFlee(k, mind, null)).toBe(true);
  });
});

describe('appetite', () => {
  it('will not hunt something bigger than itself', () => {
    /* Without the gate a hungry small predator commits suicide on the
     * biggest thing it can see, which reads as broken rather than brave. */
    const k = KIND({ size: 1 });
    expect(isPrey(k, SEEN({ size: 1 }))).toBe(true);
    expect(isPrey(k, SEEN({ size: 1.1 }))).toBe(false);
  });

  it('never has a herbivore hunt at all', () => {
    const k = KIND({ diet: 'herbivore' });
    const mind = newMind(k);
    mind.hunger = 100;
    expect(isPrey(k, SEEN())).toBe(false);
    expect(wantsToHunt(k, mind)).toBe(false);
  });

  it('sends a carnivore looking only once it is actually hungry', () => {
    const k = KIND({ diet: 'carnivore', huntAt: 55 });
    const mind = newMind(k);
    mind.hunger = 54;
    expect(wantsToHunt(k, mind)).toBe(false);
    mind.hunger = 55;
    expect(wantsToHunt(k, mind)).toBe(true);
  });
});

describe('the decision itself', () => {
  it('puts survival above appetite above boredom', () => {
    /*
     * The ORDER is the design: every rung overrides everything under it.
     * Read top to bottom it is the animal's priorities, and this pins that
     * order rather than any one branch.
     */
    const k = KIND({ fleeHealth: 0.5, huntAt: 10 });
    const mind = newMind(k);
    mind.hunger = 100;
    /* Hungry, with prey in sight, and hurt: it runs anyway. */
    mind.health = 10;
    expect(think(k, mind, { threat: SEEN({ distMm: 30 }), prey: SEEN(), fromHomeMm: 0 }))
      .toBe('flee');
    /* Healthy again, and appetite wins over standing about. */
    mind.health = k.maxHealth;
    expect(think(k, mind, { threat: null, prey: SEEN({ distMm: 80 }), fromHomeMm: 0 }))
      .toBe('hunt');
  });

  it('bites when it is close enough and not still recovering', () => {
    const k = KIND({ temperament: 'aggressive', attackMm: 20, aggroMm: 100 });
    const mind = newMind(k);
    expect(think(k, mind, { threat: SEEN({ distMm: 19 }), prey: null, fromHomeMm: 0 }))
      .toBe('attack');
    /* Mid-cooldown it closes but does not strike — otherwise `cooldownS` is
     * decoration and a creature bites every frame. */
    mind.cooldownFor = 1;
    expect(think(k, mind, { threat: SEEN({ distMm: 19 }), prey: null, fromHomeMm: 0 }))
      .toBe('chase');
  });

  it('comes home rather than following you across the island', () => {
    /* What stops one aggressive creature chasing you to the far shore, and
     * what keeps a population roughly where it was put. */
    const k = KIND({ temperament: 'aggressive', giveUpMm: 900 });
    const mind = newMind(k);
    const chase = { threat: SEEN({ distMm: 10 }), prey: null, fromHomeMm: 901 };
    expect(think(k, mind, chase)).toBe('wander');
  });

  it('finishes its meal', () => {
    /* An animal that abandoned dinner the instant anything happened would
     * never finish one, and `eatTimeS` would mean nothing. */
    const k = KIND({ eatTimeS: 4 });
    const mind = newMind(k);
    setBehaviour(mind, 'eat');
    mind.forS = 1;
    expect(think(k, mind, { threat: SEEN({ distMm: 5 }), prey: null, fromHomeMm: 0 }))
      .toBe('eat');
    mind.forS = 5;
    expect(think(k, mind, { threat: SEEN({ distMm: 5 }), prey: null, fromHomeMm: 0 }))
      .not.toBe('eat');
  });

  it('is dead before it is anything else', () => {
    const k = KIND();
    const mind = newMind(k);
    mind.health = 0;
    expect(think(k, mind, { threat: SEEN({ distMm: 1 }), prey: SEEN(), fromHomeMm: 0 }))
      .toBe('dead');
  });

  it('does not stand still forever with nothing to do', () => {
    /*
     * A REAL BUG, caught by `probe:brain` in the running game rather than
     * here — two hundred worms sat at `idle` for thirty seconds because
     * `think` returned the CURRENT behaviour whenever it was already idle or
     * wandering, on the theory that some caller would flip it. No caller
     * did, and a fresh mind starts idle. Resting is now the state with a
     * timeout and wandering is the default.
     */
    const k = KIND({ diet: 'herbivore' });
    const mind = newMind(k);
    expect(mind.behaviour).toBe('idle');
    /* Freshly idle it may rest... */
    expect(think(k, mind, NOTHING)).toBe('idle');
    /* ...but not indefinitely. */
    mind.forS = IDLE_S + 0.1;
    expect(think(k, mind, NOTHING)).toBe('wander');
    setBehaviour(mind, 'chase');
    expect(think(k, mind, NOTHING)).toBe('wander');
  });

  it('staggers its think clock when asked, so a crowd does not spike', () => {
    /* An earlier version set this to zero and CLAIMED in a comment to have
     * staggered it, which is worse than not staggering at all. */
    const k = KIND();
    expect(newMind(k, 0).sinceThink).toBe(0);
    expect(newMind(k, 1).sinceThink).toBeCloseTo(THINK_S, 9);
    expect(newMind(k, 0.5).sinceThink).toBeCloseTo(THINK_S / 2, 9);
    /* Out of range is clamped rather than trusted. */
    expect(newMind(k, 99).sinceThink).toBeCloseTo(THINK_S, 9);
    expect(newMind(k, -5).sinceThink).toBe(0);
  });
});

describe('the clocks', () => {
  it('runs every frame while thinking is throttled', () => {
    /*
     * The split exists because a cooldown that only ticked on think frames
     * would be quantised to 0.15 s, and a creature could not be hit at a
     * finer rate than that.
     */
    const k = KIND();
    const mind = newMind(k);
    mind.cooldownFor = 1;
    let thoughts = 0;
    for (let i = 0; i < 60; i += 1) {
      tickMind(k, mind, 1 / 60, false);
      if (thinkDue(mind)) thoughts += 1;
    }
    expect(mind.cooldownFor).toBeCloseTo(0, 5);
    /* One second at 0.15 s a think. */
    expect(thoughts).toBe(Math.floor(1 / THINK_S));
  });

  it('lets anger cool off on its own', () => {
    const k = KIND({ reprovokeS: 6 });
    const mind = newMind(k);
    wound(k, mind, 5);
    expect(mind.angryFor).toBe(6);
    for (let i = 0; i < 60 * 7; i += 1) tickMind(k, mind, 1 / 60, false);
    expect(mind.angryFor).toBe(0);
  });

  it('gives stamina a way back up, as the project rule demands', () => {
    /* "A bar may only move if there is a way to move it back." */
    const k = KIND();
    const mind = newMind(k);
    for (let i = 0; i < 60 * 5; i += 1) tickMind(k, mind, 1 / 60, true);
    const spent = mind.stamina;
    expect(spent).toBeLessThan(k.maxStamina);
    for (let i = 0; i < 60 * 20; i += 1) tickMind(k, mind, 1 / 60, false);
    expect(mind.stamina).toBe(k.maxStamina);
  });

  it('caps hunger rather than starving forever', () => {
    const k = KIND({ hungerRate: 50 });
    const mind = newMind(k);
    for (let i = 0; i < 60 * 60; i += 1) tickMind(k, mind, 1 / 60, false);
    expect(mind.hunger).toBe(100);
    feed(k, mind);
    expect(mind.hunger).toBe(0);
  });

  it('ignores a zero or negative step', () => {
    const k = KIND();
    const mind = newMind(k);
    tickMind(k, mind, 0, false);
    expect(mind.forS).toBe(0);
  });
});

describe('being hit', () => {
  it('records anger as an EVENT, not at the next think', () => {
    /* A hit that arrived and expired between two throttled thinks would
     * otherwise be missed entirely. */
    const k = KIND({ reprovokeS: 6 });
    const mind = newMind(k);
    expect(wound(k, mind, 10)).toBe(false);
    expect(mind.health).toBe(90);
    expect(mind.angryFor).toBe(6);
  });

  it('reports the killing blow, once', () => {
    const k = KIND();
    const mind = newMind(k);
    expect(wound(k, mind, 200)).toBe(true);
    expect(mind.health).toBe(0);
    expect(mind.behaviour).toBe('dead');
    /* A corpse cannot be killed again — otherwise a death is announced on
     * every subsequent hit and whatever listens fires repeatedly. */
    expect(wound(k, mind, 10)).toBe(false);
  });

  it('never heals by taking negative damage', () => {
    const k = KIND();
    const mind = newMind(k);
    wound(k, mind, -50);
    expect(mind.health).toBe(k.maxHealth);
  });
});

describe('how fast it goes', () => {
  it('stands still to bite, eat, idle or die', () => {
    const k = KIND();
    const mind = newMind(k);
    for (const b of ['idle', 'attack', 'eat', 'dead'] as const) {
      setBehaviour(mind, b);
      expect(speedMm(k, mind)).toBe(0);
    }
  });

  it('runs at chase speed whether chasing, hunting or fleeing', () => {
    const k = KIND();
    const mind = newMind(k);
    for (const b of ['chase', 'hunt', 'flee'] as const) {
      setBehaviour(mind, b);
      expect(speedMm(k, mind)).toBe(k.chaseSpeedMm);
    }
    setBehaviour(mind, 'wander');
    expect(speedMm(k, mind)).toBe(k.wanderSpeedMm);
  });
});

describe('the earthworm, as data', () => {
  it('cannot attack anything, under any circumstances', () => {
    expect(EARTHWORM.damage).toBe(0);
    expect(EARTHWORM.attackMm).toBe(0);
    expect(shouldEngage(EARTHWORM, SEEN({ distMm: 0 }), true)).toBe(false);
    const mind = newMind(EARTHWORM);
    mind.hunger = 100;
    expect(wantsToHunt(EARTHWORM, mind)).toBe(false);
  });

  it('withdraws from anything that could hurt it', () => {
    /* Measured biology: L. terrestris retreats into its burrow on
     * vibration — Catania 2008, PLoS ONE 3(10): e3472. */
    const mind = newMind(EARTHWORM);
    expect(shouldFlee(EARTHWORM, mind, SEEN({ size: EARTHWORM.size }))).toBe(true);
    expect(think(EARTHWORM, mind, {
      threat: SEEN({ distMm: 20, size: EARTHWORM.size }), prey: null, fromHomeMm: 0,
    })).toBe('flee');
  });

  it('digs at the speed the worm code actually uses', () => {
    /* Its wander speed IS its dig speed — for a worm those are one act, and
     * two numbers that must agree are a bug waiting to happen. */
    expect(EARTHWORM.wanderSpeedMm).toBe(3);
    expect(EARTHWORM.chaseSpeedMm).toBeGreaterThan(EARTHWORM.wanderSpeedMm);
  });

  it('is registered under its own id', () => {
    expect(CREATURE_KINDS.earthworm).toBe(EARTHWORM);
    for (const [id, kind] of Object.entries(CREATURE_KINDS)) {
      expect(kind.id).toBe(id);
      expect(kind.maxHealth).toBeGreaterThan(0);
      expect(kind.sightMm).toBeGreaterThan(0);
    }
  });
});
