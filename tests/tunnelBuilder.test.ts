/**
 * The island's guided dig, as arithmetic.
 *
 * These pin the PLAYER's spec, not the constants behind it: a palette of
 * ninety-degree pieces laid on the end of what is already there, each one
 * instant and each one costing a bite of stamina; joints that become rooms
 * or splits, with a Y forking at 45° and a T at 90°; and a compiled plan
 * that is an ordinary valid nest. The rail geometry is `railFromPlan`'s and
 * the branching `pieceTrack`'s — both already covered; nothing re-derives
 * them here.
 */

import { describe, expect, it } from 'vitest';
import {
  BORE_RADIUS_MM, HUB_RADIUS_MM, PIECE_MM, PIECE_STAMINA, ROOM_RADIUS_MM,
  STAMINA_MAX, STAMINA_REGEN, TunnelBuilder, pieceIsUseful, piecesFor,
} from '../src/scenes/tunnelBuilder';
import { validatePlan } from '../src/nest/nestPlan';

const ORIGIN = { x: 0, y: 0, z: 0 };

/** Lay a piece with the strength for it, and insist it landed. */
function lay(b: TunnelBuilder, kind: Parameters<TunnelBuilder['addPiece']>[1],
  source: Parameters<TunnelBuilder['addPiece']>[0] = { extend: 0 }): number {
  b.stamina = STAMINA_MAX;
  const landed = b.addPiece(source, kind);
  if (typeof landed === 'string') throw new Error(landed);
  return landed;
}

describe('the palette', () => {
  it('a straight runs one piece-length dead ahead', () => {
    const b = new TunnelBuilder();
    const leg = b.previewPiece({ extend: 0 }, 'straight');
    expect(leg.lengthMm).toBeCloseTo(PIECE_MM, 0);
    const end = leg.points[leg.points.length - 1]!;
    expect(end.z).toBeCloseTo(PIECE_MM, 0);
    expect(Math.abs(end.x)).toBeLessThan(0.5);
  });

  it('a bend is two 45s, so the carve stays round', () => {
    expect(piecesFor('left90', 0).map((p) => p.turn)).toEqual([45, 45]);
    expect(piecesFor('right90', 0).map((p) => p.turn)).toEqual([-45, -45]);
  });

  it('and it really turns ninety degrees', () => {
    const b = new TunnelBuilder();
    lay(b, 'left90');
    // Heading is absolute: a left 90 from due +Z ends pointing along +X.
    const next = b.legStart({ extend: 0 });
    expect(next.headingDeg).toBeCloseTo(90, 0);
  });

  it('UP and DOWN are RELATIVE, so a shaft can be levelled out of', () => {
    expect(piecesFor('up90', 0).map((p) => p.pitch)).toEqual([45, 90]);
    expect(piecesFor('down90', 0).map((p) => p.pitch)).toEqual([-45, -90]);
    // The one that matters: plumb down, UP 90 comes back to level. An
    // absolute reading would send her straight up instead, and there would
    // be no button at all for the drift every nest needs.
    expect(piecesFor('up90', -90).map((p) => p.pitch)).toEqual([-45, 0]);
    // And past the limit it parks rather than folding over.
    expect(piecesFor('down90', -90).map((p) => p.pitch)).toEqual([-90, -90]);
  });

  it('a turn on a plumb shaft is refused, not silently wasted', () => {
    const b = new TunnelBuilder();
    lay(b, 'down90');
    expect(pieceIsUseful('left90', -90)).toBe(false);
    expect(pieceIsUseful('straight', -90)).toBe(true);
    b.stamina = STAMINA_MAX;
    expect(b.addPiece({ extend: 0 }, 'left90')).toBe('no-turn');
    expect(b.stamina).toBe(STAMINA_MAX);   // and it cost her nothing
  });

  it('level out first, and the turn works', () => {
    const b = new TunnelBuilder();
    lay(b, 'down90');
    lay(b, 'up90');                        // back to level
    const before = b.legStart({ extend: 0 }).headingDeg;
    lay(b, 'left90');
    let turned = b.legStart({ extend: 0 }).headingDeg - before;
    while (turned > 180) turned -= 360;
    expect(Math.abs(turned)).toBeCloseTo(90, 0);
  });

  it('a DOWN 90 from the surface really goes down', () => {
    const b = new TunnelBuilder();
    lay(b, 'down90');
    const end = b.legStart({ extend: 0 }).at;
    expect(end.y).toBeLessThan(-10);
    expect(Math.hypot(end.x, end.z)).toBeLessThan(PIECE_MM);
  });

  it('the ghost is exactly what the button digs', () => {
    const b = new TunnelBuilder();
    const ghost = b.previewPiece({ extend: 0 }, 'left90');
    lay(b, 'left90');
    expect(b.branches[0]!.pieces).toEqual(ghost.pieces);
  });
});

describe('stamina', () => {
  it('paces the digging without ever stopping it', () => {
    const b = new TunnelBuilder();
    expect(b.addPiece({ extend: 0 }, 'straight')).not.toBe('no-stamina'); // 100 -> 60
    expect(b.addPiece({ extend: 0 }, 'straight')).not.toBe('no-stamina'); // 60 -> 20
    expect(b.addPiece({ extend: 0 }, 'straight')).toBe('no-stamina');     // 20 < 40
    b.tick(PIECE_STAMINA / STAMINA_REGEN + 0.01);
    expect(b.addPiece({ extend: 0 }, 'straight')).not.toBe('no-stamina');
  });

  it('a refused piece costs nothing', () => {
    const b = new TunnelBuilder();
    b.stamina = 0;
    b.addPiece({ extend: 0 }, 'straight');
    expect(b.stamina).toBe(0);
    expect(b.branches[0]!.pieces.length).toBe(0);
  });

  it('never banks past full', () => {
    const b = new TunnelBuilder();
    b.tick(100);
    expect(b.stamina).toBe(STAMINA_MAX);
  });
});

