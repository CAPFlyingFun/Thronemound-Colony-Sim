/**
 * WALKING ON EVERYTHING — gravity that points at whatever she is standing on.
 *
 * An ant does not have a down. It has a surface, and the surface is down. The
 * block room proved this out on a cube: she walks up a face, over the edge,
 * across the underside and back, and never once consults world +Y. This is
 * that mechanism, lifted out of `BlockScene` so the island can have it too,
 * with the scene-specific parts (where the soil is, how fast she walks) handed
 * in rather than hard-coded.
 *
 * The whole of it is four ideas:
 *
 *   1. HER UP IS THE FIELD'S GRADIENT. The soil is a signed scalar — positive
 *      inside — so the direction of steepest decrease is the way out of it,
 *      which is the outward normal. Read from an INTERPOLATED field it turns
 *      smoothly across a rounded edge instead of snapping between six axes,
 *      and that is the entire reason she rounds a corner rather than flipping
 *      onto the next face.
 *   2. SHE IS SEATED, NOT TELEPORTED. Every frame, cast from off her back down
 *      through her soles and ease her onto `contact + normal * ride`. Easing
 *      rather than setting is what makes a bad sample cost a wobble instead of
 *      a jump.
 *   3. AN EDGE IS FOUND BY LOOKING BEHIND HER. Walk over a convex lip and the
 *      cast through her soles finds nothing, because the surface has curled
 *      away underneath. The far side of that lip is behind and below her IN
 *      HER OWN FRAME, so a fan of arcs sweeping back from her down toward her
 *      tail finds it. Only when those come back empty has she really stepped
 *      off into the air.
 *   4. HER UP HAS A SPEED LIMIT. Attitude changes through exactly one function,
 *      which eases and then rate-caps. Digging removes the ground from under
 *      her several times a second and the normal it leaves behind flickers; a
 *      cap turns that into a few degrees of wobble instead of the body
 *      spinning.
 *
 * The density callback must answer EVERYWHERE. A walker that loses grip at the
 * edge of a streamed window drops her through the world, so the caller is
 * expected to fall back on whatever it knows out there — for a heightfield,
 * `surface(x, z) - y` is the same signed quantity and stitches on seamlessly.
 */

import * as THREE from 'three';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Looking for the far side of an edge: behind and below, in her own frame. */
const WRAP_ARCS = [0.6, 1.1, 1.7, 2.4] as const;

export interface SurfaceWalkTuning {
  /** The probe step, and the arm of the central difference. A field's cell. */
  cell: number;
  /** How far off the soil her centre rides. */
  ride: number;
  /** How far off her back the seating cast starts. */
  gripLift: number;
  /** How far that cast, and the wrap search, reach. */
  gripReach: number;
  /** How fast her up eases onto the contact normal, per second. */
  align: number;
  /** The ceiling on that, in radians per second. A body cannot snap. */
  maxTiltRate: number;
  /** How fast she is drawn onto the seat, per second. */
  snap: number;
  /**
   * Seat corrections smaller than this are not made at all.
   *
   * The seat is derived from field samples of her own position, so at rest
   * the two form a loop, and a loop with any disagreement in it at all — a
   * lattice step, a bisection tolerance — oscillates at frame rate instead
   * of settling. The dead-band breaks the loop: within it she simply does
   * not move, and a body that does not move samples the same field, gets
   * the same seat, and stays put.
   *
   * THE BAND MUST BEAT THE DISAGREEMENT OR IT HOLDS NOTHING. The walker's
   * two surface estimates differ at rest by up to 0.24 mm on real lattice
   * terrain (measured; a tenth-of-a-millimetre band just slowed the creep,
   * and the residue walked her straight into the anti-embed guard's
   * three-frame snap — a 14 Hz sawtooth instead of a 22 Hz buzz). Three
   * tenths clears the worst measured case, and at rest three tenths of a
   * millimetre of seat error on a nine-millimetre ant whose feet are
   * IK-planted anyway is invisible.
   */
  deadband: number;
  /** World-frame acceleration once she has nothing to hold. */
  gravity: number;
}

export const DEFAULT_WALK_TUNING: SurfaceWalkTuning = {
  cell: 0.2,
  ride: 0.26,
  gripLift: 0.6,
  gripReach: 1.8,
  align: 12,
  maxTiltRate: (240 * Math.PI) / 180,
  snap: 14,
  deadband: 0.06,
  gravity: 9,
};

