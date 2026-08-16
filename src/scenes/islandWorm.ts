/**
 * THE EARTHWORMS — the island's other diggers, and the first thing in it
 * that changes the world without being asked to.
 *
 * Asked for: "can we add a few earthworms on the island that will dig like
 * the queen, one bite per second, randomly move maybe 30-60 s per new
 * direction?" — and, in the same breath, the question that actually
 * decides whether it is a good idea: "how big of a hole would the worm
 * create? Might be enough that would be like automatic tunnel starters."
 *
 * ## A worm's burrow is its own body
 *
 * She digs with a shovel and it shows: her bite is 10 mm wide, 5 tall and
 * 3 deep, a wide low mouthful shaped for a passage she can walk down. A
 * worm has no shovel. It eats forward and the hole behind it is exactly as
 * wide as the worm — which for the model we have is 6 mm.
 *
 * That number is the whole answer to the question. Her own bore is about
 * 7 mm across, so a worm burrow is a hair narrower than a tunnel she digs
 * for herself — passable, not comfortable. A worm is a tunnel STARTER, not
 * a tunnel. What it leaves is a lead worth following and widening, which
 * is a better thing for the game than a free corridor.
 *
 * ## It only digs where the world is real
 *
 * The fine soil is a 192 mm window that follows HER. Outside it there is
 * no density field to carve, so a worm out of the window is a worm
 * pretending. Rather than fake it, one simply does not dig while it is out
 * there — see `WormSoil.covers`. That makes worms a thing that happens
 * near the player, which is where anyone would ever see it, and it is
 * stated here rather than discovered later as a bug.
 *
 * IT ALSO MEANS A WORM CAN STALL FOR GOOD. Measured: a worm digs about
 * 120 mm, leaves the window, and then never moves again while she stands
 * still — 300 seconds of probe travelled exactly as far as 90 did. In play
 * she moves and the window goes with her, so they start again; standing
 * in one spot, the worms around you finish their burrows and stop. Worth
 * knowing before anyone tunes the speed by watching one.
 *
 * ## Not a physics animal
 *
 * It burrows THROUGH soil rather than walking on it, so it has no footing,
 * no gravity and no collision — the tube it is carving is its collision.
 * The only thing it avoids is the sky: a worm that wandered up out of the
 * ground would leave the density field it lives in.
 */
import * as THREE from 'three';
import { MM } from '../world/worldScape';
import {
  type CreatureMind, newMind, setBehaviour, speedMm, think, thinkDue, tickMind,
} from './creatureBrain';
import { EARTHWORM } from './creatureKinds';

/** What a worm needs of the world, and nothing else. */
export interface WormSoil {
  /** Is this point inside the fine window that can actually be carved? */
  covers(x: number, y: number, z: number): boolean;
  /** Take a sphere of soil out. */
  carve(x: number, y: number, z: number, radius: number): void;
  /** The drawn surface above this column, so a worm can stay under it. */
  surfaceAt(x: number, z: number): number;
  /**
   * The bottom of the diggable earth under this column — sea level on this
   * island, because below that is water and these are not sea worms.
   *
   * A separate question from `surfaceAt`, and it has to be: out over the
   * water the seafloor is BELOW sea level, so the column there is inverted
   * and a worm has nowhere to be. That is what keeps them off the ocean —
   * no special case, just a band with no room in it.
   */
  baseAt(x: number, z: number): number;
}

/**
 * The hole it leaves, in millimetres — its own body thickness.
 *
 * Measured biology: a common Lumbricus terrestris is 6-10 mm thick, and
 * the burrow of a worm is its own diameter because the worm is what made
 * it. Six is the thin end, which is the honest match for a 150 mm worm
 * rather than a 250 mm one.
 */
export const WORM_BORE_MM = 6;

/** One bite a second, as asked. */
export const WORM_BITE_S = 1;

