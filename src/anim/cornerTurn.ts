/**
 * ROUNDING A CORNER, ONE FOOT AT A TIME — the scheduler, and nothing else.
 *
 * ## What it is for
 *
 * The tripod gait cannot start a climb, and the reason is geometric rather
 * than a matter of tuning. Its one question about the world is "what is the
 * nearest solid to this point, along my up" — so standing on flat soil with
 * a trunk in front of her, every front-foot probe answers SOIL until her
 * foot home has crossed into the wood, at which point the cast starts inside
 * the trunk and hands back its own origin. Measured on the island: soil at
 * gaps of 14 down to 5 mm, then a fictional contact 2.5 mm inside the bark.
 * Meanwhile a ray along her FORWARD from the same origin finds the wall
 * every time.
 *
 * The walker cannot start it either. Its seating cast goes down and its wrap
 * arcs sweep behind and below her, which finds the far side of a CONVEX lip.
 * A concave corner is the other sign, and it is not in its vocabulary:
 * standing still at gaps of 10, 6, 4 and 2 mm her up reads exactly zero. The
 * climb that happens today is her walking INTO the trunk and the walker's
 * embedded-rescue extruding her onto it.
 *
 * So this exists, and its whole job is a QUEUE: which single foot may leave
 * the old surface next, and where it must land. It owns no attitude, moves
 * no body, and plants no feet — `LegDrive` does all three, exactly as it
 * does on flat ground.
 *
 * ## NO GRIP, NO CLIMB
 *
 * Holding forward at a wall is not a request to climb; it is a request to
 * walk, which she may then be unable to finish. Nothing here arms until a
 * front foot has a REAL contact inside its own measured workspace — the same
 * `spread` the stance clip uses. Intent is necessary and never sufficient.
 *
 * ## The one trick worth naming
 *
 * Once a target surface is known, finding a foothold on it is the gait's own
 * question RE-FRAMED: cast from `home + up * lift` along `-newUp`, instead of
 * from `home + up * rise` along `-up`. Same operation, one axis swapped —
 * the lift still clears the surface she is standing on, and the direction is
 * now the one she is going to. That is why floor-to-wall, wall-to-ceiling,
 * trunk-to-branch and tunnel-floor-to-wall are not four cases here. There is
 * no tree in this file, and there must never be one.
 */

import * as THREE from 'three';

/** Millimetres per world unit. */
const MM = 5;

