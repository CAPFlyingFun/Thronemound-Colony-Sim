/**
 * THE TUNNEL BUILDER — the island's guided dig, as pure state.
 *
 * The player's spec, written down before any of it was code:
 *
 *   1. Start at the surface, arm DIG (first person).
 *   2. The camera's angle is the digging angle; its direction, the direction.
 *   3. A monorail-style guide shows EXACTLY what will be carved, before
 *      anything commits.
 *   4. Start the first leg; the next leg snaps to its end joint — you can
 *      preview ahead of yourself from underground.
 *   5. Walk in and keep building in real time.
 *   6. Tap a joint to make it a room or a junction: a Y branches two ways at
 *      45°, a T two ways at 90°, an X three ways at 90° — four ways in all,
 *      counting the tunnel you came by.
 *
 * And the dig itself: one press, one SCOOP — an egg of soil 9 mm across,
 * 6 mm tall and 3 mm deep, wide face toward the ant — costing a bite of
 * stamina, so digging is paced by recovery rather than by a slow animation.
 * Endless, but never a firehose.
 *
 * Everything here is arithmetic over plain data — no THREE, no scene — in
 * the builder's own millimetre frame, whose origin is the first leg's start
 * (the entrance). The geometry is `pieceTrack`'s, never re-derived: legs are
 * `aimPiece` pairs, joints are branch ends, the compiled nest is
 * `branchesToPlan`. The scene's whole job is to translate this frame into
 * the island and draw what this module says.
 */

import {
  aimPiece, buildRail, branchStartOf, endStateOf, exitAimOf, bestExitToward,
  takenExitsOf, branchesToPlan,
  type BranchStart, type ExitDir, type TrackBranch,
} from './pieceTrack';
import { type DigPiece } from './digPlan';
import { MIN_ENTRANCE_RADIUS_MM, type NestPlan } from '../nest/nestPlan';
import { type Vec3Like } from './tunnelRail';

/* ------------------------------------------------------------- the numbers */

/** One leg of tunnel, in millimetres — two pieces of the format's max 10. */
export const LEG_MM = 20;
const LEG_HALF_MM = 10;

/** The egg: full extents, wide face toward the ant. */
export const SCOOP_WIDE_MM = 9;
export const SCOOP_TALL_MM = 6;
export const SCOOP_DEEP_MM = 3;

/** Stamina: a scoop costs 40 of 100; recovery refills in a few seconds —
 *  two quick scoops, then a breath. Digging is endless but paced. */
export const SCOOP_STAMINA = 40;
export const STAMINA_MAX = 100;
export const STAMINA_REGEN = 18;

/**
 * The bore the plan carves where the scoops chewed: 4.5 mm horizontal
 * radius, squashed vertically to the egg's own 6:9 — so the tunnel the
 * plan regenerates on reload is the tunnel the scoops actually cut.
 */
export const BORE_RADIUS_MM = 4.5;
export const BORE_SQUASH = SCOOP_TALL_MM / SCOOP_WIDE_MM;

/** Joint radii: a hub is just big enough to turn a 9 mm ant; a room is a room. */
export const HUB_RADIUS_MM = 9;
export const ROOM_RADIUS_MM = 12;

/** Steeper than this, travel is the invisible spline's job (GRIP); at or
 *  under it, the free walker owns the floor. The player's own number. */
export const STEEP_DEG = 70;

/* --------------------------------------------------------------- the kinds */

export type JunctionKind = 'Y' | 'T' | 'X';
export type RoomKind = 'queen' | 'nursery' | 'storage' | 'food';
export type JointKind = JunctionKind | RoomKind;

export const ROOM_KINDS: readonly RoomKind[] = ['queen', 'nursery', 'storage', 'food'];
export const JUNCTION_KINDS: readonly JunctionKind[] = ['Y', 'T', 'X'];

