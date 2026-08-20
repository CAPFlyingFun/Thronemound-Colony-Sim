/**
 * ONE ANT, MOVED — the movement system, and nothing above or below it.
 *
 * The brief's ownership chain for this milestone reads:
 *
 *     ANT AI          decides what she wants        `antStroll`
 *     MOVEMENT        moves her                     THIS FILE
 *     IK / ANIMATION  poses her                     `LegDrive`, `QueenModel`
 *
 * So this takes an intent it did not choose, hands it to legs it does not
 * pose, and seats the result on ground it does not own. It never asks what
 * she is trying to achieve and it never touches a bone.
 *
 * THE LEGS MOVE HER, which is the island build's hardest-won lesson and the
 * one piece of its movement thinking worth carrying over: `LegDrive.step`
 * displaces `at` by what her planted feet could actually reach, so the gait
 * and the travel cannot disagree. Nothing here integrates a velocity.
 *
 * WHAT IS DELIBERATELY MISSING. There is no wall-climbing, no corner
 * scheduler, no gravity and no fall. Milestone 0's acceptance is a queen
 * standing and walking correctly on soil with small surface variation, and
 * every one of those systems is a later milestone that will want its own
 * proof. Her up is world up, and the seater below says why that is honest
 * here and would not be on a slope worth the name.
 *
 * NOTHING FROM `IslandScene` OR `island*`. That is the milestone's own
 * acceptance criterion, and it is why this file re-derives a ride height and
 * a walking speed rather than importing `islandTuning`: those constants
 * belong to the frozen direct-control build, and reaching into them would
 * tie the new simulation to the thing it exists to replace.
 */

import * as THREE from 'three';
import { QueenModel } from '../anim/QueenModel';
import {
  FOOT_CLEARANCE_MM, LegDrive, REACH_DOWN_MM,
  type DriveReport, type Ground, type LegSetup,
} from '../anim/legDrive';
import { VOXEL_MM } from '../voxel/VoxelWorld';
import type { StrollIntent } from './antStroll';

/**
 * How fast she walks, in voxels a second — one voxel being five millimetres,
 * so this is 7 mm/s.
 *
 * NOT A TASTE, A RANGE THE GAIT WAS TUNED IN. A first cut picked 30 mm/s as
 * "an unhurried ant" and it is nothing of the kind: her stride is 2 mm
 * (`STRIDE_MM.walk`), so 30 mm/s asks for fifteen leg cycles a second and
 * the tripod never finishes one. Measured — 1.60 of 6 legs groping the whole
 * time she walked, because they were permanently in swing.
 *
 * The frozen build walks the player at 1.8 units/s and its roaming colonists
 * at 1.1. This sits between them, which is where the leg drive's stride,
 * spare reach and gait thresholds were all measured. An observer's ant
 * should amble anyway.
 */
export const WALK_SPEED = 1.4;

/**
 * WHERE THE FLOOR IS UNDER A POINT, ASKED FROM A HEIGHT.
 *
 * The third argument is the one that lets her go underground. Asked without
 * it, a world answers "the top of that column" — correct on the surface and
 * catastrophic in a burrow, where the top of her column is the roof with the
 * whole tray sitting on it. She would be lifted out of her own tunnel.
 *
 * `QueenModel.solveFeet` takes the same argument for the same reason, at the
 * foot instead of at the body. This is that rule one level up.
 */
export type SurfaceQuery =
  (x: number, z: number, from?: number) => number | null;

/**
 * How far above her body origin she looks for a floor, in voxels.
 *
 * It has to clear the highest bank she is allowed to step onto and stay well
 * under the roof of a tunnel she fits in — a scan that starts inside the
 * ceiling finds the ceiling and calls it ground. Her corridor is about two
 * and a half voxels tall and she rides near the bottom of it, so one voxel up
 * is inside the air either way.
 */
export const LOOK_UP = 1;

/** And how fast she comes round, in radians a second. */
export const TURN_RATE = 1.6;

