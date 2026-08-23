/**
 * WALK TO IT, FACE IT, THEN DIG IT — and not before.
 *
 * This is the thing card 01 records as never built, and the complaint behind
 * it has been made four separate ways:
 *
 *   "the ants body faces and walks up to the dirt being dug so it will always
 *    look more natural and until the ant is touching that block, it won't dig
 *    it remotely"
 *
 *   "it needs to act like a person controlling it. Walk to a square, dig it,
 *    move forward or any direction once it picks a new location so like arm
 *    it, move to it, dig. Pick new target, arm the location, walk to it, dig"
 *
 * The old founding brain chewed cells up to 12 mm away and 7.5 mm to the side,
 * at any angle, because nothing in it had a notion of where her mandibles
 * were. Soil left an ant-length away and arrived nowhere; that is what "it
 * digs remotely" means and it is why the digging never read as work.
 *
 * ## The gate is her ANATOMY, not a distance constant
 *
 * The bore starts AT HER JAW. `boreFrom` is cut flat at its origin, so soil
 * behind that plane cannot be removed however the aim is pointed — she cannot
 * scoop out the ground under her own gaster. And she may only start a bite
 * when the field is actually solid a short way along her aim, which is the
 * literal reading of "until the ant is touching that block". Both are
 * geometry, so neither can drift out of step with the animation the way a
 * hand-tuned radius would.
 *
 * ## Every phase has a deadline
 *
 * The previous brain deadlocked twice, and both times the shape was the same:
 * a state waiting for a condition the world had stopped being able to satisfy.
 * Once it was a target dropped one frame before the excavator would have
 * finished it; once it was a stand spot that had become unreachable. So no
 * phase here can wait forever. A phase that runs out of patience re-arms, and
 * re-arming is cheap: the site was picked at random and another one is as
 * good. A brain that gives up and tries elsewhere is an animal; a brain that
 * waits is a hang.
 */

import * as THREE from 'three';
import { DIG_PITCH_DOWN } from '../AntBody';
import type { StrollIntent } from '../antStroll';
import {
  CASTE_DIG, MM_PER_UNIT, boreRadiusMm, boreSegmentMm, toUnits, type Caste,
} from './casteDig';
import { seatOnSoil } from './digSweep';
import {
  ShaftTrack, advanceRateMmS, continueTrack, foundingTrack,
} from './foundingTrack';
import type { DigPiece } from '../../scenes/digPlan';

export type DigPhase = 'walking' | 'facing' | 'closing' | 'digging' | 'moving';

/**
 * A place she could stand and work from — the answer the pose search gives.
 */
export interface WorkingPose {
  x: number;
  y: number;
  z: number;
  heading: number;
}

/**
 * How many pieces are added each time she digs out the plan she has.
 *
 * Small, so the nest keeps its shape rather than sprouting a corridor at a
 * time, and so the rail rebuild that comes with it stays cheap.
 */
const GROWTH_PIECES = 3;

/** How much closer counts as progress, in world units — a tenth of a mm. */
const PROGRESS_MIN = 0.02;

/** How long she may fail to close on a pose before writing it off. */
const STALL_SECONDS = 1.5;

/** How near a refused pose a candidate must be to count as the same one. */
const REFUSED_NEAR = 0.15;

