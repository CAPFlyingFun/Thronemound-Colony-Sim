/**
 * COASTER-STYLE TRACK BUILDING: a tunnel authored as pieces appended to the
 * end of the last one, the way the mobile builders do it.
 *
 * The vocabulary is `digPlan`'s — pitch absolute, turn relative and spread
 * across the length, roll relative to the bore — and the geometry is
 * `railFromPlan`'s. This module adds only what a palette of buttons needs on
 * top of those two: "what piece does UP mean, given the piece before it?",
 * "what bank goes with this turn?", and "what nest plan is this track?".
 *
 * Everything here is arithmetic over plain data: no THREE, no scene, so every
 * rule a button encodes can be tested without a renderer. The rail itself is
 * built by `railFromPlan` — never re-derived here — so the builder, the ride
 * and the tests all read one implementation of the track's shape. (A probe
 * once kept a hand copy of the world's height function; this module exists
 * partly so that mistake is structurally impossible for the track.)
 */

import { PIECE_LIMITS, clampPiece, type DigPiece } from './digPlan';
import { TunnelRail, railFromPlan, type Vec3Like } from './tunnelRail';
import type { NestPlan } from '../nest/nestPlan';

/** What the palette offers. Each appends ONE piece relative to the last. */
export type PieceKind = 'straight' | 'up' | 'down' | 'left' | 'right';

/** The lengths the LEN button cycles through, in millimetres. All must sit
 *  inside `PIECE_LIMITS.length`, which the clamp below enforces anyway. */
export const PIECE_LENGTHS_MM = [3, 6, 10] as const;

/** One tap's worth of angle, in degrees — the exact steps the spec asks for.
 *  Taken from the limits table so the builder and the runner cannot drift. */
export const PITCH_STEP_DEG = PIECE_LIMITS.pitch.step;
export const TURN_STEP_DEG = PIECE_LIMITS.turn.step;

/**
 * The bank never exceeds this, however tight the curve. Forty-five keeps the
 * floor of the bore readable as a floor; past it a banked tunnel starts to
 * read as a corkscrew, which is a coaster's job and not an ant's.
 */
export const BANK_MAX_DEG = 45;

/** The curve length the auto-bank gain is tuned at: a TURN_STEP turn over
 *  this many millimetres banks by exactly one roll step. */
const BANK_REFERENCE_MM = 6;

/**
 * The bank that goes with a turn, in whole roll steps.
 *
 * Curvature-proportional: the same total turn over a shorter piece is a
 * tighter curve and gets more bank, exactly as a coaster would. Snapped to
 * the roll step so the readout shows the same round numbers the buttons
 * speak, and signed WITH the turn — left turn, lean left (both are positive
 * counterclockwise seen from behind, `digPlan`'s own convention).
 */
export function autoBankFor(turnDeg: number, lengthMm: number): number {
  if (lengthMm <= 0) return 0;
  const raw = turnDeg * (BANK_REFERENCE_MM / lengthMm);
  const step = PIECE_LIMITS.roll.step;
  const snapped = Math.round(raw / step) * step;
  return Math.max(-BANK_MAX_DEG, Math.min(BANK_MAX_DEG, snapped));
}

export interface AppendOptions {
  lengthMm: number;
  autoBank: boolean;
}

/**
 * The piece a palette button means, RELATIVE to the track so far.
 *
 * Pitch is absolute in the piece format (see digPlan — relative pitch
 * compounds and rolls the plan over), so UP and DOWN read the previous
 * piece's pitch and step from it; the first piece steps from level. Turn is
 * already relative by convention, so LEFT and RIGHT need no history at all.
 * Everything funnels through `clampPiece`, so a UP held past the limit
 * simply parks at the limit instead of inventing an angle the runner would
 * refuse.
 */
export function appendPiece(
  pieces: readonly DigPiece[], kind: PieceKind, opts: AppendOptions,
): DigPiece {
  const lastPitch = pieces.length ? pieces[pieces.length - 1]!.pitch : 0;
  let pitch = lastPitch;
  let turn = 0;
  if (kind === 'up') pitch = lastPitch + PITCH_STEP_DEG;
  if (kind === 'down') pitch = lastPitch - PITCH_STEP_DEG;
  if (kind === 'left') turn = TURN_STEP_DEG;
  if (kind === 'right') turn = -TURN_STEP_DEG;
  const roll = opts.autoBank ? autoBankFor(turn, opts.lengthMm) : 0;
  return clampPiece({ pitch, turn, roll, length: opts.lengthMm });
}