/** A place to stand and which way that surface faces. */
export interface SurfaceContact {
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

/**
 * What the scheduler needs to know about a leg — and no more than that.
 * `LegDrive.Leg` satisfies it structurally; nothing here may write to one.
 */
export interface CornerLeg {
  readonly slot: string;
  /** Rest position of the foot, in her body frame. */
  readonly home: THREE.Vector3;
  /** The world point it is locked to. Meaningless unless planted. */
  readonly anchor: THREE.Vector3;
  readonly planted: boolean;
  /** In the air with nothing found — reaching, not travelling. */
  readonly groping: boolean;
  /** How far this foot may sit from home, across the surface. */
  readonly spread: number;
}

export interface CornerBody {
  at: THREE.Vector3;
  up: THREE.Vector3;
  forward: THREE.Vector3;
}

/** What the scheduler is told each frame. */
export interface CornerInput {
  /** -1..1 along her forward. Forward INTENT is the arming gate. */
  walk: number;
  /**
   * The gait's stroke radius this frame, in world units.
   *
   * Not a tuning knob — it is how much room a foothold has to LEAVE for the
   * foot that takes it. A contact at the very edge of a leg's workspace is
   * not somewhere she can walk from: measured on the trunk, the leading pair
   * gripped at 97% of their spread and she froze on the spot for eight
   * hundred frames with every foot exactly at its limit. A foot needs a
   * stride's worth of room left over, and the gait already knows what a
   * stride is.
   */
  radius?: number;
  /**
   * May a transition arm at all this frame?
   *
   * The caller's veto, and it is a veto rather than a mode: a dodge is the
   * ordinary movement with different numbers in it, so the drive cannot tell
   * one from a walk, and a burst that happens to point at a wall must not
   * stage a climb. Same for an active dig stroke. Default true.
   */
  mayTransition?: boolean;
}

/** What the world must answer for a corner to be found. */
export interface CornerGround {
  /**
   * The first solid along `dir` within `maxDistance`, and its outward normal.
   *
   * Returns null when the origin is ALREADY solid — a ray that starts inside
   * something reports a hit at zero range, which is correct for a ray and is
   * a fictional foothold here. That case is not hypothetical: it is what the
   * gait's own downward cast does once a front foot home crosses the bark.
   */
  probeContact(
    origin: THREE.Vector3, dir: THREE.Vector3, maxDistance: number,
  ): SurfaceContact | null;
}

export type CornerPhase =
  | 'normal'
  /** Getting the leading row onto the new surface. */
  | 'acquireFront'
  /** Every row between the first and the last, one foot at a time. */
  | 'transferMiddle'
  /** The trailing row. */
  | 'transferRear'
  /** All across; rebasing the gait's bookkeeping before it resumes. */
  | 'settle'
  /** Support fell too far, or the target was lost. No new releases. */
  | 'recover';

export interface CornerTuning {
  /** Disagreement between the support normal and a candidate to ENTER. */
  enter: number;
  /** And to LEAVE — lower, so a corner does not chatter across it. */
  exit: number;
  /**
   * How far off the target normal a contact may be and still count NEW.
   *
   * Its job is to reject a THIRD surface, not to grade the target one.
   * Measured on the island's trunk across the whole window where a front
   * foot can reach — gaps of 7 mm down to 4 — the foothold comes back
   * between 0.2 and 2.6 degrees off target, because the lift in
   * `footholdFor` puts the ray on clean wall rather than in the crease. The
   * surface she is LEAVING sits about 85 degrees away. Forty-five is the
   * middle of that gap, with forty degrees of margin on each side, and it
   * absorbs a curved trunk without effort: three millimetres round a
   * five-hundred-millimetre bole is a third of one degree.
   */
  band: number;
  /**
   * How far off the sole plane the look-ahead starts.
   *
   * MEASURED, and the measurement is the whole reason it exists. At sole
   * height a forward ray strikes exactly where the floor's field meets the
   * wall's, and the union's gradient there is their BLEND — 45.9 degrees at
   * every approach distance, which is the entry threshold itself, so arming
   * would be a coin toss. Lifted half a millimetre it reads 71.7; lifted one
   * millimetre — one field cell, which is the blend's own width — it reads
   * 85.5 and stays there at every gap from 10 mm in to 4.
   */
  browLift: number;
  /**
   * Directions to look, as angles up from her forward about her own right.
   *
   * Two, not a sweep. Straight ahead finds a wall she is walking at; tilted
   * up finds a ceiling she is walking under and the underside of a branch.
   * Down is the floor she is already on.
   */
  fan: readonly number[];
  /** How far ahead a candidate is worth tracking. */
  lookAhead: number;
  /** Feet on a surface below which nothing may be released. */
  minPlanted: number;
  /** How long a scheduled foot may reach before the release is called off. */
  gropeSeconds: number;
  /**
   * How long a transition may make no progress at all before it gives up.
   *
   * Progress is a foot being scheduled or her body moving; a corner that is
   * neither is a corner she is stuck in, and staying armed keeps the
   * ordinary gait muzzled. Generous, because waiting for a foot to come
   * within reach IS progress and she may be creeping.
   */
  stallSeconds: number;
  /** How fast the target normal may be re-aimed by new contacts, per second. */
  aimRate: number;
}

/**
 * The numbers, in the units they are argued in.
 *
 * `enter` is the request's own 45 degrees, and it is a real threshold rather
 * than a nominal one now that the look-ahead clears the corner blend — the
 * wall reads 85 degrees, so there is forty degrees of margin either side.
 */
export const CORNER_DEG = { enter: 45, exit: 32, band: 45, fan: [0, 30] } as const;

export const CORNER_TUNING: CornerTuning = {
  enter: (CORNER_DEG.enter * Math.PI) / 180,
  exit: (CORNER_DEG.exit * Math.PI) / 180,
  band: (CORNER_DEG.band * Math.PI) / 180,
  browLift: 1.0 / MM,
  fan: CORNER_DEG.fan.map((d) => (d * Math.PI) / 180),
  lookAhead: 12 / MM,
  /*
   * FOUR. She has six legs and releases one at a time, so an untroubled
   * transition sits at five planted and never tests this. It is what the
   * bookkeeping is checked against when something else has already gone
   * wrong — a foot dragged past its own reach by the body coming round.
   */
  minPlanted: 4,
  gropeSeconds: 0.6,
  stallSeconds: 2,
  aimRate: 4,
};

/** What the drive is told to do this frame. */
export interface CornerCommand {
  /** Is the ordinary tripod scheduler paused? */
  active: boolean;
  /** The one slot authorised to leave its surface this frame. */
  release: string | null;
  /** Where the scheduled swing must land. Null when nothing is scheduled. */
  aim: SurfaceContact | null;
  /** The slot `aim` belongs to. */
  aimSlot: string | null;
  /** Set on the frame the transition hands back — see `LegDrive` grace. */
  handedOff: boolean;
}

/** Everything a debug line wants, and nothing that costs geometry. */
export interface CornerReport {
  phase: CornerPhase;
  onNew: number;
  onOld: number;
  planted: number;
  swinging: string | null;
  /** Degrees between the frozen support normal and the target normal. */
  turnDeg: number;
  /** Millimetres to the tracked candidate; -1 when there is none. */
  candidateMm: number;
  /**
   * Per foot: which surface it belongs to and what it is doing. In rig
   * order, so a printed line reads the same way twice running.
   */
  feet: ReadonlyArray<{
    slot: string;
    owner: 'old' | 'new';
    state: 'PLANT' | 'SWING' | 'GROPE';
  }>;
}

type Owner = 'old' | 'new';

const angleBetween = (a: THREE.Vector3, b: THREE.Vector3): number =>
  Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));