/**
 * How far it advances per bite, in millimetres.
 *
 * MUST BE UNDER THE BORE, or the burrow is a string of beads rather than a
 * tunnel — the same reason her own held stroke cuts two overlapping scoops
 * instead of one. Three against six is a half-diameter overlap, which
 * leaves a continuous tube with no scalloping worth seeing.
 *
 * It also sets the speed, and the speed is GAME TUNING rather than
 * biology. Three millimetres a second is roughly eighteen times what a
 * real earthworm manages in packed soil; a real one would take twenty
 * minutes to dig its own length, which is not a thing anybody would ever
 * notice happening.
 */
export const WORM_STEP_MM = 3;

/**
 * How many the island seeds.
 *
 * Fifty, scattered over the whole island rather than three around her
 * founding — Joshua's call, and the reason the old number was three no
 * longer applies. Three was chosen because each carves 180 mm of burrow a
 * minute and a dozen packed around one spot would turn the ground under her
 * into a sponge inside a session. Spread across 56 metres of island that is
 * not a risk: only the handful inside the 192 mm streamed window can dig at
 * all, and the rest are waiting their turn wherever she is not.
 *
 * The cost is drawing them, not simulating them — see `WORM_DRAWN`.
 */
export const WORM_COUNT = 200;

/**
 * How many worms have a BODY at any moment.
 *
 * Fifty skinned meshes at seventeen bones each, posed every frame against a
 * path, is real work for a phone — and forty-nine of them are somewhere she
 * cannot see. The bodies are a pool handed to whichever worms are nearest,
 * which costs a sort of fifty items a frame and nothing else.
 */
export const WORM_DRAWN = 6;

/**
 * How near a worm has to be to take part in the world, in world units.
 *
 * The shove list is resolved pairwise every frame. Two hundred worms spread
 * over 56 metres would be two hundred bodies of which a hundred and
 * ninety-nine are metres away — quadratic work to discover that nothing is
 * touching anything. Culled at the same reach the drawn pool uses, so the
 * worms she can bump into are exactly the worms she can see.
 *
 * Forty world units is 200 mm, a shade past the 192 mm streamed window.
 */
export const WORM_REACH = 40;

/** Seconds on one heading before it picks another — Joshua's range. */
export const WORM_HEADING_MIN_S = 30;
export const WORM_HEADING_MAX_S = 60;

/**
 * How fast it swings onto a new heading, RADIANS A SECOND — and it is a
 * hard angular limit, not an easing factor.
 *
 * THE TURN RADIUS HAS TO BEAT THE BORE, which is what the first cut got
 * wrong. It eased `dir` toward the target by half the remaining angle each
 * second, so a fresh 90-degree heading turned at about 45 degrees a second
 * against a speed of 3 mm — a turning radius of roughly 4 mm inside a 6 mm
 * tube. The worm was digging a knot, and it measured: with the body laid
 * on the path, only 49% of its bones were in air and the rest were drawn
 * through the wall of the very burrow they had just made.
 *
 * Radius is speed over rate, so 3 mm/s at 0.12 rad/s is 25 mm — four bores
 * wide, which a 150 mm body can lie in.
 */
export const WORM_TURN = 0.12;

/**
 * THE BAND A WORM LIVES IN, in millimetres.
 *
 * Joshua's placement: "keep them underground, maybe +5 mm from the max depth
 * the base of the earth is, to -5 mm underground, so they have a large area
 * to dig since they have the whole island — but do need to make sure they
 * don't end up in the ocean since they aren't sea worms."
 *
 * So the roaming volume is the whole soil column at wherever it stands, less
 * five millimetres of headroom at each end: near enough the surface to be
 * found by digging, never through it, and never down past the bottom of the
 * island into water.
 *
 * This REPLACES the surfacing behaviour of v0.1.71. That was written to
 * answer "I don't see any worms", it worked, and having seen them Joshua
 * asked for them underground instead. The visibility problem is solved a
 * different way now: fifty of them across the island rather than three, so
 * digging runs into one.
 *
 * Both are hard limits enforced on the STEP, not biases on the heading — see
 * `wanderDir` for why a bias alone is not enough, which cost a version.
 */
export const WORM_CEIL_MM = 5;
export const WORM_FLOOR_MM = 5;

