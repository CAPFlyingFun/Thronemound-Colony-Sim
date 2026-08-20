/**
 * CLAUSTRAL FOUNDING, decided by the ant rather than by the player.
 *
 * A newly mated fire ant queen lands, sheds her wings, digs herself a sealed
 * chamber and never comes out again — she lives off her own metabolised flight
 * muscles until the first workers hatch. It is the opening act of every
 * colony, and here it is the first thing in the game that happens entirely
 * without the keeper.
 *
 * This file is the AI end of the founding chain and NOTHING ELSE:
 *
 *     ANT AI          decides what she wants      THIS FILE
 *     DIG SYSTEM      validates the request       `excavation`
 *     VOXEL TERRAIN   modifies the soil           `VoxelWorld.dig`
 *     MOVEMENT        moves her                   `AntBody`
 *     IK / ANIMATION  poses her                   `LegDrive`
 *
 * It returns an intent — walk this much, turn this much, and I would like
 * that cell gone — and it may not do any of those things itself. The board's
 * card underlines the important half: "Digging must NEVER directly drive ant
 * locomotion." So there is no teleport into a fresh tunnel here, no snapping
 * her down a shaft, no advancing her by the length of what she removed. She
 * digs a space and then she WALKS into it on her own six legs, and if she
 * cannot walk into it then the tunnel is the wrong shape and that is a real
 * bug rather than something to paper over with a position write.
 *
 * ## Why she digs a ramp and not a shaft
 *
 * A real founding queen sinks something close to vertical and gets down it by
 * bracing on the walls. Wall-walking is a later milestone and an honest one —
 * `AntBody` says in as many words that there is no climbing in it yet. Faking
 * it would mean moving her down the hole by hand, which is exactly the rule
 * above.
 *
 * So she digs a DESCENDING RAMP: mostly downward, at a grade her legs can
 * actually walk. Card 01 asks for "continues mostly downward to about 30 mm"
 * and explicitly says not to over-engineer nest architecture yet, and a ramp
 * satisfies the flow it describes — enters the soil, progresses through a
 * continuous tunnel, changes direction, ends in a usable chamber — using only
 * movement that already exists and is already proven. When she can climb, the
 * grade is one constant.
 *
 * ## One cell at a time, on purpose
 *
 * The corridor is wider than a cell, so every step of tunnel is a handful of
 * cells. She takes them ONE AT A TIME, nearest first, because that is what
 * makes Ant Scout's round bar mean anything: a bar over a face is a cell
 * coming out, and a bar over six cells at once is a loading spinner.
 */

import type { Cell } from './excavation';
import { FILL_EPSILON } from './dugSoil';

/** What the brain may ask about the world. It may not change it. */
export interface FoundingSenses {
  /**
   * How full this cell is, 0..1. Outside the world reads as FULL — a brain
   * that took the void for open space would drive its ramp out through the
   * end of the array and then stand there wanting cells nothing can give it.
   */
  fillAt(x: number, y: number, z: number): number;
  /** The top of the floor under a column, looked for from a height. */
  floorUnder(x: number, z: number, from: number): number | null;
}

/**
 * A cell she wants worked, and how much of it she wants LEFT.
 *
 * The second number is the whole reason the tunnel is walkable. A corridor's
 * floor is a sloping line, and the cells it passes through are meant to end
 * up part full — cut off at the line — rather than removed. Asking for cells
 * and not for shapes is what produced a five-millimetre staircase under a
 * three-millimetre ant.
 */
export interface DigWish {
  cell: Cell;
  /** 0 for "gone", a fraction for "cut down to here". */
  leave: number;
}

/** Where she is, in voxels, and which way she faces. */
export interface FoundingPose {
  x: number;
  y: number;
  z: number;
  heading: number;
}

