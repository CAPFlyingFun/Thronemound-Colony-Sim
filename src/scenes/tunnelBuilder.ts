/**
 * THE TUNNEL BUILDER — the island's guided dig, as pure state.
 *
 * The player's spec, written down before any of it was code:
 *
 *   1. Find a place to dig; the first piece is automatically the OPENING.
 *   2. Drop into the opening and you are aimed straight down, on your
 *      current heading — a nest starts as a shaft, always.
 *   3. From there a palette of pieces, the way a coaster builder does it:
 *      STRAIGHT, LEFT 90, RIGHT 90, UP 90, DOWN 90, and the splits — a T
 *      that branches two ways at 90°, a Y that forks two at 45°. Plus the
 *      rooms: queen's chamber, nursery, and the rest.
 *   4. Pieces go in AS YOU PLAY. Each one is instant, and each one costs a
 *      bite of stamina, so digging is endless but paced by recovery rather
 *      than by waiting out an animation.
 *
 * Everything here is arithmetic over plain data — no THREE, no scene — in
 * the builder's own millimetre frame, whose origin is the opening. The
 * geometry is `pieceTrack`'s, never re-derived: pieces are `DigPiece`s,
 * joints are branch ends, the compiled nest is `branchesToPlan`. The
 * scene's whole job is to translate this frame into the island, draw the
 * ghost, and carve what this module says.
 */

import {
  buildRail, branchStartOf, endStateOf, exitAimOf, bestExitToward,
  takenExitsOf, branchesToPlan,
  type BranchStart, type ExitDir, type TrackBranch,
} from './pieceTrack';
import { PIECE_LIMITS, clampPiece, type DigPiece } from './digPlan';
import { MIN_ENTRANCE_RADIUS_MM, type NestPlan } from '../nest/nestPlan';
import { type Vec3Like } from './tunnelRail';

/* ------------------------------------------------------------- the numbers */

/**
 * One piece of tunnel, in millimetres — and it is TWO of the format's own
 * pieces, because `PIECE_LIMITS.length` caps a single one at ten. Bends are
 * swept as two halves for the same reason the pipes room sweeps them: a 90°
 * corner turned all at once chews a sphere, not a bend.
 */
export const PIECE_MM = 20;
const HALF_MM = 10;

/** Stamina: a piece costs 40 of 100, recovery refills in a few seconds —
 *  two quick pieces, then a breath. Endless, but never a firehose. */
export const PIECE_STAMINA = 40;
export const STAMINA_MAX = 100;
export const STAMINA_REGEN = 18;

/**
 * THE BORE IS ROUND, and that is what buys the 360° crawl.
 *
 * The spec asks for a tube "as wide as the ant" that she can rotate right
 * around inside, and those two together force a circle: in an oval wider
 * than it is tall she fits on the floor and on the ceiling, and jams on the
 * way past the sides. So the cross-section is a circle of the ant's own
 * half-width, she rides with her back to the axis and her legs on the wall,
 * and rolling around it is simply a change of which wall — geometry the
 * rail has always had, now given a tube it actually works in.
 */
export const BORE_RADIUS_MM = 4.5;

/** Joint radii: a hub just big enough to turn in; a room is a room. */
export const HUB_RADIUS_MM = 9;
export const ROOM_RADIUS_MM = 12;

/** Steeper than this, travel is the invisible spline's job (GRIP); at or
 *  under it, the free walker owns the floor. The player's own number. */
export const STEEP_DEG = 70;

/* --------------------------------------------------------------- the kinds */

/** The pieces on the palette — RCT's own vocabulary, at ninety degrees. */
export type PieceButton = 'straight' | 'left90' | 'right90' | 'up90' | 'down90';

export const PIECE_BUTTONS: readonly PieceButton[] = [
  'straight', 'left90', 'right90', 'up90', 'down90',
];

export const PIECE_LABELS: Record<PieceButton, string> = {
  straight: 'STRAIGHT', left90: '⟵90°', right90: '90°⟶', up90: 'UP 90°', down90: 'DOWN 90°',
};

export type JunctionKind = 'Y' | 'T' | 'X';
export type RoomKind = 'queen' | 'nursery' | 'storage' | 'food';
export type JointKind = JunctionKind | RoomKind;

export const ROOM_KINDS: readonly RoomKind[] = ['queen', 'nursery', 'storage', 'food'];
export const JUNCTION_KINDS: readonly JunctionKind[] = ['Y', 'T', 'X'];

export const ROOM_LABELS: Record<RoomKind, string> = {
  queen: "QUEEN'S", nursery: 'NURSERY', storage: 'STORAGE', food: 'FOOD',
};

/**
 * What each junction offers, relative to arrival — the player's exact spec.
 * A Y forks two ways at 45°. A T branches two at 90°. An X carries you
 * straight through and hands you both sides: three exits, four ways in all
 * counting the tunnel you arrived by. Rooms are hubs the classic way — any
 * of the six axis exits, like the pipes room's balls.
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

/** Where a new piece grows from: a bare branch tip, or a joint's exit. */
export type LegSource =
  | { extend: number }
  | { branch: number; exit: ExitDir };

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

/**
 * Steeper than this and the tube has no heading worth turning.
 *
 * Not a taste call: a plumb run's direction is (0, ±1, 0), `atan2` of its
 * two horizontal components is noise, and `endStateOf` deliberately carries
 * the last heading it had rather than inventing one. So a LEFT laid on a
 * shaft changes nothing at all — measured, first try: the opening sinks a
 * shaft, LEFT 90 turned the line by zero degrees. The palette says so
 * instead of pretending, and UP 90 is how you get a heading back.
 */