/** What the brain needs the world to answer. */
export interface DigWorld {
  /** Is this point inside soil? */
  solidAt(x: number, y: number, z: number): boolean;
  /** The top of the soil under an x/z, seen from a height. */
  surfaceAt(x: number, z: number, from?: number): number | null;
  /**
   * Take a BEAT of the cut out — a run of overlapping spheres along the
   * bore's line, handed over by `DigJob`. The island's shape, not a capsule
   * per press: see `digSweep.ts` for why the difference is the scalloping.
   */
  carveSweep(points: readonly THREE.Vector3[], radius: number): void;
  /**
   * WHERE HER BODY COULD ACTUALLY STAND IN THIS COLUMN, or null if nowhere.
   *
   * Phase 11's whole subject, and it exists because of what Phase 1 proved:
   * the digger had no navigability sense at all. The stroller has one —
   * `StrollSenses.groundAhead` refuses soil that is where her body wants to
   * be — and the scene hands the digger a different, smaller world, so every
   * approach it ever steered was blind. That did not show while she could
   * walk through dirt. It shows now: with the soil made solid she spent 3145
   * frames of 7200 in `closing`, creeping at a face she had no legal path
   * to.
   *
   * Returns the y her body ORIGIN would sit at, seated on the floor found
   * looking down from `fromY` — so asking from HER OWN height finds the
   * floor of the tunnel she is in, where asking from above the tray finds
   * the open surface. Omit it for the surface; that is the same default
   * `surfaceAt` already uses, and the two must agree or a site can be armed
   * on one floor and walked to on another. Null
   * means either no floor there or no room for her body above it, and the
   * caller must not need to know which: both mean "not somewhere she can
   * be".
   *
   * THIS IS SENSING, NOT SAFETY. `BodyShell` still guarantees she cannot
   * enter soil whatever the brain asks for. This exists so she stops asking
   * — the difference between an ant that walks around an obstacle and one
   * that bumps into it until a timer expires.
   */
  standAt(x: number, z: number, heading: number, fromY?: number): number | null;
  /**
   * IS SHE ON THE RAIL RIGHT NOW — inside the tunnel, carried by it?
   *
   * It changes what "go to the face" means. On open ground it is a place to
   * steer toward; on the rail it is simply FURTHER ALONG, and a brain that
   * kept steering by heading would be turning a body the tunnel is already
   * turning.
   */
  onRail(): boolean;
  /** The tank's interior span, in world units. */
  size: number;
}

/** Where she is going and what she means to do when she gets there. */
export interface DigSite {
  /** The patch of surface she means to open. */
  target: THREE.Vector3;
  /** Where she has to stand for her jaws to be over it. */
  stand: THREE.Vector3;
  /** How many bites this site has taken — the tunnel's own progress. */
  bites: number;
  /** The bearing she has to hold while she works. */
  heading: number;
}

/**
 * How steeply she bites, in radians below her own forward.
 *
 * Steep, and that is not a style choice. Standing on flat soil her jaw is
 * ABOVE the surface, so a bore aimed level travels through air and the reach
 * gate never opens — she would face a perfectly good patch of ground and
 * refuse to touch it forever. An ant opening an entrance bites DOWN at the
 * ground in front of her, and a steep aim is also what turns the first few
 * bites into a mouth rather than a scrape.
 */
export const DIG_PITCH = 1.0;

/**
 * HER MANDIBLE REACH — how far along her aim soil must be to count as under
 * her jaws. Measured on this rig, not borrowed.
 *
 * `hexapod.ts` records that the dig dip brings her jaw "from 1.121 mm over the
 * soil down to 0.070 mm". That is the ISLAND rig at the island's seat, and it
 * is not true here: measured in the tray, dipped, on flat ground, her
 * mandibles settle 1.80 mm above the surface and stay there. The first gate
 * was 0.35 mm and could therefore never open — she walked to eleven sites,
 * faced every one, creeped the whole allowance and took not one bite. A
 * borrowed measurement is a guess with a decimal point on it.
 *
 * So: 1.80 mm of standing clearance plus a little for ground that is not
 * flat, and scaled by body length so a worker is not handed a queen's reach.
 *
 * THIS IS THE NUMBER JOSHUA'S RULE IS ABOUT — "until the ant is touching that
 * block, it won't dig it remotely" — so it is worth saying what it replaces.
 * The old brain chewed cells up to 12 mm away and 7.5 mm to the SIDE, at any
 * angle, with no notion of where her mandibles were. This is a quarter of her
 * own body length, along her own aim, from a bore that starts at her jaw and
 * is cut flat behind it. A head bent to the ground at her feet is not digging
 * at a distance; the previous behaviour was.
 */