/**
 * How much room it wants before it stops worrying about a wall.
 *
 * The hard limits above stop a worm; this is the distance over which it is
 * gently turned away from one, so it curves off rather than swimming into
 * the ceiling and sitting there. A whole body length: it is a long animal
 * and a turn takes it 25 mm of travel — see `WORM_TURN`.
 */
export const WORM_UNDER_MM = 12;

/**
 * How far apart the breadcrumbs are, in millimetres, and how many there
 * are — together, how much body the trail can hold.
 *
 * Every 3 mm over 56 points is 165 mm of path, which covers the 150 mm worm
 * with room to spare. The spacing matters more than it looks: the body is
 * laid on the POLYLINE through these points, so a coarse trail cuts the
 * corners of a curve and pushes the body into the wall. Five was the first
 * choice and it cut visibly.
 */
export const TRAIL_STEP_MM = 3;
export const TRAIL_POINTS = 56;

const S_WANT = new THREE.Vector3();
const S_HEAD = new THREE.Vector3();
const S_STEP = new THREE.Vector3();

/**
 * A new heading, turned away from whichever end of the band is nearer.
 *
 * Pulled out because it is the only interesting decision a worm makes, and
 * because "pick a random direction" and "stay inside the soil" fight unless
 * one of them is written as a bias on the other.
 *
 * `roomUpMm` is how far it may still rise before the ceiling, `roomDownMm`
 * how far it may still fall before the floor. Both, rather than one depth,
 * because the band has two ends now: the grass above and the bottom of the
 * island below. A worm given only the first happily dug down into the sea.
 *
 * NOTE THAT A BIAS IS NOT A LIMIT. This runs only when a heading is CHOSEN,
 * and a heading lasts thirty to sixty seconds against a turn rate of 0.12
 * rad/s — thirteen seconds to come about. A worm pointed at the sky keeps
 * going for tens of millimetres whatever this says, which is exactly how
 * v0.1.70 ended up with worms flying 28 mm above the ground. The hard stop
 * lives in `tick`; this only makes the hard stop rare.
 */
export function wanderDir(
  rand: () => number, roomUpMm: number, roomDownMm: number, into: THREE.Vector3,
): THREE.Vector3 {
  const yaw = rand() * Math.PI * 2;
  /* Mostly level. A worm that picked uniformly on a sphere would spend
   * most of its life going straight up or straight down. */
  let pitch = (rand() - 0.5) * 0.9;
  /* Near a wall, bend away from it in proportion to how near. At the wall
   * itself the bias is total; a body length off it, there is none. Both
   * ends are computed and the STRONGER one wins, so a worm in a thin seam
   * of soil with both walls close is turned by whichever it is nearer
   * rather than by the sum, which would cancel out to level and leave it
   * ploughing along one plane. */
  const nearTop = Math.max(0, 1 - roomUpMm / WORM_UNDER_MM);
  const nearFloor = Math.max(0, 1 - roomDownMm / WORM_UNDER_MM);
  const bend = Math.max(nearTop, nearFloor);
  if (bend > 0) {
    /* Away from the closer wall: down if the ceiling is nearer, up if the
     * floor is. */
    const away = nearTop >= nearFloor ? -1 : 1;
    pitch = away * Math.abs(pitch) * bend + pitch * (1 - bend);
  }
  const flat = Math.cos(pitch);
  return into.set(Math.sin(yaw) * flat, Math.sin(pitch), Math.cos(yaw) * flat)
    .normalize();
}

export class Worm {
  /** Its head — the end that does the digging. */
  readonly at = new THREE.Vector3();

  /** The way it is pointed. Its body lies back along this. */
  readonly dir = new THREE.Vector3(0, 0, 1);

  /** Where it is turning toward. */
  private readonly want = new THREE.Vector3(0, 0, 1);

  private untilTurn = 0;

  private sinceBite = 0;

  /** How many bites it has taken — for probes and for the record. */
  bites = 0;

  /** Its name on the shove list. Stable for the life of the island. */
  readonly id: number;

  /** Where its last bite landed. The one point its burrow is certainly at. */
  readonly lastBite = new THREE.Vector3();