/** Where she is and which way she is standing. The walker owns all three. */
export interface WalkFrame {
  at: THREE.Vector3;
  up: THREE.Vector3;
  forward: THREE.Vector3;
}

export class SurfaceWalker {
  /** Is she holding on to something, or in the air? */
  gripping = true;

  /** World-frame fall speed, only meaningful while not gripping. */
  fallSpeed = 0;

  /* Scratch: this runs every frame and must not feed the collector. */
  private readonly probe = new THREE.Vector3();

  private readonly scratchA = new THREE.Vector3();

  private readonly scratchB = new THREE.Vector3();

  private readonly scratchC = new THREE.Vector3();

  constructor(
    /**
     * Signed soil density at a world point: positive inside. Total — this is
     * asked outside any streamed window and must still answer.
     *
     * Only the NORMAL reads this, and only six times a frame, because only a
     * normal needs the field between the samples.
     */
    private readonly densityAt: (x: number, y: number, z: number) => number,
    readonly tune: SurfaceWalkTuning = DEFAULT_WALK_TUNING,
    /**
     * Is this point in soil — the cheap question, asked hundreds of times a
     * frame by the marches.
     *
     * Every ray here wants a yes or no, and interpolating eight lattice
     * samples to produce one is seven reads of waste per probe. Measured at
     * 0.033 µs against 0.094 for the smooth read, over roughly two hundred
     * probes a frame between the cast, the lift and the buried search.
     * Omitted, it falls back on the sign of the smooth field, which is
     * correct and simply slower.
     */
    private readonly solidProbe?: (x: number, y: number, z: number) => boolean,
  ) {}

  solidAt(x: number, y: number, z: number): boolean {
    return this.solidProbe
      ? this.solidProbe(x, y, z)
      : this.densityAt(x, y, z) > 0;
  }

  /**
   * The outward normal of the soil at a point, from the field's gradient.
   *
   * Central differences at one cell, which on a rounded edge gives the blend
   * between two faces rather than a jump.
   */
  normalAt(p: THREE.Vector3, into: THREE.Vector3): THREE.Vector3 {
    const h = this.tune.cell;
    into.set(
      this.densityAt(p.x - h, p.y, p.z) - this.densityAt(p.x + h, p.y, p.z),
      this.densityAt(p.x, p.y - h, p.z) - this.densityAt(p.x, p.y + h, p.z),
      this.densityAt(p.x, p.y, p.z - h) - this.densityAt(p.x, p.y, p.z + h),
    );
    if (into.lengthSq() < 1e-12) into.copy(WORLD_UP);
    return into.normalize();
  }

  /** March for the first solid point, and bisect once it is found. */
  cast(from: THREE.Vector3, dir: THREE.Vector3, reach: number): THREE.Vector3 | null {
    const step = this.tune.cell * 0.5;
    const probe = this.probe;
    let previous = 0;
    for (let d = 0; d <= reach; d += step) {
      probe.copy(from).addScaledVector(dir, d);
      if (this.solidAt(probe.x, probe.y, probe.z)) {
        let lo = previous;
        let hi = d;
        for (let i = 0; i < 6; i += 1) {
          const mid = (lo + hi) * 0.5;
          probe.copy(from).addScaledVector(dir, mid);
          if (this.solidAt(probe.x, probe.y, probe.z)) hi = mid;
          else lo = mid;
        }
        return probe.copy(from).addScaledVector(dir, hi).clone();
      }
      previous = d;
    }
    return null;
  }

  /**
   * How far she can be lifted off her own back before the lift is itself
   * INSIDE something. Nought means she is embedded.
   *
   * A cast reports a hit at zero range when its origin is already solid, which
   * is correct for a ray and catastrophic here: starting the seating cast a
   * fixed height above her, in a tunnel barely wider than she is, starts it in
   * the CEILING — which then "hits" at zero range and seats her a body-height
   * above the roof, every frame. An elevator dressed up as a grip.
   */
  private clearLift(frame: WalkFrame): number {
    const step = this.tune.cell * 0.5;
    const probe = this.scratchA;
    for (let lift = this.tune.gripLift; lift > 0; lift -= step) {
      probe.copy(frame.at).addScaledVector(frame.up, lift);
      if (!this.solidAt(probe.x, probe.y, probe.z)) return lift;
    }
    return 0;
  }