/** What she wants this frame. Somebody else does all of it. */
export interface FoundingIntent {
  /** Forward, -1..1. */
  walk: number;
  /** Yaw, -1..1. */
  turn: number;
  /** The cell she would like worked, and how much to leave. */
  digAt: Cell | null;
  /** How full to leave it, 0..1. */
  leave: number;
}

export type FoundingState =
  /** Walking the surface, looking for somewhere to start. */
  | 'seeking'
  /** Cutting the ramp down. */
  | 'sinking'
  /** Coming round at the bottom, before the chamber. */
  | 'turning'
  /** Hollowing the first chamber out. */
  | 'chambering'
  /** In, and staying in. */
  | 'sealed';

/**
 * How long she wanders before committing to a site, in seconds.
 *
 * A real queen tests the soil, and a queen who starts digging in the frame
 * she is placed reads as a scripted animation rather than a decision. This is
 * long enough to watch her choose and short enough not to be waiting.
 */
export const SEEK_SECONDS = 6;

/**
 * How deep the founding goes, in millimetres below the grade at her chosen
 * site. Card 01: "about 30 mm".
 */
export const FOUNDING_DEPTH_MM = 30;

/**
 * The ramp's grade — voxels down per voxel forward.
 *
 * MEASURED, AND IT IS BOUNDED BY HER FRONT LEGS. A dug floor is made of
 * cells, so a ramp is a run of level treads one voxel long and `RAMP_GRADE`
 * voxels apart — and her front foot has to stand on the tread ahead of the
 * one her body is over. That foot's home sits 0.062 voxels above her origin
 * and it has 0.224 of spare downward reach (`REACH_DOWN_MM`, 1.12 mm), so it
 * can touch 0.162 voxels below her body and no further. The tread it is
 * reaching for is one grade down.
 *
 * Walking the whole founding at each grade, feet of six while she digs:
 *
 *     grade   planted   groping
 *      0.30    3.44      2.50
 *      0.18    3.90      2.01
 *      0.12    4.33      1.55
 *      0.09    4.54      1.32
 *
 * 0.09 is about 5 degrees, which is shallower than a real founding shaft by
 * a long way — a fire ant queen goes nearly straight down and grips the walls
 * to do it. She will too, when there is wall-walking. This is the steepest
 * ramp her legs can currently keep their feet on, and the honest note is that
 * even here it is not zero: see the head of `probe-founding.mjs`.
 *
 * THE FLOOR IT DESCRIBES IS A CONE ROUND THE ENTRANCE, not a slope in front
 * of her nose — see `floorAt`.
 */
export const RAMP_GRADE = 0.11;

/**
 * AND SHE CURVES AS SHE DIGS, so the ramp is a shallow spiral.
 *
 * The grade above is bounded by her front legs and comes out very shallow —
 * six voxels of depth need something like fifty of tunnel. The formicarium is
 * ninety-six voxels across, so a straight ramp from the middle of the tray
 * hits the glass: measured, she reached 21 mm down and 92 of 96 voxels out
 * with nowhere left to go.
 *
 * Bearing round solves it without touching the grade, because the floor is
 * measured along her PATH rather than across the tray. A gentle constant turn
 * while she walks gives a circle of roughly a dozen voxels' radius, which
 * fits in the tank many times over and drops about 45 mm in a full loop — far
 * more than the tunnel is tall, so the spiral never eats its own roof.
 *
 * It also happens to be what a nest looks like.
 *
 * Applied only while she is WALKING. A turn while she is stood at the face
 * would swing the corridor away from the hole she is chewing.
 */
export const SPIRAL_TURN = 0.075;

/**
 * The bore's radius in voxels, and how far ahead of her the working face
 * sits.
 *
 * 1.25 voxels is a 12.5 mm tunnel: she is about 12 mm long and rather less
 * across, so this is a corridor she fits in with her legs out rather than one
 * she has to be poured into. Tunnels a founding queen digs really are close
 * to her own body width, but a tunnel that is exactly her width is one where
 * every leg is against a wall, and the leg solver has nothing to stand on.
 */