/**
 * What each junction offers, relative to arrival — the player's exact spec.
 * A Y is a fork: two arms at 45°. A T is a crossing bar: two at 90°. An X
 * carries you straight through and hands you both sides: three exits, four
 * ways counting the tunnel you arrived by. Rooms are hubs the classic way —
 * any of the six axis exits, like the pipes room's balls.
 */
export const JUNCTION_EXITS: Record<JunctionKind, readonly ExitDir[]> = {
  Y: ['left45', 'right45'],
  T: ['left', 'right'],
  X: ['forward', 'left', 'right'],
};

const ROOM_EXIT_DIRS: readonly ExitDir[] = [
  'forward', 'back', 'left', 'right', 'up', 'down',
];

/* --------------------------------------------------------------- the state */

/** Where a new leg grows from: a bare branch tip, or a joint's exit. */
export type LegSource =
  | { extend: number }
  | { branch: number; exit: ExitDir };

export interface PendingLeg {
  source: LegSource;
  pieces: readonly DigPiece[];
  /** How far the working face has been chewed along the leg, mm. */
  faceMm: number;
  lengthMm: number;
}

export interface ScoopOrder {
  /** Centre of the egg, in the builder's mm frame. */
  centerMm: Vec3Like;
  /** The dig direction there — the egg's DEEP axis. */
  along: Vec3Like;
  /** True when this scoop finished the leg and it has been committed. */
  legDone: boolean;
}

export interface LegPreview {
  pieces: readonly DigPiece[];
  /** Sampled centreline, builder mm frame, every ~2 mm. */
  points: Vec3Like[];
  lengthMm: number;
}

interface SavedBuilder {
  v: 1;
  branches: TrackBranch[];
  jointKinds: [number, JointKind][];
}

export class TunnelBuilder {
  /** Branch 0 is the mainline from the entrance. Branches only append —
   *  that is what keeps plain indices stable enough to key joints by. */
  branches: TrackBranch[] = [{ pieces: [], roomMm: null, parent: null }];

  /** Joint kind by BRANCH index — a joint IS a branch's end. */
  readonly jointKinds = new Map<number, JointKind>();

  stamina = STAMINA_MAX;

  pending: PendingLeg | null = null;

  /* ----------------------------------------------------------- geometry */

  /** The frame a leg from this source starts in. */
  legStart(source: LegSource): BranchStart {
    if ('extend' in source) {
      const start = branchStartOf(this.branches, source.extend);
      const end = endStateOf(this.branches[source.extend]?.pieces ?? [], {
        at: start.at, forward: start.forward,
      });
      const rad = (end.headingDeg * Math.PI) / 180;
      const pitch = (end.pitchDeg * Math.PI) / 180;
      return {
        at: { x: end.x, y: end.y, z: end.z },
        forward: {
          x: Math.sin(rad) * Math.cos(pitch),
          y: Math.sin(pitch),
          z: Math.cos(rad) * Math.cos(pitch),
        },
        seedPitchDeg: end.pitchDeg,
        headingDeg: end.headingDeg,
      };
    }
    const start = branchStartOf(this.branches, source.branch);
    const end = endStateOf(this.branches[source.branch]?.pieces ?? [], {
      at: start.at, forward: start.forward,
    });
    const aim = exitAimOf(end.headingDeg, source.exit);
    const rad = (aim.headingDeg * Math.PI) / 180;
    return {
      at: { x: end.x, y: end.y, z: end.z },
      forward: { x: Math.sin(rad), y: 0, z: Math.cos(rad) },
      seedPitchDeg: aim.pitchDeg,
      headingDeg: aim.headingDeg,
    };
  }

