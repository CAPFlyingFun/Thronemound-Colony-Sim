/**
 * The points, as arithmetic.
 *
 * What these pin is the GRAMMAR of a junction — that the way she came is
 * never offered back to her, that roads are named the way a driver would
 * name them, that a shaft is up or down rather than a wild bearing, and
 * that not choosing takes you straight on. None of it consults a camera,
 * which is the whole reason this module exists.
 */

import { describe, expect, it } from 'vitest';
import {
  cycleSelection, defaultOption, optionByLabel, optionsAt,
  type SwitchEdge,
} from '../src/scenes/railSwitch';

const P = (x: number, y: number, z: number) => ({ x, y, z });

/** A crossroads at the origin, entered from the south heading north (+Z). */
const CROSS: SwitchEdge[] = [
  { a: P(0, 0, -10), b: P(0, 0, 0), from: 's', to: 'hub' },   // 0: the arrival
  { a: P(0, 0, 0), b: P(0, 0, 10), from: 'hub', to: 'n' },    // 1: straight on
  { a: P(0, 0, 0), b: P(10, 0, 0), from: 'hub', to: 'e' },    // 2: left (+X)
  { a: P(0, 0, 0), b: P(-10, 0, 0), from: 'hub', to: 'w' },   // 3: right (-X)
  { a: P(0, 0, 0), b: P(0, -10, 0), from: 'hub', to: 'd' },   // 4: a shaft down
];

const NORTH = P(0, 0, 1);

describe('optionsAt', () => {
  it('never offers the way she came', () => {
    const opts = optionsAt(CROSS, 'hub', 0, NORTH);
    expect(opts.some((o) => o.edge === 0)).toBe(false);
    expect(opts.length).toBe(4);
  });

  it('names the roads the way a driver would', () => {
    const opts = optionsAt(CROSS, 'hub', 0, NORTH);
    const byEdge = new Map(opts.map((o) => [o.edge, o.label]));
    expect(byEdge.get(1)).toBe('straight');
    expect(byEdge.get(2)).toBe('left');
    expect(byEdge.get(3)).toBe('right');
    expect(byEdge.get(4)).toBe('down');
  });

  it('offers them straightest first', () => {
    const opts = optionsAt(CROSS, 'hub', 0, NORTH);
    expect(opts[0]!.label).toBe('straight');
    for (let i = 1; i < opts.length; i += 1) {
      expect(Math.abs(opts[i]!.turnDeg)).toBeGreaterThanOrEqual(Math.abs(opts[i - 1]!.turnDeg));
    }
  });

  it('says which way to ride each road, from whichever end she meets it', () => {
    // An edge stored running INTO the hub is ridden backwards.
    const rails: SwitchEdge[] = [
      { a: P(0, 0, -10), b: P(0, 0, 0), from: 's', to: 'hub' },
      { a: P(0, 0, 10), b: P(0, 0, 0), from: 'n', to: 'hub' },
    ];
    const [road] = optionsAt(rails, 'hub', 0, NORTH);
    expect(road!.startT).toBe(1);
    expect(road!.dir).toBe(-1);
    expect(road!.label).toBe('straight');
  });

  it('a shaft is up or down, never a bearing pulled out of the noise', () => {
    const rails: SwitchEdge[] = [
      { a: P(0, 0, -10), b: P(0, 0, 0), from: 's', to: 'hub' },
      { a: P(0, 0, 0), b: P(0, 10, 0), from: 'hub', to: 'up' },
    ];
    const [road] = optionsAt(rails, 'hub', 0, NORTH);
    expect(road!.label).toBe('up');
    expect(Number.isFinite(road!.turnDeg)).toBe(true);
    expect(road!.pitchDeg).toBeCloseTo(90, 5);
  });

  it('a doubling-back road is BACK, not a very sharp turn', () => {
    const rails: SwitchEdge[] = [
      { a: P(0, 0, -10), b: P(0, 0, 0), from: 's', to: 'hub' },
      { a: P(0, 0, 0), b: P(1, 0, -10), from: 'hub', to: 'b' },
    ];
    const [road] = optionsAt(rails, 'hub', 0, NORTH);
    expect(road!.label).toBe('back');
  });

  it('a plain corner is one road, so there is nothing to choose', () => {
    const rails: SwitchEdge[] = [
      { a: P(0, 0, -10), b: P(0, 0, 0), from: 's', to: 'hub' },
      { a: P(0, 0, 0), b: P(10, 0, 0), from: 'hub', to: 'e' },
    ];
    expect(optionsAt(rails, 'hub', 0, NORTH).length).toBe(1);
  });

  it('a dead end offers nothing', () => {
    const rails: SwitchEdge[] = [
      { a: P(0, 0, -10), b: P(0, 0, 0), from: 's', to: 'hub' },
    ];
    expect(optionsAt(rails, 'hub', 0, NORTH)).toEqual([]);
  });

  it('the arrival bearing is what the labels are relative to', () => {
    /*
     * The same crossroads entered from a different road renames all of it.
     * Arriving westbound (-X), the road that was "left" from the south is
     * now straight on, and north — which WAS straight on — becomes a turn.
     *
     * Which turn is the project's convention, not this module's: headings
     * are `atan2(x, z)` and `pieceTrack`'s EXIT_YAW_DEG puts left at +90,
     * so +Z off a westbound arrival is +90 and therefore LEFT. Anything
     * here that disagreed with that table would put a button marked LEFT
     * on a road the piece builder calls right.
     */
    const opts = optionsAt(CROSS, 'hub', 2, P(-1, 0, 0));
    const byEdge = new Map(opts.map((o) => [o.edge, o.label]));
    expect(byEdge.get(3)).toBe('straight');
    expect(byEdge.get(1)).toBe('left');
  });
});

