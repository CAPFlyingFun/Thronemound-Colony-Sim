import { describe, expect, it } from 'vitest';
import {
  NEST_DEPTH_BUDGET_MM, colonyFaults, colonyNest,
  type ColonySite, type RoomId,
} from '../src/nest/colonyNest';
import { FLOOR_BELOW_MM, REBASE_SLACK_MM } from '../src/world/IslandStream';
import {
  MIN_ENTRANCE_RADIUS_MM, routeBetween, sampleEdge, validatePlan,
} from '../src/nest/nestPlan';
import { planHollow } from '../src/nest/nestCarve';

const SITE: ColonySite = { id: 'test', xMm: 28000, zMm: 28000, groundMm: 208 };

const ROOMS: RoomId[] = ['throne', 'nursery', 'larder'];

/*
 * THE TEMPLATE IS A HOME, AND IT IS THE SAME HOME EVERYWHERE.
 *
 * Two different promises, and both matter. A colony has to be well-formed —
 * every room reachable, nothing grown into anything else, the Queen standing
 * in air rather than in rock. And it has to be REUSABLE, which is the whole
 * point of a template: the nest at the far corner of the map must be the
 * same nest as the one at the middle, only moved.
 */
describe('the colony template', () => {
  it('is a valid plan and a valid nest', () => {
    const colony = colonyNest(SITE);
    expect(validatePlan(colony.plan)).toEqual([]);
    expect(colonyFaults(colony)).toEqual([]);
  });

  it('has the five parts the card asks for', () => {
    /* "Surface entrance / mound. Main shaft... Queen chamber... Brood/
     * hatching area. Food/storage area." Named, so a future colony menu can
     * ask for the brood by name rather than by counting chambers. */
    const { plan, rooms } = colonyNest(SITE);
    expect(plan.nodes.filter((n) => n.kind === 'entrance')).toHaveLength(1);
    expect(plan.nodes.filter((n) => n.kind === 'chamber')).toHaveLength(3);
    expect(new Set(Object.keys(rooms))).toEqual(new Set(ROOMS));
    /* Starter tunnels only — a home, not a finished warren. */
    expect(plan.edges.length).toBeLessThanOrEqual(6);
  });

  it('drops a shaft about 30 mm from the mouth to the first landing', () => {
    /* The card's own figure, and its own caveat: "around 30 mm as a tuning
     * starting point, not sacred." Pinned loosely on purpose — this test
     * exists to catch the shaft being retuned to 300, not to forbid 32. */
    const { plan, entranceMm } = colonyNest(SITE);
    const hall = plan.nodes.find((n) => n.id === 'hall')!;
    expect(entranceMm.y - hall.y).toBeGreaterThanOrEqual(20);
    expect(entranceMm.y - hall.y).toBeLessThanOrEqual(45);
    /* And it is a plumb drop, so the rail can ride it. */
    expect(Math.hypot(hall.x - entranceMm.x, hall.z - entranceMm.z)).toBeCloseTo(0, 6);
  });

  it('puts the mouth on the ground, wide enough to be found', () => {
    const colony = colonyNest(SITE);
    expect(colony.entranceMm.y).toBe(SITE.groundMm);
    expect(colony.entranceMm.x).toBe(SITE.xMm);
    expect(colony.entranceMm.z).toBe(SITE.zMm);
    const gate = colony.plan.nodes.find((n) => n.kind === 'entrance')!;
    /* Measured, not chosen: she strides straight over anything narrower. */
    expect(gate.radiusMm).toBeGreaterThanOrEqual(MIN_ENTRANCE_RADIUS_MM);
  });

  it('gives the Queen and the player somewhere real to stand', () => {
    /* The card's DONE WHEN, as arithmetic: "a living Queen and valid player
     * hatch point". Valid means IN THE AIR THE CARVER WILL CUT — asked of
     * `planHollow` itself, which is the field the soil comes from, so this
     * cannot pass against a second description of where the void is. */
    const colony = colonyNest(SITE);
    const air = planHollow(colony.plan, { stepMm: 1 });
    expect(air(colony.queenAnchorMm.x, colony.queenAnchorMm.y, colony.queenAnchorMm.z))
      .toBeGreaterThan(0);
    expect(air(colony.hatchMm.x, colony.hatchMm.y, colony.hatchMm.z)).toBeGreaterThan(0);
    /* And they are in DIFFERENT rooms — you hatch among the brood, she sits
     * on the throne. A hatch point inside the Queen's chamber would make the
     * opening a royal audience instead of an ant waking up. */
    expect(colony.hatchMm).not.toEqual(colony.queenAnchorMm);
    expect(colony.rooms.throne.nodeId).not.toBe(colony.rooms.nursery.nodeId);
  });

  it('stands its occupants above the floor, not on the boundary', () => {
    /* A point exactly on the floor is a point exactly on the void's surface,
     * where the field reads nought and which side of the wall it counts as
     * is a rounding decision. Both points sit clear of it. */
    const colony = colonyNest(SITE);
    for (const id of ROOMS) {
      const room = colony.rooms[id];
      expect(room.standMm.y).toBeGreaterThan(room.floorMm.y);
      expect(room.standMm.y).toBeLessThan(room.centreMm.y);
    }
    expect(colony.queenAnchorMm.y).toBeGreaterThan(colony.rooms.throne.floorMm.y);
    expect(colony.hatchMm.y).toBeGreaterThan(colony.rooms.nursery.floorMm.y);
  });

  it('every room is walkable from the mouth', () => {
    const colony = colonyNest(SITE);
    for (const id of ROOMS) {
      expect(routeBetween(colony.plan, 'gate', colony.rooms[id].nodeId)).not.toBeNull();
    }
  });

  it('keeps the whole nest inside the depth the streamer guarantees', () => {
    /* The budget is DERIVED from the band, so this also pins that the two
     * have not drifted apart — the failure mode being a chamber carved into
     * soil the field is not currently describing, which renders as solid or
     * as a hole depending on where the band happened to sit. */
    expect(NEST_DEPTH_BUDGET_MM).toBe(FLOOR_BELOW_MM - REBASE_SLACK_MM);
    const colony = colonyNest(SITE);
    expect(colony.depthMm).toBeGreaterThan(0);
    expect(colony.depthMm).toBeLessThanOrEqual(NEST_DEPTH_BUDGET_MM);
  });

  it('no room grows into another', () => {
    /* Two chambers merged into one cavern is a valid graph and a broken
     * nest — which is exactly why this check is not `validatePlan`'s. */
    expect(colonyFaults(colonyNest(SITE)).filter((f) => f.kind === 'room-overlap'))
      .toEqual([]);
  });

  it('no tunnel is beads on a string', () => {
    /* `sampleEdge`'s own overlap rule: a step wider than the bore leaves
     * gaps between the spheres it walks, which carves a dotted line. */
    const colony = colonyNest(SITE);
    for (const edge of colony.plan.edges) {
      expect(sampleEdge(colony.plan, edge, 1).length).toBeGreaterThan(1);
      expect(edge.radiusMm).toBeGreaterThan(1);
    }
  });
});

