import { describe, expect, it } from 'vitest';
import {
  AntStroll, AVOID_TURN, CLEAR_AHEAD, LOOK_AHEAD, type StrollSenses,
} from '../src/sim/antStroll';

/**
 * The stroll takes its randomness as a function, so every test here is
 * deterministic by construction rather than by seeding.
 */
const cycling = (values: number[]): (() => number) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

/** Ground everywhere. */
const OPEN: StrollSenses = { groundAhead: () => true };

/** Ground nowhere — a nose against the glass whichever way she looks. */
const WALLED: StrollSenses = { groundAhead: () => false };

/** Run her for `frames` at 60 Hz and collect what she asked for. */
const run = (
  ant: AntStroll, senses: StrollSenses, frames: number, dt = 1 / 60,
): { walk: number; turn: number }[] => {
  const out = [];
  let heading = 0;
  for (let i = 0; i < frames; i += 1) {
    const intent = ant.step(dt, heading, senses);
    heading += intent.turn * 1.6 * dt;
    out.push(intent);
  }
  return out;
};

/** Lengths of the consecutive runs of frames on which she asked for a turn. */
const turnRuns = (intents: { turn: number }[]): number[] => {
  const runs: number[] = [];
  let n = 0;
  for (const it of intents) {
    if (Math.abs(it.turn) > 1e-9) n += 1;
    else if (n > 0) { runs.push(n); n = 0; }
  }
  if (n > 0) runs.push(n);
  return runs;
};

describe('AntStroll bearing changes', () => {
  /*
   * THE BUG THIS FILE WAS WRITTEN FOR. The new-bearing turn was returned on
   * one frame and dropped on the next, so "a turn over the next leg" changed
   * her course by about a degree — and the one-frame spike snapped her gaster
   * sideways every time, which is what read on the device as shaking.
   */
  it('holds a new bearing for many frames, not one', () => {
    /* 0.9 picks a walk rather than a pause, and a turn near full. */
    const ant = new AntStroll(cycling([0.9, 0.05]));
    const runs = turnRuns(run(ant, OPEN, 60 * 30));
    expect(runs.length).toBeGreaterThan(0);
    expect(Math.min(...runs)).toBeGreaterThan(1);
    /* And long enough to be a bearing change: at least a fifth of a second. */
    expect(Math.min(...runs)).toBeGreaterThanOrEqual(12);
  });

  it('never asks for a turn outside -1..1', () => {
    const ant = new AntStroll(cycling([0.9, 0.0, 0.5, 1.0, 0.25, 0.75]));
    for (const it of run(ant, OPEN, 60 * 60)) {
      expect(Math.abs(it.turn)).toBeLessThanOrEqual(1);
      expect(Math.abs(it.walk)).toBeLessThanOrEqual(1);
    }
  });

  it('actually changes course over a leg', () => {
    const ant = new AntStroll(cycling([0.9, 0.0]));
    let heading = 0;
    for (let i = 0; i < 60 * 20; i += 1) {
      heading += ant.step(1 / 60, heading, OPEN).turn * 1.6 / 60;
    }
    /* A degree would mean the turn was still an impulse. */
    expect(Math.abs(heading)).toBeGreaterThan(0.3);
  });
});

describe('AntStroll wall avoidance', () => {
  it('turns away from a wall, hard, and does not walk into it', () => {
    const ant = new AntStroll(cycling([0.5]));
    const intents = run(ant, WALLED, 120);
    const last = intents[intents.length - 1]!;
    expect(last.walk).toBe(0);
    expect(Math.abs(last.turn)).toBeCloseTo(AVOID_TURN, 6);
  });

  /*
   * THE HYSTERESIS, and the other half of the shake. Resuming on the SAME
   * probe that triggered the avoid let one frame of turning clear the test,
   * so she flipped between walking and avoiding at frame rate and ground
   * along the glass emitting one-frame turn impulses.
   */
  it('does not resume on the probe distance that stopped her', () => {
    /* Clear at the trigger distance, still blocked further out. */
    const marginal: StrollSenses = {
      groundAhead: (_h, probe) => probe <= LOOK_AHEAD + 1e-9,
    };
    const ant = new AntStroll(cycling([0.5]));
    /* Walk her into it first. */
    ant.step(1 / 60, 0, WALLED);
    const intents = run(ant, marginal, 200);
    expect(intents.every((it) => it.walk === 0)).toBe(true);
    expect(turnRuns(intents)).toEqual([200]);
  });

  it('resumes once she can see past what stopped her', () => {
    const ant = new AntStroll(cycling([0.5]));
    ant.step(1 / 60, 0, WALLED);
    const intents = run(ant, OPEN, 10);
    expect(intents[0]!.walk).toBe(1);
    expect(intents[0]!.turn).toBe(0);
  });

  it('needs a genuinely longer sightline to clear', () => {
    expect(CLEAR_AHEAD).toBeGreaterThan(1);
  });
});
