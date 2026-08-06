/**
 * The coaster-style builder's rules, as arithmetic.
 *
 * These tests pin BEHAVIOUR a palette button promises — exact angle steps,
 * clamps that park at the limit, banks that lean into the turn, a compile
 * whose nodes actually sit on the rail — not the constants behind them.
 * The geometry itself is `railFromPlan`'s, already covered by
 * `tunnelRail.test.ts`; nothing here re-derives it.
 */

import { describe, expect, it } from 'vitest';
import {
  BANK_MAX_DEG, PIECE_LENGTHS_MM, PITCH_STEP_DEG, TURN_STEP_DEG,
  appendPiece, autoBankFor, buildRail, endStateOf, piecesToPlan,
} from '../src/scenes/pieceTrack';
import { PIECE_LIMITS, type DigPiece } from '../src/scenes/digPlan';
import { validatePlan } from '../src/nest/nestPlan';

const OPTS = { lengthMm: 6, autoBank: false };

function grow(kinds: Parameters<typeof appendPiece>[1][], opts = OPTS): DigPiece[] {
  const pieces: DigPiece[] = [];
  for (const kind of kinds) pieces.push(appendPiece(pieces, kind, opts));
  return pieces;
}

describe('appendPiece', () => {
  it('steps pitch by exactly one step per UP, from level', () => {
    const pieces = grow(['up', 'up', 'up']);
    expect(pieces.map(p => p.pitch)).toEqual([
      PITCH_STEP_DEG, PITCH_STEP_DEG * 2, PITCH_STEP_DEG * 3,
    ]);
  });

  it('DOWN undoes UP, back through level and below it', () => {
    const pieces = grow(['up', 'down', 'down']);
    expect(pieces.map(p => p.pitch)).toEqual([PITCH_STEP_DEG, 0, -PITCH_STEP_DEG]);
  });

  it('a held UP parks at the pitch limit instead of passing it', () => {
    const taps = Math.ceil(PIECE_LIMITS.pitch.max / PITCH_STEP_DEG) + 3;
    const pieces = grow(Array.from({ length: taps }, () => 'up' as const));
    expect(pieces[pieces.length - 1]!.pitch).toBe(PIECE_LIMITS.pitch.max);
    // And it STAYS parked — the piece before the last already sat there.
    expect(pieces[pieces.length - 2]!.pitch).toBe(PIECE_LIMITS.pitch.max);
  });

  it('STRAIGHT carries the grade it was appended at', () => {
    const pieces = grow(['down', 'down', 'straight']);
    expect(pieces[2]!.pitch).toBe(-PITCH_STEP_DEG * 2);
    expect(pieces[2]!.turn).toBe(0);
  });

  it('LEFT turns left-positive, RIGHT the mirror, neither touching pitch', () => {
    const pieces = grow(['up', 'left', 'right']);
    expect(pieces[1]!.turn).toBe(TURN_STEP_DEG);
    expect(pieces[2]!.turn).toBe(-TURN_STEP_DEG);
    expect(pieces[1]!.pitch).toBe(PITCH_STEP_DEG);
    expect(pieces[2]!.pitch).toBe(PITCH_STEP_DEG);
  });

  it('offers only lengths the piece limits accept', () => {
    for (const length of PIECE_LENGTHS_MM) {
      expect(length).toBeGreaterThanOrEqual(PIECE_LIMITS.length.min);
      expect(length).toBeLessThanOrEqual(PIECE_LIMITS.length.max);
    }
  });
});

describe('autoBankFor', () => {
  it('banks WITH the turn: left turn, left lean', () => {
    expect(autoBankFor(TURN_STEP_DEG, 6)).toBeGreaterThan(0);
    expect(autoBankFor(-TURN_STEP_DEG, 6)).toBeLessThan(0);
  });

  it('gives no bank to a straight piece', () => {
    expect(autoBankFor(0, 6)).toBe(0);
  });

  it('banks a tighter curve harder: same turn over less length', () => {
    expect(Math.abs(autoBankFor(TURN_STEP_DEG, 3)))
      .toBeGreaterThan(Math.abs(autoBankFor(TURN_STEP_DEG, 10)));
  });

  it('lands on whole roll steps, so the readout speaks the palette numbers', () => {
    for (const length of PIECE_LENGTHS_MM) {
      for (let turn = -90; turn <= 90; turn += TURN_STEP_DEG) {
        // Math.abs: a negative bank's modulo is -0, which Object.is refuses.
        expect(Math.abs(autoBankFor(turn, length) % PIECE_LIMITS.roll.step)).toBe(0);
      }
    }
  });

  it('never exceeds the bank ceiling, however hard the curve', () => {
    expect(Math.abs(autoBankFor(90, 1))).toBeLessThanOrEqual(BANK_MAX_DEG);
  });

  it('is what an auto-banked append actually writes into the piece', () => {
    const piece = appendPiece([], 'left', { lengthMm: 6, autoBank: true });
    expect(piece.roll).toBe(autoBankFor(TURN_STEP_DEG, 6));
    const flat = appendPiece([], 'left', { lengthMm: 6, autoBank: false });
    expect(flat.roll).toBe(0);
  });
});