/**
 * The tag a piece wears in the world: its exact angles, spelled the way the
 * palette speaks them. Pitch always — it is absolute, so "+10°" or "-70°"
 * reads alone — and yaw only when the piece turns, as a handedness rather
 * than a signed number, because "L15°" survives being read from any side of
 * the track and "-15°" does not.
 */
export function pieceLabel(piece: DigPiece): string {
  const pitch = `${piece.pitch >= 0 ? '+' : '−'}${Math.abs(piece.pitch)}°`;
  if (piece.turn === 0) return pitch;
  const yaw = piece.turn > 0
    ? `L${piece.turn}°`
    : `R${-piece.turn}°`;
  return `${pitch} ${yaw}`;
}

/** Where a track starts unless the caller says otherwise: the origin,
 *  heading +Z — the same convention every scene in the project uses. */
export const TRACK_START = {
  at: { x: 0, y: 0, z: 0 },
  forward: { x: 0, y: 0, z: 1 },
} as const;

/** The track a piece list describes, in the caller's units (mm here). */
export function buildRail(
  pieces: readonly DigPiece[],
  start: { at: Vec3Like; forward: Vec3Like } = TRACK_START,
): TunnelRail {
  return railFromPlan(pieces, start);
}

export interface TrackEnd {
  x: number; y: number; z: number;
  /** World bearing at the far end, degrees, 0 facing +Z, left positive. */
  headingDeg: number;
  /** Grade at the far end, degrees, nose-up positive. */
  pitchDeg: number;
  lengthMm: number;
}

/**
 * Where the track ends up, read OFF THE RAIL rather than re-integrated —
 * one implementation of the geometry, everywhere.
 */
export function endStateOf(
  pieces: readonly DigPiece[],
  start: { at: Vec3Like; forward: Vec3Like } = TRACK_START,
): TrackEnd {
  const rail = buildRail(pieces, start);
  const frame = rail.sample(rail.lengthMm, 0);
  if (!frame) {
    return {
      x: start.at.x, y: start.at.y, z: start.at.z,
      headingDeg: (Math.atan2(start.forward.x, start.forward.z) * 180) / Math.PI,
      pitchDeg: 0,
      lengthMm: 0,
    };
  }
  return {
    x: frame.x, y: frame.y, z: frame.z,
    headingDeg: (Math.atan2(frame.fx, frame.fz) * 180) / Math.PI,
    pitchDeg: (Math.asin(Math.max(-1, Math.min(1, frame.fy))) * 180) / Math.PI,
    lengthMm: rail.lengthMm,
  };
}

/**
 * THE AIMED PIECE — first person's whole grammar in one function.
 *
 * You look somewhere; the tube grows that way. The look is continuous and
 * the track speaks 15° steps, so the aim is SNAPPED — to the pitch step
 * absolutely, and to the turn step relative to the way the track already
 * ends (wrapped, so aiming across the ±180 seam turns the short way).
 * `clampPiece` then parks anything past the limits, and the bank is
 * computed from the turn that SURVIVED clamping, so a wild swing of the
 * view banks like the 90° bend it becomes, not the 300° it asked for.
 */
export function aimPiece(
  endHeadingDeg: number, aimHeadingDeg: number, aimPitchDeg: number,
  opts: AppendOptions,
): DigPiece {
  const snap = (v: number, step: number): number => Math.round(v / step) * step;
  let turn = snap(aimHeadingDeg - endHeadingDeg, TURN_STEP_DEG);
  while (turn > 180) turn -= 360;
  while (turn < -180) turn += 360;
  const pitch = snap(aimPitchDeg, PITCH_STEP_DEG);
  const clamped = clampPiece({ pitch, turn, roll: 0, length: opts.lengthMm });
  return {
    ...clamped,
    roll: opts.autoBank ? autoBankFor(clamped.turn, clamped.length) : 0,
  };
}

/* ------------------------------------------------------------- presets */

