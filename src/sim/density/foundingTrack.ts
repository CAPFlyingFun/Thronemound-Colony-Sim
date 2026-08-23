/**
 * THE QUEEN'S FOUNDING NEST, AUTHORED AS TRACK PIECES — and then dug.
 *
 * Joshua, 2026-08-23: "How about the AI using like the rail system where it
 * creates random preset tunnels/pipes/tubing. Think plumbing with starting
 * with a straight down piece that's 6x6x10mm, but it still digs the dirt over
 * time."
 *
 * ## Why this replaces what was there
 *
 * The old digger had no idea what it was building. Each bore was seated on
 * whatever soil her aim ray happened to meet, so the tunnel's shape was an
 * accident of where she was standing, and every question that mattered had to
 * be answered by searching: where does the tunnel go, where can she stand to
 * work it, is the next bite continuous with the last. Three phases of work
 * went into answering those by search and the honest result was two bores in
 * two minutes.
 *
 * A track answers all three by construction. The centreline is known before a
 * grain of soil moves, so the next work face is a point on it, a place to
 * stand is a point on it BEHIND the face — necessarily already excavated —
 * and continuity is not a property to be measured but the definition of a
 * curve.
 *
 * ## Nothing here is new machinery
 *
 * `digPlan`, `pieceTrack` and `tunnelRail` already build exactly this: a
 * tunnel authored as pieces appended to the end of the last one, with real
 * vertical supported (`PIECE_LIMITS.pitch` is +-90 and the rail carries the
 * heading through a plumb run as integrator state). They were written for the
 * player-facing builder. This module only chooses the pieces an ant would
 * choose, and the digger rides the same rail the builder makes.
 *
 * Reusing them is the point. `CLAUDE.md`: do not duplicate a mechanic in two
 * competing systems — and the version this replaces was already the second
 * implementation of "where does a tunnel go".
 */

import { PIECE_LIMITS, clampPiece, type DigPiece } from '../../scenes/digPlan';
import { railFromPlan, type TunnelRail, type Vec3Like } from '../../scenes/tunnelRail';
import { DIG_RATE_MM3_S } from '../../scenes/islandTuning';
import type { BodyRail, RailFrameOut } from '../AntBody';
import { MM_PER_UNIT, boreRadiusMm, type Caste } from './casteDig';

/**
 * THE FIRST PIECE IS A PLUMB DROP OF TEN MILLIMETRES.
 *
 * Straight down, the length the palette's longest piece already offers
 * (`PIECE_LENGTHS_MM` ends at 10), at the caste's own bore — six millimetres
 * across for a queen. That is Joshua's "straight down piece that's 6x6x10mm"
 * exactly, and it is also what a founding queen does: a plumb entrance shaft
 * before anything else.
 *
 * It is a piece rather than a special case so that everything below it — the
 * carve, the rail, the ride — treats it like any other.
 */
export const ENTRANCE_DROP: DigPiece = {
  pitch: -90, turn: 0, roll: 0, length: 10,
};

/**
 * How far the shaft may lean away from plumb per piece after the drop, in
 * degrees, and how long a piece runs.
 *
 * Held to the palette's own steps so a generated track is one a player could
 * have built by tapping the same buttons — which is the test of whether the
 * two systems really are one system.
 */
const LEAN_STEPS = [0, 15, 15, 30] as const;
const RUN_LENGTHS_MM = [6, 10] as const;

/** Pick one, seeded. */
function oneOf<T>(items: readonly T[], rand: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(rand() * items.length))]!;
}

/**
 * A founding track: the plumb drop, then a few pieces easing off vertical.
 *
 * DELIBERATELY SHORT AND DELIBERATELY EASING. A shaft that stays at -90 for
 * its whole length is a well she cannot work from below, and one that levels
 * out immediately is a scrape. The pitch walks back toward horizontal in the
 * palette's own 15 degree steps, which is what turns a drop into a nest.
 */