  /**
   * The guide: what a leg aimed THERE would be. Two pieces — the first
   * carries the snapped turn, the second runs the pitch straight out — so a
   * leg bends once at its root and lands 20 mm along, which is what makes
   * the end joint predictable enough to build ahead of yourself.
   */
  previewLeg(source: LegSource, aimHeadingDeg: number, aimPitchDeg: number): LegPreview {
    const start = this.legStart(source);
    const lead = aimPiece(start.headingDeg, aimHeadingDeg, aimPitchDeg, {
      lengthMm: LEG_HALF_MM, autoBank: false,
    });
    const pieces: DigPiece[] = [
      lead,
      { pitch: lead.pitch, turn: 0, roll: 0, length: LEG_HALF_MM },
    ];
    const rail = buildRail(pieces, { at: start.at, forward: start.forward });
    const points: Vec3Like[] = [];
    for (let s = 0; s <= rail.lengthMm; s += 2) {
      const f = rail.sample(s, 0);
      if (f) points.push({ x: f.x, y: f.y, z: f.z });
    }
    const tail = rail.sample(rail.lengthMm, 0);
    if (tail) points.push({ x: tail.x, y: tail.y, z: tail.z });
    return { pieces, points, lengthMm: rail.lengthMm };
  }

  /** The locked leg's own guide — same shape `previewLeg` returns, but from
   *  the pieces the scoops are actually marching down, camera long gone. */
  pendingPreview(): LegPreview | null {
    const leg = this.pending;
    if (!leg) return null;
    const start = this.legStart(leg.source);
    const rail = buildRail(leg.pieces, { at: start.at, forward: start.forward });
    const points: Vec3Like[] = [];
    for (let s = 0; s <= rail.lengthMm; s += 2) {
      const f = rail.sample(s, 0);
      if (f) points.push({ x: f.x, y: f.y, z: f.z });
    }
    const tail = rail.sample(rail.lengthMm, 0);
    if (tail) points.push({ x: tail.x, y: tail.y, z: tail.z });
    return { pieces: leg.pieces, points, lengthMm: rail.lengthMm };
  }

  /** Lock the aim: from here the guide stops following the camera and the
   *  scoops march down it. The first press of the shovel calls this. */
  startLeg(source: LegSource, aimHeadingDeg: number, aimPitchDeg: number): void {
    if (this.pending) return;
    if ('extend' in source && this.branches[source.extend]?.roomMm !== null
      && (this.branches[source.extend]?.pieces.length ?? 0) > 0) {
      // A branch that ends in a room is CLOSED — rooms grow by exits.
      return;
    }
    const { pieces, lengthMm } = this.previewLeg(source, aimHeadingDeg, aimPitchDeg);
    this.pending = { source, pieces, faceMm: 0, lengthMm };
  }

  get canScoop(): boolean {
    return this.stamina >= SCOOP_STAMINA;
  }

  /**
   * One press of the shovel: one egg leaves the working face. Costs its
   * stamina, advances the face 3 mm, and — when the face reaches the leg's
   * end — commits the leg into the branch tree and clears the pending state,
   * so the very next preview snaps to the new joint.
   */
  scoop(): ScoopOrder | 'no-stamina' | 'no-leg' {
    const leg = this.pending;
    if (!leg) return 'no-leg';
    if (!this.canScoop) return 'no-stamina';
    this.stamina -= SCOOP_STAMINA;

    const start = this.legStart(leg.source);
    const rail = buildRail(leg.pieces, { at: start.at, forward: start.forward });
    const semis = SCOOP_DEEP_MM / 2;
    const at = Math.min(leg.faceMm + semis, rail.lengthMm - semis);
    const f = rail.sample(at, 0);
    const centerMm = f ? { x: f.x, y: f.y, z: f.z } : { ...start.at };
    const along = f ? { x: f.fx, y: f.fy, z: f.fz } : { ...start.forward };

    const next = leg.faceMm + SCOOP_DEEP_MM;
    const legDone = next >= leg.lengthMm;
    if (legDone) this.commitPending();
    else leg.faceMm = next;
    return { centerMm, along, legDone };
  }

  /** Abandon the guide (the scoops already taken stay taken — soil does
   *  not grow back for free). */
  cancelLeg(): void {
    this.pending = null;
  }

  private commitPending(): void {
    const leg = this.pending;
    if (!leg) return;
    if ('extend' in leg.source) {
      const b = this.branches[leg.source.extend];
      if (b) b.pieces = [...b.pieces, ...leg.pieces];
    } else {
      this.branches.push({
        pieces: [...leg.pieces],
        roomMm: null,
        parent: { branch: leg.source.branch, exit: leg.source.exit },
      });
    }
    this.pending = null;
  }