describe('the same colony, somewhere else', () => {
  it('is the same nest translated, at any position', () => {
    const a = colonyNest(SITE);
    const b = colonyNest({ ...SITE, id: 'far', xMm: 4096, zMm: 51000 });
    expect(b.plan.nodes).toHaveLength(a.plan.nodes.length);
    for (let i = 0; i < a.plan.nodes.length; i += 1) {
      const na = a.plan.nodes[i]!;
      const nb = b.plan.nodes[i]!;
      expect(nb.id).toBe(na.id);
      expect(nb.radiusMm).toBe(na.radiusMm);
      expect(nb.x - na.x).toBeCloseTo(4096 - SITE.xMm, 6);
      expect(nb.z - na.z).toBeCloseTo(51000 - SITE.zMm, 6);
      expect(nb.y).toBeCloseTo(na.y, 6);
    }
    expect(colonyFaults(b)).toEqual([]);
  });

  it('follows the site up and down the terrain', () => {
    const low = colonyNest({ ...SITE, groundMm: 96 });
    const high = colonyNest({ ...SITE, groundMm: 208 });
    expect(high.entranceMm.y - low.entranceMm.y).toBeCloseTo(112, 6);
    expect(high.queenAnchorMm.y - low.queenAnchorMm.y).toBeCloseTo(112, 6);
    /* Depth below the surface is a fact about the nest, not about the hill
     * it is cut into. */
    expect(low.depthMm).toBeCloseTo(high.depthMm, 6);
  });

  it('turns without deforming — a colony faces a different way, same rooms', () => {
    /* Cosmetic, and worth having: without it every colony on the map is the
     * same drawing in the same orientation. What must NOT change is the
     * nest — so the check is that every distance survives the turn. */
    const straight = colonyNest(SITE);
    const turned = colonyNest({ ...SITE, facing: Math.PI / 3 });
    const span = (c: ReturnType<typeof colonyNest>, a: string, b: string): number => {
      const na = c.plan.nodes.find((n) => n.id === a)!;
      const nb = c.plan.nodes.find((n) => n.id === b)!;
      return Math.hypot(nb.x - na.x, nb.y - na.y, nb.z - na.z);
    };
    for (const [a, b] of [['gate', 'throne'], ['gate', 'nursery'], ['larder', 'throne']]) {
      expect(span(turned, a!, b!)).toBeCloseTo(span(straight, a!, b!), 6);
    }
    /* The mouth is the pivot, so it does not move at all. */
    expect(turned.entranceMm).toEqual(straight.entranceMm);
    /* But the rooms genuinely have. */
    expect(turned.rooms.throne.centreMm.x).not.toBeCloseTo(straight.rooms.throne.centreMm.x, 3);
    expect(colonyFaults(turned)).toEqual([]);
    /* Depth is about y, which a turn about +Y cannot touch. */
    expect(turned.depthMm).toBeCloseTo(straight.depthMm, 6);
  });
});

