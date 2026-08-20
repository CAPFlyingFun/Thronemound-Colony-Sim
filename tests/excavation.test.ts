import { describe, expect, it } from 'vitest';
import { DIG_RATE, Excavation, FILL_STEPS, type Cell } from '../src/sim/excavation';
import { AIR, CLAY, GLASS_ID, STONE, TOPSOIL } from './excavationWorld';
import { TinyWorld } from './excavationWorld';

/**
 * The dig system's whole job is saying NO to the AI, so most of this is the
 * refusals. The one thing it says yes to is a solid, soft, reachable cell.
 */
describe('Excavation', () => {
  const solidWorld = (): TinyWorld => new TinyWorld(5, 5, 5, TOPSOIL);

  it('accepts a solid cell with an open face', () => {
    const world = solidWorld();
    world.set(2, 3, 2, AIR);              // a pocket above it
    const dig = new Excavation(world);
    expect(dig.aim([2, 2, 2])).toBe(true);
    expect(dig.refused).toBeNull();
    expect(dig.target).toEqual([2, 2, 2]);
  });

  it('refuses a cell with no open face — she digs a face, not a bubble', () => {
    const dig = new Excavation(solidWorld());
    expect(dig.aim([2, 2, 2])).toBe(false);
    expect(dig.refused).toBe('unreachable');
    expect(dig.target).toBeNull();
  });

  /*
   * The edge of the array is not an opening. A cell on the boundary has three
   * neighbours outside the world; if those counted, an ant anywhere in the
   * tank could dig the far wall.
   */
  it('does not treat the outside of the world as an open face', () => {
    const dig = new Excavation(solidWorld());
    expect(dig.aim([0, 0, 0])).toBe(false);
    expect(dig.refused).toBe('unreachable');
  });

  it('refuses air, stone and out-of-bounds', () => {
    const world = solidWorld();
    world.set(2, 3, 2, AIR);
    world.set(2, 2, 2, STONE);
    const dig = new Excavation(world);
    expect(dig.aim([2, 3, 2])).toBe(false);
    expect(dig.refused).toBe('already-air');
    expect(dig.aim([2, 2, 2])).toBe(false);
    expect(dig.refused).toBe('too-hard');
    expect(dig.aim([99, 0, 0])).toBe(false);
    expect(dig.refused).toBe('out-of-bounds');
  });

  /*
   * THE ONE THAT MATTERS MOST. The tank's glass carries an id with no entry
   * in MATERIALS, so it reads as undiggable — an ant must never chew her way
   * out of the formicarium.
   */
  it('refuses the tank glass', () => {
    const world = solidWorld();
    world.set(2, 3, 2, AIR);
    world.set(2, 2, 2, GLASS_ID);
    const dig = new Excavation(world);
    expect(dig.aim([2, 2, 2])).toBe(false);
    expect(dig.refused).toBe('too-hard');
  });

  it('wears a cell down and takes it out at zero', () => {
    const world = solidWorld();
    world.set(2, 3, 2, AIR);
    const dig = new Excavation(world);
    dig.aim([2, 2, 2]);

    /* Half a cell's worth of chewing is half the bar and no hole. */
    const half = dig.bite(0.5 / DIG_RATE);
    expect(half.progress).toBeCloseTo(0.5, 5);
    expect(half.broke).toBeNull();
    expect(world.get(2, 2, 2)).toBe(TOPSOIL);

    const rest = dig.bite(0.5 / DIG_RATE + 1e-6);
    expect(rest.broke).toEqual([2, 2, 2]);
    expect(rest.removed).toBe(TOPSOIL);
    expect(world.get(2, 2, 2)).toBe(AIR);
    expect(dig.excavated).toBe(1);
    /* And it lets go afterwards rather than chewing the hole it just made. */
    expect(dig.target).toBeNull();
    expect(dig.progress).toBe(0);
  });

  /* Hardness is a ratio: clay at 1.5 takes half again as long as topsoil. */
  it('takes longer through harder soil', () => {
    const world = solidWorld();
    world.set(2, 3, 2, AIR);
    world.set(2, 2, 2, CLAY);
    const dig = new Excavation(world);
    dig.aim([2, 2, 2]);
    const bar = dig.bite(1 / DIG_RATE).progress;
    expect(bar).toBeCloseTo(1 / 1.5, 5);
  });

  it('keeps its progress when re-aimed at the same cell', () => {
    const world = solidWorld();
    world.set(2, 3, 2, AIR);
    const dig = new Excavation(world);
    dig.aim([2, 2, 2]);
    dig.bite(0.5 / DIG_RATE);
    dig.aim([2, 2, 2]);
    expect(dig.progress).toBeCloseTo(0.5, 5);
  });

  /*
   * THE GRADED CUT — a cell the corridor's floor passes through is worked
   * DOWN TO A LINE and left there, not removed. It is what makes a tunnel a
   * ramp instead of a five-millimetre staircase. See `DugSoil`.
   */
  it('cuts a cell down to a fraction and leaves it standing', () => {
    const world = solidWorld();
    world.set(2, 3, 2, AIR);
    const dig = new Excavation(world);
    dig.aim([2, 2, 2], 0.4);

    /* Only 0.6 of a cell is being taken, so it costs 0.6 of a cell's work. */
    const part = dig.bite((0.5 * 0.6) / DIG_RATE);
    expect(part.progress).toBeCloseTo(0.5, 4);
    /*
     * Half way from 1 down to 0.4 is 0.7, and the DRAWN fill is quantised to
     * eighths so the chunk is not re-meshed every frame — so it reads 0.75.
     * Asserted at the quantisation rather than through it: a tighter number
     * here would be a test claiming a precision `FILL_STEPS` says it does not
     * have.
     */
    expect(world.fillOf(2, 2, 2)).toBe(Math.round(0.7 * FILL_STEPS) / FILL_STEPS);

    const done = dig.bite((0.5 * 0.6) / DIG_RATE + 1e-6);
    expect(done.broke).toBeNull();
    expect(done.changed).toBe(true);
    /* Still soil, and still there — just 40% of it. */
    expect(world.get(2, 2, 2)).toBe(TOPSOIL);
    expect(world.fillOf(2, 2, 2)).toBeCloseTo(0.4, 5);
    expect(dig.excavated).toBe(0);
  });

  it('refuses a cell that has already been cut away to nothing', () => {
    const world = solidWorld();
    world.set(2, 3, 2, AIR);
    world.setFill(2, 2, 2, 0);
    const dig = new Excavation(world);
    expect(dig.aim([2, 2, 2])).toBe(false);
    expect(dig.refused).toBe('already-air');
  });

  it('and drops it when re-aimed somewhere else', () => {
    const world = solidWorld();
    world.set(2, 3, 2, AIR);
    world.set(3, 3, 2, AIR);
    const dig = new Excavation(world);
    dig.aim([2, 2, 2]);
    dig.bite(0.5 / DIG_RATE);
    dig.aim([3, 2, 2]);
    expect(dig.progress).toBe(0);
  });

  /*
   * The world moves under an excavator — a second ant may take the same cell.
   * The target is re-checked every tick, not only when it was chosen.
   */
  it('lets go of a target that stopped being solid underneath it', () => {
    const world = solidWorld();
    world.set(2, 3, 2, AIR);
    const dig = new Excavation(world);
    dig.aim([2, 2, 2]);
    dig.bite(0.5 / DIG_RATE);
    world.set(2, 2, 2, AIR);              // somebody else got there first
    const after = dig.bite(0.1);
    expect(after.broke).toBeNull();
    expect(dig.target).toBeNull();
    expect(dig.excavated).toBe(0);
  });

  it('reports nothing at all when it has no target', () => {
    const dig = new Excavation(solidWorld());
    const idle: Cell | null = dig.target;
    expect(idle).toBeNull();
    expect(dig.bite(1)).toEqual({ progress: 0, broke: null, removed: 0, changed: false });
  });
});