export const TOUCH_PER_LENGTH = 0.28;

export function touchMm(caste: Caste): number {
  return CASTE_DIG[caste].lengthMm * TOUCH_PER_LENGTH;
}

/**
 * HOW FAR THE AIM IS WALKED LOOKING FOR SOIL, in millimetres — the island's
 * `NOSE_REACH + JAW_PAST_NOSE`, measured from her CENTRE rather than her jaw.
 *
 * This is the number that lets her open an entrance on level ground, and its
 * absence is why the tray could not. A gate asking whether soil lay within a
 * couple of millimetres of her MANDIBLES fails on flat soil, because her jaw
 * sits 1.89 mm above it even fully dipped — thirteen sites armed, no bites.
 * Measured from her centre the same ground is well inside reach, and the bore
 * is then SEATED where the ray lands rather than started where her mouth
 * happens to be.
 *
 * It is not "digging at a distance": nothing is removed at the far end of the
 * ray. The ray only finds the face; the cut begins half a bore-radius on the
 * AIR side of it and eats forward from there.
 */
export const NOSE_REACH_MM = 5.1;

/** Seconds of held, gated effort per bite. "It will take over time." */
export const BITE_SECONDS = 2.4;

/** Close enough to the stand spot, in world units. */
export const ARRIVE = 0.18;

/** Close enough to the bearing, in radians. */
export const FACE_TOL = 0.12;

/** How hard she turns per radian of error — a P term, clamped to -1..1. */
const TURN_GAIN = 2.2;

/** Patience, per phase, in seconds. See the note on deadlocks. */
export const PATIENCE = { walking: 14, facing: 4, closing: 9, digging: 8 } as const;

/**
 * How far she may walk forward hunting for the face, in world units.
 *
 * A BORE LENGTH AND A HALF, and the first value here was a fifth of that,
 * which is why she took two bites in two minutes. The mistake was thinking of
 * this as a nudge to correct for uneven ground. It is not: after a bite the
 * soil she was chewing is GONE, she is standing at the lip of a fresh hole
 * with her mandibles over air, and the next face is at the far side of a
 * mouthful she just removed. Getting to it means walking INTO her own
 * excavation, which is what digging an entrance ramp actually looks like.
 *
 * Measured before and after: 0.35 units gave up at every lip and sent her
 * across the tray for a new random site, so she spent 93% of two minutes
 * walking and completed two bites.
 */
export const CLOSE_WALK = 2.5;

/**
 * How many failed approaches at one site before she tries somewhere else.
 *
 * More than one, because a single failure is the ordinary case at a lip —
 * she has to step down into what she dug. Not many more, because a face that
 * cannot be reached twice running is a face she is not going to reach.
 */
export const CLOSE_TRIES = 2;

/**
 * How far from the glass she stops working, in world units.
 *
 * Wider than the margin `arm` picks sites in, so a site chosen legally cannot
 * put her over the line the moment she leans into it. A queen is 1.8 units
 * long; this is most of her.
 */
export const EDGE_MARGIN = 1.0;

const wrap = (a: number): number => {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
};

const clamp1 = (x: number): number => Math.max(-1, Math.min(1, x));

/**
 * HOW FAR BEHIND THE FACE SHE STANDS TO WORK IT, in millimetres.
 *
 * Her mandibles sit a measured distance in front of her thorax and her reach
 * is `NOSE_REACH_MM` beyond that; standing this far back down the rail puts
 * the face inside it with room to spare, and puts HER inside tunnel that is
 * already cut. Nearer than her own body length and she would be asked to
 * stand where the face is.
 */
const STATION_BACK_MM = 4;

const FACE_AT = new THREE.Vector3();
const CARVE_PTS: THREE.Vector3[] = [];
const SEAT = new THREE.Vector3();

export class DigBrain {
  phase: DigPhase = 'walking';

  site: DigSite | null = null;

  /** 0..1 through the current bite — what the round bar draws. */
  progress = 0;

  /** Bites completed, and sites armed. A probe watches both. */
  bites = 0;

