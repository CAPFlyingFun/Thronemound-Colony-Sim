/**
 * A COLONY THAT WAS ALREADY THERE — one template, stamped anywhere.
 *
 * The decision this file serves is locked on the board (card 06): the
 * default opening no longer has the player dig as the Queen. "Players hatch
 * as a young Worker inside an established colony. Digging is Worker/Major
 * gameplay." Which means the game now needs something it has never had — a
 * home that exists before the player does.
 *
 * ONE TEMPLATE, NOT ONE NEST. The same card asks for the reusable piece
 * first and the map placement second, and for a good reason beyond tidiness:
 * "the same template creates the other permanent home colonies." Every
 * enemy colony, every neutral one, every site card 07 registers is this
 * function with a different position. A hand-drawn nest would have to be
 * hand-drawn again for each.
 *
 * IT PRODUCES A `NestPlan` AND NOTHING ELSE — the format the designer
 * draws, the carver cuts, the rails ride and the sonar draws. That is the
 * whole reason this is fifty lines of data instead of a carving routine:
 * `nestPlan.ts` is emphatic that one representation is the authority, and a
 * premade colony that carved itself its own way would be the second
 * description that file exists to prevent.
 *
 * WHAT IT ADDS ON TOP is the part a plain plan cannot carry: which room is
 * which. A `NestPlan` knows it has three chambers; it does not know one of
 * them is the throne. The Queen has to be put somewhere, the player has to
 * hatch somewhere, and a future colony menu has to know where the brood is,
 * so the template names its rooms and hands back the points — the card's
 * "living Queen and valid player hatch point", as coordinates rather than
 * as a promise.
 *
 * NOTHING HERE KNOWS ABOUT THREE, the renderer or the scene, so the whole
 * template is testable as arithmetic. `IslandScene.stampColony` is the only
 * thing that turns it into soil.
 */

import {
  MIN_ENTRANCE_RADIUS_MM, findNode, routeBetween,
  type NestEdge, type NestNode, type NestPlan, type Vec3,
} from './nestPlan';
import { CHAMBER_SCALE, nodeBounds, planHollow, type Bounds } from './nestCarve';
import { FLOOR_BELOW_MM, REBASE_SLACK_MM } from '../world/IslandStream';

/**
 * HOW DEEP A COLONY MAY GO, and it is the streamer's number rather than a
 * taste: `IslandStream` hangs its depth band `FLOOR_BELOW_MM` under the
 * surface at the window's centre and only re-anchors once the ideal has
 * drifted `REBASE_SLACK_MM`, so the depth guaranteed to be represented at
 * any moment is the difference. A chamber cut below it is not a deep
 * chamber, it is a chamber in soil the field is not currently describing —
 * it would render as solid, or as a hole in the world floor, depending on
 * where the band happened to sit when you looked.
 *
 * Derived, not typed, so retuning the band retunes this with it.
 */
export const NEST_DEPTH_BUDGET_MM = FLOOR_BELOW_MM - REBASE_SLACK_MM;

/** The rooms a colony has. Named, because "chamber 3" is not a place. */
export type RoomId = 'throne' | 'nursery' | 'larder';

export interface ColonySite {
  /** Stable id — card 07's registry will key its sites on this. */
  id: string;
  /** Where the entrance goes, in island millimetres. */
  xMm: number;
  zMm: number;
  /** The DRAWN surface height there. A mouth must sit on the ground the
   *  player sees, which is the walker's own rule and not negotiable. */
  groundMm: number;
  /**
   * Which way the nest fans out, radians about +Y. Purely cosmetic and
   * therefore worth having: without it every colony on the map is the same
   * drawing in the same orientation, and a player who has explored one has
   * seen them all.
   */
  facing?: number;
}

export interface ColonyRoom {
  nodeId: string;
  /** The middle of the room, in island mm. */
  centreMm: Vec3;
  /** The lowest point of its floor — what an ant stands on. */
  floorMm: Vec3;
  /** A point comfortably inside the air, for seating an occupant. */
  standMm: Vec3;
}

export interface Colony {
  site: ColonySite;
  /** The nest itself, in island mm — hand this straight to the carver. */
  plan: NestPlan;
  rooms: Record<RoomId, ColonyRoom>;
  /** The mouth, on the surface. */
  entranceMm: Vec3;
  /** Where the Queen lives — the throne room's floor. */
  queenAnchorMm: Vec3;
  /** Where the player's worker wakes up — the nursery. */
  hatchMm: Vec3;
  /** How far the lowest floor sits below the site's ground, in mm. */
  depthMm: number;
}

/* ------------------------------------------------------- the drawing */

