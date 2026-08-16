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

/** What a worm needs of the world, and nothing else. */
export interface WormSoil {
  /** Is this point inside the fine window that can actually be carved? */
  covers(x: number, y: number, z: number): boolean;
  /** Take a sphere of soil out. */
  carve(x: number, y: number, z: number, radius: number): void;
  /** The drawn surface above this column, so a worm can stay under it. */
  surfaceAt(x: number, z: number): number;
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
 * Deliberately few. Each carves a 6 mm tube at 3 mm a second, which is
 * 180 mm of burrow a minute — a dozen would turn the ground under her into
 * a sponge inside one session.
 */
export const WORM_COUNT = 3;

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
 * How far under the surface it tries to stay, in millimetres.
 *
 * Not a hard ceiling — it is a bias applied to the heading, so a worm
 * heading up gets turned down rather than stopped. A hard clamp would have
 * them all crawling along one plane at exactly this depth.
 */
export const WORM_UNDER_MM = 12;

/**
 * HOW LONG IT DIGS BEFORE COMING UP FOR AIR, and how long it lies there.
 *
 * Reported twice: "I don't see any worms." They were there and they were
 * digging — the probe counted their bites — but they spawned twelve
 * millimetres under the grass and `wanderDir` turns a shallow worm DOWN, so
 * nothing ever brought one back up. Three animals living their whole lives
 * inside opaque ground. The bug was not that they were missing; it was that
 * nothing could ever have seen them.
 *
 * Surfacing is also the honest biology rather than a visibility hack.
 * Lumbricus terrestris is ANECIC: it holds a more or less permanent vertical
 * burrow and comes to the mouth of it to feed on leaf litter and to cast,
 * chiefly at night and after rain, with the tail anchored below. A worm that
 * never left its tunnel would be the wrong animal.
 *
 * Both numbers are GAME TUNING, not measured biology. A real worm spends
 * hours at this; a player is looking at the ground for seconds.
 */
export const WORM_DIG_S = 40;
export const WORM_BASK_S = 18;

/**
 * How steeply it climbs when it decides to surface, as a fraction of
 * straight up.
 *
 * Straight up would have it rise through its own body and come out of the
 * burrow it is lying in. Climbing at a slope leaves a ramp that the body can
 * still lie along — the same reason `WORM_TURN` is a radius rather than a
 * snap.
 */
export const WORM_CLIMB = 0.55;

/**
 * How far its head clears the grass when it is lying at the mouth, in
 * millimetres — and, the same number, how far ANY worm may rise.
 *
 * It is a hard ceiling rather than another bias, and that is the fix for a
 * bug this file already had and the surfacing behaviour merely exposed:
 * `wanderDir` biases DOWNWARD only at the moment a new heading is picked,
 * and a heading lasts thirty to sixty seconds. A worm pointed up therefore
 * carried on up, and `WORM_TURN` is 0.12 rad/s — thirteen seconds to swing
 * through a right angle, thirty-nine millimetres of travel. Measured in the
 * running game before this existed: three worms with their heads 10, 23 and
 * 28 mm ABOVE the ground, flying.
 *
 * Ten was chosen by looking at it. Four — two thirds of a bore — is
 * technically visible and renders as a pink nub that reads as a pebble; at
 * ten the annulations are legible and it is unmistakably a worm, while still
 * being a fraction of a 150 mm animal, so it reads as coming OUT of a hole
 * rather than standing beside one. It is also just over the queen's own
 * length, which makes it something she can be shown next to.
 */
export const WORM_OUT_MM = 10;

/**
 * How far apart the breadcrumbs are, in millimetres, and how many there
 * are — together, how much body the trail can hold.
 *
 * Every 3 mm over 56 points is 165 mm of path, which covers the 150 mm
 * worm with room to spare. The spacing matters more than it looks: the
 * body is laid on the POLYLINE through these points, so a coarse trail
 * cuts the corners of a curve and pushes the body into the wall. Five was
 * the first choice and it cut visibly.
 */
export const TRAIL_STEP_MM = 3;
export const TRAIL_POINTS = 56;

const S_WANT = new THREE.Vector3();
const S_HEAD = new THREE.Vector3();

/**
 * A new heading, biased down when it is too near the sky.
 *
 * Pulled out because it is the only interesting decision a worm makes, and
 * because "pick a random direction" and "do not leave the ground" fight
 * unless one of them is written as a bias on the other.
 */
export function wanderDir(
  rand: () => number, depthMm: number, into: THREE.Vector3,
): THREE.Vector3 {
  const yaw = rand() * Math.PI * 2;
  /* Mostly level. A worm that picked uniformly on a sphere would spend
   * most of its life going straight up or straight down. */
  let pitch = (rand() - 0.5) * 0.9;
  /* Too shallow: bias downward in proportion to how shallow. At the
   * surface it can only go down; well under, it is free. */
  const shallow = Math.max(0, 1 - depthMm / WORM_UNDER_MM);
  if (shallow > 0) pitch = -Math.abs(pitch) * shallow + pitch * (1 - shallow);
  const flat = Math.cos(pitch);
  return into.set(Math.sin(yaw) * flat, Math.sin(pitch), Math.cos(yaw) * flat)
    .normalize();
}

/**
 * What a worm is doing with itself.
 *
 * `down` is digging, `up` is climbing for the surface, `out` is lying at the
 * mouth of its own burrow with its head in the open air. Named rather than
 * a pair of booleans because two flags allow a state that is neither.
 */
export type WormMood = 'down' | 'up' | 'out';

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

  /** Digging, climbing out, or lying at the mouth. */
  mood: WormMood;

  /** Seconds left in whatever it is doing. */
  private moodFor: number;