  arms = 0;

  /**
   * The nest she is digging, drawn in full before the first grain moves.
   * Null until `arm` lays one. See `foundingTrack`.
   */
  track: ShaftTrack | null = null;

  /** Where she is heading in order to work, when `phase` is `moving`. */
  pose: WorkingPose | null = null;

  /** The closest she has got to the current pose, and for how long. */
  private moveBest = Infinity;

  private moveStall = 0;

  /** How many working poses have been searched for, and how many found. */
  poseSearches = 0;

  poseFound = 0;

  /** Where the last bore started and ran, for the gauge and for probes. */
  readonly jaw = new THREE.Vector3();

  readonly aim = new THREE.Vector3();

  /** True when her jaws are actually on soil — the gate, exposed. */
  onFace = false;

  private left = 0;

  /** Where she was when this approach began, so the creep is a real distance
   * rather than an integrated guess at one. */
  private readonly creptFrom = new THREE.Vector3();

  private creptSet = false;

  private failedCloses = 0;

  /** Where she stood this frame, for the ray seat. */
  private readonly at = new THREE.Vector3();

  /** Where the last bore's face was found, and how far from her centre. */
  readonly seat = new THREE.Vector3();

  seatReachMm = 0;

  /** Whether a cut is being eaten right now. */
  /** Is soil actually leaving right now? On a track: she is at the face and
   *  there is track left to eat. */
  get cutting(): boolean {
    return this.phase === 'digging' && !!this.track && !this.track.done;
  }

  constructor(
    private readonly caste: Caste,
    private readonly world: DigWorld,
    private readonly rand: () => number = Math.random,
  ) {}

  /** Is she still on the tray, with room for her body? */
  private inside(at: THREE.Vector3): boolean {
    const edge = EDGE_MARGIN;
    return at.x > edge && at.x < this.world.size - edge
      && at.z > edge && at.z < this.world.size - edge;
  }

  /**
   * Pick a new place to work, at random.
   *
   * Randomised by Joshua's instruction, and it is also what makes the
   * deadline policy affordable: no site is special, so abandoning one costs
   * nothing. The stand spot is derived BACKWARD from the target along a
   * random approach bearing, so she always arrives facing her work rather
   * than arriving and then discovering she has to turn around.
   */
  /**
   * CHOOSE A MOUTH AND DRAW THE WHOLE NEST FROM IT.
   *
   * The old version of this picked a random patch of surface to bite and
   * nothing else — no notion of a tunnel, so every re-arm threw the last one
   * away. Now it lays a `ShaftTrack`: a plumb ten-millimetre drop and a few
   * pieces easing off vertical, taken from the same palette the player-facing
   * builder offers. The shape of the nest is decided here, once, and the rest
   * of this file only digs it.
   */
  arm(at: THREE.Vector3): void {
    this.arms += 1;
    this.progress = 0;
    this.creptSet = false;
    this.failedCloses = 0;
    this.track = null;
    this.pose = null;
    const margin = 1.2;
    const span = this.world.size - margin * 2;
    for (let tries = 0; tries < 12; tries += 1) {
      const mx = margin + this.rand() * span;
      const mz = margin + this.rand() * span;
      const top = this.world.surfaceAt(mx, mz);
      if (top === null) continue;
      const bearing = this.rand() * Math.PI * 2;
      /*
       * SHE STANDS BESIDE THE MOUTH, NOT ON IT — backed off by her own jaw
       * reach along the approach, the same rule the old stand spot used and
       * for the same reason: her mandibles are a measured distance in front
       * of her thorax, so a queen and a minim cannot share a stand point.
       */
      const back = toUnits(CASTE_DIG[this.caste].jawForwardOfThoraxMm);
      const sx = mx - Math.sin(bearing) * back;
      const sz = mz - Math.cos(bearing) * back;
      const standTop = this.world.surfaceAt(sx, sz);
      if (standTop === null) continue;
      this.site = {
        target: new THREE.Vector3(mx, top, mz),
        stand: new THREE.Vector3(sx, standTop, sz),
        heading: bearing,
        bites: 0,
      };
      this.track = new ShaftTrack(
        this.caste,
        this.pieces(),
        { x: mx, y: top, z: mz },
        { x: Math.sin(bearing), y: 0, z: Math.cos(bearing) },
      );
      this.phase = 'walking';
      const far = Math.hypot(sx - at.x, sz - at.z);
      this.left = Math.min(PATIENCE.walking, 3 + far * 2.2);
      return;
    }
    /* Twelve refusals means the surface query is answering null everywhere it
     * was asked, which is a terrain fault rather than a brain one. Keep the
     * old site rather than clearing it, so the caller sees no phase change and
     * the next tick tries again. */
  }

