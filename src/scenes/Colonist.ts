/**
 * A COLONIST — a worker or a major, walking on her own legs.
 *
 * Pulled out of `IslandScene.ts` (via the tuning split) into her own file,
 * unchanged. She was never a constant and never really belonged in the
 * scene either: she owns a model, a leg drive and a heading, and the scene's
 * only business with her is holding the list and stepping it.
 *
 * The queen is not one of these. She has the spine, the corner scheduler,
 * the dig and the camera hanging off her; a colonist has legs and somewhere
 * to be, which is the whole difference and the reason this is a small file.
 */

import * as THREE from 'three';

import { QueenModel } from '../anim/QueenModel';
import { FOOT_CLEARANCE_MM, LegDrive, type Ground, type LegSetup } from '../anim/legDrive';
import { MM } from '../world/worldScape';
import {
  COLONIST_ARRIVE, COLONIST_FALL, COLONIST_FALL_MAX, COLONIST_SPEED,
  COLONIST_STEP_DOWN, COLONIST_STEP_UP, COLONIST_TURN, FOOT_AIR, RIDE,
} from './islandTuning';

export /**
 * A COLONIST — a worker or a major, walking the island on her own legs.
 *
 * The first worker was a JIG: a fixed circle, a hard-coded speed handed
 * straight to the gait, and a height read off the heightfield. It looked
 * like a toy beside a queen whose legs carry her, and the note under it
 * said so — "not yet a colonist with jobs; that part arrives with the
 * sandbox mechanics".
 *
 * This is those mechanics. She gets the same `LegDrive` the player has, so
 * her gait comes out of the step she actually took rather than a number
 * hoped into agreement with it; the same leg-rest seating and the same
 * `FOOT_AIR` floor, so she stands ON the ground; and a heading of her own.
 *
 * She does NOT get the queen's jaws. Digging wants two mandibles and a bore
 * rig, and a colonist has neither — which is why the caste split is here
 * and not a flag on one shared body.
 */
class Colonist {
  readonly model: QueenModel;

  ready = false;

  readonly at = new THREE.Vector3();

  readonly up = new THREE.Vector3(0, 1, 0);

  readonly fwd = new THREE.Vector3(0, 0, 1);

  private drive: LegDrive | null = null;

  private ride = RIDE;

  /** Where she is headed, and how long before she picks somewhere else. */
  private readonly want = new THREE.Vector3();

  private dwell = 0;

  private speed = 0;

  /** How fast she is falling, world units a second — see the seating. */
  private fall = 0;

  private readonly wasAt = new THREE.Vector3();

  private readonly right = new THREE.Vector3();

  private readonly basis = new THREE.Matrix4();

  /** Her name on the shove list. Stable for as long as she lives. */
  readonly id: number;

