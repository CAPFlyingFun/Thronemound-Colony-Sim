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
  FOOT_CLEARANCE_MM, LegDrive, type DriveReport, type Ground, type LegSetup,
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

/** And how fast she comes round, in radians a second. */
export const TURN_RATE = 1.6;

/**
 * How far her feet hang below her body origin is a fact about her RIG, not a
 * number anybody gets to choose — see `legPlan`. This is the small extra gap
 * held between the sole plane and the soil so a foot rests ON the surface
 * rather than in it, in voxels.
 */
export const FOOT_AIR = 0.01;

/** The castes with a rig. Taken off `QueenModel` so the two cannot drift. */
export type Caste = ConstructorParameters<typeof QueenModel>[0];

export class AntBody {
  readonly model: QueenModel;

  readonly at = new THREE.Vector3();

  /** World up, for this milestone. See the note at the head of the file. */
  readonly up = new THREE.Vector3(0, 1, 0);

  readonly forward = new THREE.Vector3(0, 0, 1);

  private drive: LegDrive | null = null;

  /** Her body origin's height above the soil, from her own leg plan. */
  private ride = 0;

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
   * Her legs, and the height they imply.
   *
   * The ride is minus the mean foot height in her own bind pose: her rig
   * puts its sole plane a little below her origin, so seating the origin AT
   * the soil would bury her feet and seating it a guessed distance above
   * would have them hover. The rig's own number is the only one that cannot
   * be wrong.
   */
  private buildDrive(): void {
    const setup: LegSetup[] = this.model.legPlan().map((leg) => ({
      slot: leg.slot,
      home: new THREE.Vector3(leg.home[0], leg.home[1], leg.home[2]),
      reach: leg.reach,
    }));
    if (setup.length === 0) return;
    const meanFootY = setup.reduce((sum, leg) => sum + leg.home.y, 0) / setup.length;
    this.ride = -meanFootY + FOOT_AIR;
    /* Her own back is the ceiling on how high a foot may reach — measured
     * off her skin, not guessed. See `LegDrive`'s note on `REACH_UP_MM`. */
    this.drive = new LegDrive(setup, 1, this.model.bodyTopAboveSole());
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
    surfaceAt: (x: number, z: number) => number | null,
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
     *
     * A missing answer leaves her where she is rather than dropping her.
     * There is no gravity in this milestone, so "no ground under me" is a
     * situation to hold still in, not to fall through.
     */
    const surface = surfaceAt(this.at.x, this.at.z);
    if (surface !== null) this.at.y = surface + this.ride;

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
      (x, z) => surfaceAt(x, z) ?? this.at.y - this.ride,
      FOOT_CLEARANCE_MM / VOXEL_MM,
      this.ride * 2,
    );
  }
}

/* Scratch, so a walking ant allocates nothing per frame. */
const RIGHT = new THREE.Vector3();
const BASIS = new THREE.Matrix4();