export const BORE_HALF_WIDTH = 1.5;
export const FACE_AHEAD = 2.4;

/**
 * And how close in the working face starts.
 *
 * NOT ZERO, and this is the difference between a ramp and a pit. The first
 * cut let the corridor start at her own body, so the nearest solid cell was
 * always the one directly beneath her: she chewed straight down, sank into
 * the hole as her floor fell away, and never took a step. Measured — she
 * reached 40 mm without her x or z moving a millimetre.
 *
 * That is not a tunnel, and worse, it is descent by terrain removal rather
 * than by walking, which is the exact thing card 01 forbids. Starting the
 * face ahead of her feet means the ground she is standing on stays, and the
 * only way down is to walk onto what she has cut.
 */
export const FACE_NEAR = 0.9;

/**
 * The corridor's headroom, in voxels above its floor.
 *
 * A FLAT FLOOR AND A CEILING, rather than the round bore a real tunnel is.
 * `carve.bore` cuts a cylinder and a cylinder's floor is a trough: her feet
 * land on the curve either side of the axis and slide off it. Measured in
 * the round version, 2.9 of 6 feet were groping the whole way down.
 *
 * She will grip a round tunnel's walls when there is wall-walking. Until
 * then the tunnel is the shape her legs can use, which is a corridor.
 */
export const BORE_HEADROOM = 1.7;

/** How far below the corridor's floor line a cell may be and still go. */
export const FLOOR_SLACK = 0.15;

/**
 * SHE DOES NOT STEP UNTIL THE FACE IS FINISHED.
 *
 * The first cut let her walk whenever the nearest 1.4 voxels happened to be
 * clear, and she outran her own excavation: she was on top of a corridor that
 * had been shaved in one place and not another, her feet were over cells that
 * had not been cut yet, and the round bar never filled because the cell it
 * was measuring kept going out of reach. Measured — 6 of 6 feet groping for
 * most of the descent and not one cell finished in a minute.
 *
 * So the rule is the simple one: while ANY of the corridor within reach still
 * has soil in it she stands and digs, and she walks only into a length of
 * tunnel that is entirely cut. Dig, step, dig, step — which is both what an
 * ant does and what makes the bar mean something.
 */
export const DIG_BEFORE_STEP = true;

/** How far round she comes at the bottom, in radians. */
export const TURN_RADIANS = 1.9;

/**
 * The chamber: its radius in voxels, and how many air cells inside that ball
 * count as hollow enough to stop.
 *
 * A radius-2.5 ball holds about 65 cells. Two thirds of them is a room rather
 * than a wide spot in the tunnel, which is the distinction the old
 * direct-control founding gate was also drawing when it demanded 14 of 33.
 */
export const CHAMBER_RADIUS = 2.5;
export const CHAMBER_AIR = 44;

/**
 * The founding brain. One queen, one nest, no player.
 *
 * Seeded randomness is passed in rather than taken from `Math.random`, for
 * the same reason the rest of this scene is seeded: a founding that differs
 * every reload cannot be compared against yesterday's run.
 */
export class AntFounding {
  state: FoundingState = 'seeking';

  /** Seconds spent in the current state. */
  private held = 0;

  /** The grade at her chosen site — depth is measured from this. */
  private siteGrade = 0;

  /** Where she committed, so the chamber knows where the nest is. */
  private site: { x: number; z: number } | null = null;