/**
 * BODY = HEIGHT. LEGS = MOTION.
 *
 * The gap held between the lowest point of her BODY and the soil, in
 * millimetres. Asked for from the device, and it is a correction of what
 * this file did first:
 *
 *   "the height above the ground needs to be the bottom of the ant's body
 *    to ground to keep a constant height (like 0.4mm) and the legs will
 *    naturally stretch longer if it needs to, while the legs drive the ant
 *    forward."
 *
 * The first cut seated her on the SOLE PLANE — the mean height of her leg
 * homes in the bind pose — which sounds equivalent and is not. That number
 * describes where her FEET are, so it ties her body to her legs: every
 * foothold on uneven soil moves the whole animal, and she bobs with the
 * terrain instead of gliding over it. Held at the belly, the body is a
 * smooth line and the legs are what reach — which is what an ant looks
 * like, and what the request says in four words.
 *
 * 0.25 AND NOT THE 0.4 THAT WAS ASKED FOR, and the difference is measured
 * rather than preferred. This rig is authored with its origin ON the ground
 * and its gaster hanging to within 0.23 mm of it, so holding the belly at a
 * given clearance lifts the WHOLE ant by very nearly that much — and a leg's
 * spare downward reach is small and measured: 1.08 mm at her tightest
 * (`REACH_DOWN_MM`). Whatever the seat spends, the terrain cannot have.
 *
 * Walking her 300 frames across the tray at each clearance, feet of six:
 *
 *     clearance   planted   groping
 *      0.00 mm     4.11      0.00      (the old sole-plane seat)
 *      0.15 mm     4.11      0.00
 *      0.25 mm     4.08      0.08
 *      0.30 mm     3.94      0.25
 *      0.40 mm     2.67      2.08      <- the asked-for figure
 *
 * At 0.4 mm a third of her feet are in the air reaching for ground they
 * cannot get to, which is the "animation looks off" this change is meant to
 * cure and not a thing to ship a cure with. 0.25 mm is the most this rig
 * carries cleanly; it still lifts her gaster off the soil it was dragging
 * on, which was the real fault.
 *
 * ONE CONSTANT. If the tray gets gentler or the rig's legs get longer, raise
 * it and re-run `npm run probe:habitat` — it now fails on groping feet.
 */
export const BELLY_CLEARANCE_MM = 0.25;

/**
 * HOW FAR A PLANTED FOOT MAY RISE ABOVE ITS HOME before she picks it up
 * again, in millimetres.
 *
 * Reported from the device: "the feet still keep rising above her body while
 * she was dropping down." They were — measured over her entrance shaft, the
 * mean planted foot stood 3.86 mm above her body origin and the worst 6.77,
 * against a back that is 3.17 mm high. Her feet were over her own thorax.
 *
 * The cause is in `LegDrive.excursion`, which projects the vertical out of a
 * stance foot's strain on purpose: the gait circle is a circle on the ground,
 * which is right for an animal walking OVER terrain and wrong for one whose
 * floor is being dug away underneath her. Nothing horizontal moved, so no
 * foot was ever spent, so no foot was ever lifted.
 *
 * The number is her BELLY CLEARANCE, and that is not a coincidence: her leg
 * homes sit within a hair of her belly line in the bind pose, so "no more
 * than one clearance above home" is the same statement as "a foot may not get
 * more than a clearance above the underside of her body". Which is what an
 * ant looks like, and what the device asked for the first time round: "most
 * ants keep their feet below their body so they don't lose their balance".
 */
export const FOOT_LIFT_MM = BELLY_CLEARANCE_MM;

/**
 * How quickly her height chases the ground it is aiming at, as a time
 * constant in seconds — UP and DOWN separately.
 *
 * Both smoothed, per the request ("should use like Lerp or something to be
 * smooth especially if the terrain is bumpy"), and framerate-independent:
 * the step is `1 - exp(-dt/tau)`, so a 30 Hz frame and a 120 Hz frame land
 * in the same place. A plain `lerp(a, b, 0.2)` does not, and this build
 * runs at wildly different rates between the device and the probe.
 *
 * Rising is the faster of the two because a slow rise is a belly through a
 * bump, while a slow fall is only a longer leg — one is a bug and the other
 * is the animation the request asks for.
 */