  /** The pieces this caste's founding nest is made of. Seeded. */
  private pieces(): DigPiece[] {
    return foundingTrack(this.rand);
  }

  /**
   * One tick of wanting to dig. Returns what she wants her body to do.
   *
   * `jawAt` is asked of the caller because only the model knows where her
   * mandibles ended up after the gait, the seat and the IK have all had their
   * say. Deriving it from her origin and a constant is how the old brain
   * came to believe it was touching soil it was nowhere near.
   */
  step(
    dt: number,
    at: THREE.Vector3,
    heading: number,
    forward: THREE.Vector3,
    jawAt: (into: THREE.Vector3) => boolean,
  ): StrollIntent {
    if (!this.site) { this.arm(at); return { walk: 0, turn: 0 }; }
    /*
     * THE GLASS COMES FIRST, whatever she was doing.
     *
     * The digger has no `groundAhead` — it steers to a stand spot rather than
     * wandering — so nothing in the loop was stopping it walking her out of
     * the tank. `close()` in particular advances her blindly toward a face,
     * and a face near the wall is a face on the far side of it. Measured:
     * over sixty seconds she reached 28.66 on a tray that ends at 25.6, spent
     * 875 frames off the soil entirely and 592 with nothing under her feet.
     *
     * `arm` already picks sites inside a margin, so re-arming is both the fix
     * and the way back: the next stand spot is inside the tray and she walks
     * to it. No new steering, no wall-follow, no second idea of where the
     * edges are.
     *
     * NOT WHILE SHE IS WALKING, though, and the first cut missed that. Being
     * outside is a state that persists for as long as it takes her to walk
     * back, so a guard that fires every frame re-armed every frame — 4913
     * sites in two minutes, nine bites, and she never got anywhere because
     * the destination changed before she could reach it. Walking IS the
     * recovery, so it has to be allowed to run.
     */
    if (!this.inside(at) && this.phase !== 'walking') {
      this.arm(at);
      return { walk: 0, turn: 0 };
    }
    this.left -= dt;

    /* The aim: her forward, pitched down. Computed every tick because her
     * forward moves, and a stale aim is a bore that goes somewhere she is no
     * longer looking. */
    this.aim.set(forward.x, 0, forward.z).normalize()
      .multiplyScalar(Math.cos(DIG_PITCH));
    this.aim.y = -Math.sin(DIG_PITCH);
    this.aim.normalize();

    this.at.copy(at);
    if (!jawAt(this.jaw)) return { walk: 0, turn: 0 };
    const touch = toUnits(touchMm(this.caste));
    this.onFace = this.world.solidAt(
      this.jaw.x + this.aim.x * touch,
      this.jaw.y + this.aim.y * touch,
      this.jaw.z + this.aim.z * touch,
    );

    switch (this.phase) {
      case 'walking': return this.walk(at, heading);
      case 'facing': return this.face(heading);
      case 'closing': return this.close(at);
      case 'moving': return this.move(dt, at, heading);
      default: return this.dig(dt);
    }
  }

