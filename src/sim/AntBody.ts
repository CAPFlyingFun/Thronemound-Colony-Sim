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
import { RIGS } from '../anim/hexapod';
import { VOXEL_MM } from '../voxel/VoxelWorld';
import { BodyShell, type SegmentName, type SignedField } from './bodyShell';
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
 * How long her POSE takes to catch up with her intent, in seconds.
 *
 * See `poseSpeed` / `poseTurn`. Turn is the slower of the two because it is
 * the one that swings her abdomen; speed only has to keep the gait from
 * snapping between standing and walking in a single frame.
 */
export const POSE_SPEED_TAU = 0.09;
export const POSE_TURN_TAU = 0.14;
export const POSE_DIG_TAU = 0.18;

/**
 * HOW FAR SHE PITCHES HER BODY NOSE-DOWN TO DIG, in radians. About 34
 * degrees at full effort.
 *
 * THE BODY, NOT THE FOOT FRAME — and that separation is the whole of why
 * this works where two earlier attempts did not.
 *
 * The first tried leaning `up` itself onto the support normal. It pitched
 * her, and it also told `LegDrive` that the ground was tilted 57 degrees,
 * so her legs tried to stand on a plane that was not there: planted feet
 * fell from 4.0 to 1.13 and groping rose to 4.16. Body attitude and foot
 * support were the same vector, so leaning for the dig capsized the walk.
 *
 * They are different questions. Her feet are on a floor and want the floor's
 * normal; her body is leaning INTO a face and wants her own intent. A real
 * ant opening a nest braces her legs on the ground and drives her head down —
 * her feet do not tilt with her thorax. So `up` stays the foot frame, and
 * this pitches only the drawn body around it.
 *
 * AND IT IS DELIBERATELY SHALLOWER THAN THE BORE. `digBrain.DIG_PITCH` aims
 * the cut 57 degrees below her forward; this leans the body 34. The gap is
 * not a disagreement, it is the HEAD: her thorax tips a third of a turn and
 * her head carries the rest, which is the decomposition Joshua asked for —
 * "mid-thorax through mandibles, with the head raising and lowering". So the
 * bore is left exactly as it was, because it was already the sum of the two,
 * and 33.6 mm of measured excavation depends on it.
 */
export const DIG_PITCH_DOWN = 0.6;

/** How fast the body settles into that pitch, in seconds. */
export const PITCH_TAU = 0.2;

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

/**
 * A TUNNEL SHE CAN RIDE — the shape of a rail, as this file needs it.
 *
 * Declared here in WORLD UNITS rather than importing `TunnelRail`, which
 * speaks millimetres and lives with the island's track builder. The
 * conversion belongs at the edge, in whatever supplies the rail; three unit
 * systems have caused real bugs in this project and this keeps the movement
 * system in exactly one of them.
 */
export interface BodyRail {
  /** How long the tunnel is, in world units. */
  lengthWu: number;
  /** The bore's radius, world units — the tube her feet stand inside. */
  radiusWu: number;
  /** The frame at a distance along, or null past the ends. */
  frameAt(sWu: number, into: RailFrameOut): boolean;
  /** Where on the rail a world point is nearest, or null. */
  nearestTo(x: number, y: number, z: number): { sWu: number; distWu: number } | null;
}