/**
 * PRESET MOVES — several pieces in one tap, the way a coaster builder's
 * panel offers a whole shape. Named for what an ant digs, not what a
 * coaster rides:
 *
 *  SHAFT      a plunge at the piece format's own steepest grade. −75°, not
 *             −90: pitch is capped there by `PIECE_LIMITS`, and the rail's
 *             frame degenerates at true plumb (up has nothing to be
 *             perpendicular to) — a real vertical needs that fixed first,
 *             and −75 already reads as a shaft.
 *  SPIRAL     the classic nest helix: down at −45° while turning 180°,
 *             handed left or right.
 *  U-TURN     a switchback at the CURRENT grade — 180° of turn and no
 *             change of pitch, which is how a nest gains depth under a
 *             small footprint.
 */
export type PresetId = 'shaft' | 'spiralLeft' | 'spiralRight' | 'uturn';

export const PRESET_IDS: readonly PresetId[] = [
  'shaft', 'spiralLeft', 'spiralRight', 'uturn',
];

/** The pieces a preset appends, given the track so far. */
export function presetPieces(
  pieces: readonly DigPiece[], id: PresetId,
  opts: AppendOptions & {
    /** The grade an EMPTY run should lead with — a branch hung off a
     *  room's UP exit starts climbing, so its shaft and spirals must
     *  climb too, not tunnel back down through the room. */
    seedPitchDeg?: number;
  },
): DigPiece[] {
  const seed = pieces.length === 0 ? opts.seedPitchDeg ?? 0 : undefined;
  const lastPitch = pieces.length
    ? pieces[pieces.length - 1]!.pitch : seed ?? 0;
  // Presets dive by default (this is a nest); an UP-seeded branch flips
  // them so the first move honors the exit it grows from.
  const sign = seed !== undefined && seed >= 50 ? 1 : -1;
  const make = (pitch: number, turn: number): DigPiece => clampPiece({
    pitch,
    turn,
    roll: opts.autoBank ? autoBankFor(turn, opts.lengthMm) : 0,
    length: opts.lengthMm,
  });
  switch (id) {
    case 'shaft':
      return [
        make(sign * 75, 0), make(sign * 75, 0),
        make(sign * 75, 0), make(sign * 75, 0),
      ];
    case 'spiralLeft':
      return [
        make(sign * 45, 45), make(sign * 45, 45),
        make(sign * 45, 45), make(sign * 45, 45),
      ];
    case 'spiralRight':
      return [
        make(sign * 45, -45), make(sign * 45, -45),
        make(sign * 45, -45), make(sign * 45, -45),
      ];
    case 'uturn':
      return [
        make(lastPitch, 45), make(lastPitch, 45),
        make(lastPitch, 45), make(lastPitch, 45),
      ];
    default:
      return [];
  }
}

/* ------------------------------------------------------------ branching */

/**
 * A ROOM IS A HUB — the player's own spec: a room links up to seven
 * connections. One is the tunnel you arrived by; the other six are the
 * axis exits, named RELATIVE TO HOW YOU CAME IN, because that is the frame
 * a player standing at the room actually thinks in. Dig a room straight
 * down and the way back out is UP — so UP is spent, and down, left, right,
 * forward and back are still open to branch from.
 */
export type ExitDir = 'forward' | 'back' | 'left' | 'right' | 'up' | 'down';

export const EXIT_DIRS: readonly ExitDir[] = [
  'forward', 'back', 'left', 'right', 'up', 'down',
];

/** One run of pieces. The first branch is the station line; every other
 *  branch hangs off a parent branch's end room by one of its exits. */
export interface TrackBranch {
  pieces: readonly DigPiece[];
  /** Radius of the room this branch ends in, or null for a bare end. */
  roomMm: number | null;
  parent: { branch: number; exit: ExitDir } | null;
}

/** The heading change an exit applies, relative to the arrival bearing. */
const EXIT_YAW_DEG: Record<ExitDir, number> = {
  forward: 0, back: 180, left: 90, right: -90, up: 0, down: 0,
};

/** The grade a branch STARTS at for each exit. Vertical exits lead with the
 *  steepest grade the piece format allows; the flat four lead level. */
export const EXIT_SEED_PITCH_DEG: Record<ExitDir, number> = {
  forward: 0, back: 0, left: 0, right: 0,
  up: PIECE_LIMITS.pitch.max, down: PIECE_LIMITS.pitch.min,
};

/**
 * Which exit the ARRIVING tunnel spends. The way back out of the room is
 * the reverse of the arrival direction: come in flat and BACK is spent;
 * come in steeply down and the way out is UP.
 */