describe('joints', () => {
  function withPiece(): TunnelBuilder {
    const b = new TunnelBuilder();
    lay(b, 'straight');
    return b;
  }

  it('a Y forks two ways at 45', () => {
    const b = withPiece();
    b.stamina = STAMINA_MAX;
    expect(b.digJoint(0, 'Y')).toBe(true);
    expect(b.branches[0]!.roomMm).toBe(HUB_RADIUS_MM);
    expect(b.exitsAvailable(0)).toEqual(['left45', 'right45']);
    expect(b.pickExit(0, 45, 0)).toBe('left45');
    expect(b.pickExit(0, -45, 0)).toBe('right45');
  });

  it('a T branches at 90, an X adds straight-through', () => {
    const b = withPiece();
    b.stamina = STAMINA_MAX;
    b.digJoint(0, 'T');
    expect(b.exitsAvailable(0)).toEqual(['left', 'right']);
    b.stamina = STAMINA_MAX;
    b.digJoint(0, 'X');
    expect(b.exitsAvailable(0)).toEqual(['forward', 'left', 'right']);
    expect(b.pickExit(0, 0, 0)).toBe('forward');
    expect(b.pickExit(0, 90, 0)).toBe('left');
  });

  it('a room is bigger than a hub, and closes its branch', () => {
    const b = withPiece();
    b.stamina = STAMINA_MAX;
    b.digJoint(0, 'queen');
    expect(b.branches[0]!.roomMm).toBe(ROOM_RADIUS_MM);
    expect(b.canExtend({ extend: 0 })).toBe(false);
    expect(b.addPiece({ extend: 0 }, 'straight')).toBe('closed');
  });

  it('a joint costs stamina like anything else dug', () => {
    const b = withPiece();
    b.stamina = 0;
    expect(b.digJoint(0, 'T')).toBe(false);
    expect(b.branches[0]!.roomMm).toBeNull();
  });

  it('a branch off an exit spends it', () => {
    const b = withPiece();
    b.stamina = STAMINA_MAX;
    b.digJoint(0, 'X');
    lay(b, 'straight', { branch: 0, exit: 'left' });
    expect(b.exitsAvailable(0)).toEqual(['forward', 'right']);
    const arm = b.legStart({ extend: 1 });
    expect(arm.at.x).toBeGreaterThan(PIECE_MM - 1);
  });

  it('aiming at the wall of a Y picks nothing', () => {
    const b = withPiece();
    b.stamina = STAMINA_MAX;
    b.digJoint(0, 'Y');
    expect(b.pickExit(0, 180, 0)).toBeNull();
  });
});

describe('the plan', () => {
  it('compiles to a valid nest with a round bore', () => {
    const b = new TunnelBuilder();
    lay(b, 'down90');
    lay(b, 'straight');
    b.stamina = STAMINA_MAX;
    b.digJoint(0, 'Y');
    lay(b, 'straight', { branch: 0, exit: 'left45' });
    const plan = b.plan({ x: 28000, y: 1300, z: 28000 });
    expect(validatePlan(plan)).toEqual([]);
    expect(plan.nodes[0]!.kind).toBe('entrance');
    expect(plan.nodes[0]!.x).toBeCloseTo(28000, 5);
    expect(plan.edges.every((e) => e.radiusMm === BORE_RADIUS_MM)).toBe(true);
    /* Round, deliberately: an oval tube she cannot roll all the way around
     * is the one thing the 360° crawl rules out. */
    expect(plan.edges.every((e) => e.squashY === undefined)).toBe(true);
    expect(plan.nodes.some((n) => n.kind === 'chamber' && n.radiusMm === HUB_RADIUS_MM))
      .toBe(true);
  });

  it('an untouched builder has nothing to carve', () => {
    const b = new TunnelBuilder();
    expect(b.hasTunnels).toBe(false);
    expect(b.plan(ORIGIN).nodes).toEqual([]);
  });
});

describe('the save', () => {
  it('round-trips branches and joint kinds', () => {
    const b = new TunnelBuilder();
    lay(b, 'down90');
    b.stamina = STAMINA_MAX;
    b.digJoint(0, 'T');
    lay(b, 'straight', { branch: 0, exit: 'left' });
    const copy = TunnelBuilder.fromJSON(JSON.parse(JSON.stringify(b.toJSON())));
    expect(copy).not.toBeNull();
    expect(copy!.branches.length).toBe(b.branches.length);
    expect(copy!.jointKinds.get(0)).toBe('T');
    expect(copy!.plan(ORIGIN)).toEqual(b.plan(ORIGIN));
  });

  it('rejects garbage without throwing', () => {
    expect(TunnelBuilder.fromJSON(null)).toBeNull();
    expect(TunnelBuilder.fromJSON({ v: 2 })).toBeNull();
    expect(TunnelBuilder.fromJSON('nest')).toBeNull();
  });
});
