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
  aimPiece, appendPiece, autoBankFor, buildRail, endStateOf, pieceLabel,
  piecesToPlan, presetPieces,
} from '../src/scenes/pieceTrack';
import { PIECE_LIMITS, type DigPiece } from '../src/scenes/digPlan';
import { validatePlan } from '../src/nest/nestPlan';
import { carvePlan } from '../src/nest/nestCarve';

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

describe('aimPiece — the first-person look, snapped to the track', () => {
  const OPT = { lengthMm: 6, autoBank: true };

  it('snaps the pitch to the step, whichever side is nearer', () => {
    expect(aimPiece(0, 0, -50, OPT).pitch).toBe(-45);
    expect(aimPiece(0, 0, -70, OPT).pitch).toBe(-75);
    expect(aimPiece(0, 0, 8, OPT).pitch).toBe(15);
    expect(aimPiece(0, 0, 7, OPT).pitch).toBe(0);
  });

  it('turns by the snapped difference from the track end heading', () => {
    expect(aimPiece(0, 40, 0, OPT).turn).toBe(45);
    expect(aimPiece(30, 30, 0, OPT).turn).toBe(0);
    expect(aimPiece(0, -22, 0, OPT).turn).toBe(-15);
  });

  it('wraps across the ±180 seam and turns the short way', () => {
    expect(aimPiece(170, -170, 0, OPT).turn).toBe(15);
    expect(aimPiece(-170, 170, 0, OPT).turn).toBe(-15);
  });

  it('clamps a wild swing to the piece limit, and banks the survivor', () => {
    const wild = aimPiece(0, 150, 0, OPT);
    expect(wild.turn).toBe(PIECE_LIMITS.turn.max);
    expect(wild.roll).toBe(autoBankFor(PIECE_LIMITS.turn.max, 6));
  });

  it('banks only when asked', () => {
    expect(aimPiece(0, 40, 0, { lengthMm: 6, autoBank: false }).roll).toBe(0);
  });
});

describe('presetPieces', () => {
  const OPT = { lengthMm: 6, autoBank: true };

  it('SHAFT plunges at the format limit, never past it', () => {
    const shaft = presetPieces([], 'shaft', OPT);
    expect(shaft.length).toBe(4);
    for (const p of shaft) {
      expect(p.pitch).toBe(PIECE_LIMITS.pitch.min);
      expect(p.turn).toBe(0);
    }
  });

  it('SPIRAL turns a half circle while descending, handed', () => {
    for (const [id, sign] of [['spiralLeft', 1], ['spiralRight', -1]] as const) {
      const spiral = presetPieces([], id, OPT);
      const turn = spiral.reduce((sum, p) => sum + p.turn, 0);
      expect(turn).toBe(180 * sign);
      for (const p of spiral) {
        expect(p.pitch).toBe(-45);
        // Banked INTO the helix when auto-bank is on.
        expect(Math.sign(p.roll)).toBe(sign);
      }
      const end = endStateOf(spiral);
      expect(end.headingDeg).toBeCloseTo(180 * sign, 0);
      expect(end.y).toBeLessThan(-10);
    }
  });

  it('U-TURN keeps the grade it was asked at', () => {
    const downhill = [appendPiece([], 'down', { lengthMm: 6, autoBank: false })];
    const uturn = presetPieces(downhill, 'uturn', OPT);
    expect(uturn.reduce((sum, p) => sum + p.turn, 0)).toBe(180);
    for (const p of uturn) expect(p.pitch).toBe(downhill[0]!.pitch);
  });

  it('presets bank only when asked', () => {
    for (const p of presetPieces([], 'spiralLeft', { lengthMm: 6, autoBank: false })) {
      expect(p.roll).toBe(0);
    }
  });
});

