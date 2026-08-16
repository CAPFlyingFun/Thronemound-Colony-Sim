/*
 * CARRYING, AND THE COLONY'S SHARE OF IT.
 *
 * The rule these are all circling is the one in CLAUDE.md: a bar may only
 * move if there is a way to move it back. A dropped beetle stays on the
 * ground and can be picked up again; a fumbled one does too. Nothing here
 * may consume a load without either delivering it or leaving it where the
 * player can get it.
 */
import { describe, expect, it } from 'vitest';
import {
  Carry, FIRE_ANT_CARRY, emptyStores, withinNest, type Portable,
} from '../src/scenes/islandCarry';
import { STRENGTH } from '../src/scenes/mandibleReach';

const prey = (over: Partial<Portable> = {}): Portable => ({
  id: 'beetle',
  at: { x: 0, y: 0, z: 0 },
  massMg: 45,
  proteinMg: 27,
  alive: false,
  ...over,
});

/** A purse that always pays, for tests that are not about stamina. */
const rich = () => true;

describe('picking it up', () => {
  it('lifts a felled beetle and reports the load', () => {
    const c = new Carry();
    expect(c.lift(prey(), rich)).toBeNull();
    expect(c.carrying).toBe(true);
    /* A beetle is a DRAG — 45 mg against a 20 mg carry limit and a 60 mg
     * drag limit — so it reads in the meter's upper half, five eighths of
     * the way from her carrying limit to what will not move at all. */
    expect(c.load).toBeCloseTo(0.8125, 4);
    /* And what it costs her is still the plain fraction of what she can
     * shift, unchanged by the meter's curve. */
    expect(c.strain).toBeCloseTo(45 / STRENGTH.queen.dragMg, 3);
  });

  it('spends the whole bar, not its bottom third', () => {
    /*
     * THE FIX, PINNED. Reported as "the carry bar isn't being filled
     * correctly like the HP bar or other stats", and measured in the
     * running game: every prop she can actually CARRY sat under 14% —
     * a twig 13.3% — because the reading was mass over the DRAG limit, so
     * two thirds of the channel could only be reached by hauling.
     *
     * Half the bar to each limit, and the join is the landmark: half-full
     * is exactly the heaviest thing she can carry, which is also where
     * `loadColour`'s amber stop sits.
     */
    const at = (massMg: number): number => {
      const c = new Carry();
      c.lift(prey({ massMg }), rich);
      return c.load;
    };
    expect(at(STRENGTH.queen.carryMg)).toBeCloseTo(0.5, 6);
    /* The twig, which is the one Joshua was holding. */
    expect(at(8)).toBeCloseTo(0.2, 6);
    /* The pebble — a drag, and it must not jump BACKWARDS across the join
     * for being one gram heavier than a carry. */
    expect(at(22)).toBeGreaterThan(at(20));
    expect(at(22)).toBeCloseTo(0.525, 6);
    /* Monotonic the whole way up, so heavier never reads lighter. */
    let last = -1;
    for (let mg = 0; mg <= STRENGTH.queen.dragMg; mg += 1) {
      const now = at(mg);
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
  });

  it('drags a beetle rather than carrying it', () => {
    /* 45mg against a queen's 20mg carry limit and 60mg drag limit. The
     * beetle is the reason the queen's numbers are what they are. */
    const c = new Carry();
    c.lift(prey(), rich);
    expect(c.mode).toBe('drag');
  });

  it('carries a crumb outright, and quickly', () => {
    const c = new Carry();
    c.lift(prey({ id: 'crumb', massMg: 5 }), rich);
    expect(c.mode).toBe('carry');
    expect(c.speedFactor).toBeGreaterThan(0.8);
  });

  it('gives a worker different answers to the same objects', () => {
    /* THE POINT OF THE TABLE. Nothing here is a branch on caste — the same
     * two calls, a different row, and the nanitic's world is heavier. */
    const worker = new Carry('worker');
    worker.lift(prey({ id: 'twig', massMg: 8 }), rich);
    expect(worker.mode).toBe('drag');

    const queen = new Carry('queen');
    queen.lift(prey({ id: 'twig', massMg: 8 }), rich);
    expect(queen.mode).toBe('carry');
  });

  it('refuses a worker the beetle a queen can drag', () => {
    const worker = new Carry('worker');
    expect(worker.lift(prey(), rich)).toBe('too-heavy');
    expect(new Carry('queen').lift(prey(), rich)).toBeNull();
  });

  it('refuses a beetle that is still fighting', () => {
    const c = new Carry();
    expect(c.lift(prey({ alive: true }), rich)).toBe('still-alive');
    expect(c.carrying).toBe(false);
  });

  it('refuses a second load', () => {
    const c = new Carry();
    c.lift(prey(), rich);
    expect(c.lift(prey({ id: 'other' }), rich)).toBe('already-carrying');
    expect(c.held?.id).toBe('beetle');
  });

  it('refuses what it cannot shift at all', () => {
    const c = new Carry();
    expect(c.lift(prey({ massMg: STRENGTH.queen.dragMg + 1 }), rich))
      .toBe('too-heavy');
  });

  it('refuses when she has not the stamina, and takes nothing for trying', () => {
    const c = new Carry();
    let spent = 0;
    const broke = (cost: number): boolean => { spent += cost; return false; };
    expect(c.lift(prey(), broke)).toBe('too-tired');
    expect(c.carrying).toBe(false);
    /* It asked once and was told no. A refused lift must not leave her
     * poorer — that is the failure that makes a control feel broken. */
    expect(spent).toBe(FIRE_ANT_CARRY.liftCost);
  });

  it('caps the load at 1 at the very limit of what she can shift', () => {
    const c = new Carry();
    c.lift(prey({ massMg: STRENGTH.queen.dragMg }), rich);
    expect(c.load).toBe(1);
  });
});

describe('the load changes how she is played', () => {
  it('leaves her able to run with something she can simply carry', () => {
    const c = new Carry();
    c.lift(prey({ massMg: 10 }), rich);
    expect(c.mode).toBe('carry');
    expect(c.tooLadenToRun).toBe(false);
  });

  it('slows her continuously rather than in one step', () => {
    /* A crumb should not cost what a beetle costs. The taper is
     * `carryVerdict`'s and this is the island agreeing to use it. */
    const light = new Carry(); light.lift(prey({ massMg: 3 }), rich);
    const heavy = new Carry(); heavy.lift(prey({ massMg: 18 }), rich);
    expect(light.speedFactor).toBeGreaterThan(heavy.speedFactor);
    expect(new Carry().speedFactor).toBe(1);
  });

  it('takes the run away under a beetle', () => {
    const c = new Carry();
    c.lift(prey(), rich);
    expect(c.tooLadenToRun).toBe(true);
  });

  it('gives it back the moment she puts it down', () => {
    const c = new Carry();
    c.lift(prey(), rich);
    c.drop();
    expect(c.tooLadenToRun).toBe(false);
    expect(c.load).toBe(0);
  });
});

describe('carrying costs something', () => {
  it('spends stamina in proportion to the load', () => {
    const c = new Carry();
    c.lift(prey(), rich);
    let spent = 0;
    c.tick(1, (cost) => { spent += cost; return true; });
    /* `strain`, not `load`: the drain is proportional to the fraction of
     * her strength the thing uses, and the meter's curve is not that. This
     * assertion is what stops a future HUD tweak retuning her stamina. */
    expect(spent).toBeCloseTo(FIRE_ANT_CARRY.ladenDrain * c.strain, 5);
  });

  it('costs nothing at all when her jaws are empty', () => {
    const c = new Carry();
    let spent = 0;
    c.tick(1, (cost) => { spent += cost; return true; });
    expect(spent).toBe(0);
  });

  it('FUMBLES rather than carrying on for free when she runs dry', () => {
    const c = new Carry();
    c.lift(prey(), rich);
    c.drain();
    c.tick(1, () => false);
    expect(c.carrying).toBe(false);
    expect(c.drain().map((e) => e.kind)).toEqual(['fumbled']);
  });
});

describe('what the colony gets', () => {
  it('moves protein into the store and empties her jaws', () => {
    const c = new Carry();
    const stores = emptyStores();
    c.lift(prey(), rich);
    expect(c.deliver(stores)).toBe(27);
    expect(stores.proteinMg).toBe(27);
    expect(c.carrying).toBe(false);
  });

  it('accumulates across trips', () => {
    const c = new Carry();
    const stores = emptyStores();
    for (const id of ['a', 'b', 'c']) {
      c.lift(prey({ id }), rich);
      c.deliver(stores);
    }
    expect(stores.proteinMg).toBe(81);
  });

  it('delivers nothing when she is carrying nothing', () => {
    const c = new Carry();
    const stores = emptyStores();
    expect(c.deliver(stores)).toBe(0);
    expect(stores.proteinMg).toBe(0);
  });

  it('hands back the beetle on a drop, so nothing is ever destroyed', () => {
    /* The rule from CLAUDE.md, as a test: a load she puts down has to be a
     * load she can pick up again, or the player has lost a beetle to a
     * mis-tap. */
    const c = new Carry();
    const beetle = prey();
    c.lift(beetle, rich);
    expect(c.drop()).toBe(beetle);
  });
});

describe('being close enough to hand it over', () => {
  const nest = { x: 10, y: 0, z: 10 };

  it('is true standing on it', () => {
    expect(withinNest({ x: 10, y: 0, z: 10 }, nest, 3)).toBe(true);
  });

  it('is true just inside, false just outside', () => {
    expect(withinNest({ x: 12, y: 0, z: 10 }, nest, 3)).toBe(true);
    expect(withinNest({ x: 14, y: 0, z: 10 }, nest, 3)).toBe(false);
  });

  it('counts depth as distance — the chamber is below the entrance', () => {
    expect(withinNest({ x: 10, y: -2, z: 10 }, nest, 3)).toBe(true);
    expect(withinNest({ x: 10, y: -9, z: 10 }, nest, 3)).toBe(false);
  });
});