  /**
   * WHERE THE TUNNEL FLOOR IS, at any point in the world — a cone centred on
   * the entrance, falling away at `RAMP_GRADE`.
   *
   * MEASURED ALONG HER PATH, not from her body and not from the entrance.
   *
   * Three versions, and the reasons are worth keeping.
   *
   * FROM HER BODY was the first, and wrong: the line started at her feet and
   * fell away ahead of her, so every cut was measured from wherever she
   * happened to be standing, and she re-cut overlapping bands of the same
   * tunnel from a dozen different origins. The floor came out rippled by a
   * few tenths of a voxel — one or two millimetres, against 1.08 mm of spare
   * leg — and her feet fell into the troughs. Measured: standing STILL to
   * dig, 3.37 of 6 feet down where the same ant on the surface has all six.
   *
   * A CONE ROUND THE ENTRANCE fixed that, because a function of world
   * position cannot disagree with itself. But a cone can only descend by
   * going further out, and the tank is 96 voxels across: at the shallow grade
   * her legs need, she walked into the glass 21 mm down with nowhere to go.
   *
   * DISTANCE ALONG HER PATH is the one that satisfies both. It is still
   * single-valued and still cannot disagree with itself — a cell is cut once,
   * at the depth the path had reached — but it does not care about the SHAPE
   * of the path, so she can spiral gently and descend as far as she likes
   * inside a small tank. See `SPIRAL_TURN`.
   */
  private floorAt(along: number): number {
    return this.siteGrade - RAMP_GRADE * (this.travelled + along);
  }

  /** How far she has walked from the entrance, along her own path. */
  private travelled = 0;

  /** Her last position, for accumulating how far she has walked. */
  private wasAt: { x: number; z: number } | null = null;

  /** The mouth of the nest, in world voxels. */
  entrance: { x: number; y: number; z: number } | null = null;

  /** Her heading when she started turning, so the turn can be measured. */
  private turnFrom = 0;

  /** How far she has come round, in radians, accumulated. */
  private turned = 0;

  /** Where the chamber is being hollowed, once she has stopped. */
  private chamberAt: { x: number; y: number; z: number } | null = null;

  /**
   * THE CELL SHE IS CURRENTLY ON, held until it is finished.
   *
   * An ant works one spot until it is gone, and so must this — but the
   * stickiness is load-bearing for a duller reason than realism. The corridor
   * is re-derived from her pose every frame, and her pose moves a hair every
   * frame even when she is standing still, because the belly seat is chasing
   * the ground. That reorders cells whose distance along her heading differs
   * in the fourth decimal, so "the nearest cell" flipped between two
   * neighbours several times a second. Every flip is a fresh `aim`, and a
   * fresh aim throws the progress away: measured, the round bar wandered
   * between 0 and 0.86 for a minute and not one cell was ever finished.
   */
  private working: DigWish | null = null;

  constructor(private readonly rand: () => number = () => 0.5) {}

  /** Depth below the grade at her chosen site, in millimetres. */
  depthMm(pose: FoundingPose, voxelMm = 5): number {
    if (!this.site) return 0;
    return (this.siteGrade - pose.y) * voxelMm;
  }

  /** Is the founding finished? */
  get founded(): boolean {
    return this.state === 'sealed';
  }

  /** Where she settled, once she has. */
  get den(): { x: number; y: number; z: number } | null {
    return this.chamberAt;
  }

  step(dt: number, pose: FoundingPose, senses: FoundingSenses): FoundingIntent {
    this.held += dt;
    switch (this.state) {
      case 'seeking': return this.seek(pose, senses);
      case 'sinking': return this.sink(pose, senses);
      case 'turning': return this.turn(dt, pose);
      case 'chambering': return this.chamber(pose, senses);
      default: return STILL;
    }
  }

  private enter(state: FoundingState): void {
    this.state = state;
    this.held = 0;
    this.working = null;
  }