export function entryExitOf(arrivalPitchDeg: number): ExitDir {
  if (arrivalPitchDeg <= -50) return 'up';
  if (arrivalPitchDeg >= 50) return 'down';
  return 'back';
}

export interface BranchStart {
  at: Vec3Like;
  forward: Vec3Like;
  /** The grade the branch's FIRST piece should lead with. */
  seedPitchDeg: number;
  /** Arrival bearing at the hub, degrees — the frame the exits are named in. */
  headingDeg: number;
}

const STATION_START: BranchStart = {
  at: TRACK_START.at, forward: TRACK_START.forward,
  seedPitchDeg: 0, headingDeg: 0,
};

/**
 * Where a branch begins: the station for the first, the parent's end room
 * for the rest, turned by the exit it hangs from. Walks parents recursively
 * — trees here are a handful of branches, and a cycle (which the scene
 * never writes) just bottoms out at the station rather than spinning.
 */
export function branchStartOf(
  branches: readonly TrackBranch[], index: number, depth = 0,
): BranchStart {
  const branch = branches[index];
  if (!branch || !branch.parent || depth > branches.length) return STATION_START;
  const parentStart = branchStartOf(branches, branch.parent.branch, depth + 1);
  const end = endStateOf(branches[branch.parent.branch]?.pieces ?? [], {
    at: parentStart.at, forward: parentStart.forward,
  });
  const headingDeg = end.headingDeg + EXIT_YAW_DEG[branch.parent.exit];
  const rad = (headingDeg * Math.PI) / 180;
  return {
    at: { x: end.x, y: end.y, z: end.z },
    forward: { x: Math.sin(rad), y: 0, z: Math.cos(rad) },
    seedPitchDeg: EXIT_SEED_PITCH_DEG[branch.parent.exit],
    headingDeg,
  };
}

/** The exits a branch's end room has already spent: the arrival, plus one
 *  per child branch hanging off it. */
export function takenExitsOf(
  branches: readonly TrackBranch[], index: number,
): Set<ExitDir> {
  const start = branchStartOf(branches, index);
  const end = endStateOf(branches[index]?.pieces ?? [], {
    at: start.at, forward: start.forward,
  });
  const taken = new Set<ExitDir>([entryExitOf(end.pitchDeg)]);
  branches.forEach((b) => {
    if (b.parent?.branch === index) taken.add(b.parent.exit);
  });
  return taken;
}

export interface PlanOptions {
  /** Where the track's start sits, in the plan's millimetre frame. */
  originMm: Vec3Like;
  /** The bore's radius along every edge. */
  boreRadiusMm: number;
  /** The mouth's radius — generous, per nestPlan's own note: an ant strides
   *  straight over a hole narrower than her own reach. */
  entranceRadiusMm: number;
  /** The longest straight edge a curved piece may be flattened into. */
  maxChordMm?: number;
  /**
   * End the tunnel in a ROOM of this radius instead of a bare junction —
   * the Utilities panel's whole idea. The node becomes a `chamber`, and
   * `nestCarve` carves it as the standard ant-room ellipsoid (wide, long,
   * vertically squashed) that `ChamberMovement` already knows how to walk.
   */
  endChamberMm?: number;
}

/**
 * The track AS A NEST PLAN — the bridge to everything that already exists.
 *
 * Nodes are laid along the rail: one at the start (the entrance — the
 * station), one at every piece boundary, and extra ones inside turning
 * pieces so no straight edge spans more than `maxChordMm` of curve. Edges
 * carry the bore radius. The result is an ordinary `NestPlan`: `nestCarve`
 * can cut it, `nestView` can draw it, `islandSoil` can fold it into the
 * ground, and the jaws-execute mode can chew along it — none of them knowing
 * or caring that it was authored as pieces.
 */
