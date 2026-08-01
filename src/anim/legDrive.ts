/**
 * The legs drive the ant. The player drives the legs.
 *
 * The framing is a tank: the stick is the steering wheel and the throttle,
 * the ant is the vehicle, and the legs are the wheels. Which means the body
 * does not travel and drag its feet along behind it — the feet lock to the
 * world, and the body goes wherever the locked feet will let it.
 *
 * That inversion is worth the trouble because it makes three separate hacks
 * unnecessary. Gripping a wall is not a special case: a foot locked to a
 * wall simply holds. Walking the underside is not a special case either.
 * And an animal who cannot find anything to stand on does not slide — she
 * paddles and stays put, which is what should happen on a smooth overhang.
 *
 * ## How the loop runs
 *
 * 1. The stick PROPOSES a body motion.
 * 2. The planted feet CONSTRAIN it: a stance leg has a maximum reach, and a
 *    body that would over-travel is pulled back until every planted foot is
 *    reachable again. This is where "the legs move her" actually lives.
 * 3. What survives step 2 is her real displacement, and it is what advances
 *    the gait — so legs step in proportion to ground covered, like wheels
 *    turning, and a body that is blocked takes no steps at all.
 * 4. Swing legs reach for a new spot ahead; if there is nothing to stand on,
 *    the leg STAYS UP and the others carry her.
 *
 * Proposing and then constraining, rather than solving the body purely from
 * the feet, is a deliberate choice: a pure fit oscillates when two stance
 * feet disagree, and the disagreement is constant on rough ground. This
 * cannot oscillate — the constraint only ever removes motion.
 *
 * ## The numbers are measured, not chosen
 *
 * Reach comes from the rig: see `scripts/probe-legs.mjs`, which measures
 * each leg hip to FOOT in the pose she stands in, and again with every bone
 * up to that foot pulled straight. The difference is all a leg has spare
 * for reaching down past a lip — 1.12 mm at the front, 1.10 in the middle,
 * 1.83 at the back, and NOT the three to five millimetres it is tempting to
 * assume. A leg asked for reach it does not have does not stretch; the
 * solver drags the body down instead, which reads as sinking.
 *
 * "Foot" is `limbTip`, the last bone with geometry on it. The first version
 * of that probe measured to the last bone in the CHAIN and reported the
 * front legs 1.2 mm longer than they are, because every leg here ends in
 * two auto-rig terminals that carry no vertices and point back up above the
 * claw. Measuring to a marker floating above her foot is the same mistake
 * that once had the solver planting one.
 */

import * as THREE from 'three';

/** Millimetres per world unit. */
const MM = 5;

/** The two tripods: 1-4-5 and 2-3-6. */
export const TRIPOD_A = ['frontLeft', 'midRight', 'rearLeft'];
export const TRIPOD_B = ['frontRight', 'midLeft', 'rearRight'];

/**
 * How far a foot travels fore and aft of its home, per gait.
 *
 * One table, so the modes are compared rather than scattered. Turning takes
 * short steps because a spin on the spot is many small placements, and long
 * ones would have her lurching round in quarters.
 */
export const STRIDE_MM = { walk: 2.0, turn: 0.8 } as const;

/**
 * How far below its home a foot may reach for ground, per leg, in
 * millimetres — the measured spare reach and nothing more.
 */
export const REACH_DOWN_MM: Record<string, number> = {
  frontLeft: 1.12, frontRight: 1.12,
  midLeft: 1.10, midRight: 1.08,
  rearLeft: 1.83, rearRight: 1.83,
};

/**
 * And how far ABOVE home it may plant, which is bounded by folding the leg
 * rather than by stretching it and is therefore roomier. Two and a half
 * millimetres is a working figure rather than a measured one — the fold
 * limit belongs to the IK's joint limits, and estimating it here would be
 * inventing a number in a file whose whole point is not to.
 */
export const REACH_UP_MM = 2.5;

/** The body keeps this much daylight under it, or the legs push it up. */
export const RIDE_CLEARANCE_MM = 0.25;

/** Fraction of a swing after which the foot is down and locked. */
const LOCK_AT = 0.9;
/** Peak lift of a swinging foot, as a fraction of the stride. */
const SWING_LIFT = 0.35;
/** Seconds a swing takes when she is moving at all. */
const SWING_SECONDS = 0.16;