  /** Steer to the stand spot; a wall of patience behind her. */
  private walk(at: THREE.Vector3, heading: number): StrollIntent {
    const site = this.site!;
    const dx = site.stand.x - at.x;
    const dz = site.stand.z - at.z;
    const away = Math.hypot(dx, dz);
    if (away <= ARRIVE) {
      this.phase = 'facing';
      this.left = PATIENCE.facing;
      return { walk: 0, turn: 0 };
    }
    if (this.left <= 0) { this.arm(at); return { walk: 0, turn: 0 }; }
    const want = Math.atan2(dx, dz);
    const off = wrap(want - heading);
    /*
     * WALKING AND TURNING AT ONCE, but the walk falls away as the error grows
     * — full ahead while she is pointed at it, nothing at all while she is
     * pointed away. Marching at a target that is behind her is the arc that
     * made the old approach look like a drunk.
     */
    return { walk: Math.max(0, Math.cos(off)), turn: clamp1(off * TURN_GAIN) };
  }

  /** Settle onto the working bearing before touching anything. */
  private face(heading: number): StrollIntent {
    const site = this.site!;
    const off = wrap(site.heading - heading);
    if (Math.abs(off) <= FACE_TOL) {
      this.phase = 'closing';
      this.left = PATIENCE.closing;
      this.creptSet = false;
      return { walk: 0, turn: 0 };
    }
    if (this.left <= 0) {
      /* She could not settle on the bearing. Take the one she has rather than
       * spin: the site was random and so is this. */
      site.heading = heading;
      this.phase = 'closing';
      this.left = PATIENCE.closing;
      this.creptSet = false;
      return { walk: 0, turn: 0 };
    }
    return { walk: 0, turn: clamp1(off * TURN_GAIN) };
  }

  /**
   * Creep the last hair until her mandibles are ON the soil.
   *
   * The stand spot is computed from a rig measurement and the ground is not
   * flat, so "arrived" and "touching" are close but not the same thing. This
   * is the difference, walked rather than assumed — and bounded, so a face
   * that is not there sends her elsewhere instead of into the glass.
   */
  private close(at: THREE.Vector3): StrollIntent {
    if (!this.creptSet) { this.creptFrom.copy(at); this.creptSet = true; }
    /*
     * THE GATE HERE IS THE ONE `dig` WILL APPLY, and it used to be a
     * different one.
     *
     * This asked whether her JAW was on soil; `dig` asks whether a ray from
     * her CENTRE meets soil within her nose reach. Standing on the lip of a
     * bore she had just cut, her jaw touched the rim and the ray went down
     * her own hole and found nothing — so `close` sent her to dig, `dig`
     * sent her back, and she oscillated every frame for nineteen hundred of
     * them without moving. Two gates that disagree are a livelock however
     * patient each of them is.
     */
    if (this.canSeat()) {
      this.phase = 'digging';
      this.left = PATIENCE.digging;
      this.progress = 0;
      this.failedCloses = 0;
      return { walk: 0, turn: 0, dig: 1 };
    }
    /*
     * STEER TO THE STAND SPOT while closing, rather than walking blindly
     * ahead. After a bite that spot has moved down her own tunnel, so this is
     * what carries her into the hole instead of along the top of it.
     */
    const toStand = Math.hypot(
      this.site!.stand.x - at.x, this.site!.stand.z - at.z,
    );
    const walked = Math.hypot(at.x - this.creptFrom.x, at.z - this.creptFrom.z);
    if (this.left <= 0 || walked >= CLOSE_WALK) {
      this.failedCloses += 1;
      if (this.failedCloses >= CLOSE_TRIES) { this.arm(at); return { walk: 0, turn: 0 }; }
      /* One more go from where she now stands, before writing the site off. */
      this.left = PATIENCE.closing;
      this.creptSet = false;
      return { walk: 0, turn: 0, dig: 1 };
    }
    /*
     * HEAD ALREADY DOWN while she closes. The dip is what puts her mandibles
     * on the soil — 1.121 mm above it standing, 0.070 mm dipped — so a gate
     * checked with her head up can never open, and she would creep the whole
     * allowance and give up. Measured before the dip was wired: eleven sites
     * armed, not one bite taken.
     */
    /* Slow when she is nearly over it — a full stride past the face is how
     * she ends up biting the far wall of a hole she is standing in. */
    return { walk: toStand > 0.25 ? 0.6 : 0.3, turn: 0, dig: 1 };
  }

