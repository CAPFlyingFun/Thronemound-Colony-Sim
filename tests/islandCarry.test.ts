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
  Carry, FIRE_ANT_CARRY, QUEEN_BODY_MG, emptyStores, withinNest,
  type Portable,
} from '../src/scenes/islandCarry';

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
    /* 45 of a 70mg capacity. The beetle is most of a load and not all of
     * it, which is the whole reason the capacity is five body masses. */
    expect(c.load).toBeCloseTo(45 / (QUEEN_BODY_MG * 5), 3);
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

  it('refuses what it cannot lift at all', () => {
    const c = new Carry();
    expect(c.lift(prey({ massMg: FIRE_ANT_CARRY.capacityMg + 1 }), rich))
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

  it('caps the load at 1 even for something at the very limit', () => {
    const c = new Carry();
    c.lift(prey({ massMg: FIRE_ANT_CARRY.capacityMg }), rich);
    expect(c.load).toBe(1);
  });
});

describe('the load changes how she is played', () => {
  it('leaves her able to run when lightly loaded', () => {
    const c = new Carry();
    c.lift(prey({ massMg: 10 }), rich);
    expect(c.tooLadenToRun).toBe(false);
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
    expect(spent).toBeCloseTo(FIRE_ANT_CARRY.ladenDrain * c.load, 5);
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