  /**
   * Walking the surface until she commits.
   *
   * She wanders straight with a slow drift rather than using the stroller's
   * full state machine: this is a queen with a job to do, not an ant on a
   * walk, and the difference should be visible before she digs anything.
   */
  private seek(pose: FoundingPose, senses: FoundingSenses): FoundingIntent {
    if (this.held >= SEEK_SECONDS) {
      const grade = senses.floorUnder(pose.x, pose.z, pose.y + 2);
      /* No floor under her is not a site. Keep walking and ask again. */
      if (grade !== null) {
        this.site = { x: pose.x, z: pose.z };
        this.siteGrade = grade;
        this.entrance = { x: pose.x, y: grade, z: pose.z };
        this.enter('sinking');
        return STILL;
      }
      this.held = SEEK_SECONDS / 2;
    }
    return { walk: 1, turn: (this.rand() - 0.5) * 0.25, digAt: null, leave: 0 };
  }

  /**
   * THE RAMP. Chew the nearest solid cell in the corridor ahead and below;
   * when the near part of it is clear, walk into what she has made.
   */
  private sink(pose: FoundingPose, senses: FoundingSenses): FoundingIntent {
    /*
     * HOW FAR SHE HAS COME, accumulated from her own movement — which is the
     * only honest way to measure it, because the walker owns her position and
     * this file may not.
     */
    if (this.wasAt) {
      this.travelled += Math.hypot(pose.x - this.wasAt.x, pose.z - this.wasAt.z);
    }
    this.wasAt = { x: pose.x, z: pose.z };

    if (this.depthMm(pose) >= FOUNDING_DEPTH_MM) {
      this.turnFrom = pose.heading;
      this.turned = 0;
      this.enter('turning');
      return STILL;
    }
    const face = this.faceCells(pose, senses);
    if (face.length === 0) {
      /* Nothing left to work in reach — the way ahead is open, so take it,
       * bearing round as she goes. See `SPIRAL_TURN`. */
      return { walk: 1, turn: SPIRAL_TURN, digAt: null, leave: 0 };
    }
    /* Soil left in the corridor at all means she stands and works it. */
    const wish = this.hold(face, senses);
    return { walk: 0, turn: 0, digAt: wish.cell, leave: wish.leave };
  }

  /**
   * Keep working the cell she is already on, if it is still worth working and
   * still in the corridor. Otherwise take the nearest.
   */
  private hold(face: DigWish[], senses: FoundingSenses): DigWish {
    const held = this.working;
    if (held) {
      const still = face.find((w) => (
        w.cell[0] === held.cell[0]
        && w.cell[1] === held.cell[1]
        && w.cell[2] === held.cell[2]
      ));
      /*
       * Kept at its ORIGINAL target, not the one this frame's geometry would
       * give it. Re-deriving `leave` as she settles would move the goalposts
       * under a cell that is half chewed, and the excavator would measure its
       * bar against a span that keeps changing.
       */
      if (still && senses.fillAt(...held.cell) > held.leave + FILL_EPSILON) {
        return held;
      }
    }
    this.working = face[0]!;
    return this.working;
  }

  /** Coming round at the bottom of the ramp. Card 01: "turns/branches". */
  private turn(dt: number, pose: FoundingPose): FoundingIntent {
    this.turned = Math.abs(wrap(pose.heading - this.turnFrom));
    if (this.turned >= TURN_RADIANS || this.held > 12) {
      this.chamberAt = { x: pose.x, y: pose.y, z: pose.z };
      this.enter('chambering');
      return STILL;
    }
    return { walk: 0, turn: 1, digAt: null, leave: 0 };
  }

  /**
   * Hollowing the first chamber: the same nearest-first rule, but around a
   * point rather than along an axis.
   *
   * SHE STANDS STILL FOR IT. A chamber is dug from inside by an animal
   * turning on the spot, and letting her walk while hollowing produced a
   * wandering blob rather than a room.
   */
  private chamber(pose: FoundingPose, senses: FoundingSenses): FoundingIntent {
    const at = this.chamberAt ?? { x: pose.x, y: pose.y, z: pose.z };
    if (countAir(at, senses) >= CHAMBER_AIR) {
      this.enter('sealed');
      return STILL;
    }
    const cell = nearestSolid(at, senses);
    /*
     * A chamber that cannot be finished — she has hit stone, or the tank
     * floor — is finished anyway. Standing in a half-room chewing at
     * bedrock forever is worse than a small den.
     */
    if (!cell) { this.enter('sealed'); return STILL; }
    return { walk: 0, turn: 0.12, digAt: cell, leave: 0 };
  }