describe('the faults report what is actually wrong', () => {
  it('catches a nest sunk past the depth band', () => {
    const colony = colonyNest(SITE);
    /* Not by breaking the template — by claiming a depth nothing supports,
     * which is the shape of the real failure: a map site that says the
     * ground is somewhere it is not. */
    const sunk = { ...colony, depthMm: NEST_DEPTH_BUDGET_MM + 1 };
    expect(colonyFaults(sunk).map((f) => f.kind)).toContain('too-deep');
  });

  it('catches a room cut off from the mouth', () => {
    const colony = colonyNest(SITE);
    const cut = {
      ...colony,
      plan: {
        nodes: colony.plan.nodes,
        edges: colony.plan.edges.filter((e) => e.id !== 'royal-run'),
      },
    };
    const kinds = colonyFaults(cut).map((f) => f.kind);
    expect(kinds).toContain('unreachable');
    /* And it says WHICH room, because "a room is unreachable" is not a
     * diagnosis. */
    expect(colonyFaults(cut).find((f) => f.kind === 'unreachable')!.detail)
      .toContain('throne');
  });

  it('catches an occupant standing in solid soil', () => {
    const colony = colonyNest(SITE);
    const lost = {
      ...colony,
      queenAnchorMm: { x: colony.entranceMm.x + 500, y: colony.entranceMm.y - 40, z: colony.entranceMm.z },
    };
    expect(colonyFaults(lost).map((f) => f.kind)).toContain('point-in-soil');
  });

  it('catches two rooms grown into each other', () => {
    const colony = colonyNest(SITE);
    const throne = colony.plan.nodes.find((n) => n.id === 'throne')!;
    const merged = {
      ...colony,
      plan: {
        nodes: colony.plan.nodes.map((n) => (
          n.id === 'nursery' ? { ...n, x: throne.x, y: throne.y, z: throne.z } : n
        )),
        edges: colony.plan.edges,
      },
    };
    expect(colonyFaults(merged).map((f) => f.kind)).toContain('room-overlap');
  });
});