/**
 * Rows of legs, leading first, from their MEASURED homes.
 *
 * Sorted along her forward and paired off, so "the front two" is a fact
 * about where this animal's feet are rather than a list of names. A caste
 * with a different number of legs rows up the same way, and nothing here
 * counts to six.
 */
export function rowsFromHomes(
  legs: ReadonlyArray<{ slot: string; home: THREE.Vector3 }>,
): string[][] {
  const sorted = legs.slice().sort((a, b) => b.home.z - a.home.z);
  const rows: string[][] = [];
  for (let i = 0; i < sorted.length; i += 2) {
    rows.push(sorted.slice(i, i + 2).map((l) => l.slot));
  }
  return rows;
}

export class CornerTurn {
  private state: CornerPhase = 'normal';

  /** The surface she started on. FROZEN at entry: labels must not drift. */
  private readonly oldUp = new THREE.Vector3(0, 1, 0);

  /** The surface she is going to. Re-aimed slowly, never snapped. */
  private readonly newUp = new THREE.Vector3(0, 1, 0);

  private readonly owner = new Map<string, Owner>();

  /**
   * Every slot the scheduler has actually PUT on the new surface, this
   * transition. Distinct from `owner`, and the difference matters: a label
   * comes off again when a foot loses its grip, so "nothing is standing on
   * the old surface" can be satisfied by the last old foot merely being in
   * the air. Measured — the corner finished with a rear foot that had never
   * been scheduled at all, mid-step over the floor it started on. A ledger
   * that only ever grows is what makes "all six went across" a fact.
   */
  private readonly crossed = new Set<string>();

  /** Which row is being transferred. */
  private row = 0;

  private swinging: string | null = null;

  /**
   * Is the foot in the air being brought BACK rather than taken across?
   *
   * A reach that found nothing is called off, and the foot then has to get
   * home somehow. Putting it there — planting it on its old anchor the frame
   * the timeout fires — is a teleport of a couple of millimetres, which is
   * visible and is the thing this whole file refuses to do. So the aim is
   * simply swapped for the anchor it never stopped carrying, and the
   * ordinary swing interpolation walks it back over its ordinary swing.
   */
  private returning = false;

  private readonly aimPoint = new THREE.Vector3();

  private readonly aimNormal = new THREE.Vector3();

  private gropeClock = 0;

  /**
   * How long she has been armed with nothing to do and nowhere to go.
   *
   * A recovery guard and nothing else. Without it a corner that stops making
   * progress stays armed for ever with the ordinary gait muzzled — measured
   * after a teleport, five hundred frames armed at a gap of 12 mm with no
   * foothold in reach and no exit condition that could fire.
   */
  private stallClock = 0;

  /** Last frame's progress marks — see the stall guard in `update`. */
  private wasAcross = 0;

  private wasTurn = Infinity;

  /** The gait's stroke radius, as the drive last reported it. */
  private stroke = 0;

  /** The tracked candidate, so the world is not rediscovered every frame. */
  private hasCandidate = false;

  private readonly candidatePoint = new THREE.Vector3();

  private readonly candidateNormal = new THREE.Vector3();

  private candidateRange = -1;