  constructor(
    x: number, y: number, z: number,
    private readonly rand: () => number = Math.random,
    /* Where in its cycle it starts. The island lays one worm out on the
     * grass from the first frame so there is something to SEE, and starts
     * the rest underground — see `spawnWorms`. */
    mood: WormMood = 'down',
  ) {
    this.mood = mood;
    /*
     * STAGGERED, so three worms are not one worm drawn three times. Sharing
     * a clock would have them surface together, lie together and dive
     * together, which reads as a scripted event rather than as animals.
     */
    this.moodFor = (mood === 'out' ? WORM_BASK_S : WORM_DIG_S) * (0.25 + rand() * 0.75);
    this.at.set(x, y, z);

    /*
     * WHICH WAY IT IS POINTED BEFORE ITS BODY IS LAID OUT, because the body
     * is laid BACKWARDS along the heading and so the heading decides where
     * the body goes.
     *
     * One lying at the mouth points UP, which puts its trail — and therefore
     * its body — straight down the burrow beneath it with only the head in
     * the open. That is the posture the animal actually holds: an anecic
     * worm feeds at its doorway with the tail still anchored below, ready to
     * be pulled back in.
     */
    this.untilTurn = WORM_HEADING_MIN_S
      + this.rand() * (WORM_HEADING_MAX_S - WORM_HEADING_MIN_S);
    if (mood === 'out') this.want.set(0, 1, 0);
    else wanderDir(this.rand, WORM_UNDER_MM, this.want);
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

  /** One frame. Returns whether it actually took a bite. */
  tick(dt: number, soil: WormSoil): boolean {
    if (dt <= 0) return false;

    const depthMm = (soil.surfaceAt(this.at.x, this.at.z) - this.at.y) * MM;

    /*
     * THE DAY OF A WORM: dig for a while, climb out, lie at the mouth, dig
     * again. See `WORM_DIG_S` for why this exists at all — without it a worm
     * is an animal nobody can ever see.
     */
    /* At or through the ceiling — see `WORM_OUT_MM`. */
    const atSky = depthMm <= -WORM_OUT_MM;

    this.moodFor -= dt;
    if (this.mood === 'up' && atSky) {
      /* Arrived. It stops HERE, head just clear of the grass, rather than
       * carrying on into the sky where there is no field to live in. */
      this.mood = 'out';
      this.moodFor = WORM_BASK_S;
    } else if (this.moodFor <= 0) {
      if (this.mood === 'down') {
        this.mood = 'up';
        /* Long enough to climb from any working depth, and no longer: if it
         * cannot find the surface in this it has met something it cannot
         * dig, and going back to work beats climbing forever. */
        this.moodFor = WORM_DIG_S;
      } else {
        this.mood = 'down';
        this.moodFor = WORM_DIG_S;
      }
      /* A fresh heading on every change of mind, so it does not dive back
       * down the hole it just came up. */
      this.untilTurn = 0;
    }

    if (this.mood === 'out') {
      /* Lying at its own doorway. It does not move, and it does not dig —
       * the burrow behind it is what its body is drawn along, and a worm
       * that kept carving up here would be carving the sky. */
      return false;
    }

    this.untilTurn -= dt;
    if (this.untilTurn <= 0) {
      wanderDir(this.rand, depthMm, this.want);
      this.untilTurn = WORM_HEADING_MIN_S
        + this.rand() * (WORM_HEADING_MAX_S - WORM_HEADING_MIN_S);
    }

    /*
     * CLIMBING OVERRIDES THE WANDER, and it has to: `wanderDir` turns a
     * shallow worm DOWN in proportion to how shallow it is, which is right
     * for a digging worm and is exactly what kept every one of them buried.
     * The yaw it picked is kept, so it surfaces somewhere it was heading
     * anyway rather than reversing on the spot.
     */
    if (this.mood === 'up') {
      const flat = Math.hypot(this.want.x, this.want.z) || 1;
      const level = Math.sqrt(Math.max(0, 1 - WORM_CLIMB * WORM_CLIMB));
      this.want.set(
        (this.want.x / flat) * level, WORM_CLIMB, (this.want.z / flat) * level,
      ).normalize();
    }

    /*
     * THE CEILING, half one. A digging worm that has nosed out of the ground
     * aims back down at once — see `WORM_OUT_MM` for the measurement that
     * made this necessary.
     *
     * A worm lying at the mouth has already returned, above, so anything
     * still here is one that means to be underground.
     */
    if (atSky && this.want.y > -0.1) {
      /* Depth zero makes `wanderDir`'s bias total, so this always comes
       * back pointing into the ground. */
      wanderDir(this.rand, 0, this.want);
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
     * THE CEILING, half two — AND IT MUST COME AFTER THE TURN.
     *
     * Refusing the step matters as much as re-aiming, because the turn is a
     * hard 0.12 rad/s and a worm that kept moving while it came about would
     * climb most of a body length into the air first. But putting this
     * refusal BEFORE the turn deadlocks it: the worm returns early, never
     * reaches the swing, and so is frozen pointing at the sky forever. That
     * is not hypothetical — it measured, as a worm sitting at exactly the
     * ceiling with zero bites and zero travel after ninety seconds.
     *
     * So it turns first and only then declines to move. It noses out,
     * pauses while it comes about, and goes back in.
     */
    if (atSky && this.dir.y > 0) return false;

    /*
     * IT ONLY MOVES WHEN IT CAN DIG. A worm drifting through soil it
     * cannot carve is a worm leaving no burrow and turning up somewhere
     * else — which reads as teleporting, not as burrowing. Out of the
     * window it simply waits.
     */
    if (!soil.covers(this.at.x, this.at.y, this.at.z)) return false;

    this.at.addScaledVector(this.dir, (WORM_STEP_MM / MM / WORM_BITE_S) * dt);
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
