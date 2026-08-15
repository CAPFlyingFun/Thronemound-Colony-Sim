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

/** How fast it swings onto a new heading. A worm does not pivot. */
export const WORM_TURN = 0.5;

/**
 * How far under the surface it tries to stay, in millimetres.
 *
 * Not a hard ceiling — it is a bias applied to the heading, so a worm
 * heading up gets turned down rather than stopped. A hard clamp would have
 * them all crawling along one plane at exactly this depth.
 */
export const WORM_UNDER_MM = 12;

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

  constructor(
    x: number, y: number, z: number,
    private readonly rand: () => number = Math.random,
  ) {
    this.at.set(x, y, z);
    this.untilTurn = WORM_HEADING_MIN_S
      + this.rand() * (WORM_HEADING_MAX_S - WORM_HEADING_MIN_S);
    wanderDir(this.rand, WORM_UNDER_MM, this.want);
    this.dir.copy(this.want);
  }

  /** One frame. Returns whether it actually took a bite. */
  tick(dt: number, soil: WormSoil): boolean {
    if (dt <= 0) return false;

    this.untilTurn -= dt;
    if (this.untilTurn <= 0) {
      const depthMm = (soil.surfaceAt(this.at.x, this.at.z) - this.at.y) * MM;
      wanderDir(this.rand, depthMm, this.want);
      this.untilTurn = WORM_HEADING_MIN_S
        + this.rand() * (WORM_HEADING_MAX_S - WORM_HEADING_MIN_S);
    }

    /* Swing onto the new heading rather than snapping to it. */
    const turn = Math.min(1, WORM_TURN * dt);
    this.dir.addScaledVector(S_WANT.copy(this.want).sub(this.dir), turn).normalize();

    /*
     * IT ONLY MOVES WHEN IT CAN DIG. A worm drifting through soil it
     * cannot carve is a worm leaving no burrow and turning up somewhere
     * else — which reads as teleporting, not as burrowing. Out of the
     * window it simply waits.
     */
    if (!soil.covers(this.at.x, this.at.y, this.at.z)) return false;

    this.at.addScaledVector(this.dir, (WORM_STEP_MM / MM / WORM_BITE_S) * dt);

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