  /* Scratch. This runs every frame on a phone; nothing here allocates. */
  private readonly sA = new THREE.Vector3();

  private readonly sB = new THREE.Vector3();

  private readonly sC = new THREE.Vector3();

  private readonly sD = new THREE.Vector3();

  constructor(
    private readonly rows: readonly string[][],
    private readonly tune: CornerTuning = CORNER_TUNING,
  ) {}

  get phase(): CornerPhase { return this.state; }

  get active(): boolean { return this.state !== 'normal'; }

  /** The target surface's normal, for whoever wants to draw or test it. */
  get target(): THREE.Vector3 { return this.newUp; }

  /** And the one she started from. */
  get support(): THREE.Vector3 { return this.oldUp; }

  /** Home, in the world, for a body pose — the drive's own formula. */
  private homeWorld(leg: CornerLeg, body: CornerBody, into: THREE.Vector3): THREE.Vector3 {
    const right = this.sA.crossVectors(body.up, body.forward).normalize();
    return into.copy(body.at)
      .addScaledVector(right, leg.home.x)
      .addScaledVector(body.up, leg.home.y)
      .addScaledVector(body.forward, leg.home.z);
  }

  /**
   * A foothold on the TARGET surface for one leg, or null.
   *
   * The gait's own question in the NEW frame: from this foot's home, aimed
   * along the target's own normal, out to as far as this leg can reach.
   *
   * The lift off her CURRENT surface is the part that had to be measured.
   * Without it the ray leaves at sole height and, on a corner that is not
   * exactly square, drifts into the floor before it ever gets to the wall —
   * measured on the island's trunk, every front-foot probe from 10 mm out to
   * 5.5 mm came back with a hit 0.6 mm from home whose normal was 85 degrees
   * off the target. That is not a foothold on the wall, it is the ground she
   * is standing on, and it is what "never armed" was made of. One field cell
   * of clearance — the same one the look-ahead uses, for the same reason —
   * puts the ray on clean surface.
   *
   * The hit is then accepted only if it is genuinely within `spread` of
   * home. That is what stops a foot being stretched because a scheduler
   * would like it to be.
   */
  private footholdFor(
    leg: CornerLeg, body: CornerBody, ground: CornerGround, into: SurfaceContact,
  ): boolean {
    const home = this.homeWorld(leg, body, this.sB);
    const origin = this.sC.copy(home).addScaledVector(body.up, this.tune.browLift);
    const dir = this.sD.copy(this.newUp).negate();
    const hit = ground.probeContact(origin, dir, leg.spread + this.tune.browLift);
    if (!hit) return false;
    /* The reach test, in three dimensions and against her MEASURED spread
     * LESS a stride. Projecting it onto a frame would be picking one of the
     * two frames that are in dispute, which is the whole difficulty of a
     * corner; taking the whole spread would be handing her a foothold she
     * cannot then move from. See `CornerInput.radius`. */
    if (this.homeWorld(leg, body, this.sB).distanceTo(hit.point) > this.budgetFor(leg)) {
      return false;
    }
    /* And it must be the surface we are going to, not some third thing. */
    if (angleBetween(hit.normal, this.newUp) > this.tune.band) return false;
    into.point.copy(hit.point);
    into.normal.copy(hit.normal);
    return true;
  }

  /**
   * Is there a steep surface ahead of her? Tracks one rather than rediscovering.
   *
   * Two rays while she is walking forward, and only while she is: the fan is
   * her forward and her forward tilted up, taken from the leading row's homes
   * lifted one field cell — see `CornerTuning.browLift`.
   */
  private look(
    body: CornerBody, ground: CornerGround, legs: readonly CornerLeg[],
  ): boolean {
    const lead = this.rows[0] ?? [];
    const brow = this.sB.set(0, 0, 0);
    let n = 0;
    for (const slot of lead) {
      const leg = legs.find((l) => l.slot === slot);
      if (!leg) continue;
      brow.add(this.homeWorld(leg, body, this.sC));
      n += 1;
    }
    if (n === 0) return false;
    brow.divideScalar(n).addScaledVector(body.up, this.tune.browLift);

    const right = this.sC.crossVectors(body.up, body.forward).normalize();
    for (const lift of this.tune.fan) {
      const dir = this.sD.copy(body.forward);
      if (lift !== 0) dir.applyAxisAngle(right, lift).normalize();
      const hit = ground.probeContact(brow, dir, this.tune.lookAhead);
      if (!hit) continue;
      if (angleBetween(hit.normal, body.up) < this.tune.enter) continue;
      this.hasCandidate = true;
      this.candidatePoint.copy(hit.point);
      this.candidateNormal.copy(hit.normal);
      this.candidateRange = brow.distanceTo(hit.point);
      return true;
    }
    this.hasCandidate = false;
    this.candidateRange = -1;
    return false;
  }