export const RISE_TAU = 0.05;
export const FALL_TAU = 0.13;

/**
 * Where she looks for the ground her body has to clear: a disc `AHEAD_MM`
 * in front of her, of radius `LOOK_RADIUS_MM`.
 *
 * "maybe do like a ground/obstacle sample ahead 3mm in a 3mm radius" — and
 * the reason it has to be ahead is the smoothing above. Chasing only the
 * soil directly under her means she starts rising when her belly is already
 * at the bump; sampling forward starts the rise while the bump is still in
 * front of her, which is what makes a time constant look like anticipation
 * instead of lag.
 *
 * The HIGHEST sample in the disc wins, not the mean: the disc's job is to
 * keep her belly out of the soil, and a mean lets the tallest thing in it
 * through.
 */
export const AHEAD_MM = 3;
export const LOOK_RADIUS_MM = 3;

/** The castes with a rig. Taken off `QueenModel` so the two cannot drift. */
export type Caste = ConstructorParameters<typeof QueenModel>[0];

export class AntBody {
  readonly model: QueenModel;

  readonly at = new THREE.Vector3();

  /** World up, for this milestone. See the note at the head of the file. */
  readonly up = new THREE.Vector3(0, 1, 0);

  readonly forward = new THREE.Vector3(0, 0, 1);

  private drive: LegDrive | null = null;

  /**
   * How far her body origin rides above the ground her belly is clearing —
   * her measured belly drop plus `BELLY_CLEARANCE_MM`. A constant, because
   * the whole point of the belly model is that this number does not move.
   */
  private ride = 0;

  /**
   * And where her SOLE PLANE sits in the bind pose, signed, relative to the
   * same origin. Kept only as the fallback seat for a rig whose skin never
   * measured — the body does not ride on it any more.
   */
  private solePlane = 0;

  /**
   * The anchors, switchable — a DIAGNOSTIC, in the same spirit as
   * `QueenModel.ikEnabled`. Feet sliding under a walking ant has two
   * suspects, the gait and the solver, and the only way to tell them apart
   * is to take the anchor away and see whether the slide survives. Always
   * true in the game.
   */
  useAnchorsForTest = true;

  /** Her longest leg, from the rig. The leg solver's snap-down window. */
  private legReach = 0;

  /**
   * How much HIGHER than the soil directly under her the look-ahead is
   * allowed to seat her, in world units.
   *
   * Not a taste — what is left of her legs. A leg's spare downward reach is
   * measured, small and per-leg (`REACH_DOWN_MM`: 1.08 mm at her tightest),
   * and `legDrive`'s own note is explicit about overspending it: "A leg
   * asked for reach it does not have does not stretch; the solver drags the
   * body down instead, which reads as sinking." Holding her belly clear
   * already spends part of that budget; this is the remainder, and it is
   * what the anticipation gets.
   *
   * Measured what happens without it: aiming at the tallest soil in a 6 mm
   * disc on a tray with 7.5 mm of relief asked for lifts several times her
   * spare reach, and she walked with 2.08 of 6 feet groping — up from 0.04.
   */
  private liftCap = 0;

  /**
   * The height her body is currently AIMING at: the top of the highest soil
   * in the look-ahead disc. `at.y` chases this rather than jumping to it —
   * see `seat`.
   */
  private aim: number | null = null;

  ready = false;

  constructor(caste: Caste = 'queen') {
    this.model = new QueenModel(caste);
    this.model.root.visible = false;
  }

  async load(): Promise<boolean> {
    const ok = await this.model.load();
    this.ready = ok;
    this.model.root.visible = ok;
    if (ok) this.buildDrive();
    return ok;
  }