export interface LegSetup {
  slot: string;
  /** Rest position of the foot, in her body frame. */
  home: THREE.Vector3;
  /** Hip to foot in that pose, as the rig measures it. */
  reach: number;
}

/** What the room must answer for the legs to work. */
export interface Ground {
  /**
   * The nearest solid point to `at`, searching along `-up` and `+up` within
   * the band. Null when there is nothing to stand on, which is a real
   * answer and not a failure — the leg stays up.
   */
  nearest(at: THREE.Vector3, up: THREE.Vector3, down: number, rise: number): THREE.Vector3 | null;
}

interface Leg {
  slot: string;
  home: THREE.Vector3;
  /** World point the foot is locked to. Meaningless unless planted. */
  anchor: THREE.Vector3;
  planted: boolean;
  /** Swing endpoints and progress, used while not planted. */
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  /** Where the foot is right now, planted or mid-swing. */
  at: THREE.Vector3;
  /** True while it is reaching and has found nothing: held up. */
  groping: boolean;
  down: number;
}

export interface BodyPose {
  at: THREE.Vector3;
  up: THREE.Vector3;
  forward: THREE.Vector3;
}

export interface DriveInput {
  /** -1..1 along her forward. */
  walk: number;
  /** -1..1 about her up. */
  yaw: number;
  speed: number;
  yawRate: number;
}

export interface DriveReport {
  /** How far the body actually moved, after the feet had their say. */
  movedMm: number;
  /** How much of the proposal the feet refused. */
  heldBackMm: number;
  planted: number;
  groping: number;
  /** Daylight under her body at the end of the step. */
  clearanceMm: number;
}

export class LegDrive {
  private readonly legs: Leg[] = [];
  /** Which tripod is currently in the air. */
  private swinging: 0 | 1 = 0;
  /** 0..1 through the current half-cycle, advanced by DISTANCE. */
  private phase = 0;

  constructor(setup: LegSetup[]) {
    for (const leg of setup) {
      this.legs.push({
        slot: leg.slot,
        home: leg.home.clone(),
        anchor: new THREE.Vector3(),
        planted: false,
        from: new THREE.Vector3(),
        to: new THREE.Vector3(),
        t: 1,
        at: new THREE.Vector3(),
        groping: false,
        down: (REACH_DOWN_MM[leg.slot] ?? 1) / MM,
      });
    }
  }

  /** Where each foot should be drawn this frame, for the IK. */
  anchorFor(slot: string): readonly [number, number, number] | null {
    const leg = this.legs.find((l) => l.slot === slot);
    if (!leg) return null;
    return [leg.at.x, leg.at.y, leg.at.z];
  }

  /** How far a leg can be from its home before the body has over-travelled. */
  private maxReach(leg: Leg): number {
    return leg.home.length() + leg.down;
  }

  /** Home, in the world, for a given body pose. */
  private homeWorld(leg: Leg, body: BodyPose, into: THREE.Vector3): THREE.Vector3 {
    const right = new THREE.Vector3().crossVectors(body.up, body.forward).normalize();
    return into.copy(body.at)
      .addScaledVector(right, leg.home.x)
      .addScaledVector(body.up, leg.home.y)
      .addScaledVector(body.forward, leg.home.z);
  }

  /** Put every foot on the ground under its home. Call once, on spawn. */
  plantAll(body: BodyPose, ground: Ground): void {
    const home = new THREE.Vector3();
    for (const leg of this.legs) {
      this.homeWorld(leg, body, home);
      const hit = ground.nearest(home, body.up, leg.down, REACH_UP_MM / MM);
      leg.planted = !!hit;
      leg.groping = !hit;
      leg.anchor.copy(hit ?? home);
      leg.at.copy(leg.anchor);
      leg.t = 1;
    }
  }