  /**
   * The bite. Held effort, gated on contact every frame.
   *
   * Losing contact mid-bite drops her back to closing rather than finishing
   * anyway — the bar is a claim that she is working on something, and a bar
   * that fills while her jaws are in the air is the "magical digging" this
   * whole file exists to end.
   */
  /**
   * SHE EATS ALONG THE TRACK, and the track was drawn before she started.
   *
   * Joshua, 2026-08-23: "How about the AI using like the rail system where it
   * creates random preset tunnels/pipes/tubing. Think plumbing with starting
   * with a straight down piece that's 6x6x10mm, but it still digs the dirt
   * over time."
   *
   * What this replaces is three phases of searching. A bore used to be seated
   * on whatever soil her aim ray met, so the tunnel's shape was an accident
   * of where she stood; then the next work face had to be found, and a place
   * to stand and reach it had to be found, and neither search could be
   * trusted because the thing being searched for did not exist until she made
   * it. Two bores in two minutes was the honest result.
   *
   * On a track all three are coordinates. The face is `s = dug`. A place to
   * stand is `s = dug - back`, which is excavated by definition because the
   * cut has already passed it. Continuity is not measured, it is what a curve
   * IS.
   *
   * The soil still comes out over time — the advance is the caste's own
   * volumetric rate expressed as millimetres of tunnel a second, so a metre
   * of track costs exactly what the same volume of bores cost.
   */
  private dig(dt: number): StrollIntent {
    const track = this.track;
    if (!track) { this.arm(this.at); return { walk: 0, turn: 0 }; }
    if (track.done) {
      /*
       * THE PLAN IS DUG, SO THERE IS MORE PLAN.
       *
       * This used to stop, which read from the device as "it dug for a little
       * bit and stopped" — the founding track is only a handful of pieces and
       * she gets through all of it. A colony does not finish. Another few
       * pieces are laid on the end from the same palette and the same seeded
       * stream, so the nest grows as one continuous tunnel rather than as a
       * second unrelated hole.
       */
      const last = track.pieces[track.pieces.length - 1];
      track.extend(continueTrack(this.rand, last?.pitch ?? -45, GROWTH_PIECES));
      return { walk: 0, turn: 0, dig: 1 };
    }

    const face = track.face();
    if (!face) { this.arm(this.at); return { walk: 0, turn: 0 }; }
    FACE_AT.set(face.at.x, face.at.y, face.at.z);

    /*
     * CAN SHE TOUCH IT? The reach rule is unchanged and non-negotiable: soil
     * only leaves where her mandibles are. What HAS changed is the answer
     * when she cannot — she now knows exactly where to go, rather than
     * hunting for it.
     */
    if (FACE_AT.distanceTo(this.at) > toUnits(NOSE_REACH_MM)) {
      /*
       * ON THE RAIL, "get to the face" IS "walk deeper". No steering, no
       * station to find, no pose to search: the tunnel is already pointed at
       * the work and she is in it.
       */
      if (this.world.onRail()) return { walk: 1, turn: 0, dig: 1 };
      const station = track.station(STATION_BACK_MM);
      if (station) {
        this.pose = {
          x: station.at.x,
          y: station.at.y,
          z: station.at.z,
          heading: Math.atan2(station.forward.x, station.forward.z),
        };
        this.phase = 'moving';
        this.left = PATIENCE.walking;
        this.moveBest = Infinity;
        this.moveStall = 0;
        return { walk: 0, turn: 0, dig: 1 };
      }
      this.toClosing();
      return { walk: 0, turn: 0, dig: 1 };
    }

    /* Within reach: eat. */
    const before = track.dugMm;
    const points = track.advance(
      advanceRateMmS(this.caste) * dt, this.boreRadius(),
    );
    if (points.length > 0) {
      for (const p of points) CARVE_PTS.push(new THREE.Vector3(p.x, p.y, p.z));
      this.world.carveSweep(CARVE_PTS, this.boreRadius());
      CARVE_PTS.length = 0;
    }
    /* One "bite" per millimetre of tunnel, so the counter still means
     * something comparable to what it meant before the track existed. */
    if (Math.floor(track.dugMm) > Math.floor(before)) this.bites += 1;
    this.progress = track.plannedMm > 0 ? track.dugMm / track.plannedMm : 0;
    this.seat.copy(FACE_AT);
    this.seatReachMm = FACE_AT.distanceTo(this.at) * MM_PER_UNIT;
    return { walk: 0, turn: 0, dig: 1 };
  }