  constructor(
    readonly caste: 'worker' | 'major',
    private readonly rand: () => number,
    id = 0,
  ) {
    this.id = id;
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

  /** Her legs' own rest plane, measured the same way the queen's is. */
  private buildDrive(): void {
    const setup: LegSetup[] = this.model.legPlan().map((leg) => ({
      slot: leg.slot,
      home: new THREE.Vector3(leg.home[0], leg.home[1], leg.home[2]),
      reach: leg.reach,
    }));
    if (setup.length === 0) return;
    const meanFootY = setup.reduce((sum, leg) => sum + leg.home.y, 0) / setup.length;
    this.ride = -meanFootY + FOOT_AIR;
    this.drive = new LegDrive(setup);
  }

  place(x: number, z: number, groundAt: (px: number, pz: number) => number): void {
    this.at.set(x, groundAt(x, z) + this.ride, z);
    this.want.set(x, 0, z);
    this.dwell = 0;
  }

  step(
    dt: number,
    home: THREE.Vector3,
    roam: number,
    groundAt: (x: number, z: number) => number,
    normalAt: (p: THREE.Vector3, into: THREE.Vector3) => void,
    ground: Ground,
  ): void {
    if (!this.ready) return;

    this.dwell -= dt;
    if (this.dwell <= 0) {
      /* Somewhere else within reach of where she hatched — a colonist with
       * no leash is over the horizon in a minute. */
      const a = this.rand() * Math.PI * 2;
      const r = roam * (0.35 + this.rand() * 0.65);
      this.want.set(home.x + Math.cos(a) * r, 0, home.z + Math.sin(a) * r);
      this.dwell = 3 + this.rand() * 5;
    }

    const dx = this.want.x - this.at.x;
    const dz = this.want.z - this.at.z;
    const far = Math.hypot(dx, dz);
    let yaw = 0;
    let walk = 0;
    if (far > COLONIST_ARRIVE) {
      /*
       * Which side her target is on, about her OWN up.
       *
       * `up . (forward x target)` is positive when the target lies toward
       * `up x forward`, and a positive spin about up carries her nose that
       * same way — so the sign passes straight through with no convention
       * to get backwards.
       */
      const ux = dx / far;
      const uz = dz / far;
      const cx = this.fwd.y * uz;
      const cy = this.fwd.z * ux - this.fwd.x * uz;
      const cz = -this.fwd.y * ux;
      const side = this.up.x * cx + this.up.y * cy + this.up.z * cz;
      const ahead = (this.fwd.x * ux + this.fwd.z * uz);
      yaw = Math.max(-1, Math.min(1, side * 3));
      /* Walk once she is roughly pointed at it, and ease off as she lands,
       * or she paces back and forth across the spot for ever. */
      walk = ahead > 0.3 ? Math.min(1, far / (COLONIST_ARRIVE * 3)) : 0;
    } else {
      this.dwell = Math.min(this.dwell, 0);
    }

    this.wasAt.copy(this.at);
    this.drive?.step(
      dt,
      { at: this.at, up: this.up, forward: this.fwd },
      {
        walk,
        yaw,
        speed: COLONIST_SPEED,
        yawRate: COLONIST_TURN,
        settle: false,
        /*
         * NOT YET, and for a reason about this class rather than about the
         * scheduler — which is caste-agnostic and would run a worker's legs
         * on their own measured homes perfectly well.
         *
         * A colonist's body is PINNED: three lines below, her height is
         * written from the heightfield and her up from its normal, every
         * frame. Feet on a trunk would be dragged straight back off it by
         * that, so she would stage a transition she could never finish. The
         * queen is seated by the walker, which is what a corner needs.
         * Roaming NPCs get this when they get her seating.
         */
        mayTransition: false,
      },
      ground,
    );

    /* Seated on the island and leaning with it: a colonist on a bank stands
     * square to the bank, not plumb through it. */
    normalAt(this.at, this.up);
    if (this.up.lengthSq() < 1e-9) this.up.set(0, 1, 0);
    this.up.normalize();
    /*
     * SHE STANDS ON IT, STEPS DOWN IT, OR FALLS — three cases, and the
     * previous cut had one rate for all of them.
     *
     * Reported: "the other ants aren't sticking and walking through the
     * dirt sometimes." Both halves were the rate, and the climbing half was
     * my mistake: a cap on RISING ground is a cap on the one direction that
     * must never lag. Ground coming up under her at more than the cap means
     * she is inside it — which is walking through the dirt — and the drop
     * cap did the mirror image, leaving her hanging over ground that fell
     * away, which is not sticking to it.
     *
     * RISING IS NOT NEGOTIABLE. You cannot sink into a bank by standing on
     * it. What stops her levitating up a wall is not a slow climb, it is
     * REFUSING THE STEP — a rise of more than `COLONIST_STEP_UP` is a wall
     * and she does not take it, which is a fact about where she may walk
     * rather than about how fast she rises.
     *
     * FALLING IS THE ONLY THING WITH A RATE, and only past a step. Ordinary
     * undulation is a step and she takes it at once, so she sticks. A drop
     * bigger than a step is a shaft mouth, and there she accelerates rather
     * than descending at a constant speed, so a deep fall reads as a fall.
     */
    const wantY = groundAt(this.at.x, this.at.z) + this.ride;
    const gap = wantY - this.at.y;
    if (gap > COLONIST_STEP_UP) {
      /* A wall. Refuse the ground she tried to walk onto and stay where
       * she was — which is provably standing, since she was standing on
       * it last frame. */
      this.at.x = this.wasAt.x;
      this.at.z = this.wasAt.z;
      const heldY = groundAt(this.at.x, this.at.z) + this.ride;
      this.at.y = Math.max(this.at.y, heldY);
      this.fall = 0;
    } else if (gap >= -COLONIST_STEP_DOWN) {
      /* On it, or a step down she can simply take. */
      this.at.y = wantY;
      this.fall = 0;
    } else {
      this.fall = Math.min(COLONIST_FALL_MAX, this.fall + COLONIST_FALL * dt);
      this.at.y = Math.max(wantY, this.at.y - this.fall * dt);
      if (this.at.y === wantY) this.fall = 0;
    }
    this.fwd.addScaledVector(this.up, -this.fwd.dot(this.up));
    if (this.fwd.lengthSq() < 1e-9) this.fwd.set(0, 0, 1).addScaledVector(this.up, -this.up.z);
    this.fwd.normalize();

    /* What she TRAVELLED, across her own tangent plane — the honest number
     * the gait runs on, so a colonist stopped by a trunk stops her legs
     * instead of running on the spot. */
    this.wasAt.sub(this.at);
    this.wasAt.addScaledVector(this.up, -this.wasAt.dot(this.up));
    const went = this.wasAt.length() / Math.max(dt, 1e-6);
    this.speed += (went - this.speed) * Math.min(1, dt * 12);

    this.right.crossVectors(this.up, this.fwd).normalize();
    this.model.root.position.copy(this.at);
    this.model.root.quaternion.setFromRotationMatrix(
      this.basis.makeBasis(this.right, this.up, this.fwd),
    );
    this.model.update(dt, {
      speed: this.speed,
      turn: yaw * COLONIST_TURN,
      digging: 0,
      carrying: 0,
      headYaw: 0,
      headPitch: 0,
    });
    this.model.solveFeet(
      (x, z) => groundAt(x, z), FOOT_CLEARANCE_MM / MM, this.ride * 2,
    );
  }

  dispose(): void { this.model.dispose(); }
}