describe('endStateOf', () => {
  it('an empty track ends where it starts, level, facing +Z', () => {
    const end = endStateOf([]);
    expect(end.lengthMm).toBe(0);
    expect(end.x).toBe(0);
    expect(end.headingDeg).toBeCloseTo(0, 5);
  });

  it('descends by the arithmetic: 10 mm at -30 degrees is 5 mm down', () => {
    const end = endStateOf([{ pitch: -30, turn: 0, roll: 0, length: 10 }]);
    expect(end.y).toBeCloseTo(-5, 1);
    expect(end.lengthMm).toBeCloseTo(10, 6);
    expect(end.pitchDeg).toBeCloseTo(-30, 1);
  });

  it('sums turns: two lefts and a right end 15 degrees left of start', () => {
    const end = endStateOf(grow(['left', 'left', 'right']));
    expect(end.headingDeg).toBeCloseTo(TURN_STEP_DEG, 1);
  });

  it('a full 90 of turn ends heading 90, wherever the pieces split it', () => {
    const end = endStateOf([
      { pitch: 0, turn: 45, roll: 0, length: 6 },
      { pitch: 0, turn: 45, roll: 0, length: 6 },
    ]);
    expect(end.headingDeg).toBeCloseTo(90, 1);
  });
});

describe('piecesToPlan', () => {
  const OPTIONS = {
    originMm: { x: 100, y: 50, z: 100 }, boreRadiusMm: 4, entranceRadiusMm: 8,
  };

  it('starts at an entrance and validates clean', () => {
    const plan = piecesToPlan(grow(['straight', 'down', 'left']), OPTIONS);
    expect(plan.nodes[0]!.kind).toBe('entrance');
    expect(plan.nodes[0]!.radiusMm).toBe(8);
    expect(validatePlan(plan)).toEqual([]);
  });

  it('chains every edge nose to tail with the bore radius', () => {
    const plan = piecesToPlan(grow(['straight', 'up']), OPTIONS);
    for (let i = 0; i < plan.edges.length; i += 1) {
      expect(plan.edges[i]!.from).toBe(plan.nodes[i]!.id);
      expect(plan.edges[i]!.to).toBe(plan.nodes[i + 1]!.id);
      expect(plan.edges[i]!.radiusMm).toBe(4);
    }
  });

  it('puts every node ON the rail, origin shift and all', () => {
    const pieces = grow(['straight', 'left', 'down', 'right']);
    const plan = piecesToPlan(pieces, OPTIONS);
    const rail = buildRail(pieces);
    for (const node of plan.nodes) {
      const near = rail.nearest({
        x: node.x - OPTIONS.originMm.x,
        y: node.y - OPTIONS.originMm.y,
        z: node.z - OPTIONS.originMm.z,
      });
      expect(near).not.toBeNull();
      expect(near!.distMm).toBeLessThan(0.05);
    }
  });

  it('subdivides a curved piece so no chord spans more than asked', () => {
    const bend = [{ pitch: 0, turn: 90, roll: 0, length: 9 }];
    const plan = piecesToPlan(bend, { ...OPTIONS, maxChordMm: 3 });
    // A 9 mm bend at 3 mm chords is 3 edges; a straight 9 mm piece is 1.
    expect(plan.edges.length).toBe(3);
    const straight = piecesToPlan(
      [{ pitch: 0, turn: 0, roll: 0, length: 9 }], { ...OPTIONS, maxChordMm: 3 },
    );
    expect(straight.edges.length).toBe(1);
  });

  it('keeps the chords honest: subdivided nodes hug the true curve', () => {
    const bend = [{ pitch: 0, turn: 90, roll: 0, length: 12 }];
    const plan = piecesToPlan(bend, { ...OPTIONS, maxChordMm: 3 });
    const rail = buildRail(bend);
    // The worst sag of any chord's MIDPOINT off the rail stays under half a
    // millimetre — the width a 4 mm bore forgives without the ride leaving
    // the carved tunnel.
    for (let i = 0; i + 1 < plan.nodes.length; i += 1) {
      const a = plan.nodes[i]!;
      const b = plan.nodes[i + 1]!;
      const mid = {
        x: (a.x + b.x) / 2 - OPTIONS.originMm.x,
        y: (a.y + b.y) / 2 - OPTIONS.originMm.y,
        z: (a.z + b.z) / 2 - OPTIONS.originMm.z,
      };
      expect(rail.nearest(mid)!.distMm).toBeLessThan(0.5);
    }
  });

  it('an empty track is just the station, and still a valid plan', () => {
    const plan = piecesToPlan([], OPTIONS);
    expect(plan.nodes.length).toBe(1);
    expect(plan.edges.length).toBe(0);
    expect(validatePlan(plan)).toEqual([]);
  });
});