describe('defaultOption', () => {
  it('takes you straight on when you choose nothing', () => {
    const opts = optionsAt(CROSS, 'hub', 0, NORTH);
    expect(defaultOption(opts)!.edge).toBe(1);
  });

  it('will not turn you round while any road leads on', () => {
    const rails: SwitchEdge[] = [
      { a: P(0, 0, -10), b: P(0, 0, 0), from: 's', to: 'hub' },
      { a: P(0, 0, 0), b: P(1, 0, -10), from: 'hub', to: 'b' },   // back
      { a: P(0, 0, 0), b: P(10, 0, 0), from: 'hub', to: 'e' },    // left
    ];
    expect(defaultOption(optionsAt(rails, 'hub', 0, NORTH))!.label).toBe('left');
  });

  it('but a true dead end may turn you round', () => {
    const rails: SwitchEdge[] = [
      { a: P(0, 0, -10), b: P(0, 0, 0), from: 's', to: 'hub' },
      { a: P(0, 0, 0), b: P(1, 0, -10), from: 'hub', to: 'b' },
    ];
    expect(defaultOption(optionsAt(rails, 'hub', 0, NORTH))!.label).toBe('back');
  });

  it('nothing offered is nothing chosen', () => {
    expect(defaultOption([])).toBeNull();
  });
});

describe('the chooser', () => {
  it('cycles both ways and wraps', () => {
    const opts = optionsAt(CROSS, 'hub', 0, NORTH);
    expect(cycleSelection(opts, 0, 1)).toBe(1);
    expect(cycleSelection(opts, 0, -1)).toBe(opts.length - 1);
    expect(cycleSelection(opts, opts.length - 1, 1)).toBe(0);
  });

  it('survives an empty junction', () => {
    expect(cycleSelection([], 0, 1)).toBe(0);
  });

  it('finds the road a labelled button means', () => {
    const opts = optionsAt(CROSS, 'hub', 0, NORTH);
    expect(opts[optionByLabel(opts, 'left')]!.edge).toBe(2);
    expect(opts[optionByLabel(opts, 'right')]!.edge).toBe(3);
    expect(optionByLabel(opts, 'back')).toBe(-1);
  });
});