  /**
   * Her legs, and — separately — the height her BODY rides at.
   *
   * Two numbers off the same bind pose, and the reason they are two is the
   * correction this file exists around. The ride comes off her BELLY, so it
   * is a fact about her body and holds still. The sole drop comes off her
   * LEG HOMES, and it stays only as the leg solver's search band. Seating
   * her on the sole plane — which is what the first cut did — makes her
   * body a function of her feet, and then a foothold on a lump lifts the
   * whole ant.
   *
   * A rig that measured no belly reports zero, and there the sole plane is
   * the only honest fallback: better a queen standing on her old, slightly
   * tall seat than one buried to the thorax.
   */
  private buildDrive(): void {
    const setup: LegSetup[] = this.model.legPlan().map((leg) => ({
      slot: leg.slot,
      home: new THREE.Vector3(leg.home[0], leg.home[1], leg.home[2]),
      reach: leg.reach,
    }));
    if (setup.length === 0) return;
    const meanFootY = setup.reduce((sum, leg) => sum + leg.home.y, 0) / setup.length;
    /*
     * The sole plane, as a SIGNED offset from her origin — and on this rig
     * it is a positive one: the GLB is authored with its origin on the
     * ground and her feet a quarter of a millimetre above it. Which is why
     * the leg band below is taken from her leg REACH and not from this.
     */
    this.solePlane = meanFootY;
    this.legReach = Math.max(...setup.map((leg) => leg.reach));

    const belly = this.model.bellyAboveOrigin();
    /*
     * BELLY FIRST, sole plane only as a fallback. `ride` is where her ORIGIN
     * goes relative to the soil, so putting her belly a fixed gap up means
     * subtracting where the belly sits within her: origin = ground + gap -
     * bellyOffset. A rig that measured no skin gets the old sole-plane seat,
     * which is slightly tall and never buried.
     */
    this.ride = belly === null
      ? -meanFootY + BELLY_CLEARANCE_MM / VOXEL_MM
      : BELLY_CLEARANCE_MM / VOXEL_MM - belly;
    const spareWu = Math.min(
      ...setup.map((leg) => (REACH_DOWN_MM[leg.slot] ?? 1) / VOXEL_MM),
    );
    const footLift = this.ride + this.solePlane;
    this.liftCap = Math.max(0, spareWu - footLift);
    /* Her own back is the ceiling on how high a foot may reach — measured
     * off her skin, not guessed. See `LegDrive`'s note on `REACH_UP_MM`. */
    this.drive = new LegDrive(setup, 1, this.model.bodyTopAboveSole());
  }

  /** What the probe needs to check the seat is the one that was asked for. */
  seatForTest(): { rideMm: number; bellyMm: number; soleMm: number } {
    return {
      rideMm: this.ride * VOXEL_MM,
      bellyMm: (this.model.bellyAboveOrigin() ?? 0) * VOXEL_MM,
      soleMm: this.solePlane * VOXEL_MM,
    };
  }

  /** Which way her nose points, as a world bearing. */
  get heading(): number {
    return Math.atan2(this.forward.x, this.forward.z);
  }

  set heading(radians: number) {
    this.forward.set(Math.sin(radians), 0, Math.cos(radians)).normalize();
  }

  /**
   * The last frame's report from her legs — how far she actually moved, how
   * many feet are down, how many are groping. Read by the probe, because
   * "she walks correctly" is a claim about her feet and not about her
   * position.
   */
  report: DriveReport | null = null;

  /**
   * Set her down at a place, seated on whatever is under it.
   *
   * `surfaceY` is asked of the caller rather than found here because the
   * ground is the simulation's, not the body's — the same reason `step`
   * takes a `Ground` instead of a world.
   */
  place(x: number, z: number, surfaceY: number, heading = 0): void {
    this.at.set(x, surfaceY + this.ride, z);
    this.heading = heading;
    this.up.set(0, 1, 0);
    /* A placement is a teleport, and a teleport is the one time her height
     * may jump: smoothing it would sink her into the soil and glide her out
     * of it over a tenth of a second, in full view. */
    this.aim = surfaceY;
  }