describe('the end room', () => {
  const OPTIONS = {
    originMm: { x: 0, y: 0, z: 0 }, boreRadiusMm: 4, entranceRadiusMm: 8,
  };
  const DIVE = presetPieces([], 'shaft', { lengthMm: 6, autoBank: false });

  it('turns the last node into a chamber of the asked size', () => {
    const plan = piecesToPlan(DIVE, { ...OPTIONS, endChamberMm: 11 });
    const last = plan.nodes[plan.nodes.length - 1]!;
    expect(last.kind).toBe('chamber');
    expect(last.radiusMm).toBe(11);
    expect(plan.nodes.filter((n) => n.kind === 'chamber').length).toBe(1);
    expect(validatePlan(plan)).toEqual([]);
  });

  it('leaves the plan roomless when not asked', () => {
    const plan = piecesToPlan(DIVE, OPTIONS);
    expect(plan.nodes.every((n) => n.kind !== 'chamber')).toBe(true);
  });

  it('never rooms an empty track — the station is not a chamber', () => {
    const plan = piecesToPlan([], { ...OPTIONS, endChamberMm: 11 });
    expect(plan.nodes.length).toBe(1);
    expect(plan.nodes[0]!.kind).toBe('entrance');
  });

  it('carves wider than the bore where the room is', () => {
    const soil = (x: number, y: number, z: number): number =>
      Math.min(-y, y + 70, 60 - Math.abs(x), 60 - Math.abs(z - 30));
    const plan = piecesToPlan(DIVE, { ...OPTIONS, endChamberMm: 11 });
    const carved = carvePlan(soil, plan);
    const end = plan.nodes[plan.nodes.length - 1]!;
    // Ten millimetres to the side of the END is inside the room's 15.4 mm
    // half-width but far outside the 4 mm bore.
    expect(carved(end.x + 10, end.y, end.z)).toBeLessThan(0);
  });
});

describe('pieceLabel', () => {
  it('always says the pitch, signed', () => {
    expect(pieceLabel({ pitch: 10, turn: 0, roll: 0, length: 6 })).toBe('+10°');
    expect(pieceLabel({ pitch: -70, turn: 0, roll: 0, length: 6 })).toBe('−70°');
    expect(pieceLabel({ pitch: 0, turn: 0, roll: 0, length: 6 })).toBe('+0°');
  });

  it('adds yaw as a handedness, only when the piece turns', () => {
    expect(pieceLabel({ pitch: -15, turn: 15, roll: 15, length: 6 })).toBe('−15° L15°');
    expect(pieceLabel({ pitch: 30, turn: -45, roll: -30, length: 6 })).toBe('+30° R45°');
  });
});

describe('carving the track out of soil', () => {
  /** A 120 mm block of ground whose surface is y = 0. */
  const soil = (x: number, y: number, z: number): number =>
    Math.min(-y, y + 70, 60 - Math.abs(x), 60 - Math.abs(z - 30));

  const DIVE: DigPiece[] = [
    { pitch: -45, turn: 0, roll: 0, length: 10 },
    { pitch: -45, turn: 0, roll: 0, length: 10 },
    { pitch: 0, turn: 45, roll: 15, length: 10 },
    { pitch: 0, turn: 0, roll: 0, length: 10 },
  ];

  it('opens air along the whole rail, bends included', () => {
    const plan = piecesToPlan(DIVE, {
      originMm: { x: 0, y: 0, z: 0 }, boreRadiusMm: 4, entranceRadiusMm: 6,
    });
    const carved = carvePlan(soil, plan);
    const rail = buildRail(DIVE);
    for (let s = 2; s <= rail.lengthMm - 0.5; s += 1) {
      const f = rail.sample(s, 0)!;
      // Deep enough that this is a real tunnel question, not the open sky.
      // Positive is SOIL in the carve convention, so the bore must read
      // negative — air — at every step of the centreline.
      if (f.y > -3) continue;
      expect(carved(f.x, f.y, f.z), `soil left in the bore at s=${s}`).toBeLessThan(0);
    }
  });

  it('leaves the soil beside the bore untouched', () => {
    const plan = piecesToPlan(DIVE, {
      originMm: { x: 0, y: 0, z: 0 }, boreRadiusMm: 4, entranceRadiusMm: 6,
    });
    const carved = carvePlan(soil, plan);
    const rail = buildRail(DIVE);
    const f = rail.sample(rail.lengthMm * 0.6, 0)!;
    // Fifteen millimetres to the side of a 4 mm bore is undug country.
    expect(carved(f.x + 15, f.y, f.z)).toBeGreaterThan(0);
    expect(carved(f.x, f.y - 15, f.z)).toBeGreaterThan(0);
  });

  it('heaps the entrance mound over the station', () => {
    const plan = piecesToPlan(DIVE, {
      originMm: { x: 0, y: 0, z: 0 }, boreRadiusMm: 4, entranceRadiusMm: 6,
    });
    const carved = carvePlan(soil, plan);
    // Above the undug surface but inside the heap — and NOT down the vent.
    expect(soil(8, 2, 0)).toBeLessThan(0);
    expect(carved(8, 2, 0)).toBeGreaterThan(0);
  });
});