export interface RailFrameOut {
  at: THREE.Vector3;
  up: THREE.Vector3;
  forward: THREE.Vector3;
}

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
   * WHAT HER POSE FOLLOWS, as opposed to what her steering obeys.
   *
   * `LegDrive` gets the raw intent — a brain that says "turn now" must turn
   * her now, and smoothing her steering would make her sluggish to command.
   * The POSE is a different question. `gaitPose` maps turn straight onto her
   * gaster's yaw and her body's roll, so an intent that changes in one frame
   * moves her abdomen in one frame, and the abdomen is the heaviest thing on
   * her.
   *
   * Measured on the tray: her brain was emitting turn impulses that lasted a
   * single frame, and each one snapped her gaster 0.497 mm sideways against a
   * median frame-to-frame motion of 0.052 mm — a tenfold spike, several times
   * a second. That is the shaking. The stroll's chatter is fixed separately
   * and is the larger half, but a pose that tracks its input instantly would
   * still snap on any honest change of mind, so both halves are worth having.
   *
   * `hexapod.ts` already claims this behaviour — "a heavy abdomen does not
   * track the thorax instantly" — and does not implement it. Rather than
   * change it there, where the frozen island reads the same function, the lag
   * is applied to the values handed IN. The island passes its own and is
   * untouched.
   */
  private poseSpeed = 0;

  private poseTurn = 0;

  /** And how far her head is dipped into the work. See `StrollIntent.dig`. */
  private poseDig = 0;

  /**
   * How far her body is pitched nose-down, in radians — drawn, and aimed
   * along, but NOT the frame her feet stand on. See `DIG_PITCH_DOWN`.
   */
  private bodyPitch = 0;

  /** Her penetration at the top of this frame. See `bodyClear`. */
  private insideBefore = 0;

  /**
   * THE TUNNEL SHE IS IN, when she is in one. Null on open ground.
   *
   * Riding is a second way of moving her and that is a deliberate exception
   * to this file's own first rule, "THE LEGS MOVE HER". The rule is right on
   * open ground, where the gait and the travel must not be able to disagree.
   * It cannot hold inside a plumb shaft: a tube six millimetres across gives
   * a nine-millimetre ant nowhere to put a tripod, and her body pitches to
   * 34 degrees against a shaft that drops at 90. Measured over four phases of
   * work, a free-walking ant simply cannot enter her own entrance — she stands
   * on the rim and stalls, which is what Joshua saw as the abdomen dance.
   *
   * On a rail the tunnel says where her body is and which way is up, and her
   * legs are posed against the tube's wall rather than searching a vertical
   * line for a floor that is not under her. That is how `RailScene` — the
   * room built to prove the track — has always ridden it, and this brings
   * the same mechanism to the colony build rather than inventing a third.
   */
  rail: BodyRail | null = null;

  /** How far along that rail she is, world units. */
  railS = 0;

  /**
   * WHERE EACH FOOT BRACES ON THE TUBE WALL, as an angle about the bore and
   * an offset along it. Derived once from the rig's own leg plan.
   *
   * Her planted stance is 7.22 mm across and her nominal bore is 6. On open
   * ground that is a curiosity; inside the tube it is decisive — the walk
   * animation puts her feet a millimetre or two OUTSIDE the wall, the height
   * solve has nothing to stand them on, and the drawn feet ended up as much
   * as 22 mm inside solid. Measured, with one leg groping 94 % of the ride.
   *
   * An ant in a gallery does not stand on a floor with her legs splayed as
   * if she were on the surface: she braces on the walls. So each foot keeps
   * its own ANGLE around the bore — the direction its home already points,
   * out from her spine — and is placed where that direction meets the wall.
   * The stance folds to whatever the tunnel is, without the rig or the caste
   * spec changing, which is what `CASTE_DIG` holding 6 mm nominal requires.
   */
  private tubeStations: Array<{
    slot: string; cos: number; sin: number; along: number;
  }> = [];

  /**
   * How far her body origin rides above the ground her belly is clearing —
   * her measured belly drop plus `BELLY_CLEARANCE_MM`. A constant, because
   * the whole point of the belly model is that this number does not move.
   */
  private ride = 0;

  /** How far her body origin rides above the floor, world units. Read by the
   *  world when it works out where a candidate pose would seat her. */
  get rideHeight(): number { return this.ride; }

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

  constructor(private readonly caste: Caste = 'queen') {
    this.model = new QueenModel(caste);
    this.model.root.visible = false;
  }

  async load(): Promise<boolean> {
    const ok = await this.model.load();
    this.ready = ok;
    this.model.root.visible = ok;
    if (ok) {
      this.buildDrive();
      /* `Caste` is read off QueenModel's constructor, whose parameter has a
       * default, so the type admits `undefined` while the value never is. */
      const rig = RIGS[this.caste ?? 'queen'];
      if (rig) this.shell = BodyShell.measure(this.model.root, rig);
      this.tubeStations = this.model.legPlan().map((leg) => {
        /* Her home's direction ACROSS the bore — sideways and vertical —
         * is the angle that foot owns. A home dead on the axis (which no
         * real leg has) would be ambiguous, so it falls to straight down. */
        const across = Math.hypot(leg.home[0], leg.home[1]);
        return {
          slot: leg.slot,
          cos: across < 1e-6 ? 0 : leg.home[0] / across,
          sin: across < 1e-6 ? -1 : leg.home[1] / across,
          along: leg.home[2],
        };
      });
    }
    return ok;
  }

  /**
   * Her core body as three measured capsules, or null if the rig had no skin
   * to measure. See `BodyShell`.
   *
   * NULL IS NOT "CLEAR". A caller that cannot measure her cannot enforce
   * anything, and the honest reading of that is "no collision available" —
   * which the scene reports rather than quietly letting her walk through
   * walls again.
   */
  shell: BodyShell | null = null;

  /**
   * The soil her body may not be inside. Set by the world; without it she is
   * as solid as she was before this existed, which is not at all.
   */
  solid: SignedField | null = null;

  /**
   * Segments exempt from the clearance test right now.
   *
   * The head is the one that ever needs it: while a bore is running her
   * mandibles are ON the work face, and a face is solid by definition. The
   * scene sets this while a `DigJob` is live and clears it after.
   */
  readonly exempt = new Set<SegmentName>();

  /**
   * How far inside solid soil her core body is at a PROPOSED pose, world
   * units. Zero when clear, and zero when nothing can measure it.
   */
  insideAt(
    at: THREE.Vector3,
    forward: THREE.Vector3,
    up: THREE.Vector3,
    /**
     * Segments to ignore, defaulting to whatever is exempt right now.
     *
     * Passed explicitly by the WORKING-POSE SEARCH, which asks a different
     * question from the movement clamp: not "may she be here" but "could she
     * work from here" — and working means her head is ON the face, which is
     * solid by definition. Asking with the head included rejects every pose
     * that can actually reach anything, which is precisely what it did.
     */
    skip: ReadonlySet<SegmentName> = this.exempt,
  ): number {
    if (!this.shell || !this.solid) return 0;
    PROBE_RIGHT.crossVectors(up, forward).normalize();
    PROBE_BASIS.makeBasis(PROBE_RIGHT, up, forward);
    PROBE_Q.setFromRotationMatrix(PROBE_BASIS);
    /* The drawn body carries her dig pitch on top of the foot frame, and so
     * must the shape being tested — otherwise the collision describes an ant
     * standing level while the one on screen is nose-down 34 degrees. */
    if (Math.abs(this.bodyPitch) > 1e-4) {
      PROBE_PITCH.setFromAxisAngle(PROBE_RIGHT, this.bodyPitch);
      PROBE_Q.premultiply(PROBE_PITCH);
    }
    return this.shell.worstInside(this.solid, at, PROBE_Q, skip);
  }

  /** Her body's deepest penetration where she actually is, world units. */
  get inside(): number {
    return this.insideAt(this.at, this.forward, this.up);
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

  /**
   * HOW FAR HER DRAWN BODY IS PITCHED NOSE-DOWN, in degrees.
   *
   * Read off the MODEL's own rotation rather than off `bodyPitch`, because
   * the field is what this file intends and the quaternion is what the
   * renderer will use. Two earlier attempts at pitch got the intent right
   * and the sign wrong, and a probe reading the field would have called
   * both of them green while she reared at the ceiling. Positive is
   * nose-down.
   */
  drawnPitchDegForTest(): number {
    const nose = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(this.model.root.quaternion);
    return -Math.asin(THREE.MathUtils.clamp(nose.dot(this.up), -1, 1))
      * THREE.MathUtils.RAD2DEG;
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
    /* And her pose starts at rest rather than carrying the lag of whatever
     * she was doing before she was moved. */
    this.poseSpeed = 0;
    this.poseTurn = 0;
    this.poseDig = 0;
    this.bodyPitch = 0;
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

    /* How deep she is BEFORE anything moves her, so every clamp this frame
     * judges against the same starting point. See `bodyClear`. */
    this.insideBefore = this.insideAt(this.at, this.forward, this.up);

    if (this.rail) { this.rideRail(dt, intent); return; }

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
        /*
         * SOLID SOIL IS A CONSTRAINT ON THIS TWIST. See
         * `DriveInput.bodyClear`. Undefined until the world hands her a
         * field, so nothing changes for a caller that has no soil.
         */
        /*
         * NEVER WORSE, rather than never touching — and the difference was
         * the whole of why she danced instead of walking.
         *
         * A strict `<= CLEARANCE_TOL` sounds stricter and is in fact
         * unusable: an ant walking has her belly ON the ground, and the
         * shell is a capsule approximation of a body that is not a capsule,
         * so ordinary contact reads as a hair of penetration. She sat at
         * exactly 0.01 mm — the tolerance itself — and every step that
         * momentarily deepened it by a thousandth was bisected away. She
         * covered 2.49 mm in four seconds against a walk that should carry
         * her 28, while the gait cycled at full rate. Marching in place,
         * reported from the device as "digs one section then does a little
         * abdomen dance with her back legs".
         *
         * So the rule is the one `clearFraction` and `clearPitch` already
         * use, and it should have been the same rule from the start: a
         * movement is legal if it leaves her no deeper than she already is,
         * or clear. She can always get out; she can never get further in.
         */
        bodyClear: this.solid && this.shell
          ? (at, forward, up) => {
            const d = this.insideAt(at, forward, up);
            return d <= CLEARANCE_TOL || d <= this.insideBefore;
          }
          : undefined,
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
    /*
     * The body's own pitch, eased in. It rides ON TOP of her frame rather
     * than replacing it: the basis below is still built from the up her feet
     * are using, and the pitch is applied afterwards, so the legs keep
     * solving against real ground while the body leans into its work.
     */
    const wantPitch = DIG_PITCH_DOWN * this.poseDig;
    const pitchStep = (wantPitch - this.bodyPitch)
      * Math.min(1, 1 - Math.exp(-dt / PITCH_TAU));
    /*
     * AND THE PITCH IS SUBJECT TO SOLID SOIL TOO — the third way her body
     * moves, and the one the first cut of the collision work missed.
     *
     * Translation goes through `LegDrive`'s clip and the seat goes through
     * `clearFraction`; this rotates her about her own origin, which drives
     * her gaster down and her thorax through whatever is behind her without
     * touching either path. It showed up two phases later, when the working
     * pose search found that her body measured 0.69 mm inside soil at the
     * pose she was standing in — so the search rejected every candidate,
     * including the spot she was on. A body-collision system has to own
     * EVERY way the body moves or it owns none of them, and rotation is one
     * of them.
     */
    this.bodyPitch += this.clearPitch(pitchStep) * pitchStep;
    this.model.root.position.copy(this.at);
    this.model.root.quaternion.setFromRotationMatrix(
      BASIS.makeBasis(RIGHT, this.up, this.forward),
    );
    if (Math.abs(this.bodyPitch) > 1e-4) {
      /*
       * POSITIVE ABOUT `RIGHT` IS NOSE-DOWN, and that is a measurement, not
       * a derivation. The negation that stood here first drew her 34.2
       * degrees nose-UP: it lifted her mandibles clear of the soil, so the
       * face gate never opened, and she armed nine sites and bit none — 1.5
       * mm of excavation against the 32.5 mm she manages flat. Every earlier
       * attempt at pitch got this sign wrong too.
       */
      PITCH_Q.setFromAxisAngle(RIGHT, this.bodyPitch);
      this.model.root.quaternion.premultiply(PITCH_Q);
    }
    /*
     * The pose lags the intent. Exponential rather than a fixed rate so the
     * lag is a TIME and not a distance: a small change of mind arrives almost
     * at once and a large one takes the same fraction of a second to arrive
     * fully, which is what mass does.
     *
     * Turn lags harder than speed because it is the term that reaches the
     * gaster. Both are frame-rate independent by construction — the same
     * `1 - exp(-dt/tau)` the seater uses — so a slow frame does not overshoot.
     */
    const wantSpeed = Math.abs(intent.walk) * WALK_SPEED;
    const wantTurn = intent.turn * TURN_RATE;
    this.poseSpeed += (wantSpeed - this.poseSpeed)
      * Math.min(1, 1 - Math.exp(-dt / POSE_SPEED_TAU));
    this.poseTurn += (wantTurn - this.poseTurn)
      * Math.min(1, 1 - Math.exp(-dt / POSE_TURN_TAU));
    /*
     * The dip eases in and out on its own, slower time constant. A head that
     * snaps to the soil the frame a bite is decided is the same fault as the
     * gaster that snapped on a one-frame turn: correct in the numbers, wrong
     * in the animal.
     */
    const wantDig = Math.max(0, Math.min(1, intent.dig ?? 0));
    this.poseDig += (wantDig - this.poseDig)
      * Math.min(1, 1 - Math.exp(-dt / POSE_DIG_TAU));

    this.model.update(dt, {
      speed: this.poseSpeed,
      turn: this.poseTurn,
      digging: this.poseDig,
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
  /**
   * ONE FRAME ON THE RAIL. See `rail` for why this exists at all.
   *
   * Named `rideRail` rather than `ride` because `ride` is already the height
   * her body sits at above the floor, and the two would be one identifier
   * meaning two things a line apart.
   *
   * The tunnel is the mover: her distance along it integrates from the
   * intent, and her position, up and forward all come from the frame there.
   * Nothing is searched and nothing can be refused, because every point of
   * the rail is the centre of a bore that has been cut — which is the whole
   * reason the track was drawn before she started digging.
   */
  private rideRail(dt: number, intent: StrollIntent): void {
    const rail = this.rail!;
    const step = intent.walk * WALK_SPEED * dt;
    this.railS = Math.max(0, Math.min(rail.lengthWu, this.railS + step));
    if (!rail.frameAt(this.railS, RAIL_FRAME)) return;

    this.up.copy(RAIL_FRAME.up).normalize();
    /*
     * Her nose runs along the tunnel, squared to her up. Backwards is a
     * negative walk, not a reversed frame: a tunnel has one direction and
     * an ant backing out of one is still facing the way she came.
     */
    this.forward.copy(RAIL_FRAME.forward)
      .addScaledVector(this.up, -RAIL_FRAME.forward.dot(this.up));
    if (this.forward.lengthSq() < 1e-12) this.forward.set(0, 0, 1);
    this.forward.normalize();
    /*
     * SEATED ON THE TUBE'S FLOOR, not on its centreline — down by the bore's
     * radius, less the height her body rides at. On the level this is the
     * same seat the ground gives her; in a plumb shaft it is what makes
     * "the floor" mean the wall she is standing against.
     */
    /*
     * HER BELLY ON THE FLOOR OF THE BORE, which puts the centreline just
     * over her back.
     *
     * The version before this dropped her by `radiusWu - crossRadius`, and
     * that is a units mistake wearing a plausible face: `crossRadius` is how
     * far she reaches ACROSS the tube, and it was being spent as a VERTICAL
     * offset. It floated her up into the middle of the bore, so the rail ran
     * through the low part of her body instead of above it. Joshua, from the
     * device, looking straight down the shaft: "the center rails need to be
     * at the top of her body not bottom".
     *
     * The right quantity is how far her skin hangs BELOW her origin, so that
     * her lowest point lands on the wall — an ant in a gallery walks on its
     * floor. Her sides are what the bore's own width has to accommodate, and
     * it does: at her widest she sits about 2.2 mm from a centreline with
     * 3 mm to give.
     */
    const belly = this.shell?.dropBelowOrigin ?? 0;
    this.at.copy(RAIL_FRAME.at)
      .addScaledVector(this.up, -Math.max(0, rail.radiusWu - belly));
    this.aim = this.at.y - this.ride;

    RIGHT.crossVectors(this.up, this.forward).normalize();
    /*
     * NO DIG PITCH ON THE RAIL, and it is not a detail.
     *
     * The lean exists to aim her head at a face while she is standing on
     * open ground with her body level. In a tunnel the TUNNEL aims her —
     * `forward` is the bore's own direction — so leaning a further 34 degrees
     * on top of it drives her head straight through the floor of a bore three
     * millimetres in radius. Measured before this: her head read 13.3 mm
     * inside solid partway down a plumb shaft, while her thorax, which is not
     * pitched away from the frame, read 0.6.
     */
    this.bodyPitch += (0 - this.bodyPitch)
      * Math.min(1, 1 - Math.exp(-dt / PITCH_TAU));
    this.model.root.position.copy(this.at);
    this.model.root.quaternion.setFromRotationMatrix(
      BASIS.makeBasis(RIGHT, this.up, this.forward),
    );
    if (Math.abs(this.bodyPitch) > 1e-4) {
      PITCH_Q.setFromAxisAngle(RIGHT, this.bodyPitch);
      this.model.root.quaternion.premultiply(PITCH_Q);
    }

    const wantSpeed = Math.abs(intent.walk) * WALK_SPEED;
    this.poseSpeed += (wantSpeed - this.poseSpeed)
      * Math.min(1, 1 - Math.exp(-dt / POSE_SPEED_TAU));
    this.poseTurn += (0 - this.poseTurn)
      * Math.min(1, 1 - Math.exp(-dt / POSE_TURN_TAU));
    const wantDig = Math.max(0, Math.min(1, intent.dig ?? 0));
    this.poseDig += (wantDig - this.poseDig)
      * Math.min(1, 1 - Math.exp(-dt / POSE_DIG_TAU));
    this.model.update(dt, {
      speed: this.poseSpeed,
      turn: this.poseTurn,
      digging: this.poseDig,
      carrying: 0,
      headYaw: 0,
      headPitch: 0,
    });

    /*
     * HER FEET ON THE TUNNEL WALL — the analytic tube, not a height field.
     *
     * For a query point, take its radial offset from the nearest centreline
     * frame with the tangential part removed, and drop along her up to the
     * wall: |r - t*u| = R solves to t = r.u + sqrt((r.u)^2 - (|r|^2 - R^2)).
     * The positive root, because the frame's up is already perpendicular to
     * the tangent. A point outside the tube falls back to the plane under
     * her, so a foot never solves against a wall that is not there.
     *
     * This is `RailScene`'s wall function, which is where it was measured.
     * `solveFeet`'s `frame` parameter has existed for it all along and the
     * density build simply never passed one — which is why her legs spent
     * every underground frame searching a vertical line for a floor that was
     * five millimetres to their left.
     */
    const upX = this.up.x;
    const upY = this.up.y;
    const upZ = this.up.z;
    const floor = this.at.x * upX + this.at.y * upY + this.at.z * upZ;
    const wall = (x: number, y: number, z: number): number => {
      const near = rail.nearestTo(x, y, z);
      if (!near) return floor;
      if (!rail.frameAt(near.sWu, WALL_FRAME)) return floor;
      let rx = x - WALL_FRAME.at.x;
      let ry = y - WALL_FRAME.at.y;
      let rz = z - WALL_FRAME.at.z;
      const t = rx * WALL_FRAME.forward.x + ry * WALL_FRAME.forward.y
        + rz * WALL_FRAME.forward.z;
      rx -= WALL_FRAME.forward.x * t;
      ry -= WALL_FRAME.forward.y * t;
      rz -= WALL_FRAME.forward.z * t;
      const k = rx * upX + ry * upY + rz * upZ;
      const disc = k * k - (rx * rx + ry * ry + rz * rz
        - rail.radiusWu * rail.radiusWu);
      if (disc <= 0) return floor;
      return (x * upX + y * upY + z * upZ) - (k + Math.sqrt(disc));
    };
    /*
     * AND THE FEET ARE PUT ON THE WALL, not merely dropped onto it.
     *
     * `solveFeet` without anchors can only move a foot along up: the gait
     * animation owns where it is fore, aft and sideways, and in a tube
     * narrower than her stance that is outside the wall entirely. Handing it
     * an anchor per leg — its own angular station on the bore — is what
     * folds her stance to the tunnel. See `tubeStations`.
     */
    const anchors = new Map<string, readonly [number, number, number]>();
    for (const st of this.tubeStations) {
      ANCHOR.copy(RAIL_FRAME.at)
        .addScaledVector(this.forward, st.along)
        .addScaledVector(RIGHT, st.cos * rail.radiusWu)
        .addScaledVector(this.up, st.sin * rail.radiusWu);
      anchors.set(st.slot, [ANCHOR.x, ANCHOR.y, ANCHOR.z]);
    }
    this.model.solveFeet(
      () => 0,
      FOOT_CLEARANCE_MM / VOXEL_MM,
      this.ride * 2,
      (slot) => anchors.get(slot) ?? null,
      { up: [upX, upY, upZ], surface: wall },
    );
    /*
     * AND THE DRIVE IS TOLD WHERE HER FEET WENT.
     *
     * It is not running — the rail moved her — but its legs are the record
     * every other system reads, and a record left at whatever it held before
     * she entered the tunnel is a lie that outlives the ride: a probe read
     * one leg as groping for 94 % of a descent during which it was braced on
     * a wall, and the first frame after she leaves would swing a stale
     * anchor. Planting them on their own stations makes the state true and
     * the hand-back clean.
     */
    this.drive?.plantOn(anchors);
    this.report = { planted: 6, groping: 0, movedMm: Math.abs(step) * VOXEL_MM,
      allowed: 1 } as DriveReport;
  }

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
    const step = (want - this.at.y) * Math.min(1, 1 - Math.exp(-dt / tau));
    /*
     * AND THE SEAT IS SUBJECT TO SOLID SOIL, exactly as the twist is.
     *
     * This was left out of the first cut of the body-collision work and the
     * measurement said so immediately: with only the horizontal twist
     * constrained, her head and thorax reached zero penetration while
     * walking, facing and closing — and her GASTER got worse, 15.03 mm and
     * inside soil on 84 % of frames.
     *
     * The reason is that while she digs her walk intent is zero. The legs
     * move her nowhere; this line moves her, following a floor that the bore
     * is cutting out from under her. So every millimetre of her descent went
     * through the one path that had no clearance test on it, and clamping
     * the twist alone could never have caught it. A body-collision system
     * has to own EVERY way the body moves or it owns none of them.
     *
     * Bisected rather than rejected outright: refusing the whole step would
     * stop her following a floor she has legitimately dug away, so she takes
     * the largest fraction of it that fits. Ten halvings of one frame's ease
     * is far below anything visible.
     */
    this.at.y += this.clearFraction(step) * step;
  }

  /**
   * The largest fraction of a proposed PITCH change that keeps her core body
   * out of soil.
   *
   * A movement that only ever reduces her penetration is always allowed —
   * without that she could be trapped by a carve that closed around her, or
   * by the small residue the shell's approximation leaves at a surface she
   * is legitimately resting on, and would never be able to lean back out.
   */
  private clearPitch(step: number): number {
    if (!this.shell || !this.solid || Math.abs(step) < 1e-9) return 1;
    const was = this.bodyPitch;
    const now = this.insideAt(this.at, this.forward, this.up);
    const at = (f: number): number => {
      this.bodyPitch = was + step * f;
      const d = this.insideAt(this.at, this.forward, this.up);
      this.bodyPitch = was;
      return d;
    };
    const full = at(1);
    if (full <= CLEARANCE_TOL || full <= now) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 8; i += 1) {
      const mid = (lo + hi) / 2;
      if (at(mid) <= Math.max(CLEARANCE_TOL, now)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /**
   * The largest fraction of a proposed vertical step that keeps her core body
   * out of soil. One when the whole step fits, zero when none of it does.
   */
  private clearFraction(step: number): number {
    if (!this.shell || !this.solid || Math.abs(step) < 1e-12) return 1;
    const y0 = this.at.y;
    /* A step that only reduces her penetration is always allowed — see
     * `clearPitch` for why refusing one can trap her. */
    const now = this.insideAt(this.at, this.forward, this.up);
    const allow = Math.max(CLEARANCE_TOL, now);
    const fits = (f: number): boolean => {
      SEAT_TRY.set(this.at.x, y0 + step * f, this.at.z);
      return this.insideAt(SEAT_TRY, this.forward, this.up) <= allow;
    };
    if (fits(1)) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 10; i += 1) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
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

/**
 * HOW DEEP INTO SOIL STILL COUNTS AS CLEAR, in world units — 0.01 mm.
 *
 * Not zero, because the field is sampled with a `min()` of distances and the
 * shell radius is the largest skin vertex, so the two disagree by a hair at
 * a surface she is legitimately resting against. A hard zero makes every
 * frame a bisection that never converges. This is well under the 0.05 mm the
 * brief asks to hold her to and two orders under the 5 mm she was managing.
 */
export const CLEARANCE_TOL = 0.01 / VOXEL_MM;

/* Scratch, so a walking ant allocates nothing per frame. */
const RIGHT = new THREE.Vector3();
const PROBE_RIGHT = new THREE.Vector3();
const PROBE_BASIS = new THREE.Matrix4();
const PROBE_Q = new THREE.Quaternion();
const PROBE_PITCH = new THREE.Quaternion();
const SEAT_TRY = new THREE.Vector3();
const RAIL_FRAME: RailFrameOut = {
  at: new THREE.Vector3(), up: new THREE.Vector3(), forward: new THREE.Vector3(),
};
const ANCHOR = new THREE.Vector3();
const WALL_FRAME: RailFrameOut = {
  at: new THREE.Vector3(), up: new THREE.Vector3(), forward: new THREE.Vector3(),
};
const PITCH_Q = new THREE.Quaternion();
const BASIS = new THREE.Matrix4();