  /** Plant every foot where it stands — after a placement or a teleport. */
  plant(ground: Ground): void {
    this.drive?.plantAll(
      { at: this.at, up: this.up, forward: this.forward }, ground,
    );
  }

  /**
   * One frame. `surfaceAt` answers where the soil's top is under an x/z,
   * which is the seater's whole input.
   */
  step(
    dt: number,
    intent: StrollIntent,
    ground: Ground,
    surfaceAt: SurfaceQuery,
  ): void {
    if (!this.ready || !this.drive) return;

    this.report = this.drive.step(
      dt,
      { at: this.at, up: this.up, forward: this.forward },
      {
        walk: intent.walk,
        yaw: intent.turn,
        speed: WALK_SPEED,
        yawRate: TURN_RATE,
        settle: false,
        /* See `FOOT_LIFT_MM`. Opt-in; the frozen build passes nothing. */
        liftAbove: FOOT_LIFT_MM / VOXEL_MM,
        /* No corners in this milestone — she has nothing to climb onto and
         * a transition she cannot finish is worse than one she never
         * starts. Wall-walking is its own milestone. */
        mayTransition: false,
      },
      ground,
    );

    /*
     * AND SEATED AFTERWARDS, not before.
     *
     * The legs have just moved her across the soil; her height belongs to
     * where she has ARRIVED, not to where she set off. Doing this first
     * seats her on last frame's ground and reads as a body that lags its own
     * feet down a step.
     */
    this.seat(dt, surfaceAt);

    /*
     * AND POSED LAST — the same order and the same two calls the island's
     * colonists use, because this is the shared animation layer and the new
     * simulation bends to it rather than the other way round.
     *
     * `solveFeet` takes a HEIGHT FUNCTION rather than the drive's legs: the
     * gait decides where a foot is going and the IK decides what that looks
     * like, which is the split the brief asks for and one this rig already
     * had.
     */
    RIGHT.crossVectors(this.up, this.forward).normalize();
    this.model.root.position.copy(this.at);
    this.model.root.quaternion.setFromRotationMatrix(
      BASIS.makeBasis(RIGHT, this.up, this.forward),
    );
    this.model.update(dt, {
      speed: Math.abs(intent.walk) * WALK_SPEED,
      turn: intent.turn * TURN_RATE,
      digging: 0,
      carrying: 0,
      headYaw: 0,
      headPitch: 0,
    });
    this.model.solveFeet(
      (x, z, y) => surfaceAt(x, z, y + LOOK_UP) ?? this.aim ?? this.at.y - this.ride,
      FOOT_CLEARANCE_MM / VOXEL_MM,
      /*
       * THE LEG BAND, off her LEG REACH — and the old value was worse than
       * wrong, it was NEGATIVE.
       *
       * `band` is the window within which a planted foot gets pulled down
       * onto the soil (`footTarget`: a foot less than `band` above resting
       * is put at resting). The old `ride * 2` computed that window from the
       * body's seat, and on this rig the seat is a small NEGATIVE number —
       * her origin sits just under the sole plane — so the window was
       * negative and no planted foot was ever pulled down at all. Each one
       * hung wherever the gait left it. That is a fair share of "the
       * animation looks off".
       *
       * Her own longest leg is the honest window: a foot further above the
       * ground than her leg is long is not a foot she failed to plant.
       */
      this.legReach,
      /*
       * AND THE ANCHORS, which is the other half of "the animation looks
       * off". `solveFeet`'s own note is blunt about what omitting this
       * costs: without an anchor "nothing in the whole pipeline ever knew
       * where a foot was in the world from one frame to the next", so a
       * stance foot is re-derived from the body every frame and slides
       * along under her. Given one, a planted foot goes back on the same
       * world point and its ground speed is exactly zero.
       *
       * The gait already tracks that point — `LegDrive` moved her BY it.
       * This just stops the IK from throwing it away.
       */
      (slot) => (this.useAnchorsForTest ? this.drive?.anchorFor(slot) ?? null : null),
    );
  }