  /**
   * The cells of the corridor ahead of her, solid ones only, nearest first.
   *
   * The axis runs from her body out along her heading, descending at
   * `RAMP_GRADE`. Cells are gathered in a box around it and kept if they are
   * within `BORE_RADIUS` of the segment — the same shape `carve.bore` cuts,
   * evaluated on the lattice instead of on a density field.
   */
  private faceCells(pose: FoundingPose, senses: FoundingSenses): DigWish[] {
    const fx = Math.sin(pose.heading);
    const fz = Math.cos(pose.heading);

    const found: Array<{ cell: Cell; leave: number; along: number }> = [];
    const reach = FACE_AHEAD + BORE_HALF_WIDTH;
    const x0 = Math.floor(pose.x - reach);
    const x1 = Math.ceil(pose.x + reach);
    /* Wide enough to hold the floor anywhere in the corridor plus its
     * headroom — the cone falls away across the reach, so the window is
     * taken from the far end of it. */
    const y0 = Math.floor(this.floorAt(FACE_AHEAD) - 1);
    const y1 = Math.ceil(this.floorAt(0) + BORE_HEADROOM + 1);
    const z0 = Math.floor(pose.z - reach);
    const z1 = Math.ceil(pose.z + reach);
    for (let y = y0; y <= y1; y += 1) {
      for (let z = z0; z <= z1; z += 1) {
        for (let x = x0; x <= x1; x += 1) {
          const fill = senses.fillAt(x, y, z);
          if (fill <= FILL_EPSILON) continue;
          /* Cell centres, so a cell is judged by where its middle is. */
          const px = x + 0.5 - pose.x;
          const py = y + 0.5 - pose.y;
          const pz = z + 0.5 - pose.z;
          /*
           * ALONG is measured on the HORIZONTAL only, and the floor line is a
           * function of it. Splitting the corridor into "how far forward" and
           * "how high above the sloping floor" is what makes it a flat-floored
           * ramp instead of a tilted cylinder — the descent lives entirely in
           * where the floor sits, and the cross-section stays upright.
           */
          const along = px * fx + pz * fz;
          if (along < FACE_NEAR || along > FACE_AHEAD) continue;
          const lateral = Math.hypot(px - fx * along, pz - fz * along);
          if (lateral > BORE_HALF_WIDTH) continue;
          /*
           * HOW MUCH OF THIS CELL IS BELOW THE FLOOR — that much stays.
           *
           * The floor is read at the CELL's own centre, in world coordinates,
           * and the cell spans `y` to `y + 1`. A cell entirely under the
           * floor is untouched, one entirely above it goes, and one the
           * surface passes through is cut off at it. That last case is what
           * turns a lattice into a slope.
           */
          const floor = this.floorAt(along);
          if (y > floor + BORE_HEADROOM) continue;
          const leave = Math.max(0, Math.min(1, floor - y));
          if (fill <= leave + FILL_EPSILON) continue;
          if (!reachable(x, y, z, senses)) continue;
          found.push({ cell: [x, y, z], leave, along });
        }
      }
    }
    /*
     * NEAREST FIRST, AND THEN FROM THE TOP DOWN.
     *
     * Ties used to break toward the floor of the bore, on the reasoning that
     * the ramp should exist as early as possible. That reasoning was wrong
     * about the soil: into a virgin face, the only cell with air against it is
     * the TOP one — everything under it is buried on all six sides. She asked
     * for the deepest cell of the corridor, the dig system refused it as
     * unreachable, and she stood at the mouth of her own nest site for a
     * minute wanting a cell nobody could give her. Measured: 0 cells dug.
     *
     * Taking the roof off first is also how you actually excavate into a
     * bank, and each cell removed exposes the one beneath it.
     */
    found.sort((a, b) => (a.along - b.along) || (b.cell[1] - a.cell[1]));
    return found.map((f) => ({ cell: f.cell, leave: f.leave }));
  }
}