  /* ------------------------------------------------------------- joints */

  /** Make a branch's end a room or a junction. Sets the carve radius the
   *  plan will use, so the joint becomes a real chamber underground. */
  setJointKind(branch: number, kind: JointKind): void {
    const b = this.branches[branch];
    if (!b || b.pieces.length === 0) return;
    this.jointKinds.set(branch, kind);
    b.roomMm = (JUNCTION_KINDS as readonly string[]).includes(kind)
      ? HUB_RADIUS_MM : ROOM_RADIUS_MM;
  }

  /** The exits a joint still offers: its kind's grammar, minus the arrival
   *  and every branch already hanging there. */
  exitsAvailable(branch: number): ExitDir[] {
    const kind = this.jointKinds.get(branch);
    if (!kind) return [];
    const offered = (JUNCTION_KINDS as readonly string[]).includes(kind)
      ? JUNCTION_EXITS[kind as JunctionKind]
      : ROOM_EXIT_DIRS;
    const taken = takenExitsOf(this.branches, branch);
    return offered.filter((e) => !taken.has(e));
  }

  /** Which free exit the camera means, or null for "none of them". */
  pickExit(branch: number, aimHeadingDeg: number, aimPitchDeg: number): ExitDir | null {
    const exits = this.exitsAvailable(branch);
    if (exits.length === 0) return null;
    const start = branchStartOf(this.branches, branch);
    const end = endStateOf(this.branches[branch]?.pieces ?? [], {
      at: start.at, forward: start.forward,
    });
    return bestExitToward(aimHeadingDeg, aimPitchDeg, end.headingDeg, exits);
  }

  /* -------------------------------------------------------------- output */

  /** The whole tree as a NestPlan, anchored at `originMm` in island space.
   *  Edges carry the egg's vertical squash, so the tunnel the plan
   *  regenerates is the tunnel the scoops actually cut. */
  plan(originMm: Vec3Like): NestPlan {
    const plan = branchesToPlan(this.branches, {
      originMm,
      boreRadiusMm: BORE_RADIUS_MM,
      entranceRadiusMm: MIN_ENTRANCE_RADIUS_MM,
    });
    return {
      nodes: plan.nodes,
      edges: plan.edges.map((e) => ({ ...e, squashY: BORE_SQUASH })),
    };
  }

  /** Anything dug yet? An empty builder compiles to an empty plan. */
  get hasTunnels(): boolean {
    return this.branches.some((b) => b.pieces.length > 0);
  }

  /* ------------------------------------------------------------- stamina */

  tick(dt: number): void {
    this.stamina = Math.min(STAMINA_MAX, this.stamina + STAMINA_REGEN * dt);
  }

  /* ---------------------------------------------------------------- save */

  toJSON(): SavedBuilder {
    return {
      v: 1,
      branches: this.branches.map((b) => ({
        pieces: [...b.pieces], roomMm: b.roomMm, parent: b.parent,
      })),
      jointKinds: [...this.jointKinds.entries()],
    };
  }

  static fromJSON(raw: unknown): TunnelBuilder | null {
    const data = raw as SavedBuilder | null;
    if (!data || data.v !== 1 || !Array.isArray(data.branches)) return null;
    const builder = new TunnelBuilder();
    builder.branches = data.branches.map((b) => ({
      pieces: Array.isArray(b.pieces) ? b.pieces : [],
      roomMm: typeof b.roomMm === 'number' ? b.roomMm : null,
      parent: b.parent ?? null,
    }));
    if (builder.branches.length === 0) {
      builder.branches = [{ pieces: [], roomMm: null, parent: null }];
    }
    if (Array.isArray(data.jointKinds)) {
      for (const [i, kind] of data.jointKinds) builder.jointKinds.set(i, kind);
    }
    return builder;
  }
}