  /**
   * Steer to the working station, then hand back to the ordinary approach.
   *
   * Unlike the version this replaces, the destination is a point on the rail
   * BEHIND the cut face — so it is inside tunnel she has already dug, and
   * "can she get there" is a question about walking rather than about whether
   * such a place exists at all.
   */
  private move(dt: number, at: THREE.Vector3, heading: number): StrollIntent {
    const pose = this.pose;
    if (!pose) { this.toClosing(); return { walk: 0, turn: 0 }; }
    const dx = pose.x - at.x;
    const dz = pose.z - at.z;
    const away = Math.hypot(dx, dz);
    if (away <= ARRIVE) {
      this.phase = 'digging';
      this.left = PATIENCE.digging;
      return { walk: 0, turn: 0, dig: 1 };
    }
    /*
     * IS SHE STILL GETTING CLOSER? The body clamp can refuse a walk the brain
     * thinks is fine, and a steering loop with no notion of progress leans on
     * that wall until its timer runs out. Measured before this existed: she
     * stalled two millimetres short and re-chose the identical destination
     * eight times running.
     */
    if (away < this.moveBest - PROGRESS_MIN) {
      this.moveBest = away;
      this.moveStall = 0;
    } else {
      this.moveStall += dt;
    }
    if (this.left <= 0 || this.moveStall >= STALL_SECONDS) {
      /*
       * She cannot reach the station. Take the shallowest part of the shaft
       * she CAN stand in — further back up her own tunnel — before writing
       * the nest off. The old code re-armed a fresh random site here, which
       * threw away the tunnel she had just dug.
       */
      const nearer = this.track?.station(STATION_BACK_MM * 2) ?? null;
      if (nearer && Math.hypot(nearer.at.x - at.x, nearer.at.z - at.z) > ARRIVE) {
        this.pose = {
          x: nearer.at.x, y: nearer.at.y, z: nearer.at.z,
          heading: Math.atan2(nearer.forward.x, nearer.forward.z),
        };
        this.left = PATIENCE.walking;
        this.moveBest = Infinity;
        this.moveStall = 0;
        return { walk: 0, turn: 0 };
      }
      this.arm(at);
      return { walk: 0, turn: 0 };
    }
    const want = Math.atan2(dx, dz);
    const off = wrap(want - heading);
    return { walk: Math.max(0, Math.cos(off)), turn: clamp1(off * TURN_GAIN) };
  }

  /**
   * Could she start cutting from where she stands? On a track this is simply
   * whether the face is within her reach — the same question `dig` asks, kept
   * in one place so no two phases can hold different opinions about it. Two
   * that did cost nineteen hundred frames of a one-frame livelock.
   */
  private canSeat(): boolean {
    const face = this.track?.face();
    if (!face) return false;
    SEAT.set(face.at.x, face.at.y, face.at.z);
    return SEAT.distanceTo(this.at) <= toUnits(NOSE_REACH_MM);
  }

  /** Back to the approach, from wherever she is. */
  private toClosing(): void {
    this.phase = 'closing';
    this.left = PATIENCE.closing;
    this.creptSet = false;
  }

  private boreRadius(): number {
    return toUnits(boreRadiusMm(this.caste));
  }
}