  /**
   * The nearest bit of surface to a point buried in soil, searched outward
   * along her own axes — what an ant in a tunnel takes hold of.
   *
   * Marched OUT of the soil rather than cast back into it: buried deeper than
   * the reach, an inward cast starts solid and returns its own origin, which
   * is a fictional contact in the middle of solid ground with a zero gradient.
   * Walking out to where the soil STOPS needs no such assumption.
   */
  private nearestSurface(frame: WalkFrame, p: THREE.Vector3): THREE.Vector3 | null {
    const right = this.scratchB.crossVectors(frame.up, frame.forward).normalize();
    const dirs = [
      this.scratchC.copy(frame.up).negate().clone(),
      frame.up.clone(),
      right.clone(),
      right.clone().negate(),
      frame.forward.clone(),
      frame.forward.clone().negate(),
    ];
    const step = this.tune.cell * 0.5;
    const probe = this.scratchA;
    let best: THREE.Vector3 | null = null;
    let bestDist = Infinity;
    for (const dir of dirs) {
      let lastSolid = 0;
      for (let d = 0; d <= this.tune.gripReach; d += step) {
        probe.copy(p).addScaledVector(dir, d);
        if (this.solidAt(probe.x, probe.y, probe.z)) { lastSolid = d; continue; }
        /*
         * BISECTED, BECAUSE `cast` BISECTS. Returning the marched sample
         * itself put this estimate up to half a step outside the surface
         * while cast's sat within a sixty-fourth of one — so the walker's
         * two ways of finding the same ground disagreed by half a
         * millimetre, and `hold` flip-flopped between them every frame.
         * The dead-band above absorbs small disagreements; this removes
         * the large one at its source.
         */
        let lo = lastSolid;
        let hi = d;
        for (let i = 0; i < 6; i += 1) {
          const mid = (lo + hi) * 0.5;
          probe.copy(p).addScaledVector(dir, mid);
          if (this.solidAt(probe.x, probe.y, probe.z)) lo = mid;
          else hi = mid;
        }
        if (hi < bestDist) {
          bestDist = hi;
          best = probe.copy(p).addScaledVector(dir, hi).clone();
        }
        break;
      }
    }
    return best;
  }

  /**
   * Turn her body toward an attitude — the ONE path by which her up ever
   * changes, eased and then rate-limited.
   *
   * The easing only smooths a goal that MOVES smoothly, and digging's does
   * not: she removes the ground from under herself, so the contact flips
   * between faces several times a second and the goal arrives as a step. The
   * rate cap is what a body actually has, and it makes a bad sample cost a few
   * degrees instead of the whole view. Ordinary cornering peaks well inside it.
   *
   * Pass `dt = 0` to freeze the attitude for a frame — what active digging
   * wants, because there the normal feeds back into the cast that produced it.
   */
  aimUp(frame: WalkFrame, goal: THREE.Vector3, dt: number): void {
    const eased = this.scratchA.copy(frame.up)
      .lerp(goal, 1 - Math.exp(-this.tune.align * dt)).normalize();
    const swing = Math.acos(THREE.MathUtils.clamp(frame.up.dot(eased), -1, 1));
    const cap = this.tune.maxTiltRate * dt;
    if (swing <= cap || swing < 1e-9) {
      frame.up.copy(eased);
      return;
    }
    const axis = this.scratchB.crossVectors(frame.up, eased);
    if (axis.lengthSq() < 1e-12) {
      frame.up.copy(eased);
      return;
    }
    frame.up.applyAxisAngle(axis.normalize(), cap).normalize();
  }

  /**
   * Hold on: cast from off her back, in through her soles.
   *
   * When it lands she is drawn onto the contact and her up eases onto its
   * normal — that is the whole of walking round a corner. When it finds
   * nothing she has walked over an edge, so the wrap search looks BEHIND AND
   * BELOW her, in her own frame, which is where the far side of an edge is.
   * Only when that is empty too has she genuinely walked off into the air.
   */
  /**
   * Draw her toward a seat — unless she is already as good as on it.
   *
   * The band matters more than the pull. Without it, standing still was a
   * limit cycle: the embedded branch and the cast branch of `hold` disagreed
   * about the surface by up to half a marching step, their two seats sat on
   * opposite sides of the very in-soil/in-air boundary that picks between
   * them, and she alternated 0.08 mm up and down every single frame —
   * measured at 399 sign flips in 400 steps, about 22 Hz. That was the
   * vibration. Inside the band she does not move at all, and a body that
   * does not move gets the same answer next frame and is finally still.
   */
  private seatToward(frame: WalkFrame, seat: THREE.Vector3, dt: number, still: boolean): void {
    /*
     * ONLY WHEN SHE IS ASKED TO BE STILL. The first cut applied the band
     * unconditionally, and cornering broke: at the base of a wall her seat
     * migrates onto the new surface in exactly the sub-band steps the band
     * eats, so she stood at the wall and never turned. Movement is made of
     * small corrections; only rest should refuse them.
     */
    if (still
      && frame.at.distanceToSquared(seat) <= this.tune.deadband * this.tune.deadband) return;
    frame.at.lerp(seat, 1 - Math.exp(-this.tune.snap * dt));
  }