  /**
   * WHERE IT HAS BEEN — its own burrow, remembered so its body can lie in
   * it rather than through the wall.
   *
   * Newest first, so the head is `trail[0]` and reading the body is a walk
   * forward through the array. Sampled by DISTANCE rather than by frame:
   * at a fixed interval the spacing changes with the frame rate, and a
   * body laid on frames would stretch and gather as the phone breathed.
   *
   * Long enough to hold the whole animal and no longer — see `TRAIL_MM`.
   */
  readonly trail: THREE.Vector3[] = [];

  constructor(
    x: number, y: number, z: number,
    private readonly rand: () => number = Math.random,
    id = 0,
  ) {
    this.id = id;
    /* Its think clock is offset from its neighbours' by its own seeded draw
     * — see `newMind`. Two hundred worms thinking on the same frame is a
     * spike sixty times a second rather than a smooth load. */
    this.mind = newMind(EARTHWORM, rand());
    this.at.set(x, y, z);
    this.untilTurn = WORM_HEADING_MIN_S
      + this.rand() * (WORM_HEADING_MAX_S - WORM_HEADING_MIN_S);
    /* Born with room both ways, so its first heading is unbiased. Where it
     * actually stands is checked from the first tick onward. */
    wanderDir(this.rand, WORM_UNDER_MM, WORM_UNDER_MM, this.want);
    this.dir.copy(this.want);

    /* Born already lying somewhere: a worm whose trail is empty has its
     * whole body collapsed onto its head for the first second. */
    for (let i = 0; i < TRAIL_POINTS; i += 1) {
      this.trail.push(new THREE.Vector3(x, y, z).addScaledVector(this.dir, -i * TRAIL_STEP_MM / MM));
    }
  }

  /**
   * Drop a breadcrumb if it has moved far enough since the last one, and
   * forget the far end once the trail is longer than the animal.
   */
  private remember(): void {
    const first = this.trail[0];
    if (first && first.distanceTo(this.at) < TRAIL_STEP_MM / MM) return;
    this.trail.unshift(this.at.clone());
    while (this.trail.length > TRAIL_POINTS) this.trail.pop();
    /* One more real breadcrumb, and never more than the trail holds. The
     * fabricated tail is pushed off the end as these arrive. */
    this.dug = Math.min(this.dug + 1, TRAIL_POINTS);
  }

  /**
   * How many of `trail`'s points the worm actually travelled through — the
   * rest are the fabricated tail the constructor lays so a newborn worm is
   * not drawn collapsed onto its own head.
   *
   * It matters to anything asking the SOIL about the burrow: the fabricated
   * points were never dug, so a probe treating them as tunnel measures
   * undisturbed ground and reports the burrow as a fifth of a millimetre
   * across. Measured, as one such reading among six.
   */
  dug = 0;

  /** The stretch of trail that is really a burrow, newest first. */
  burrow(): THREE.Vector3[] {
    return this.trail.slice(0, this.dug);
  }

  /**
   * ITS BRAIN AND ITS STATS — health, stamina, hunger, and what it is doing.
   *
   * Asked for as two things — "no collision or health/stats yet" and "bring
   * the Beyond Extinction AI over" — which are one thing, because in that
   * design the stats ARE the brain's data. See `creatureBrain`.
   *
   * A worm's whole behavioural repertoire is dig, or withdraw. `flee` here
   * does not mean run away across open ground, which a worm cannot do: it
   * means go DEEPER, which is the same instinct expressed through the only
   * axis it has. Measured biology backs the instinct — Lumbricus terrestris
   * retreats into its burrow on vibration (Catania 2008, PLoS ONE 3: e3472).
   */
  readonly mind: CreatureMind;

  /** How far it reaches from its own centre, for the shove list. */
  get radius(): number { return WORM_BORE_MM / 2 / MM; }

  /**
   * What it weighs, in milligrams.
   *
   * Measured biology: a mature Lumbricus terrestris runs 3-5 g, so 4,000 mg
   * — which is a great deal more than the queen, and that is the point of
   * putting it on the shove list at all. She gives way to a worm.
   */
  get massMg(): number { return 4000; }

