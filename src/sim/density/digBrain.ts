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
import type { StrollIntent } from '../antStroll';
import {
  CASTE_DIG, boreRadiusMm, boreSegmentMm, toUnits, type Caste,
} from './casteDig';

export type DigPhase = 'walking' | 'facing' | 'closing' | 'digging';

/** What the brain needs the world to answer. */
export interface DigWorld {
  /** Is this point inside soil? */
  solidAt(x: number, y: number, z: number): boolean;
  /** The top of the soil under an x/z, seen from a height. */
  surfaceAt(x: number, z: number, from?: number): number | null;
  /** Take a bore out, starting at `origin` and running along `aim`. */
  carve(
    origin: readonly [number, number, number],
    aim: readonly [number, number, number],
    length: number, radius: number,
  ): void;
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

export class DigBrain {
  phase: DigPhase = 'walking';

  site: DigSite | null = null;

  /** 0..1 through the current bite — what the round bar draws. */
  progress = 0;

  /** Bites completed, and sites armed. A probe watches both. */
  bites = 0;

  arms = 0;

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
  arm(at: THREE.Vector3): void {
    this.arms += 1;
    this.progress = 0;
    this.creptSet = false;
    this.failedCloses = 0;
    const margin = 1.2;
    const span = this.world.size - margin * 2;
    for (let tries = 0; tries < 12; tries += 1) {
      const tx = margin + this.rand() * span;
      const tz = margin + this.rand() * span;
      const top = this.world.surfaceAt(tx, tz);
      if (top === null) continue;
      const bearing = this.rand() * Math.PI * 2;
      /*
       * BACK OFF BY HER OWN JAW REACH. She has to end up with her mandibles
       * over the target, and her mandibles are a measured distance in front
       * of her thorax — so the stand spot is the target minus that, along the
       * approach. A constant here would put a major and a minim in the same
       * place and only one of them would be able to reach.
       */
      const back = toUnits(CASTE_DIG[this.caste].jawForwardOfThoraxMm);
      const sx = tx - Math.sin(bearing) * back;
      const sz = tz - Math.cos(bearing) * back;
      const standTop = this.world.surfaceAt(sx, sz);
      if (standTop === null) continue;
      this.site = {
        target: new THREE.Vector3(tx, top, tz),
        stand: new THREE.Vector3(sx, standTop, sz),
        heading: bearing,
        bites: 0,
      };
      this.phase = 'walking';
      this.left = PATIENCE.walking;
      /* Distance decides how long she is given, within reason: a site across
       * the tray is not a hang just because it is far. */
      const far = Math.hypot(sx - at.x, sz - at.z);
      this.left = Math.min(PATIENCE.walking, 3 + far * 2.2);
      return;
    }
    /* Twelve refusals means the surface query is answering null everywhere it
     * was asked, which is a terrain fault rather than a brain one. Keep the
     * old site rather than clearing it, so the caller sees no phase change and
     * the next tick tries again. */
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
    if (this.onFace) {
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
  private dig(dt: number): StrollIntent {
    if (!this.onFace) {
      this.phase = 'closing';
      this.left = PATIENCE.closing;
      this.progress = 0;
      return { walk: 0, turn: 0, dig: 1 };
    }
    if (this.left <= 0) { this.arm(this.jaw); return { walk: 0, turn: 0 }; }
    this.progress += dt / BITE_SECONDS;
    if (this.progress < 1) return { walk: 0, turn: 0, dig: 1 };

    /*
     * AND THE SOIL COMES AWAY — from her jaw, along her aim, one caste
     * segment. `boreSegmentMm` and not `lengthMm`: the round work face
     * reaches a radius further, so the segment is short by exactly that and
     * the finished hole is the depth the spec asks for.
     */
    this.world.carve(
      [this.jaw.x, this.jaw.y, this.jaw.z],
      [this.aim.x, this.aim.y, this.aim.z],
      toUnits(boreSegmentMm(this.caste)),
      toUnits(boreRadiusMm(this.caste)),
    );
    this.bites += 1;
    this.site!.bites += 1;
    this.progress = 0;
    /*
     * THE WORK FACE MOVES WITH THE TUNNEL — and this is the difference
     * between a shaft and a trench.
     *
     * Left to creep blindly forward, she stopped the instant ANY soil came
     * within reach — which at the lip of a fresh bite is its own near wall,
     * a step away. So she nibbled the rim, shuffled on, nibbled the next rim,
     * and produced a line of shallow scoops across the surface. Joshua had
     * already reported that shape once, on the voxel build: "she isn't
     * digging straight down at first and making a trench, haha."
     *
     * Advancing the target by the bore she just took gives her somewhere to
     * BE rather than merely something to touch. She walks to stand over the
     * new deepest point, which is further along her aim and lower, so the
     * next bite continues the hole instead of starting another one.
     */
    this.site!.target.addScaledVector(this.aim, toUnits(boreSegmentMm(this.caste)));
    const standTop = this.world.surfaceAt(
      this.site!.target.x, this.site!.target.z, this.site!.target.y + 2,
    );
    const back = toUnits(CASTE_DIG[this.caste].jawForwardOfThoraxMm);
    this.site!.stand.set(
      this.site!.target.x - Math.sin(this.site!.heading) * back,
      standTop ?? this.site!.stand.y,
      this.site!.target.z - Math.cos(this.site!.heading) * back,
    );
    /* Straight back to closing, not to a new site: the face has moved away
     * from her by one bore and the next mouthful is the next step into the
     * tunnel she has just started. */
    this.phase = 'closing';
    this.left = PATIENCE.closing;
    this.creptSet = false;
    return { walk: 0, turn: 0, dig: 1 };
  }
}