  /**
   * HER HEIGHT, held at a constant belly clearance and smoothed.
   *
   * Three things, in order:
   *
   * 1. LOOK AHEAD. The highest soil in a disc `AHEAD_MM` in front of her,
   *    radius `LOOK_RADIUS_MM`, plus the column she is standing in. Highest
   *    rather than mean, because the disc's job is to keep her belly out of
   *    the soil and a mean lets the tallest thing in it through.
   *
   * 2. CHASE IT. Exponential, framerate-independent, and faster upward than
   *    down: a late rise is a belly through a bank, a late fall is only a
   *    longer leg.
   *
   * 3. AND HOLD STILL when the world has no answer. There is no gravity in
   *    this milestone, so "no ground under me" is a situation to stay put
   *    in rather than to fall through.
   */
  private seat(dt: number, surfaceAt: SurfaceQuery): void {
    const lead = AHEAD_MM / VOXEL_MM;
    const radius = LOOK_RADIUS_MM / VOXEL_MM;
    const cx = this.at.x + this.forward.x * lead;
    const cz = this.at.z + this.forward.z * lead;

    const eye = this.at.y + LOOK_UP;
    const local = surfaceAt(this.at.x, this.at.z, eye);
    if (local === null) return;

    let ahead = local;
    for (const [ox, oz] of LOOK_RING) {
      const hit = surfaceAt(cx + ox * radius, cz + oz * radius, eye);
      if (hit === null) continue;
      /*
       * A WALL IS NOT GROUND AHEAD, and this line is the difference between
       * a queen who can walk down her own tunnel and one who cannot.
       *
       * The look-ahead exists to lift her belly over what is coming. It was
       * written on the surface, where every sample in the disc is soil she
       * might walk onto. Underground, the disc is three millimetres wide and
       * the tunnel is about twelve, so the WALLS are always in it — and a
       * wall reads as ground a whole voxel higher than the floor. She was
       * lifted by her entire spare leg reach at every step of the descent,
       * permanently, and then had nothing left to reach the floor with.
       * Measured: about 1.5 of 6 feet groping the whole way down, and it did
       * not care about the ramp's grade or the tunnel's width — because it
       * was never about either.
       *
       * A rise she could not follow anyway is therefore IGNORED rather than
       * clamped. She is not going to step onto it: the stroller's own test
       * refuses to walk at soil that is where her body wants to be, and her
       * legs could not climb it if it did.
       */
      if (hit - local > this.liftCap) continue;
      if (hit > ahead) ahead = hit;
    }

    /* Still capped, because the samples that survive are the ones she can
     * follow, and the cap is what "can follow" means. */
    const top = local + Math.min(ahead - local, this.liftCap);

    this.aim = top;
    const want = top + this.ride;
    const tau = want > this.at.y ? RISE_TAU : FALL_TAU;
    /* `1 - exp(-dt/tau)` rather than a fixed lerp factor: this build runs
     * at 120 Hz on the device and a small fraction of that under the
     * probe's software renderer, and a fixed factor would settle at two
     * different speeds in the two. Clamped so one very long frame lands
     * on the target instead of overshooting past it. */
    this.at.y += (want - this.at.y) * Math.min(1, 1 - Math.exp(-dt / tau));
  }
}

/**
 * The rim of the look-ahead disc, as unit offsets. Centre plus six around
 * it — enough to catch a bank arriving from any bearing, cheap enough to run
 * every frame for every ant in a colony.
 */
const LOOK_RING: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0], [0.5, 0.866], [-0.5, 0.866],
  [-1, 0], [-0.5, -0.866], [0.5, -0.866],
];

/* Scratch, so a walking ant allocates nothing per frame. */
const RIGHT = new THREE.Vector3();
const BASIS = new THREE.Matrix4();