/**
 * THE TEMPLATE, drawn once, in millimetres relative to the mouth: x and z
 * out from it, y DOWN from the surface.
 *
 * Read it as a section through a young colony. A shaft drops from the
 * anthill; a store sits just off it near the top; the shaft continues to a
 * lower landing; the brood hangs off that; and the throne is deepest and
 * furthest off the line.
 *
 * THAT ORDER IS THE ANIMAL'S, not a level designer's. Tschinkel's casts of
 * *Pogonomyrmex badius* nests (Tschinkel 2004, J. Insect Science 4:21)
 * describe a vertical shaft with chambers opening off it, the chambers
 * largest and most crowded near the top and thinning with depth, seed
 * stores held in the upper rooms, and the queen found deep. Brood is
 * carried up and down through the day for warmth, so putting the nursery
 * between the larder and the throne is the honest middle of that range.
 *
 * THE NUMBERS ARE GAME TUNING, though, and should be read as such. The
 * thirty-millimetre shaft is the card's own starting figure, said there to
 * be "not sacred"; the room sizes are set off the animals that use them —
 * a queen is about twelve millimetres long and a worker under half that —
 * rather than off any measured burrow. A real badius nest runs two metres
 * down. This one is a home you can cross in a few seconds, because it is a
 * place to play in first.
 */
interface TemplateNode {
  id: string;
  kind: NestNode['kind'];
  /** Out from the mouth, mm. */
  x: number;
  /** BELOW the surface, mm — positive is down, which is how it reads. */
  down: number;
  z: number;
  radiusMm: number;
}

const TEMPLATE_NODES: readonly TemplateNode[] = [
  /* The anthill. Generous by law: measured, she strides straight over a
   * hole narrower than her own reach — see MIN_ENTRANCE_RADIUS_MM. */
  { id: 'gate', kind: 'entrance', x: 0, down: 0, z: 0, radiusMm: MIN_ENTRANCE_RADIUS_MM },
  /* The card's shaft: "around 30 mm as a tuning starting point". */
  { id: 'hall', kind: 'junction', x: 0, down: 30, z: 0, radiusMm: 4.5 },
  { id: 'larder', kind: 'chamber', x: 26, down: 34, z: 4, radiusMm: 9 },
  { id: 'landing', kind: 'junction', x: 0, down: 52, z: 0, radiusMm: 4.5 },
  { id: 'nursery', kind: 'chamber', x: -24, down: 56, z: 6, radiusMm: 9.5 },
  { id: 'throne', kind: 'chamber', x: 9, down: 74, z: -21, radiusMm: 11 },
];

/**
 * STARTER TUNNELS ONLY — the card is explicit, and it is the right call.
 * Five runs is a home; a finished warren is somebody else's colony that the
 * player is a tourist in. What they dig from here is theirs.
 */
const TEMPLATE_EDGES: readonly Omit<NestEdge, 'flow'>[] = [
  { id: 'shaft', from: 'gate', to: 'hall', radiusMm: 4.5 },
  { id: 'pantry-run', from: 'hall', to: 'larder', radiusMm: 4 },
  { id: 'descent', from: 'hall', to: 'landing', radiusMm: 4.5 },
  { id: 'brood-run', from: 'landing', to: 'nursery', radiusMm: 4 },
  { id: 'royal-run', from: 'landing', to: 'throne', radiusMm: 4.5 },
];

/** Which template node is which room. */
const ROOM_NODES: Record<RoomId, string> = {
  throne: 'throne', nursery: 'nursery', larder: 'larder',
};

/**
 * How far up off the floor an occupant's point is placed, as a share of the
 * room's half-height. Not zero: the floor is the SURFACE of the void, where
 * the carve field reads exactly nought, and a point placed on a boundary is
 * a coin toss about which side of it the sampler lands. A third of the way
 * up is unambiguously air, and the scene's own footing drops whoever stands
 * there onto the floor anyway.
 */
const STAND_LIFT = 1 / 3;

/* ---------------------------------------------------------- the stamp */

/**
 * THE COLONY AT THIS SITE. Pure: same site, same colony, every time — which
 * is what lets the map hold a list of positions rather than a list of nests.
 */