export const TURNABLE_PITCH_DEG = 85;

/**
 * The two halves a palette button becomes, given the grade it leaves from.
 *
 * Pitch is ABSOLUTE in this format (see `digPlan`'s conventions) but the
 * BUTTONS are relative, which is the difference between a builder you can
 * use and one you cannot: a nest opens with a plumb shaft, and an absolute
 * UP 90 from there means "straight up", so the only way back to level would
 * be a button that does not exist. Relative, UP 90 from a shaft is exactly
 * the drift you wanted. Each is swept as the halfway grade and then the
 * target, and turns are two 45s, because a 90° corner turned all at once
 * chews a sphere instead of a bend.
 */
export function piecesFor(kind: PieceButton, fromPitchDeg: number): DigPiece[] {
  const pitch = Math.round(fromPitchDeg);
  const make = (p: number, turn: number): DigPiece =>
    clampPiece({ pitch: p, turn, roll: 0, length: HALF_MM });
  const swept = (target: number): DigPiece[] => {
    const to = Math.max(PIECE_LIMITS.pitch.min, Math.min(PIECE_LIMITS.pitch.max, target));
    return [make(Math.round((pitch + to) / 2), 0), make(to, 0)];
  };
  switch (kind) {
    case 'straight':
      return [make(pitch, 0), make(pitch, 0)];
    case 'left90':
      return [make(pitch, 45), make(pitch, 45)];
    case 'right90':
      return [make(pitch, -45), make(pitch, -45)];
    case 'up90':
      return swept(pitch + 90);
    case 'down90':
      return swept(pitch - 90);
    default:
      return [];
  }
}

/** Would this button actually change anything from that grade? A turn on a
 *  plumb run would not, and a palette that lets you tap it is lying. */
export function pieceIsUseful(kind: PieceButton, fromPitchDeg: number): boolean {
  if (kind !== 'left90' && kind !== 'right90') return true;
  return Math.abs(fromPitchDeg) < TURNABLE_PITCH_DEG;
}

export class TunnelBuilder {
  /** Branch 0 is the mainline from the opening. Branches only append —
   *  that is what keeps plain indices stable enough to key joints by. */
  branches: TrackBranch[] = [{ pieces: [], roomMm: null, parent: null }];

  /** Joint kind by BRANCH index — a joint IS a branch's end. */
  readonly jointKinds = new Map<number, JointKind>();

  stamina = STAMINA_MAX;

  /* ----------------------------------------------------------- geometry */

  /** The frame a piece from this source starts in. */
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

  /** The grade a piece from this source would leave at. */
  pitchAt(source: LegSource): number {
    return this.legStart(source).seedPitchDeg;
  }

  /**
   * THE GHOST: exactly what this button would dig, before it is dug. Same
   * pieces `addPiece` would append, so the preview cannot lie about the
   * shape — there is one function that builds them.
   */
  previewPiece(source: LegSource, kind: PieceButton): LegPreview {
    const start = this.legStart(source);
    const pieces = piecesFor(kind, this.pitchAt(source));
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

  get canDig(): boolean {
    return this.stamina >= PIECE_STAMINA;
  }

  /** Whether a source can still take a piece at all — a branch that ends in
   *  a room is CLOSED, and rooms grow by their exits instead. */
  canExtend(source: LegSource): boolean {
    if (!('extend' in source)) return true;
    const b = this.branches[source.extend];
    if (!b) return false;
    return !(b.roomMm !== null && b.pieces.length > 0);
  }

  /**
   * Dig one piece, instantly, for one bite of stamina. Returns the branch
   * it landed on so the scene can follow the growing tip, or a reason it
   * did not happen.
   */
  addPiece(source: LegSource, kind: PieceButton): number | 'no-stamina' | 'closed' | 'no-turn' {
    if (!this.canDig) return 'no-stamina';
    if (!this.canExtend(source)) return 'closed';
    /* Spending stamina on a piece that provably changes nothing is the
     * worst outcome available: the tunnel does not move and the strength
     * is gone anyway. */
    if (!pieceIsUseful(kind, this.pitchAt(source))) return 'no-turn';
    const pieces = piecesFor(kind, this.pitchAt(source));
    if (pieces.length === 0) return 'closed';
    this.stamina -= PIECE_STAMINA;
    if ('extend' in source) {
      const b = this.branches[source.extend];
      if (!b) return 'closed';
      b.pieces = [...b.pieces, ...pieces];
      return source.extend;
    }
    this.branches.push({
      pieces,
      roomMm: null,
      parent: { branch: source.branch, exit: source.exit },
    });
    return this.branches.length - 1;
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

  /** A joint costs a piece's worth of stamina too — it is a room dug, not
   *  a label applied. False when she has not the strength yet. */
  digJoint(branch: number, kind: JointKind): boolean {
    if (!this.canDig) return false;
    const b = this.branches[branch];
    if (!b || b.pieces.length === 0) return false;
    this.stamina -= PIECE_STAMINA;
    this.setJointKind(branch, kind);
    return true;
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

  /** The whole tree as a NestPlan, anchored at `originMm` in island space. */
  plan(originMm: Vec3Like): NestPlan {
    return branchesToPlan(this.branches, {
      originMm,
      boreRadiusMm: BORE_RADIUS_MM,
      entranceRadiusMm: MIN_ENTRANCE_RADIUS_MM,
    });
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