export function foundingTrack(rand: () => number, pieces = 5): DigPiece[] {
  return [clampPiece({ ...ENTRANCE_DROP }),
    ...continueTrack(rand, ENTRANCE_DROP.pitch, pieces - 1)];
}

/**
 * MORE OF THE SAME NEST, carrying on from the grade it has reached.
 *
 * Separate from `foundingTrack` because that one always opens with the plumb
 * drop, and appending a plumb drop to the middle of a tunnel puts a ninety
 * degree corner in it. A nest has one entrance.
 *
 * The pitch walks toward the level in the palette's own 15 degree steps and
 * never past it — a nest goes down — so a long tunnel gradually flattens into
 * galleries the way a real one does, without any of that being a special
 * case here.
 */
export function continueTrack(
  rand: () => number, fromPitch: number, pieces: number,
): DigPiece[] {
  const out: DigPiece[] = [];
  let pitch = fromPitch;
  for (let i = 0; i < pieces; i += 1) {
    pitch = Math.min(-15, pitch + oneOf(LEAN_STEPS, rand));
    const turn = (Math.floor(rand() * 3) - 1) * PIECE_LIMITS.turn.step;
    out.push(clampPiece({
      pitch, turn, roll: 0, length: oneOf(RUN_LENGTHS_MM, rand),
    }));
  }
  return out;
}

/**
 * HOW FAST A CASTE EATS ALONG HER OWN BORE, in millimetres of tunnel a
 * second.
 *
 * Derived from the volumetric rate the island digs at rather than restated,
 * so a tunnel cut by the track takes exactly as long as the same volume cut
 * by a bore. For a queen: 30 mm3/s through a 6 mm bore is 1.06 mm/s.
 */
export function advanceRateMmS(caste: Caste): number {
  const r = boreRadiusMm(caste);
  return DIG_RATE_MM3_S / (Math.PI * r * r);
}

/** A point on the rail, in world units, with the frame that goes with it. */
export interface RailPose {
  at: { x: number; y: number; z: number };
  /** Which way the track runs here — her working aim. */
  forward: { x: number; y: number; z: number };
  /** How far along the rail this is, in millimetres. */
  s: number;
}

/**
 * THE SHAFT SHE IS SINKING: a planned centreline, and how much of it is air.
 *
 * The rail is built once in MILLIMETRES about a start point, because that is
 * the unit the pieces are written in and `railFromPlan` expects; everything
 * handed back is converted to world units at the edge. Three unit systems
 * have caused real bugs in this project, so the conversion lives here and
 * nowhere else.
 */
export class ShaftTrack implements BodyRail {
  /** The plan, which may grow. See `extend`. */
  pieces: readonly DigPiece[] = [];

  private rail: TunnelRail;

  /** Kept so the rail can be rebuilt when the plan grows. See `extend`. */
  private readonly start: { at: Vec3Like; forward: Vec3Like };

  /** How far along the centreline has actually been excavated, in mm. */
  private cutMm = 0;

  constructor(
    readonly caste: Caste,
    pieces: readonly DigPiece[],
    /** The mouth, in WORLD UNITS. */
    start: { x: number; y: number; z: number },
    /** Which way the first piece runs, before its own pitch is applied. */
    forward: { x: number; y: number; z: number },
  ) {
    this.radiusWu = boreRadiusMm(caste) / MM_PER_UNIT;
    this.pieces = pieces;
    this.start = {
      at: { x: start.x * MM_PER_UNIT, y: start.y * MM_PER_UNIT, z: start.z * MM_PER_UNIT },
      forward,
    };
    this.rail = railFromPlan(this.pieces, this.start);
  }

