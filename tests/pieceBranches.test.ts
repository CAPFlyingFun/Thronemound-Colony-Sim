/**
 * The room-as-hub arithmetic: where branches start, which exits a room has
 * already spent, and how a whole tree of branches becomes one nest plan.
 */
import { describe, expect, it } from 'vitest';
import {
  branchStartOf, branchesToPlan, buildRail, endStateOf, entryExitOf,
  presetPieces, takenExitsOf, type TrackBranch,
} from '../src/scenes/pieceTrack';
import { validatePlan } from '../src/nest/nestPlan';

const straight = (length = 10) => ({ pitch: 0, turn: 0, roll: 0, length });
const diving = (length = 10) => ({ pitch: -75, turn: 0, roll: 0, length });

const PLAN_OPTS = {
  originMm: { x: 0, y: 0, z: 0 },
  boreRadiusMm: 2.6,
  entranceRadiusMm: 8,
};

describe('entryExitOf', () => {
  it('a flat arrival spends BACK', () => {
    expect(entryExitOf(0)).toBe('back');
    expect(entryExitOf(30)).toBe('back');
  });

  it('a steep dive spends UP — the way out is up', () => {
    expect(entryExitOf(-75)).toBe('up');
  });

  it('a steep climb spends DOWN', () => {
    expect(entryExitOf(75)).toBe('down');
  });
});

describe('branchStartOf', () => {
  it('the station line starts at the station', () => {
    const branches: TrackBranch[] = [
      { pieces: [straight()], roomMm: 6, parent: null },
    ];
    const start = branchStartOf(branches, 0);
    expect(start.seedPitchDeg).toBe(0);
    expect(start.headingDeg).toBe(0);
  });

  it('a LEFT branch starts at the parent room, turned 90°', () => {
    const branches: TrackBranch[] = [
      { pieces: [straight()], roomMm: 6, parent: null },
      { pieces: [straight()], roomMm: null, parent: { branch: 0, exit: 'left' } },
    ];
    const parentEnd = endStateOf(branches[0]!.pieces);
    const start = branchStartOf(branches, 1);
    expect(start.at.x).toBeCloseTo(parentEnd.x, 5);
    expect(start.at.z).toBeCloseTo(parentEnd.z, 5);
    expect(start.headingDeg).toBeCloseTo(parentEnd.headingDeg + 90, 5);
    expect(start.seedPitchDeg).toBe(0);
  });

  it('a DOWN branch keeps the heading but seeds a plunge', () => {
    const branches: TrackBranch[] = [
      { pieces: [straight()], roomMm: 6, parent: null },
      { pieces: [diving()], roomMm: null, parent: { branch: 0, exit: 'down' } },
    ];
    const start = branchStartOf(branches, 1);
    expect(start.seedPitchDeg).toBe(-75);
    // The branch's rail actually descends from the room.
    const rail = buildRail(branches[1]!.pieces, {
      at: start.at, forward: start.forward,
    });
    const end = rail.sample(rail.lengthMm, 0)!;
    expect(end.y).toBeLessThan(start.at.y - 5);
  });
});

describe('takenExitsOf', () => {
  it('a flat room spends BACK plus one per child', () => {
    const branches: TrackBranch[] = [
      { pieces: [straight()], roomMm: 6, parent: null },
      { pieces: [], roomMm: null, parent: { branch: 0, exit: 'down' } },
    ];
    const taken = takenExitsOf(branches, 0);
    expect(taken.has('back')).toBe(true);
    expect(taken.has('down')).toBe(true);
    expect(taken.has('forward')).toBe(false);
    expect(taken.size).toBe(2);
  });

  it('a room dug into by a dive spends UP, matching the player spec', () => {
    const branches: TrackBranch[] = [
      { pieces: [diving()], roomMm: 6, parent: null },
    ];
    const taken = takenExitsOf(branches, 0);
    expect([...taken]).toEqual(['up']);
  });
});