export function colonyNest(site: ColonySite): Colony {
  const facing = site.facing ?? 0;
  const cos = Math.cos(facing);
  const sin = Math.sin(facing);
  const place = (x: number, down: number, z: number): Vec3 => ({
    x: site.xMm + x * cos - z * sin,
    y: site.groundMm - down,
    z: site.zMm + x * sin + z * cos,
  });

  const nodes: NestNode[] = TEMPLATE_NODES.map((t) => {
    const at = place(t.x, t.down, t.z);
    return { id: t.id, kind: t.kind, x: at.x, y: at.y, z: at.z, radiusMm: t.radiusMm };
  });
  const edges: NestEdge[] = TEMPLATE_EDGES.map((e) => ({ ...e, flow: 'both' as const }));
  const plan: NestPlan = { nodes, edges };

  const roomOf = (id: RoomId): ColonyRoom => {
    const node = findNode(plan, ROOM_NODES[id])!;
    const ry = node.radiusMm * CHAMBER_SCALE.y;
    return {
      nodeId: node.id,
      centreMm: { x: node.x, y: node.y, z: node.z },
      floorMm: { x: node.x, y: node.y - ry, z: node.z },
      standMm: { x: node.x, y: node.y - ry * (1 - STAND_LIFT), z: node.z },
    };
  };
  const rooms: Record<RoomId, ColonyRoom> = {
    throne: roomOf('throne'), nursery: roomOf('nursery'), larder: roomOf('larder'),
  };
  const gate = findNode(plan, 'gate')!;

  let lowest = site.groundMm;
  for (const node of nodes) {
    const box = nodeBounds(node);
    lowest = Math.min(lowest, box ? box.min[1] : node.y - node.radiusMm);
  }

  return {
    site,
    plan,
    rooms,
    entranceMm: { x: gate.x, y: gate.y, z: gate.z },
    /* SHE LIVES IN THE THRONE ROOM. `IslandScene.queenTick` leashes her to
     * this by x and z and lets `footingFrom` seat her, so what matters here
     * is that the point is in her room's air and not somebody else's. */
    queenAnchorMm: { ...rooms.throne.standMm },
    /* AND YOU WAKE UP IN THE NURSERY, which is where a young worker would
     * be: she ecloses among the brood she was one of a week ago. */
    hatchMm: { ...rooms.nursery.standMm },
    depthMm: site.groundMm - lowest,
  };
}

/* --------------------------------------------------------- the checks */

export interface ColonyFault {
  kind: 'too-deep' | 'room-overlap' | 'unreachable' | 'point-in-soil';
  detail: string;
}

const overlaps = (a: Bounds, b: Bounds): boolean => (
  a.min[0] < b.max[0] && b.min[0] < a.max[0]
  && a.min[1] < b.max[1] && b.min[1] < a.max[1]
  && a.min[2] < b.max[2] && b.min[2] < a.max[2]
);

/**
 * EVERYTHING WRONG WITH A STAMPED COLONY, on top of `validatePlan`'s
 * structural pass — the faults that are about this being a HOME rather than
 * about it being a well-formed graph.
 *
 * Separate from `validatePlan` on purpose: a plan with two rooms grown into
 * each other is perfectly valid as a graph and perfectly broken as a nest,
 * and the designer must not start refusing player drawings for breaking
 * rules that only the template promises.
 *
 * The air checks ask `planHollow` — the very field the soil is carved from
 * — rather than re-deriving where the void is. Measuring a nest against a
 * second description of it is the bug `nestPlan.ts` opens by warning about.
 */
export function colonyFaults(colony: Colony): ColonyFault[] {
  const faults: ColonyFault[] = [];

  if (colony.depthMm > NEST_DEPTH_BUDGET_MM) {
    faults.push({
      kind: 'too-deep',
      detail: `${colony.depthMm.toFixed(1)} mm below ground, past the `
        + `${NEST_DEPTH_BUDGET_MM} mm the depth band guarantees`,
    });
  }

  const roomIds = Object.keys(colony.rooms) as RoomId[];
  for (let i = 0; i < roomIds.length; i += 1) {
    for (let j = i + 1; j < roomIds.length; j += 1) {
      const a = findNode(colony.plan, colony.rooms[roomIds[i]!]!.nodeId);
      const b = findNode(colony.plan, colony.rooms[roomIds[j]!]!.nodeId);
      const ba = a && nodeBounds(a);
      const bb = b && nodeBounds(b);
      if (ba && bb && overlaps(ba, bb)) {
        faults.push({
          kind: 'room-overlap',
          detail: `${roomIds[i]} has grown into ${roomIds[j]}`,
        });
      }
    }
  }

  /* A room you cannot walk to from the door is scenery. One-way tunnels
   * are honoured by `routeBetween`, so this also catches a flow set the
   * wrong way round. */
  for (const id of roomIds) {
    if (!routeBetween(colony.plan, 'gate', colony.rooms[id]!.nodeId)) {
      faults.push({ kind: 'unreachable', detail: `no route from the mouth to the ${id}` });
    }
  }

  const air = planHollow(colony.plan, { stepMm: 1 });
  const inAir = (p: Vec3): boolean => air(p.x, p.y, p.z) > 0;
  if (!inAir(colony.queenAnchorMm)) {
    faults.push({ kind: 'point-in-soil', detail: 'the Queen is anchored in solid soil' });
  }
  if (!inAir(colony.hatchMm)) {
    faults.push({ kind: 'point-in-soil', detail: 'the hatch point is in solid soil' });
  }
  for (const id of roomIds) {
    if (!inAir(colony.rooms[id]!.standMm)) {
      faults.push({ kind: 'point-in-soil', detail: `the ${id}'s standing point is in soil` });
    }
  }

  return faults;
}