  private hold(frame: WalkFrame, dt: number, aimDt: number, still: boolean): void {
    if (this.solidAt(frame.at.x, frame.at.y, frame.at.z)) {
      const out = this.nearestSurface(frame, frame.at);
      if (out) {
        const normalOut = this.scratchC;
        this.normalAt(out, normalOut);
        const seat = out.addScaledVector(normalOut, this.tune.ride);
        this.seatToward(frame, seat, dt, still);
        this.aimUp(frame, normalOut, aimDt);
        return;
      }
    }

    const lift = this.clearLift(frame);
    const from = this.scratchA.copy(frame.at).addScaledVector(frame.up, lift);
    const dir = this.scratchB.copy(frame.up).negate();
    let hit = this.cast(from, dir, lift + this.tune.gripReach);

    if (!hit) {
      for (const arc of WRAP_ARCS) {
        const wrapDir = this.scratchB.copy(frame.up).multiplyScalar(-Math.cos(arc))
          .addScaledVector(frame.forward, -Math.sin(arc)).normalize();
        const wrapFrom = this.scratchA.copy(frame.at)
          .addScaledVector(frame.up, this.tune.gripLift * 0.5);
        hit = this.cast(wrapFrom, wrapDir, this.tune.gripReach);
        if (hit) break;
      }
    }
    if (!hit) {
      this.gripping = false;
      this.fallSpeed = 0;
      return;
    }
    const normal = this.scratchC;
    this.normalAt(hit, normal);
    const seat = hit.addScaledVector(normal, this.tune.ride);
    this.seatToward(frame, seat, dt, still);
    this.aimUp(frame, normal, aimDt);
  }

  /**
   * Off the surface: world-frame gravity until something catches.
   *
   * Being INSIDE soil is not the same as having landed, and conflating them is
   * a teleport — every point in the ground answers solid, so losing grip in a
   * tunnel would fling her to the top of the hill. Underground she takes hold
   * of whatever is nearest instead; a burrow has a floor, walls and a ceiling
   * and all three are grip.
   */
  private fall(frame: WalkFrame, dt: number): void {
    this.fallSpeed += this.tune.gravity * dt;
    frame.at.y -= this.fallSpeed * dt;
    if (!this.solidAt(frame.at.x, frame.at.y, frame.at.z)) return;
    const near = this.nearestSurface(frame, frame.at);
    if (!near) return;
    /*
     * Through the slew, not straight onto her. Writing the normal into `up`
     * is a single-frame ninety-degree flip, and digging loses and re-takes
     * grip several times a second — measured at 3.94° of body rotation per
     * frame while digging against 0.15° while walking.
     */
    const found = this.scratchC;
    this.normalAt(near, found);
    this.aimUp(frame, found, dt);
    frame.at.copy(near).addScaledVector(frame.up, this.tune.ride);
    this.gripping = true;
    this.fallSpeed = 0;
  }

  /** Her forward, re-squared against whatever up she ended the frame on. */
  squareForward(frame: WalkFrame): void {
    frame.forward.addScaledVector(frame.up, -frame.forward.dot(frame.up));
    if (frame.forward.lengthSq() < 1e-8) {
      // A cheap vector guaranteed not to be parallel to any given one.
      frame.forward.set(frame.up.z, frame.up.x, frame.up.y);
      frame.forward.addScaledVector(frame.up, -frame.forward.dot(frame.up));
    }
    frame.forward.normalize();
  }

  /**
   * One frame of contact: hold on or fall, then square her up.
   *
   * `aimDt` is the attitude's own timestep, normally `dt`. Zero freezes her
   * attitude while leaving the seating alone — see `aimUp`.
   */
  settle(frame: WalkFrame, dt: number, aimDt = dt, still = false): void {
    if (this.gripping) this.hold(frame, dt, aimDt, still);
    else this.fall(frame, dt);
    this.squareForward(frame);
  }
}