/**
 * Can she get at this cell at all — is there a GAP against any of its faces?
 *
 * Not-full rather than empty. A cell beside one that has been cut down to a
 * third has a third of a cell of open space against its face, and that is
 * somewhere to put her mandibles. Asked as "entirely empty", the rule refused
 * every cell of a tunnel whose walls were all part-dug.
 *
 * The dig system asks the same question and will refuse a cell that fails it,
 * which is deliberate belt and braces: that refusal is the guarantee, and
 * this is the brain not wasting its turn asking for the impossible. Without
 * it she offers one unreachable cell a frame forever, because a brain that
 * only proposes its single best candidate never discovers the second.
 */
function reachable(
  x: number, y: number, z: number, senses: FoundingSenses,
): boolean {
  const gap = 1 - FILL_EPSILON;
  return senses.fillAt(x + 1, y, z) < gap
    || senses.fillAt(x - 1, y, z) < gap
    || senses.fillAt(x, y + 1, z) < gap
    || senses.fillAt(x, y - 1, z) < gap
    || senses.fillAt(x, y, z + 1) < gap
    || senses.fillAt(x, y, z - 1) < gap;
}

/**
 * THE CHAMBER IS A DOME, NOT A BALL — it keeps its floor.
 *
 * Hollowing a sphere around her digs the ground out from under her as well as
 * the roof off over her, and she ends up standing in the middle of a bubble
 * with nothing to put her feet on. Measured on the ball version: 5 of 6 feet
 * groping for most of the hollowing. A room has a floor, so the cells at and
 * below her own are left alone and only what is above her comes out.
 *
 * `at.y` is her body origin, which the belly seat puts a whisker above the
 * floor, so "at or below her" is the cell she is standing on and everything
 * under it.
 */
function domeCells(
  at: { x: number; y: number; z: number },
  visit: (dx: number, dy: number, dz: number) => void,
): void {
  const r = Math.ceil(CHAMBER_RADIUS);
  const r2 = CHAMBER_RADIUS * CHAMBER_RADIUS;
  for (let dy = 0; dy <= r; dy += 1) {
    for (let dz = -r; dz <= r; dz += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        visit(dx, dy, dz);
      }
    }
  }
}

/** Open cells inside the chamber dome. */
function countAir(
  at: { x: number; y: number; z: number }, senses: FoundingSenses,
): number {
  let air = 0;
  domeCells(at, (dx, dy, dz) => {
    const fill = senses.fillAt(
      Math.floor(at.x) + dx, Math.floor(at.y) + dy, Math.floor(at.z) + dz,
    );
    if (fill <= FILL_EPSILON) air += 1;
  });
  return air;
}

/** The closest cell in the dome with soil still in it, or null. */
function nearestSolid(
  at: { x: number; y: number; z: number }, senses: FoundingSenses,
): Cell | null {
  let best: Cell | null = null;
  let bestDistance = Infinity;
  domeCells(at, (dx, dy, dz) => {
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= bestDistance) return;
    const x = Math.floor(at.x) + dx;
    const y = Math.floor(at.y) + dy;
    const z = Math.floor(at.z) + dz;
    if (senses.fillAt(x, y, z) <= FILL_EPSILON) return;
    best = [x, y, z];
    bestDistance = d2;
  });
  return best;
}

/** An angle brought into -pi..pi. */
function wrap(radians: number): number {
  let a = radians;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

const STILL: FoundingIntent = { walk: 0, turn: 0, digAt: null, leave: 0 };