  /** Whether it is still alive to be drawn and simulated. */
  get alive(): boolean { return this.mind.health > 0; }

  /**
   * One frame. Returns whether it actually took a bite.
   *
   * The brain decides at its own throttled rate — see `THINK_S` — while the
   * body moves every frame. Nothing here stutters as a result: the decision
   * changes maybe twice a minute, and what it changes is which way and how
   * fast, not whether to move at all.
   */
  tick(dt: number, soil: WormSoil): boolean {
    if (dt <= 0) return false;
    if (!this.alive) return false;

    /* Clocks first, and every frame — a cooldown that only advanced on think
     * frames would be quantised to 0.15 s. */
    tickMind(EARTHWORM, this.mind, dt, this.mind.behaviour === 'flee');
    if (thinkDue(this.mind)) {
      /*
       * A worm senses nothing yet: no threat is reported to it, so the FSM
       * settles on wander, which for a worm IS digging. The senses are
       * wired here rather than faked — when there is something to be
       * frightened of, this is the one line that changes.
       */
      setBehaviour(this.mind, think(EARTHWORM, this.mind, {
        threat: null, prey: null, fromHomeMm: 0,
      }));
    }

    /*
     * WHERE THE WALLS ARE, right here. Both ends of the band are read every
     * tick rather than once at spawn, because the surface and the seafloor
     * both move as it travels — a worm heading for the coast has its floor
     * rise to meet its ceiling until there is no band left, which is what
     * keeps it out of the water without a special case for the water.
     */
    const ceil = soil.surfaceAt(this.at.x, this.at.z) - WORM_CEIL_MM / MM;
    const floor = soil.baseAt(this.at.x, this.at.z) + WORM_FLOOR_MM / MM;
    const roomUpMm = (ceil - this.at.y) * MM;
    const roomDownMm = (this.at.y - floor) * MM;

    this.untilTurn -= dt;
    if (this.untilTurn <= 0) {
      wanderDir(this.rand, roomUpMm, roomDownMm, this.want);
      this.untilTurn = WORM_HEADING_MIN_S
        + this.rand() * (WORM_HEADING_MAX_S - WORM_HEADING_MIN_S);
    }

    /*
     * AGAINST A WALL: aim away from it at once rather than waiting for the
     * heading to expire. A heading lasts up to sixty seconds, so without
     * this a worm that touched the ceiling would grind along it for most of
     * a minute — and the version that had only a bias, and no wall at all,
     * put worms 28 mm above the grass. Re-aimed only when it is actually
     * pointed the wrong way, so it is not re-rolling a heading every frame.
     */
    if (roomUpMm <= 0 && this.want.y > -0.1) {
      wanderDir(this.rand, 0, WORM_UNDER_MM, this.want);
      this.untilTurn = WORM_HEADING_MIN_S
        + this.rand() * (WORM_HEADING_MAX_S - WORM_HEADING_MIN_S);
    } else if (roomDownMm <= 0 && this.want.y < 0.1) {
      wanderDir(this.rand, WORM_UNDER_MM, 0, this.want);
      this.untilTurn = WORM_HEADING_MIN_S
        + this.rand() * (WORM_HEADING_MAX_S - WORM_HEADING_MIN_S);
    }

    /* Swing onto the new heading at a limited ANGULAR rate — see the note
     * on `WORM_TURN` for why a lerp factor is the wrong tool here. */
    const gap = this.dir.angleTo(this.want);
    if (gap > 1e-6) {
      const step = Math.min(gap, WORM_TURN * dt);
      S_WANT.copy(this.dir).cross(this.want);
      if (S_WANT.lengthSq() > 1e-12) {
        this.dir.applyAxisAngle(S_WANT.normalize(), step).normalize();
      }
    }

    /*
     * THE WALLS THEMSELVES — AND THEY MUST COME AFTER THE TURN.
     *
     * Refusing the step matters as much as re-aiming, because the turn is a
     * hard 0.12 rad/s and a worm that kept moving while it came about would
     * travel most of a body length the wrong way first. But putting this
     * refusal BEFORE the turn deadlocks it: the worm returns early, never
     * reaches the swing, and is frozen pointing at the wall forever. That is
     * not hypothetical — it measured, as a worm sitting at exactly the
     * ceiling with zero bites and zero travel after ninety seconds.
     *
     * So it turns first and only then declines to move. It noses into the
     * wall, pauses while it comes about, and goes back the other way.
     *
     * Out over the water this is what stops it: the floor rises above the
     * ceiling, both tests fire at once, and the worm simply cannot advance
     * in any direction that takes it further out. No sea check anywhere.
     */
    /*
     * TESTED AT THE STEP'S DESTINATION, NOT AT ITS HEADING.
     *
     * A first cut refused to move only when the worm was POINTED at a wall,
     * which misses the case that actually happens: on a slope, a worm
     * travelling dead level has the ground come down to meet it. It never
     * rises and the ceiling arrives anyway. Measured — a worm 2.6 mm under
     * the grass against a 5 mm ceiling it never knowingly approached.
     *
     * So the candidate position is worked out first and CLAMPED into the
     * band that exists where it is going. Clamping rather than refusing on
     * purpose: a worm that hits its ceiling should follow the contour along,
     * the way a shallow worm does, not stop dead at the foot of every rise.
     */
    /* SPEED COMES FROM THE BRAIN NOW, not from the constant directly. They
     * agree for a wandering worm — `EARTHWORM.wanderSpeedMm` is
     * `WORM_STEP_MM`, and a test pins that — but a frightened one withdraws
     * faster, which is the whole visible difference a brain makes here. */
    const paceMm = speedMm(EARTHWORM, this.mind) || WORM_STEP_MM;
    S_STEP.copy(this.at).addScaledVector(
      this.dir, (paceMm / MM / WORM_BITE_S) * dt,
    );
    const ceilNext = soil.surfaceAt(S_STEP.x, S_STEP.z) - WORM_CEIL_MM / MM;
    const floorNext = soil.baseAt(S_STEP.x, S_STEP.z) + WORM_FLOOR_MM / MM;
    /* No band at all where it is going — over the water, where the seafloor
     * has risen past the surface. It simply does not go. */
    if (ceilNext <= floorNext) return false;
    S_STEP.y = Math.min(ceilNext, Math.max(floorNext, S_STEP.y));

    /*
     * IT MOVES WHEREVER IT IS; IT ONLY CARVES WHERE THE WORLD IS REAL.
     *
     * This was the other way round until fifty worms went out across the
     * island, and the reason it changed is arithmetic. The fine soil is a
     * 192 mm window that follows HER. That window is about 37,000 square
     * millimetres of a 3.1-billion-square-millimetre island, so the expected
     * number of fifty scattered worms inside it at any moment is 0.0006 —
     * and measured, over ninety seconds, exactly zero of fifty took a single
     * bite. A worm that may only move when it can dig is, at island scale, a
     * worm that never moves.
     *
     * The old rule was written when there were three of them beside her and
     * the worry was watching one cross the window's edge, keep going, and
     * pop out elsewhere with no burrow behind it. That worry does not
     * survive the change: soil is OPAQUE, the only ground she can see into
     * is ground inside the window, and only the six nearest worms are drawn
     * at all. A worm out there is behind a wall. When she arrives, it is
     * where it should be and starts leaving a real hole from that moment.
     *
     * The band still holds everywhere — the heightfield knows the whole
     * island — so a worm roaming unwatched still cannot break the surface
     * or wander out under the sea.
     */
    this.at.copy(S_STEP);
    this.remember();

    this.sinceBite += dt;
    if (this.sinceBite < WORM_BITE_S) return false;
    this.sinceBite -= WORM_BITE_S;
    /* At the head, which is where the mouth is. */
    S_HEAD.copy(this.at).addScaledVector(this.dir, WORM_BORE_MM / 2 / MM);
    if (!soil.covers(S_HEAD.x, S_HEAD.y, S_HEAD.z)) return false;
    soil.carve(S_HEAD.x, S_HEAD.y, S_HEAD.z, WORM_BORE_MM / 2 / MM);
    this.lastBite.copy(S_HEAD);
    this.bites += 1;
    return true;
  }
}
