/**
 * The island's guided dig, as arithmetic.
 *
 * These pin the PLAYER's spec, not the constants behind it: a leg snaps to
 * the camera and lands 20 mm along; a scoop is one egg and one bite of
 * stamina; a finished leg becomes the next joint; Y forks at 45°, T at 90°,
 * X three ways; the compiled plan is a valid nest anchored at the origin.
 * The rail geometry is `railFromPlan`'s and the branching `pieceTrack`'s —
 * both already covered; nothing here re-derives them.
 */

import { describe, expect, it } from 'vitest';
import {
  BORE_RADIUS_MM, HUB_RADIUS_MM, LEG_MM, ROOM_RADIUS_MM,
  SCOOP_DEEP_MM, SCOOP_STAMINA, STAMINA_MAX, STAMINA_REGEN,
  TunnelBuilder,
} from '../src/scenes/tunnelBuilder';
import { validatePlan } from '../src/nest/nestPlan';

const ORIGIN = { x: 0, y: 0, z: 0 };

/** Chew a whole leg through, feeding stamina between scoops. */
function digLeg(b: TunnelBuilder, aimHeadingDeg: number, aimPitchDeg: number,
  source: Parameters<TunnelBuilder['startLeg']>[0] = { extend: 0 }): void {
  b.startLeg(source, aimHeadingDeg, aimPitchDeg);
  for (let i = 0; i < 40 && b.pending; i += 1) {
    b.stamina = STAMINA_MAX;
    const order = b.scoop();
    expect(order).not.toBe('no-stamina');
    expect(order).not.toBe('no-leg');
  }
  expect(b.pending).toBeNull();
}

describe('the guide', () => {
  it('a leg aimed on the cardinal lands one leg-length out', () => {
    const b = new TunnelBuilder();
    const leg = b.previewLeg({ extend: 0 }, 0, 0);
    expect(leg.lengthMm).toBeCloseTo(LEG_MM, 0);
    const end = leg.points[leg.points.length - 1]!;
    expect(end.z).toBeCloseTo(LEG_MM, 0);
    expect(Math.abs(end.x)).toBeLessThan(0.5);
  });

  it('the aim snaps: 40° of camera becomes a 45° leg', () => {
    const b = new TunnelBuilder();
    const leg = b.previewLeg({ extend: 0 }, 40, 0);
    expect(leg.pieces[0]!.turn).toBe(45);
    expect(leg.pieces[1]!.turn).toBe(0);
  });

  it('a straight-down aim is a true shaft', () => {
    const b = new TunnelBuilder();
    const leg = b.previewLeg({ extend: 0 }, 0, -90);
    const end = leg.points[leg.points.length - 1]!;
    expect(end.y).toBeCloseTo(-LEG_MM, 0);
  });
});

describe('the scoop', () => {
  it('costs stamina, and stamina gates it', () => {
    const b = new TunnelBuilder();
    b.startLeg({ extend: 0 }, 0, 0);
    expect(b.scoop()).not.toBe('no-stamina');       // 100 -> 60
    expect(b.scoop()).not.toBe('no-stamina');       // 60 -> 20
    expect(b.scoop()).toBe('no-stamina');           // 20 < 40
    b.tick(SCOOP_STAMINA / STAMINA_REGEN + 0.01);   // a breath
    expect(b.scoop()).not.toBe('no-stamina');
  });

  it('without a leg there is nothing to dig', () => {
    const b = new TunnelBuilder();
    expect(b.scoop()).toBe('no-leg');
  });

  it('the eggs march down the guide and the last one finishes the leg', () => {
    const b = new TunnelBuilder();
    b.startLeg({ extend: 0 }, 0, 0);
    let scoops = 0;
    let lastZ = -1;
    while (b.pending) {
      b.stamina = STAMINA_MAX;
      const order = b.scoop();
      if (typeof order === 'string') throw new Error(order);
      expect(order.centerMm.z).toBeGreaterThan(lastZ);
      lastZ = order.centerMm.z;
      const len = Math.hypot(order.along.x, order.along.y, order.along.z);
      expect(len).toBeCloseTo(1, 3);
      scoops += 1;
      if (order.legDone) break;
    }
    expect(scoops).toBe(Math.ceil(LEG_MM / SCOOP_DEEP_MM));
    expect(b.branches[0]!.pieces.length).toBe(2);
  });

  it('the next leg starts where the last one ended', () => {
    const b = new TunnelBuilder();
    digLeg(b, 0, 0);
    const start = b.legStart({ extend: 0 });
    expect(start.at.z).toBeCloseTo(LEG_MM, 0);
    expect(start.headingDeg).toBeCloseTo(0, 5);
  });
});