  /**
   * Which foot goes next, by real reach — never by name.
   *
   * Two kinds of move, and the second one is not an afterthought. A TRANSFER
   * takes the next un-crossed foot of the current row onto the new surface.
   * A RE-STEP moves a foot that is ALREADY on the new surface, because it
   * has been dragged to the end of its own workspace by the body creeping
   * forward.
   *
   * Without the re-step she stops, and the reason is worth stating plainly:
   * on the new surface the ordinary swing is no use. It asks `nearest` along
   * her up, and her up still belongs to the floor — so a foot on a wall,
   * asked to step, is handed a point on the SOIL and quietly walks back off
   * the wall. Measured: the leading foot crossed, was dragged out of reach,
   * re-stepped onto the ground, and the corner never got past one foot.
   * Every step on the new surface has to be found in the new frame, which is
   * what this file is for.
   *
   * Transfers come first — the queue is the queue — and a re-step is what
   * she does when the queue is waiting for her body to bring the next row
   * within reach.
   */
  private pick(
    body: CornerBody, ground: CornerGround, legs: readonly CornerLeg[],
    into: SurfaceContact,
  ): string | null {
    const found: SurfaceContact = {
      point: new THREE.Vector3(), normal: new THREE.Vector3(),
    };
    let best: string | null = null;
    let bestScore = -Infinity;
    for (const slot of this.rows[this.row] ?? []) {
      if (this.owner.get(slot) === 'new') continue;
      const leg = legs.find((l) => l.slot === slot);
      if (!leg || !leg.planted) continue;
      if (!this.footholdFor(leg, body, ground, found)) continue;
      /*
       * MARGIN first, agreement second. How much of its own workspace the
       * foot would have left over is what decides whether a grip is real;
       * how squarely the contact faces the target breaks the tie. Reading
       * the pair off in a fixed order instead is how a scheduler ends up
       * always leading with the left foot on a slope that suits the right.
       */
      const home = this.homeWorld(leg, body, this.sB);
      const margin = leg.spread - home.distanceTo(found.point);
      const square = found.normal.dot(this.newUp);
      const score = margin + square * 0.1;
      if (score > bestScore) {
        bestScore = score;
        best = slot;
        into.point.copy(found.point);
        into.normal.copy(found.normal);
      }
    }
    if (best) return best;

    /* Nothing to transfer. Is a foot already across out of room? */
    let worst = -Infinity;
    for (const leg of legs) {
      if (this.owner.get(leg.slot) !== 'new' || !leg.planted) continue;
      const home = this.homeWorld(leg, body, this.sB);
      const over = home.distanceTo(leg.anchor) - this.budgetFor(leg);
      if (over <= 0 || over <= worst) continue;
      if (!this.footholdFor(leg, body, ground, found)) continue;
      /* And only if the new place is better than the one it is leaving. */
      if (this.homeWorld(leg, body, this.sB).distanceTo(found.point)
        >= home.distanceTo(leg.anchor)) continue;
      worst = over;
      best = leg.slot;
      into.point.copy(found.point);
      into.normal.copy(found.normal);
    }
    return best;
  }

  /**
   * How far from home a foot may sit and still be able to walk from there.
   *
   * Its measured spread LESS a stride, so a foothold always leaves the room
   * the gait needs to take the next step. Floored at a quarter of the spread
   * so a caller that never reports a stride still gets something usable.
   */
  private budgetFor(leg: CornerLeg): number {
    return Math.max(leg.spread * 0.25, leg.spread - this.stroke);
  }

  /** Give up the corner and hand every foot back to the ordinary gait. */
  private stand(): void {
    this.state = 'normal';
    this.swinging = null;
    this.returning = false;
    this.owner.clear();
    this.crossed.clear();
    this.gropeClock = 0;
    this.row = 0;
    this.hasCandidate = false;
    this.candidateRange = -1;
    this.stallClock = 0;
    this.wasAcross = 0;
    this.wasTurn = Infinity;
  }