export function piecesToPlan(
  pieces: readonly DigPiece[], opts: PlanOptions,
): NestPlan {
  const maxChord = opts.maxChordMm ?? 3;
  const rail = buildRail(pieces);
  const stops: number[] = [0];
  let s = 0;
  for (const piece of pieces) {
    const parts = piece.turn !== 0
      ? Math.max(1, Math.ceil(piece.length / maxChord))
      : 1;
    for (let i = 1; i <= parts; i += 1) stops.push(s + (piece.length * i) / parts);
    s += piece.length;
  }
  const nodes = stops.map((at, i) => {
    const frame = rail.sample(at, 0);
    const room = opts.endChamberMm !== undefined
      && pieces.length > 0 && i === stops.length - 1;
    return {
      id: `rail-${i}`,
      kind: (i === 0 ? 'entrance' : room ? 'chamber' : 'junction') as
        'entrance' | 'chamber' | 'junction',
      x: opts.originMm.x + (frame?.x ?? 0),
      y: opts.originMm.y + (frame?.y ?? 0),
      z: opts.originMm.z + (frame?.z ?? 0),
      radiusMm: i === 0 ? opts.entranceRadiusMm
        : room ? opts.endChamberMm! : opts.boreRadiusMm,
    };
  });
  const edges = stops.slice(1).map((_, i) => ({
    id: `rail-e${i}`,
    from: `rail-${i}`,
    to: `rail-${i + 1}`,
    radiusMm: opts.boreRadiusMm,
    flow: 'both' as const,
  }));
  return { nodes, edges };
}

export interface BranchPlanOptions {
  originMm: Vec3Like;
  boreRadiusMm: number;
  entranceRadiusMm: number;
  maxChordMm?: number;
}

/**
 * The whole TREE as one nest plan — `piecesToPlan`'s job, generalized to
 * branches. Every branch lays its nodes along its own rail; a child's first
 * node is NOT laid at all, because it would sit exactly on the parent's end
 * room — the child's first edge runs from the parent's room node instead,
 * which is what makes the room a junction the carve and the walkers can
 * actually use. One entrance, at the station, as ever.
 */
export function branchesToPlan(
  branches: readonly TrackBranch[], opts: BranchPlanOptions,
): NestPlan {
  const maxChord = opts.maxChordMm ?? 3;
  const nodes: NestPlan['nodes'] = [];
  const edges: NestPlan['edges'] = [];
  /** The node id of each branch's END, for children to hang edges from. */
  const endNodeId: (string | null)[] = branches.map(() => null);

  branches.forEach((branch, k) => {
    if (branch.pieces.length === 0) return;
    // A child of a branch that laid no track has nowhere to hang from;
    // emitting it anyway would put a disconnected island in the plan.
    if (branch.parent && endNodeId[branch.parent.branch] === null) return;
    const start = branchStartOf(branches, k);
    const rail = buildRail(branch.pieces, {
      at: start.at, forward: start.forward,
    });
    const stops: number[] = [0];
    let s = 0;
    for (const piece of branch.pieces) {
      const parts = piece.turn !== 0
        ? Math.max(1, Math.ceil(piece.length / maxChord))
        : 1;
      for (let i = 1; i <= parts; i += 1) {
        stops.push(s + (piece.length * i) / parts);
      }
      s += piece.length;
    }
    const parentEnd = branch.parent ? endNodeId[branch.parent.branch] : null;
    stops.forEach((at, i) => {
      const id = `b${k}-${i}`;
      const last = i === stops.length - 1;
      // A child's node 0 IS the parent's room; the room node already exists.
      if (i === 0 && parentEnd) {
        if (stops.length > 1) {
          edges.push({
            id: `b${k}-e0`,
            from: parentEnd,
            to: `b${k}-1`,
            radiusMm: opts.boreRadiusMm,
            flow: 'both',
          });
        }
        return;
      }
      const frame = rail.sample(at, 0);
      const room = last && branch.roomMm !== null;
      nodes.push({
        id,
        kind: k === 0 && i === 0 ? 'entrance' : room ? 'chamber' : 'junction',
        x: opts.originMm.x + (frame?.x ?? start.at.x),
        y: opts.originMm.y + (frame?.y ?? start.at.y),
        z: opts.originMm.z + (frame?.z ?? start.at.z),
        radiusMm: k === 0 && i === 0 ? opts.entranceRadiusMm
          : room ? branch.roomMm! : opts.boreRadiusMm,
      });
      if (i > 0 && !(i === 1 && parentEnd)) {
        edges.push({
          id: `b${k}-e${i - 1}`,
          from: `b${k}-${i - 1}`,
          to: id,
          radiusMm: opts.boreRadiusMm,
          flow: 'both',
        });
      }
      if (last) endNodeId[k] = id;
    });
  });
  return { nodes, edges };
}