describe('joints', () => {
  function withLeg(): TunnelBuilder {
    const b = new TunnelBuilder();
    digLeg(b, 0, 0);
    return b;
  }

  it('a Y forks two ways at 45', () => {
    const b = withLeg();
    b.setJointKind(0, 'Y');
    expect(b.branches[0]!.roomMm).toBe(HUB_RADIUS_MM);
    expect(b.exitsAvailable(0)).toEqual(['left45', 'right45']);
    expect(b.pickExit(0, 45, 0)).toBe('left45');
    expect(b.pickExit(0, -45, 0)).toBe('right45');
  });

  it('a T crosses at 90, an X adds straight-through', () => {
    const b = withLeg();
    b.setJointKind(0, 'T');
    expect(b.exitsAvailable(0)).toEqual(['left', 'right']);
    b.setJointKind(0, 'X');
    expect(b.exitsAvailable(0)).toEqual(['forward', 'left', 'right']);
    expect(b.pickExit(0, 0, 0)).toBe('forward');
    expect(b.pickExit(0, 90, 0)).toBe('left');
  });

  it('a dug branch spends its exit', () => {
    const b = withLeg();
    b.setJointKind(0, 'X');
    digLeg(b, 90, 0, { branch: 0, exit: 'left' });
    expect(b.exitsAvailable(0)).toEqual(['forward', 'right']);
    // And the new branch really runs east from the joint.
    const start = b.legStart({ extend: 1 });
    expect(start.at.x).toBeGreaterThan(LEG_MM - 1);
  });

  it('aiming at the wall of a Y picks nothing', () => {
    const b = withLeg();
    b.setJointKind(0, 'Y');
    expect(b.pickExit(0, 180, 0)).toBeNull();
  });

  it('a room closes its branch to bare extension', () => {
    const b = withLeg();
    b.setJointKind(0, 'queen');
    expect(b.branches[0]!.roomMm).toBe(ROOM_RADIUS_MM);
    b.startLeg({ extend: 0 }, 0, 0);
    expect(b.pending).toBeNull();
  });
});

describe('the plan', () => {
  it('compiles to a valid nest with the egg-sized bore', () => {
    const b = new TunnelBuilder();
    digLeg(b, 0, -45);
    b.setJointKind(0, 'Y');
    digLeg(b, 45, 0, { branch: 0, exit: 'left45' });
    const plan = b.plan({ x: 28000, y: 1300, z: 28000 });
    expect(validatePlan(plan)).toEqual([]);
    expect(plan.nodes[0]!.kind).toBe('entrance');
    expect(plan.nodes[0]!.x).toBeCloseTo(28000, 5);
    expect(plan.edges.every((e) => e.radiusMm === BORE_RADIUS_MM)).toBe(true);
    expect(plan.nodes.some((n) => n.kind === 'chamber' && n.radiusMm === HUB_RADIUS_MM))
      .toBe(true);
  });
});

describe('the save', () => {
  it('round-trips branches and joint kinds', () => {
    const b = new TunnelBuilder();
    digLeg(b, 15, -15);
    b.setJointKind(0, 'T');
    digLeg(b, 90, 0, { branch: 0, exit: 'left' });
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