  /**
   * Forget everything — a respawn, a teleport, a fresh plant.
   *
   * Every one of those invalidates the two frames a transition is held
   * between, and carrying them across is not a stale number, it is a
   * scheduler queueing feet onto a wall that is no longer in front of her.
   * Measured: after a teleport the corner stayed armed for the whole of the
   * next run, twelve millimetres from anything it could reach.
   */
  reset(): void { this.stand(); }

  /** The phase label for a row index, so the report reads as anatomy. */
  private labelFor(row: number): CornerPhase {
    if (row <= 0) return 'acquireFront';
    if (row >= this.rows.length - 1) return 'transferRear';
    return 'transferMiddle';
  }

  /**
   * One frame of scheduling. Reads the world, writes only its own state.
   */
  update(
    dt: number, body: CornerBody, input: CornerInput,
    ground: CornerGround | null, legs: readonly CornerLeg[],
  ): CornerCommand {
    const idle: CornerCommand = {
      active: false, release: null, aim: null, aimSlot: null, handedOff: false,
    };
    if (!ground) { if (this.active) this.stand(); return idle; }

    const planted = legs.reduce((n, l) => n + (l.planted ? 1 : 0), 0);
    const forward = input.walk > 0;
    const allowed = input.mayTransition ?? true;
    this.stroke = input.radius ?? 0;
    /*
     * PROGRESS, and it is progress TOWARD THE CORNER rather than motion.
     *
     * Her body turning onto the target counts, and so does a foot crossing.
     * Walking does not: with the wall removed out from under a reach she
     * strode off across the floor perfectly happily, which a guard that
     * reads movement calls progress and which is in fact the corner having
     * evaporated. Measured — she stayed armed for the whole four seconds
     * that followed, with the ordinary gait muzzled behind her.
     */
    let across = 0;
    for (const leg of legs) {
      if (leg.planted && this.owner.get(leg.slot) === 'new') across += 1;
    }
    const turn = angleBetween(body.up, this.newUp);
    const gaining = across > this.wasAcross || turn < this.wasTurn - 1e-4;
    this.wasAcross = across;
    this.wasTurn = turn;

    /* ------------------------------------------------- not in one yet */
    if (this.state === 'normal') {
      if (!allowed || !forward) { this.hasCandidate = false; return idle; }
      /*
       * ENTER FROM A STANDING START, not from mid-stride.
       *
       * The ordinary gait has three feet in the air for a good part of every
       * cycle, and arming on one of those frames means the queue's first
       * release takes her to three planted — the transition would begin by
       * making her less stable than walking. Waiting costs at most one swing
       * (0.16 s, well inside the reachable window), which is what "let the
       * current normal swing finish" buys.
       */
      if (planted < legs.length) return idle;
      if (!this.look(body, ground, legs)) return idle;

      /*
       * A candidate is not an entry. NO GRIP, NO CLIMB: the leading row is
       * asked, against the target this candidate implies, whether either
       * foot can actually touch it from where it rests. If neither can, she
       * keeps walking and asks again next frame.
       */
      this.newUp.copy(this.candidateNormal);
      this.oldUp.copy(body.up);
      const found: SurfaceContact = {
        point: new THREE.Vector3(), normal: new THREE.Vector3(),
      };
      let reachable = false;
      for (const slot of this.rows[0] ?? []) {
        const leg = legs.find((l) => l.slot === slot);
        if (!leg || !leg.planted) continue;
        if (this.footholdFor(leg, body, ground, found)) { reachable = true; break; }
      }
      if (!reachable) return idle;

      this.owner.clear();
      /* Every foot down at this moment is on the surface she is LEAVING, by
       * construction — the ordinary gait put it there. Nothing is probed to
       * establish that, and nothing may relabel it later. */
      for (const leg of legs) this.owner.set(leg.slot, 'old');
      this.state = this.labelFor(0);
      this.row = 0;
      this.swinging = null;
      this.gropeClock = 0;
      return { ...idle, active: true };
    }

    /* ------------------------------------------------------- in one */
    const cmd: CornerCommand = {
      active: true, release: null, aim: null, aimSlot: null, handedOff: false,
    };

    /* The frame after everything crossed: hand back. The tripod trigger is
     * muzzled a little longer than this by the drive's own grace. */
    if (this.state === 'settle') { this.stand(); return idle; }

    /*
     * A FOOT THAT LOST ITS GRIP LOSES ITS LABEL — and only then.
     *
     * Labels are frozen against the two frames the corner is between, so a
     * curved trunk cannot make one flip mid-turn. But a foot the scheduler
     * put on the new surface can be taken off it again by something that is
     * not the scheduler: the body comes round, that leg runs out of reach,
     * and the spread rule lets go. It is then in the air with no idea where
     * it is going, and the ordinary swing will put it wherever the world
     * answers — possibly straight back onto the old floor. Keeping the NEW
     * label through that is how a row gets called finished with a foot that
     * is not on it.
     *
     * So the label goes back, and the queue below re-acquires it properly.
     * The leg the scheduler is currently flying is exempt: it is still OLD
     * until it lands, by construction.
     */
    for (const leg of legs) {
      if (leg.planted || leg.slot === this.swinging) continue;
      if (this.owner.get(leg.slot) === 'new') this.owner.set(leg.slot, 'old');
    }
    /*
     * And the queue's position is DERIVED from those labels rather than
     * remembered alongside them. A remembered index and a label map are two
     * accounts of the same fact, and the moment a grip is lost they disagree
     * — the index says the front row is finished while the labels say a
     * front foot is back on the floor. One account, read fresh.
     */
    const pending = this.rows.findIndex(
      (r) => r.some((s) => this.owner.get(s) !== 'new'),
    );
    this.row = pending < 0 ? this.rows.length - 1 : pending;
    if (this.state !== 'recover') this.state = this.labelFor(this.row);

    /*
     * THE STALL GUARD. Armed, asking for forward, and neither scheduling a
     * foot nor going anywhere — give it up and let the ordinary gait have
     * her back. Paused counts as fine: letting go of forward is a pause by
     * design, and a pause must not time out.
     */
    if (!forward || !allowed || this.swinging || gaining) this.stallClock = 0;
    else this.stallClock += dt;
    if (this.stallClock >= this.tune.stallSeconds) { this.stand(); return idle; }

    /*
     * AND THE CORNER IS OVER WHEN NOTHING IS STANDING ON THE OLD SURFACE.
     *
     * Not "when all six carry the new label". That reads as the same thing
     * and is not: one foot is nearly always in the air, and a foot in the
     * air has just had its label taken away by the rule above — so the
     * all-six condition is only ever true on the rare frame when every foot
     * happens to be down at once. Measured against the wall, it was never
     * true at all: she climbed six millimetres up it with the scheduler
     * still armed, releasing a foot at a time forever, because the corner
     * she had finished could not be observed to have finished.
     *
     * Nothing planted on the surface she left IS the finish, it is what
     * "six new, none old" was always trying to say, and it cannot be undone
     * by a foot being mid-step.
     */
    let onOld = 0;
    for (const leg of legs) {
      if (leg.planted && this.owner.get(leg.slot) !== 'new') onOld += 1;
    }
    if (onOld === 0 && this.crossed.size >= legs.length) {
      this.state = 'settle';
      return { ...cmd, handedOff: true };
    }

    /* Reversing before anything has been committed is a change of mind, and
     * she is still standing on the surface she started on. */
    const anyNew = [...this.owner.values()].some((o) => o === 'new');
    if (input.walk < 0 && !anyNew && !this.swinging) { this.stand(); return idle; }

    /* The corner turned out not to be one — hysteresis, so a curved trunk
     * does not chatter across the threshold. */
    if (angleBetween(this.oldUp, this.newUp) < this.tune.exit && !anyNew) {
      this.stand();
      return idle;
    }

    /* --------------------------------------- a scheduled foot in the air */
    if (this.swinging) {
      const leg = legs.find((l) => l.slot === this.swinging);
      if (!leg) { this.swinging = null; return cmd; }
      if (leg.planted && this.returning) {
        /* Back where it started. Nothing crossed, nothing is relabelled, and
         * the queue tries again from wherever she now is. */
        this.swinging = null;
        this.returning = false;
        this.gropeClock = 0;
        this.state = this.labelFor(this.row);
        return cmd;
      }
      if (leg.planted) {
        /* It landed. Label it, and let the target lean toward what it
         * actually found — a trunk is curved, and the normal that armed
         * the corner is not the normal three feet further round it. */
        this.owner.set(leg.slot, 'new');
        this.crossed.add(leg.slot);
        this.newUp.lerp(this.aimNormal, 1 - Math.exp(-this.tune.aimRate * dt)).normalize();
        this.swinging = null;
        this.gropeClock = 0;
        /*
         * Whether that finished a row is not decided here. The block above
         * re-reads the labels every frame and moves the queue on when a row
         * is genuinely complete — including the finish, which therefore gets
         * a SETTLE frame of its own. That frame matters: the drive builds its
         * report at the END of a step, so a transition that cleared itself
         * the instant it finished would finish invisibly, and nothing — a
         * test, a debug line — could ever observe a corner completing.
         */
        this.state = this.labelFor(this.row);
        return cmd;
      }
      /*
       * Still reaching. Re-aim it every frame, because the body moves under
       * it — but do NOT let it hunt forever. On timeout the release is
       * called off and the foot goes back where it was; groping, never
       * teleporting.
       */
      if (this.returning) {
        /* Coming home. The anchor is still there — a release stops HONOURING
         * an anchor, it does not forget one — so it is a swing target like
         * any other. If she has moved so far that it is no longer a leg, the
         * aim is dropped and the ordinary swing gropes for something on the
         * old surface, which is the right answer and not this file's job. */
        const home = this.homeWorld(leg, body, this.sB);
        if (home.distanceTo(leg.anchor) <= leg.spread) {
          this.aimPoint.copy(leg.anchor);
          this.aimNormal.copy(this.oldUp);
          cmd.aim = { point: this.aimPoint, normal: this.aimNormal };
          cmd.aimSlot = leg.slot;
          return cmd;
        }
        /* She has moved too far for that to be a leg any more. Let go of it
         * ENTIRELY rather than keep steering a foot with nowhere to go —
         * holding on left the scheduler owning a leg it could not place, and
         * owning a leg is what keeps the whole transition alive. Measured: a
         * reach whose target was removed left her armed indefinitely. */
        this.swinging = null;
        this.returning = false;
        return cmd;
      }
      this.gropeClock += dt;
      if (this.footholdFor(leg, body, ground, { point: this.aimPoint, normal: this.aimNormal })) {
        cmd.aim = { point: this.aimPoint, normal: this.aimNormal };
        cmd.aimSlot = leg.slot;
        return cmd;
      }
      if (this.gropeClock >= this.tune.gropeSeconds) {
        this.returning = true;
        this.gropeClock = 0;
        this.state = 'recover';
      }
      return cmd;
    }

    /* ------------------------------------------- nothing in the air yet */

    /*
     * SUPPORT SAFETY, and it is a gate rather than an alarm. One foot at a
     * time out of six means five planted through an untroubled transfer; a
     * count below that says something else has already let go — the body
     * coming round can drag an old foot past its own reach — so no new
     * release is authorised until the gait has put it back.
     */
    if (planted < legs.length) {
      if (planted < this.tune.minPlanted) this.state = 'recover';
      return cmd;
    }
    if (this.state === 'recover') this.state = this.labelFor(this.row);

    /* Letting go of forward PAUSES. It does not abandon: the feet that have
     * crossed stay across, and the queue picks up when she asks again. */
    if (!forward || !allowed) return cmd;

    const found: SurfaceContact = {
      point: new THREE.Vector3(), normal: new THREE.Vector3(),
    };
    const next = this.pick(body, ground, legs, found);
    if (!next) return cmd;
    this.swinging = next;
    this.gropeClock = 0;
    this.aimPoint.copy(found.point);
    this.aimNormal.copy(found.normal);
    cmd.release = next;
    cmd.aim = { point: this.aimPoint, normal: this.aimNormal };
    cmd.aimSlot = next;
    return cmd;
  }

  /** Everything a debug line wants, computed from state alone. */
  report(legs: readonly CornerLeg[]): CornerReport {
    let onNew = 0;
    let onOld = 0;
    let planted = 0;
    const feet = legs.map((leg) => {
      const who: Owner = this.owner.get(leg.slot) ?? 'old';
      if (leg.planted) {
        planted += 1;
        if (who === 'new') onNew += 1; else onOld += 1;
      }
      const state = leg.planted ? 'PLANT' : (leg.groping ? 'GROPE' : 'SWING');
      return { slot: leg.slot, owner: who, state: state as 'PLANT' | 'SWING' | 'GROPE' };
    });
    return {
      phase: this.state,
      onNew,
      onOld,
      planted,
      swinging: this.swinging,
      turnDeg: this.active
        ? +((angleBetween(this.oldUp, this.newUp) * 180) / Math.PI).toFixed(1)
        : 0,
      candidateMm: this.hasCandidate ? +(this.candidateRange * MM).toFixed(2) : -1,
      feet,
    };
  }
}
