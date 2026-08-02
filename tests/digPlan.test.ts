import { describe, expect, it } from 'vitest';
import {
  DigPlanRunner, PLAN_SPEED_MM_S, PIECE_LIMITS, clampPiece, type DigPiece,
} from '../src/scenes/digPlan';

const piece = (over: Partial<DigPiece> = {}): DigPiece => ({
  pitch: 0, turn: 0, roll: 0, length: 10, ...over,
});

/** Run a plan to exhaustion, letting her move as fast as the throttle allows. */
function fly(pieces: DigPiece[], opts: { dt?: number; topSpeed?: number } = {}) {
  const dt = opts.dt ?? 1 / 60;
  const topSpeed = opts.topSpeed ?? 8;
  const runner = new DigPlanRunner(pieces);
  let heading = 0;
  let seconds = 0;
  let distance = 0;
  let moved = 0;
  const pitches: number[] = [];
  const rolls: number[] = [];
  for (let i = 0; i < 60 * 600 && !runner.finished; i += 1) {
    const step = runner.step(dt, moved);
    heading += step.turnDelta;
    pitches.push(step.pitch);
    rolls.push(step.roll);
    moved = step.walk * topSpeed * dt;
    distance += moved;
    seconds += dt;
  }
  return { heading, seconds, distance, pitches, rolls, runner };
}

describe('dig plan pieces', () => {
  it('clamps every field to what the builder offers', () => {
    const out = clampPiece({ pitch: -400, turn: 900, roll: -900, length: 99 });
    expect(out.pitch).toBe(PIECE_LIMITS.pitch.min);
    expect(out.turn).toBe(PIECE_LIMITS.turn.max);
    expect(out.roll).toBe(PIECE_LIMITS.roll.min);
    expect(out.length).toBe(PIECE_LIMITS.length.max);
  });
});

describe('dig plan runner', () => {
  it('paces a piece at a millimetre a second however fast she could walk', () => {
    // Ten millimetres should take ten seconds, not the one and a quarter she
    // would manage at her own eight-millimetre-a-second walk.
    const slow = fly([piece({ length: 10 })], { topSpeed: 8 });
    expect(slow.seconds).toBeGreaterThan(9.5);
    expect(slow.seconds).toBeLessThan(11);
    expect(slow.distance).toBeCloseTo(10, 0);
    // And the pace holds when she is capable of far more.
    const fast = fly([piece({ length: 10 })], { topSpeed: 40 });
    expect(fast.seconds).toBeGreaterThan(9.5);
    expect(fast.seconds).toBeLessThan(11);
  });

  it('spends the whole turn across the piece, not at the joint', () => {
    const { heading, runner } = fly([piece({ turn: 90, length: 10 })]);
    expect(runner.finished).toBe(true);
    expect((heading * 180) / Math.PI).toBeCloseTo(90, 1);
  });

  it('turns by distance, so a piece held up still comes out pointing right', () => {
    // Crawling at a tenth the speed must not change where she ends up facing.
    const crawl = fly([piece({ turn: -60, length: 6 })], { topSpeed: 0.4 });
    expect((crawl.heading * 180) / Math.PI).toBeCloseTo(-60, 1);
  });

  it('holds pitch and roll steady for the whole of a piece', () => {
    const { pitches, rolls } = fly([piece({ pitch: -15, roll: 30, length: 4 })]);
    const deg = (r: number) => (r * 180) / Math.PI;
    expect(Math.min(...pitches.map(deg))).toBeCloseTo(-15, 6);
    expect(Math.max(...pitches.map(deg))).toBeCloseTo(-15, 6);
    expect(Math.min(...rolls.map(deg))).toBeCloseTo(30, 6);
  });

  it('runs a plan piece by piece and totals the right length and turn', () => {
    const plan = [
      piece({ pitch: -15, turn: 45, roll: -30, length: 10 }),
      piece({ pitch: 0, turn: -45, roll: 0, length: 5 }),
      piece({ pitch: -60, turn: 0, roll: 0, length: 3 }),
    ];
    const { heading, distance, seconds, runner } = fly(plan);
    expect(runner.finished).toBe(true);
    expect(distance).toBeCloseTo(18, 0);
    // 18 mm of tunnel at a millimetre a second.
    expect(seconds).toBeGreaterThan(17);
    expect(seconds).toBeLessThan(20);
    // The two turns cancel.
    expect((heading * 180) / Math.PI).toBeCloseTo(0, 1);
  });

  it('reports what is left to dig, and stops asking for walk when done', () => {
    const runner = new DigPlanRunner([piece({ length: 4 }), piece({ length: 6 })]);
    expect(runner.remainingMm).toBe(10);
    let step = runner.step(1 / 60, 4);
    expect(runner.pieceIndex).toBe(1);
    expect(runner.remainingMm).toBe(6);
    step = runner.step(1 / 60, 6);
    expect(step.finished).toBe(true);
    expect(step.walk).toBe(0);
    expect(runner.finished).toBe(true);
    // And it stays finished rather than wrapping round.
    step = runner.step(1 / 60, 5);
    expect(step.finished).toBe(true);
    expect(step.walk).toBe(0);
  });

  it('never over-runs a piece when she moves further than it is long', () => {
    // A single huge stride must not carry credit into the next piece's turn.
    const runner = new DigPlanRunner([piece({ turn: 90, length: 2 })]);
    const step = runner.step(1 / 60, 50);
    expect((step.turnDelta * 180) / Math.PI).toBeCloseTo(90, 6);
    expect(runner.finished).toBe(true);
  });

  it('paces from the plan speed constant rather than a hard-coded number', () => {
    const { seconds } = fly([piece({ length: 5 })]);
    expect(seconds).toBeCloseTo(5 / PLAN_SPEED_MM_S, 0);
  });
});