  /**
   * ADD MORE NEST TO THE END OF THE PLAN.
   *
   * The founding track is a handful of pieces and she digs the lot, at which
   * point the old code simply stopped — reported from the device as "it dug
   * for a little bit and stopped", which was the plan being finished rather
   * than anything breaking. A colony does not stop at one shaft.
   *
   * The rail is rebuilt from the full list rather than spliced, because
   * `railFromPlan` walks the pieces in order: the geometry of the prefix is
   * identical whatever is appended after it, so the tunnel she has already
   * dug does not move. `cutMm` is untouched for the same reason.
   */
  extend(more: readonly DigPiece[]): void {
    if (more.length === 0) return;
    this.pieces = [...this.pieces, ...more];
    this.rail = railFromPlan(this.pieces, this.start);
  }

  /** The whole planned length, in millimetres. */
  get plannedMm(): number { return this.rail.lengthMm; }

  /** How much of it is dug, in millimetres. */
  get dugMm(): number { return this.cutMm; }

  get done(): boolean { return this.cutMm >= this.rail.lengthMm - 1e-6; }

  /** Where the work face is now. */
  face(): RailPose | null { return this.poseAt(this.cutMm); }

  /**
   * Where she should stand to work that face — `backMm` along the rail
   * BEHIND it, which is excavated by definition because the cut has passed
   * it. That is the whole reason a track beats a search: the answer is not
   * looked for, it is a coordinate.
   */
  station(backMm: number): RailPose | null {
    return this.poseAt(Math.max(0, this.cutMm - backMm));
  }

  /**
   * Advance the cut and hand back the centreline points to carve — spaced
   * finely enough that consecutive spheres deeply overlap, the same rule
   * `DigJob` uses and for the same reason.
   *
   * Returns an empty list when nothing new is exposed, which is a frame
   * between beats rather than a fault.
   */
  advance(mm: number, radiusWu: number): Array<{ x: number; y: number; z: number }> {
    if (this.done || !(mm > 0)) return [];
    const from = this.cutMm;
    const to = Math.min(this.rail.lengthMm, from + mm);
    const stepMm = Math.max(0.05, radiusWu * MM_PER_UNIT * 0.5);
    const out: Array<{ x: number; y: number; z: number }> = [];
    /* Inclusive of the new face, exclusive of the old one — the old face was
     * carved by the beat that reached it. */
    for (let s = from + stepMm; s < to; s += stepMm) {
      const p = this.poseAt(s);
      if (p) out.push(p.at);
    }
    const end = this.poseAt(to);
    if (end) out.push(end.at);
    /* The very first beat opens the mouth too, or the shaft starts a step
     * below the surface with a lid on it. */
    if (from === 0) {
      const mouth = this.poseAt(0);
      if (mouth) out.unshift(mouth.at);
    }
    this.cutMm = to;
    return out;
  }

  /* ---------------------------------------------------- BodyRail, in world
   * units. The rail itself is millimetres because that is what the pieces
   * are written in; this is the one place the two meet. */

  /** How far she may ride, world units — only what is actually DUG. */
  get lengthWu(): number { return this.cutMm / MM_PER_UNIT; }

  radiusWu = 0;

  frameAt(sWu: number, into: RailFrameOut): boolean {
    const f = this.rail.sample(sWu * MM_PER_UNIT);
    if (!f) return false;
    into.at.set(f.x / MM_PER_UNIT, f.y / MM_PER_UNIT, f.z / MM_PER_UNIT);
    into.up.set(f.ux, f.uy, f.uz);
    into.forward.set(f.fx, f.fy, f.fz);
    return true;
  }

  nearestTo(x: number, y: number, z: number): { sWu: number; distWu: number } | null {
    const near = this.rail.nearest({
      x: x * MM_PER_UNIT, y: y * MM_PER_UNIT, z: z * MM_PER_UNIT,
    });
    if (!near) return null;
    return { sWu: near.s / MM_PER_UNIT, distWu: near.distMm / MM_PER_UNIT };
  }

  private poseAt(s: number): RailPose | null {
    const f = this.rail.sample(s);
    if (!f) return null;
    return {
      at: { x: f.x / MM_PER_UNIT, y: f.y / MM_PER_UNIT, z: f.z / MM_PER_UNIT },
      forward: { x: f.fx, y: f.fy, z: f.fz },
      s,
    };
  }
}
