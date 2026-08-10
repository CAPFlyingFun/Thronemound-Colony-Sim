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
  /**
   * How long an ABANDONED corner keeps the scheduler benched.
   *
   * Giving up is only real if it lasts: `stand()` returns to 'normal', and
   * on the very next frame the same wall answers the same probe and the
   * same corner re-arms — a livelock that runs straight through the stall
   * guard, measured at 898 of 900 frames spent in acquireFront against the
   * wall of a dug pit. The bench gives the ordinary gait — whose walker can
   * wrap onto a wall by itself — a real turn at the problem.
   */
  retrySeconds: number;
  /** How fast the target normal may be re-aimed by new contacts, per second. */
  aimRate: number;
  /**
   * HOW FAR SHE MAY REAR toward the new face while the front grips take it,
   * as fractions of the way from her measured attitude to the face's own —
   * one front foot across, then both. A real ant does not stand flat with
   * her nose at the bark until some signal fires: the moment a front leg
   * holds the wall her shoulders start to rise, which is what lifts the
   * head clear of the wood (measured: the head shell sat half a millimetre
   * INSIDE the trunk through the last two millimetres of a flat approach,
   * with the neck already at its limit) and spends the waiting on visible
   * motion instead of a freeze. Optional so older tuning literals stand.
   */
  leanOne?: number;
  leanBoth?: number;
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
  retrySeconds: 2.5,
  aimRate: 4,
  leanOne: 0.15,
  leanBoth: 0.35,
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
  /**
   * SHE MAY NOT OUT-WALK HER OWN FRONT FEET.
   *
   * A plane the named legs must stay on the air side of, in force only while
   * the LEADING ROW is still incomplete. `slots` are the leading-row feet
   * that have not crossed yet.
   *
   * This is the fix for the thing the whole file exists to prevent, and it
   * took three measurements to find. The first front foot gripped at frame
   * 36 and the second not until frame 117, and across those eighty-one
   * frames SurfaceWalker turned her from level to eighty-six degrees on ONE
   * grip — then the spread rule dragged even that foot back off the wall.
   * Body first, feet after.
   *
   * The cause was not reach and not the queue competing with the creep for
   * the one place in the air; suppressing the creep changed the timeline by
   * exactly nothing. It was that she kept WALKING. By the time the queue
   * came round to the second front foot, her body had carried that foot's
   * home 3.8 mm INSIDE the wall — so its probe started in solid, returned
   * null, and no foothold could ever be found. She had walked past the only
   * place she could have gripped from.
   *
   * So the leading row's homes are held clear of the target face, through
   * the drive's own reach clip rather than by a separate clamp on the root:
   * one more constraint in the same bisection that stops a stance foot being
   * dragged past its spread. She walks continuously right up to the wall and
   * stops there while two feet go on — which is what an ant does, and it is
   * not a pause in open ground.
   *
   * The idea of guarding the root against the target face is the
   * `chatgpt/continuous-corner-climb` branch's. What it gated on — a live
   * scheduler aim — is false for exactly the frames that needed it: measured,
   * the guard was true on 9 frames of 900, and on those the motion left to
   * clamp was already 0.0001 mm/frame.
   */
  hold: { point: THREE.Vector3; normal: THREE.Vector3; slots: string[] } | null;
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
  /**
   * Radians between the surface she is SEATED on right now and the one her
   * front is going to — how far her back has to bend to lie along both.
   *
   * Starts at the corner's full angle and falls to nothing as the walker
   * brings her round, which is exactly the shape a spine wants. Nought
   * whenever no transition is running.
   */
  fold: number;
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
  /** Seconds the scheduler stays benched after abandoning a corner. */
  private cooloff = 0;

  /**
   * Where the body was last frame, so a "pause" can be checked against the
   * one thing that defines a pause: NOT MOVING. Parked at an armed corner
   * with every foot planted, the seat's two attractors can treadmill her
   * backwards at a millimetre a second indefinitely — hands off, nothing
   * swinging, and the old guard reading it as a pause by design. Measured:
   * ten seconds of steady backward drift that stopped the instant the
   * corner disarmed.
   */
  private readonly wasAt = new THREE.Vector3();

  private haveWasAt = false;

  /** Millimetres per second, low-passed over ~a third of a second. */
  private slipMms = 0;

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

  /**
   * The slot the scheduler still OWNS mid-swing, aim or no aim.
   *
   * `CornerCommand.aimSlot` goes null on a frame the foothold re-probe
   * fails, but the foot is still a cross-surface crossing in progress —
   * anyone timing swings off the command alone would misread that frame as
   * an ordinary step. See the swing clock in `LegDrive`.
   */
  get swingingSlot(): string | null { return this.swinging; }

  /**
   * The slot mid-CROSS — a scheduled foot genuinely going to the new
   * surface, as opposed to one being walked back home after a failed reach.
   *
   * The drive's overlap rule wants exactly this distinction: a crossing in
   * flight is the steady state a stance leg may keep stepping under, while
   * a returning foot means the corner is already recovering and piling a
   * second foot into the air on top of that is how a recovery becomes a
   * fall.
   */
  get crossingSlot(): string | null {
    return this.returning ? null : this.swinging;
  }

  /**
   * Which surface a foot belongs to, as the ledger has it.
   *
   * The drive's overlap creep needs this: a creep step lands through the
   * ordinary `nearest`, which measures along an up that still belongs to
   * the OLD surface — so a foot already across must never be handed to it.
   * Worse than the wrong landing, a second airborne foot cannot be adopted
   * while a crossing is in flight, so the label comes off and the corner
   * can never again observe itself finished. Measured: armed for the whole
   * of a 700-frame descent, one ground foot forever flapping back to 'old'.
   */
  ownerOf(slot: string): Owner { return this.owner.get(slot) ?? 'old'; }

  /**
   * A landing for a foot ALREADY ACROSS that the drive is re-stepping —
   * the corner's own foothold question, asked on the new surface, so an
   * ordinary swing can renew a crossed foot without going through the
   * queue.
   *
   * This is what makes transfers overlap: re-steps used to be scheduled
   * one at a time between crossings (each a full careful swing with the
   * body parked at the clip), and taking them off the queue lets the
   * stance renew itself while a genuine crossing is in the air. The
   * scheduler still owns every OLD→NEW transfer; this only answers where
   * a NEW foot's next ordinary step lands, in the frame `nearest` cannot
   * measure in.
   */
  restepAim(
    leg: CornerLeg, body: CornerBody, ground: CornerGround, into: SurfaceContact,
  ): boolean {
    if (!this.active) return false;
    return this.footholdFor(leg, body, ground, into);
  }

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
    /*
     * A STEP, NOT A PLANT. The ordinary swing puts a foot a stroke radius
     * AHEAD of its home along the way it is travelling; a foothold taken
     * straight down onto the new surface arrives with no stroke left and
     * runs out the moment she moves, which is what left her clipped on a
     * quarter of the frames of a corner.
     *
     * "Ahead" on the new surface is where she will be going once she is on
     * it: her OLD up, laid flat against the new face. Walking at a wall that
     * is straight up it; walking at a ceiling it is on along it. Her forward
     * is no use here — at a right-angled corner it is the new face's own
     * normal, and projecting it leaves nothing.
     */
    const along = this.sA.copy(this.oldUp)
      .addScaledVector(this.newUp, -this.oldUp.dot(this.newUp));
    if (along.lengthSq() > 1e-8) home.addScaledVector(along.normalize(), this.stroke);
    const origin = this.sC.copy(home).addScaledVector(body.up, this.tune.browLift);
    const dir = this.sD.copy(this.newUp).negate();
    const hit = ground.probeContact(origin, dir, leg.spread + this.tune.browLift);
    if (!hit) return false;
    /*
     * The reach test, in three dimensions and against her MEASURED spread —
     * from the REAL home, not from the strided aim above. Projecting it onto
     * a frame would be picking one of the two frames that are in dispute,
     * which is the whole difficulty of a corner.
     *
     * The whole spread, because the stride IS the margin now: a foot placed
     * a stroke ahead of itself spends that stroke walking back through its
     * home before it runs out, exactly as an ordinary step does. This used
     * to subtract one, which was right when a scheduled foot was planted
     * with no stroke at all and would otherwise grip at 97% of its reach and
     * freeze her.
     */
    if (this.homeWorld(leg, body, this.sB).distanceTo(hit.point) > leg.spread) {
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
   * How far from home a foot may sit before it is worth re-stepping.
   *
   * Its measured spread LESS a stride: past that, a foot has less than one
   * ordinary step of room left, which is the point at which the gait would
   * move it anyway. Only the re-step in `pick` asks this — a foothold is
   * accepted against the full spread, because a scheduled step now carries
   * its own stride. Floored at a quarter of the spread so a caller that
   * never reports a stride still gets something usable.
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
  /*
   * A reset also FORGETS WHERE SHE WAS. `stand()` deliberately keeps the
   * slip history — a bench mid-drift must not launder the very motion that
   * benched it — but a reset is a teleport or a respawn, and reading the
   * jump as one frame of velocity left the low-pass above the stall
   * threshold for seconds: a genuinely stationary hands-off pause right
   * after arriving would have been benched as a drift.
   */
  reset(): void {
    this.stand();
    this.haveWasAt = false;
    this.slipMms = 0;
  }

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
      active: false, release: null, aim: null, aimSlot: null,
      handedOff: false, hold: null,
    };
    /* No ground, no sample: the next measured frame must not read the whole
     * airborne interval as one frame of velocity. */
    if (!ground) { this.haveWasAt = false; if (this.active) this.stand(); return idle; }

    const planted = legs.reduce((n, l) => n + (l.planted ? 1 : 0), 0);
    const forward = input.walk > 0;
    /* The body's own speed, low-passed so a single reseated frame does not
     * read as motion. Only the stall guard consumes it — see `wasAt`. */
    if (dt > 0) {
      const mms = (body.at.distanceTo(this.wasAt) * MM) / dt;
      const blend = 1 - Math.exp(-3 * dt);
      this.slipMms += ((this.haveWasAt ? mms : 0) - this.slipMms) * blend;
    }
    this.wasAt.copy(body.at);
    this.haveWasAt = true;
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
    /*
     * PROGRESS IS A LEDGER, NOT A FLICKER — on both axes.
     *
     * Feet: the live on-new count flickers 0-1-0 forever against the wall
     * of a dug pit — a front foot lands, is dragged off, lands again — and
     * every flicker read as "gaining". `crossed` only ever grows, so it
     * resets the clock once per genuine new grip.
     *
     * Turn: any frame where the angle merely wobbled downward by a
     * hundredth of a degree also read as "gaining", and a stuck body
     * wobbles both ways every frame — the clock was being fed by jitter.
     * So the turn ledger is the BEST angle ever reached, and only beating
     * it by a full degree counts. Jitter around a stuck angle runs out of
     * new bests almost immediately; a real turn produces them constantly.
     */
    const TURN_GAIN = (1 * Math.PI) / 180;
    const gaining = this.crossed.size > this.wasAcross || turn < this.wasTurn - TURN_GAIN;
    this.wasAcross = this.crossed.size;
    this.wasTurn = Math.min(this.wasTurn, turn);

    if (this.cooloff > 0) this.cooloff = Math.max(0, this.cooloff - dt);

    /* ------------------------------------------------- not in one yet */
    if (this.state === 'normal') {
      if (!allowed || !forward) { this.hasCandidate = false; return idle; }
      /* Benched after a stall: the same wall would re-arm the same corner
       * on the very next frame otherwise, and the give-up would be a
       * one-frame blink inside the same livelock. */
      if (this.cooloff > 0) { this.hasCandidate = false; return idle; }
      /*
       * ENTER FROM A STANDING START, not from mid-stride.
       *
       * The ordinary gait has three feet in the air for a good part of every
       * cycle, and arming on one of those frames used to be refused
       * outright. The refusal is now only the scheduler's own support
       * floor, for a measured reason: the strict all-six gate made the
       * descent's entry window a couple of frames wide — the fold is
       * reachable for barely a gait cycle, the tripod was mid-swing across
       * exactly those frames, and she walked straight into the floor and
       * let the walker's embedded-rescue fold her (a 58 mm/s body spike
       * and 0.6 mm of penetration). Arming with feet in flight is safe
       * because arming RELEASES nothing: the queue's own support gate
       * refuses a first release until every foot is down, so the only
       * thing that starts sooner is the hold plane — which is precisely
       * the thing that stops her outwalking the corner. (Even a support
       * floor here was too strict: the ordinary tripod holds three feet in
       * the air across exactly the frames the descent's fold is reachable,
       * and the reachability test below already demands a PLANTED leading
       * foot with a real grip in reach.)
       */
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
      active: true, release: null, aim: null, aimSlot: null,
      handedOff: false, hold: null,
    };

    /* The frame after everything crossed: hand back. The tripod trigger is
     * muzzled a little longer than this by the drive's own grace. */
    if (this.state === 'settle') { this.stand(); return idle; }

    /*
     * Hold the leading row clear of the face until it is across. One cell of
     * standoff — the same one the probes use, and for the same reason: that
     * is where a foothold ray still has clean surface to find.
     *
     * Against `crossed`, the ledger that only grows, and NOT against the live
     * labels. A foot that grips and is later dragged off loses its label, and
     * reading that would put the hold back on when she is already past the
     * plane — every home beyond it, the clip unsatisfiable at any fraction,
     * and her frozen against a wall she is standing on. Measured: stuck at
     * seventeen degrees for the whole of the next five hundred frames.
     * Having once had the pair is the thing that is over.
     */
    const leading = (this.rows[0] ?? []).filter((s2) => !this.crossed.has(s2));
    if (leading.length > 0 && this.hasCandidate) {
      cmd.hold = {
        point: this.candidatePoint,
        normal: this.newUp,
        slots: leading,
      };
    }

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
    if (!this.swinging) {
      for (const leg of legs) {
        if (leg.planted || this.owner.get(leg.slot) !== 'new') continue;
        /*
         * A new foot in the air that is NOT groping is the drive re-stepping
         * it through `restepAim` — an ordinary swing to a found spot on the
         * new surface, off the queue by design. Adopting it would put it
         * back ON the queue, which is the serialisation this exists to end.
         * Only a foot that has genuinely lost the surface — groping — needs
         * the scheduler to take it over.
         *
         * The exemption holds only in the phases where the drive is allowed
         * to re-step at all — past the front row. In `acquireFront` a
         * dragged-off front grip must come back through the queue's careful
         * clock, exactly as it always did.
         */
        if (!leg.groping
          && this.state !== 'acquireFront' && this.state !== 'recover') continue;
        /*
         * ADOPT IT, do not disown it. A foot the spread rule lifted off the
         * new surface is still a foot that belongs on the new surface, and
         * the ordinary swing would put it wherever `nearest` says — which is
         * measured along an up that may still belong to the floor. Taking it
         * over costs one aim and keeps the label, which keeps the queue where
         * it was. Disowning it rewound the queue to the leading row and the
         * phase flapped between acquiring and transferring four times in a
         * single corner: an ant that visibly cannot decide what it is doing.
         */
        this.swinging = leg.slot;
        this.returning = false;
        this.gropeClock = 0;
        break;
      }
    }
    /* Anything still in the air with a NEW label that is not the one we are
     * flying has genuinely lost the surface, and the queue must go back for
     * it properly. */
    for (const leg of legs) {
      if (leg.planted || leg.slot === this.swinging) continue;
      /* Same exemption, same phase bounds: a drive re-step in flight still
       * belongs to the new surface. Only a groping foot has lost it. */
      if (!leg.groping
        && this.state !== 'acquireFront' && this.state !== 'recover') continue;
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
    /*
     * A foot IN FLIGHT no longer counts as progress. It used to reset the
     * clock, and a scheduler that perpetually flies a front foot at a wall
     * it can never hold is swinging on almost every frame — so the guard
     * built to end exactly that stall never fired. Only a pause by choice
     * (letting go of forward) or measured gain resets it now.
     */
    /*
     * AND A PAUSE ONLY COUNTS AS A PAUSE WHEN HER HANDS ARE EMPTY. Letting
     * go of forward while every foot is planted is the pause by design and
     * must not time out — but letting go while the queue is still flying a
     * foot is what a startled player does when a corner goes wrong, and it
     * used to FREEZE the guard: the jammed reach lived as long as the
     * player waited it out (telemetry: ten seconds pinned in transferRear,
     * drifting backwards, before a shove broke it loose). A foot in the
     * corner's hands keeps the clock honest whether forward is asked for
     * or not.
     */
    /*
     * ...AND ONLY WHEN SHE IS ACTUALLY STANDING STILL. A pause that is
     * measurably going somewhere is the seat treadmilling her, not the
     * player waiting, and it must time out like any other stall.
     */
    const still = this.slipMms < 0.5;
    if ((!forward && !this.swinging && still) || !allowed || gaining) this.stallClock = 0;
    else this.stallClock += dt;
    if (this.stallClock >= this.tune.stallSeconds) {
      /* Benched, not just stopped — see `retrySeconds`. */
      this.cooloff = this.tune.retrySeconds;
      this.stand();
      return idle;
    }

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
          /*
           * The anchor's OWN surface, not the old one by habit. A returning
           * foot that had already crossed is going home to the NEW face,
           * and aiming a wall point with the floor's normal is a foothold
           * that can never be honoured — measured as a front foot groping
           * at its own anchor indefinitely while the corner cycled
           * recover/transfer around it.
           */
          this.aimNormal.copy(
            this.owner.get(leg.slot) === 'new' ? this.newUp : this.oldUp,
          );
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
      if (planted < this.tune.minPlanted) { this.state = 'recover'; return cmd; }
      /*
       * OVERLAP, HALF ONE: a release may go out over ONE ordinary creep.
       *
       * Waiting for an empty sky between grips is what made the corner
       * strictly sequential — grip, wait, creep, wait, grip — and the wait
       * is most of the lost speed. One creep step in the air is the gait's
       * own steady state (a swing is in the air most of every cycle), so a
       * crossing released across it leaves four planted, which is the same
       * support the tuning already accepts as its floor. Anything else in
       * the air — two feet, a groping foot, a foot the scheduler put on the
       * new surface and lost — is not that steady state, and the queue
       * waits exactly as it always did.
       */
      const airborne = legs.filter((l) => !l.planted);
      /*
       * The one airborne foot may be either kind of ordinary step: an OLD
       * foot creeping (only while the middle row is going — creeping a rear
       * foot that should be transferring stalled the rear row for forty
       * frames at a stretch), or a NEW foot the drive is re-stepping through
       * `restepAim` (fine under any transfer, it renews the stance the body
       * is folding over). A groping foot is neither — that is a foot in
       * trouble, and the queue waits.
       */
      const flier = airborne.length === 1 ? airborne[0] : undefined;
      const creepOnly = flier !== undefined
        && !flier.groping
        && (this.owner.get(flier.slot) === 'new'
          || this.labelFor(this.row) === 'transferMiddle');
      /*
       * NEVER while the leading row is still going on. The front grips are
       * the fragile part of the whole manoeuvre — the body has to fold onto
       * the new face before a front foot's hold is real, and every attempt
       * to hurry that phase has jammed it (measured three separate ways: a
       * fast clock, a near-home gate, and this very overlap ungated — all
       * ended with the grip dragged back off and the corner re-acquiring
       * for hundreds of frames). Past the front row her attitude is
       * committed and a grip is just a grip.
       */
      if (this.row === 0 || !creepOnly
        || planted - 1 < this.tune.minPlanted) return cmd;
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
  /**
   * The corner's PRE-TILT: how far of the way toward the new face her
   * attitude goal may lean this frame, with the face itself written into
   * `out`. Nought until a front grip is actually holding the new surface —
   * the grip is the proof the lean stands on — then a small share for one
   * and a larger one for both. See `CornerTuning.leanOne`.
   *
   * A SHARE of the measured goal rather than an absolute angle, so it needs
   * no braking of its own: the walker's easing and rate cap already own how
   * fast an attitude may move, and once the crease flips the measured goal
   * onto the new face the blend collapses to nothing by construction.
   */
  leanToward(out: THREE.Vector3): number {
    if (!this.active) return 0;
    const front = this.rows[0];
    if (!front || front.length === 0) return 0;
    let across = 0;
    for (const slot of front) {
      if (this.owner.get(slot) === 'new') across += 1;
    }
    if (across === 0) return 0;
    out.copy(this.newUp);
    return across >= front.length
      ? this.tune.leanBoth ?? 0
      : this.tune.leanOne ?? 0;
  }

  report(legs: readonly CornerLeg[], up?: THREE.Vector3): CornerReport {
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
      fold: this.active && up ? angleBetween(up, this.newUp) : 0,
      candidateMm: this.hasCandidate ? +(this.candidateRange * MM).toFixed(2) : -1,
      feet,
    };
  }
}