  /**
   * One step of the whole arrangement. Mutates `body`, returns what happened.
   */
  step(dt: number, body: BodyPose, input: DriveInput, ground: Ground): DriveReport {
    const turning = Math.abs(input.yaw) > Math.abs(input.walk);
    const stride = (turning ? STRIDE_MM.turn : STRIDE_MM.walk) / MM;

    /* 1. The stick proposes. */
    const before = body.at.clone();
    const proposed = body.at.clone()
      .addScaledVector(body.forward, input.speed * input.walk * dt);
    const yaw = input.yawRate * input.yaw * dt;

    /* 2. The planted feet constrain it. */
    const home = new THREE.Vector3();
    const probe: BodyPose = { at: proposed, up: body.up, forward: body.forward };
    for (let pass = 0; pass < 2; pass += 1) {
      for (const leg of this.legs) {
        if (!leg.planted) continue;
        this.homeWorld(leg, probe, home);
        const reach = this.maxReach(leg);
        const gap = home.distanceTo(leg.anchor);
        if (gap <= reach) continue;
        // Pull the body back along the line the foot is straining on.
        const pull = home.clone().sub(leg.anchor).normalize().multiplyScalar(gap - reach);
        proposed.sub(pull);
      }
    }

    const wanted = body.at.distanceTo(
      body.at.clone().addScaledVector(body.forward, input.speed * input.walk * dt),
    );
    body.at.copy(proposed);
    if (Math.abs(yaw) > 1e-9) body.forward.applyAxisAngle(body.up, yaw).normalize();
    const moved = before.distanceTo(body.at);

    /* 3. Distance advances the gait, so the legs are wheels and not a clock. */
    if (stride > 1e-6) this.phase += (moved + Math.abs(yaw) * 0.5) / stride;
    if (this.phase >= 1) {
      this.phase = 0;
      this.swinging = this.swinging === 0 ? 1 : 0;
      const group = this.swinging === 0 ? TRIPOD_A : TRIPOD_B;
      for (const leg of this.legs) {
        if (!group.includes(leg.slot)) continue;
        leg.planted = false;
        leg.t = 0;
        leg.from.copy(leg.at);
      }
    }

    /* 4. Swing legs reach ahead; a leg that finds nothing stays up. */
    let groping = 0;
    let planted = 0;
    for (const leg of this.legs) {
      if (leg.planted) {
        leg.at.copy(leg.anchor);
        planted += 1;
        continue;
      }
      this.homeWorld(leg, body, home);
      const ahead = home.clone().addScaledVector(body.forward, stride * 0.5);
      const hit = ground.nearest(ahead, body.up, leg.down, REACH_UP_MM / MM);
      if (!hit) {
        /*
         * Nothing to stand on. She keeps the leg raised and keeps reaching —
         * over the lip of a block this is the frame or two before the foot
         * finds the side, and mid-air it is the paddling that is correct.
         */
        leg.groping = true;
        groping += 1;
        leg.at.copy(ahead).addScaledVector(body.up, stride * SWING_LIFT);
        continue;
      }
      leg.groping = false;
      leg.to.copy(hit);
      leg.t = Math.min(1, leg.t + dt / SWING_SECONDS);
      const arc = Math.sin(Math.PI * Math.min(1, leg.t)) * stride * SWING_LIFT;
      leg.at.lerpVectors(leg.from, leg.to, leg.t).addScaledVector(body.up, arc);
      if (leg.t >= LOCK_AT) {
        leg.planted = true;
        leg.anchor.copy(leg.to);
        leg.at.copy(leg.anchor);
        planted += 1;
      }
    }

    /*
     * 5. Ride height. She keeps a little daylight under her, and when the
     * ground rises into her the stance legs push down to lift her clear —
     * bounded by the same spare reach, so on a hard floor she bottoms out
     * and drags instead of floating through it.
     */
    const under = ground.nearest(body.at, body.up, 6 / MM, 0.6 / MM);
    let clearance = Infinity;
    if (under) {
      clearance = body.at.clone().sub(under).dot(body.up);
      const want = RIDE_CLEARANCE_MM / MM;
      if (clearance < want) {
        const budget = Math.min(...this.legs.filter((l) => l.planted).map((l) => l.down), 1);
        const lift = Math.min(want - clearance, Number.isFinite(budget) ? budget : want);
        body.at.addScaledVector(body.up, lift);
        clearance += lift;
      }
    }

    return {
      movedMm: moved * MM,
      heldBackMm: Math.max(0, wanted - moved) * MM,
      planted,
      groping,
      clearanceMm: Number.isFinite(clearance) ? clearance * MM : -1,
    };
  }
}