describe('branchesToPlan', () => {
  it('a single branch plans like the old single-run plan', () => {
    const branches: TrackBranch[] = [
      { pieces: [straight(), straight()], roomMm: 11, parent: null },
    ];
    const plan = branchesToPlan(branches, PLAN_OPTS);
    expect(plan.nodes[0]!.kind).toBe('entrance');
    expect(plan.nodes.at(-1)!.kind).toBe('chamber');
    expect(plan.nodes.at(-1)!.radiusMm).toBe(11);
    expect(plan.edges.length).toBe(plan.nodes.length - 1);
    expect(validatePlan(plan)).toEqual([]);
  });

  it('a child branch hangs its first edge on the parent room node', () => {
    const branches: TrackBranch[] = [
      { pieces: [straight()], roomMm: 6, parent: null },
      { pieces: [straight()], roomMm: null, parent: { branch: 0, exit: 'left' } },
    ];
    const plan = branchesToPlan(branches, PLAN_OPTS);
    const roomNode = plan.nodes.find((n) => n.kind === 'chamber')!;
    const connector = plan.edges.find((e) => e.from === roomNode.id);
    expect(connector).toBeDefined();
    expect(connector!.to).toBe('b1-1');
    // No duplicate node at the room's position: the one-piece child lays
    // exactly one node of its own (its node 0 IS the parent's room).
    expect(plan.nodes.filter((n) => n.id.startsWith('b1-')).map((n) => n.id))
      .toEqual(['b1-1']);
    expect(validatePlan(plan)).toEqual([]);
  });

  it('a child of a trackless parent is left out, not left dangling', () => {
    const branches: TrackBranch[] = [
      { pieces: [straight()], roomMm: 6, parent: null },
      { pieces: [], roomMm: null, parent: { branch: 0, exit: 'left' } },
      { pieces: [straight()], roomMm: null, parent: { branch: 1, exit: 'forward' } },
    ];
    const plan = branchesToPlan(branches, PLAN_OPTS);
    expect(plan.nodes.some((n) => n.id.startsWith('b2-'))).toBe(false);
    expect(validatePlan(plan)).toEqual([]);
  });

  it('empty branches contribute nothing, and the tree stays valid', () => {
    const branches: TrackBranch[] = [
      { pieces: [straight(), diving()], roomMm: 6, parent: null },
      { pieces: [], roomMm: null, parent: { branch: 0, exit: 'left' } },
      { pieces: [straight()], roomMm: 6, parent: { branch: 0, exit: 'forward' } },
      { pieces: [straight()], roomMm: null, parent: { branch: 2, exit: 'right' } },
    ];
    const plan = branchesToPlan(branches, PLAN_OPTS);
    expect(plan.nodes.filter((n) => n.kind === 'entrance').length).toBe(1);
    expect(plan.nodes.filter((n) => n.kind === 'chamber').length).toBe(2);
    expect(plan.nodes.some((n) => n.id.startsWith('b1-'))).toBe(false);
    expect(validatePlan(plan)).toEqual([]);
  });
});

describe('presetPieces on a seeded branch', () => {
  const opts = { lengthMm: 6, autoBank: true };

  it('a shaft off an UP exit climbs instead of diving', () => {
    const up = presetPieces([], 'shaft', { ...opts, seedPitchDeg: 75 });
    expect(up.every((p) => p.pitch === 75)).toBe(true);
    const down = presetPieces([], 'shaft', { ...opts, seedPitchDeg: -75 });
    expect(down.every((p) => p.pitch === -75)).toBe(true);
    const flat = presetPieces([], 'shaft', { ...opts, seedPitchDeg: 0 });
    expect(flat.every((p) => p.pitch === -75)).toBe(true); // nests dive
  });

  it('spirals follow the seed too, and the u-turn holds the seeded grade', () => {
    const spiral = presetPieces([], 'spiralLeft', { ...opts, seedPitchDeg: 75 });
    expect(spiral.every((p) => p.pitch === 45 && p.turn === 45)).toBe(true);
    const uturn = presetPieces([], 'uturn', { ...opts, seedPitchDeg: 75 });
    expect(uturn.every((p) => p.pitch === 75 && p.turn === 45)).toBe(true);
  });

  it('mid-track presets are unchanged by the seed option', () => {
    const track = [straight()];
    const withSeed = presetPieces(track, 'shaft', { ...opts, seedPitchDeg: 75 });
    const without = presetPieces(track, 'shaft', opts);
    expect(withSeed).toEqual(without);
  });
});
