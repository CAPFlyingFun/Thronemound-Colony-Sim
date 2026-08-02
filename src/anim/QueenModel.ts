/**
 * Load an ant and drive its gait.
 *
 * The three.js half of the hexapod: `hexapod.ts` decides what every bone should
 * do and this applies it. Kept apart so the gait itself stays testable without
 * a GPU, which is the only reason the tripod rules have tests at all.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import {
  GASTER_COUNTER, QUEEN_RIG, RIGS, cadenceFor, gaitPose, gaitSpeed, rigBones,
  rigLengthVoxels, rigScale,
  type GaitInput, type GaitPose, type RigMap,
} from './hexapod';
import { aimRotation, distanceToPolyline, footTarget, type Vec3 } from './legIk';

/**
 * How much of a leg the terrain solver may have, and how hard.
 *
 * Three joints from the foot up, which on these chains is roughly the tarsus,
 * the tibia and the knee. The hip is deliberately out of reach: it carries the
 * gait's fore-and-aft swing and is most of what makes a walk read as a walk,
 * and a solver given the whole chain reaches the right place by folding the
 * leg into a shape no ant makes.
 *
 * The budget has to close the gap WITHIN A FRAME, and that is the thing worth
 * saying: the solver starts from the gait's pose every frame rather than from
 * its own last answer, so nothing accumulates across frames and whatever it
 * fails to correct now it will fail to correct forever. Two passes at a third
 * of a radian moves a foot about two millimetres on this ant, which measured
 * as all six feet still buried when she dropped into a pit two and a half deep.
 *
 * Restarting from the gait each frame is also why a tight step cap buys
 * nothing. Its usual job is to stop a solver snapping, but the smooth thing
 * here is the gait underneath, and the correction is a deterministic function
 * of it — so the cap only decides how far short the feet land.
 */
const IK_JOINTS = 3;
const IK_PASSES = 8;
const IK_MAX_STEP = 0.9;

/**
 * How little the HEAVIEST joint of a limb may swing, against the lightest.
 *
 * Every joint used to take the same share of a correction, which is why her
 * legs "went all over the place" once she had been walking a while: a hip and a
 * claw are not equally free, so spreading the work evenly swung the massive
 * upper leg as readily as the tarsus and the whole limb flailed for a
 * correction the foot could have absorbed on its own.
 *
 * The weight is the mesh's own thickness — a joint's share is scaled by how
 * thin it is relative to the tip of its limb — so the tarsus (0.13 mm) moves
 * freely and the femur (0.5 mm) is four times more reluctant. Measured, not
 * hand-assigned, so it stays honest if the model is ever re-exported.
 *
 * The floor stops a very fat joint from freezing solid, which would just move
 * the flailing one bone further down.
 */
const IK_MIN_MOBILITY = 0.25;

/**
 * How many times a leg may be lifted and re-solved.
 *
 * Cyclic coordinate descent constrains only the END of the chain, so it will
 * happily satisfy a foot target by folding the ankle through the floor — and
 * it did: with every foot bone sitting a hundredth of a millimetre above the
 * soil exactly as asked, the joint above it was a quarter of a millimetre
 * UNDER, and five and a half thousand of her leg vertices with it. Solving,
 * measuring the deepest joint, raising the target by that much and solving
 * again converges in two or three rounds because lifting the foot can only
 * unfold the leg.
 */
const IK_ATTEMPTS = 3;

/* Scratch, so a per-frame solve over six legs allocates nothing. */
const FOOT = new THREE.Vector3();
const JOINT = new THREE.Vector3();
const TARGET = new THREE.Vector3();
const AXIS = new THREE.Vector3();
/* The generalized foot target: a base point plus a lift along the frame's up. */
const BASE = new THREE.Vector3();
const UP_SCRATCH = new THREE.Vector3();
const WORLD_SPIN = new THREE.Quaternion();
const LOCAL_SPIN = new THREE.Quaternion();
const PARENT = new THREE.Quaternion();
const TILT = new THREE.Quaternion();
/** Her pitch axis in her own frame: she faces +Z, so pitching is about X. */
const RIGHT = new THREE.Vector3(1, 0, 0);

/**
 * Meshopt, not Draco.
 *
 * Both shrink the geometry; meshopt won on two counts. It produced a smaller
 * file (1.3 MB against 2.2 MB from the same source), and its decoder ships
 * inside the three.js package so the bundler resolves it — Draco needs a
 * separate .wasm served from a path, which is exactly the sort of thing that
 * works locally and 404s under a GitHub Pages subdirectory.
 *
 * The textures are WebP, decoded by the browser with no extension needed.
 */
export const MODEL_URLS: Record<RigMap['caste'], string> = {
  queen: `${import.meta.env.BASE_URL}models/queen.glb`,
  worker: `${import.meta.env.BASE_URL}models/worker.glb`,
  major: `${import.meta.env.BASE_URL}models/major.glb`,
};
/** Kept so existing callers keep working. */
export const QUEEN_MODEL_URL = MODEL_URLS.queen;

export interface QueenPoseInput extends Omit<GaitInput, 'clock'> {}

export class QueenModel {
  readonly root = new THREE.Group();
  /** Which ant this instance is wearing. */
  readonly rig: RigMap;
  /** Bones the rig map names that the FILE does not have. Should be empty. */
  readonly missing: string[] = [];
  private bones = new Map<string, THREE.Bone>();
  /** Rest rotation per bone, so every frame is an offset and never accumulates. */
  private rest = new Map<string, THREE.Quaternion>();
  /**
   * What every bone looks like BEFORE the correction passes touch it, refreshed
   * once per `update`.
   *
   * `update` keeps the rule that each frame is an offset from rest rather than
   * a rotation of last frame — and then two passes that run after it broke the
   * rule, both by multiplying onto the live quaternion. That is correct only
   * for a bone something else has already rewritten from rest, and the gait
   * does not write every bone:
   *
   *   - the lean writes `thorax[0]`, the gait writes `thorax[LAST]`
   *   - the IK rotates three joints up each limb, the gait writes `antenna[0]`
   *
   * So both integrated. Measured standing perfectly still: the thorax lean
   * added nine degrees a FRAME, and the antennae wandered 14.9 mm and 10.5 mm
   * in six seconds — which is the mast growing out of her back in the landscape
   * shot, and why the foot readout came back as 1.45e15 mm.
   *
   * A bone the gait wrote is at its gait pose and that is its base; a bone the
   * gait skipped is still carrying the last correction, so its base is rest.
   * Deciding that here, once, is what lets both passes stay idempotent — run
   * either of them twice with the same numbers and she is in the same shape.
   */
  private poseBase = new Map<string, THREE.Quaternion>();
  /**
   * How fat the mesh is around each BONE, in world units. See `measureLimbs`.
   *
   * Per bone, not per limb. One number for a whole leg is the fattest part of
   * it — the femur — and using that as the sole thickness at the claw props
   * every foot up on the thickness of the thigh: measured at 0.86 to 1.29 mm of
   * air under six feet that the solver believed it had planted to within a
   * hundredth. An ant's leg tapers by more than an order of magnitude from hip
   * to tarsus, so this has to taper with it.
   */
  private readonly limbRadius = new Map<string, number>();
  /**
   * The last bone of each limb that any geometry is actually skinned to.
   *
   * Not the last bone in the chain. Every leg on this rig ends in two bones
   * carrying no vertices at all — auto-rig terminals — and on the queen they do
   * not even continue the leg's direction: on her rear left the chain's joints
   * sit at 1.76, 1.62, 2.80, 1.09, 0.41, 1.29, 1.30 mm above the soil, so the
   * last two markers point back UP, a millimetre above the foot they trail.
   *
   * The solver planted one of those markers, which is the whole of the "feet
   * tips are up in the air" report: the thing being placed on the ground was
   * not the thing being drawn, and no amount of solving the ankle could fix
   * where the claw ended up while the target was a marker above it.
   */
  private readonly limbTip = new Map<string, string>();
  /**
   * How freely each bone may swing under a correction, 0..1 — its weight,
   * expressed as the thing the solver actually needs. See `IK_MIN_MOBILITY`.
   */
  private readonly boneMobility = new Map<string, number>();
  /** Neutral foot position and reach per leg. See `legPlan`. */
  private readonly legHome: Array<{ slot: string; home: Vec3; reach: number }> = [];
  /** Her head in her own frame. See `headOffset`. */
  private head: Vec3 | null = null;
  /** Materials carrying the head mask, and whether it is currently on. */
  private readonly headMaterials: THREE.Material[] = [];
  private hideHead = false;
  private clock = 0;
  /** Gait revolutions, integrated. See `GaitInput.cycle`. */
  private cycle = 0;
  private loaded = false;
  private bodyRoot: THREE.Object3D | null = null;
  private baseY = 0;

  constructor(caste: RigMap['caste'] = 'queen') {
    this.rig = RIGS[caste];
  }

  /** How far she measures along Z once scaled, in voxels. */
  get lengthVoxels(): number {
    return rigLengthVoxels(this.rig);
  }

  get ready(): boolean {
    return this.loaded;
  }

  /**
   * Fetch and rig her up.
   *
   * Resolves even on failure — a missing model must not take the scene down
   * with it. The caller checks `ready` and can carry on without her.
   */
  async load(url = MODEL_URLS[this.rig.caste]): Promise<boolean> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    try {
      const gltf = await loader.loadAsync(url);
      const scene = gltf.scene;
      scene.traverse((node) => {
        if ((node as THREE.Bone).isBone) {
          const bone = node as THREE.Bone;
          this.bones.set(bone.name, bone);
          this.rest.set(bone.name, bone.quaternion.clone());
          this.poseBase.set(bone.name, bone.quaternion.clone());
        }
        const mesh = node as THREE.SkinnedMesh;
        if (mesh.isSkinnedMesh) {
          // Auto-rig exports come out double-sided, which doubles the fill cost
          // for a shell you can never see the inside of.
          const material = mesh.material as THREE.Material;
          material.side = THREE.FrontSide;
          mesh.frustumCulled = false;
          mesh.castShadow = true;
        }
      });
      scene.scale.setScalar(rigScale(this.rig));
      this.root.add(scene);
      /*
       * Check the map against the FILE, and keep the answer.
       *
       * The bone names carry no meaning, so a re-export that renumbers them
       * would leave the gait addressing bones that are not there — the ant would
       * stand perfectly still, render perfectly well, and throw nothing. This is
       * the only place that discrepancy is visible.
       */
      this.missing.length = 0;
      for (const bone of rigBones(this.rig)) {
        if (!this.bones.has(bone)) this.missing.push(bone);
      }
      this.bodyRoot = this.bones.get(this.rig.body[0]!) ?? null;
      this.baseY = this.bodyRoot?.position.y ?? 0;
      this.measureLimbs();
      this.measureLegPlan();
      this.measureHead();
      this.maskHead();
      this.loaded = true;
      return true;
    } catch {
      this.loaded = false;
      return false;
    }
  }

  /**
   * Advance the gait.
   *
   * `dt` drives an internal clock rather than the caller passing wall time,
   * because the gait's cadence is a function of speed — pausing the sim has to
   * pause her legs, or she walks on the spot while the world is frozen.
   */
  /**
   * Turn her face toward where the player is looking, and swing her gaster
   * the other way.
   *
   * Applied as a rotation in HER frame rather than as a bone-local Euler,
   * because a bone-local Euler cannot say "about her up" without knowing
   * which local axis that is — and on this auto-rig it is none of the
   * obvious ones. Measured on the queen's head bone: thirty degrees about
   * local Y moves her face 2.4 degrees, local Z gives yaw but inverted and
   * with a 1.26 gain, and local X gives pitch with fifteen degrees of yaw
   * mixed in. Any table of that is a third thing to re-derive per model.
   *
   * Her frame comes off her own root, which the scene has already oriented:
   * model +Y is her up and +X her right, so both fall out of the root's
   * world quaternion and nothing here needs a parameter.
   *
   * Neither bone is a limb, so `solveFeet` will not undo this.
   */
  private aimHead(pose: GaitPose): void {
    if (Math.abs(pose.headYaw) < 1e-6 && Math.abs(pose.headPitch) < 1e-6) return;
    this.root.updateMatrixWorld(true);
    const frame = this.root.getWorldQuaternion(new THREE.Quaternion());
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(frame);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(frame);

    const turn = (name: string | undefined, yaw: number, pitch: number): void => {
      const bone = name ? this.bones.get(name) : undefined;
      if (!bone || !bone.parent) return;
      const want = new THREE.Quaternion().setFromAxisAngle(up, yaw);
      if (Math.abs(pitch) > 1e-6) {
        want.multiply(new THREE.Quaternion().setFromAxisAngle(right, pitch));
      }
      /*
       * A world rotation, expressed in the bone's parent space. Rotating the
       * bone's own quaternion directly would rotate it about the PARENT's
       * axes, which on a neck bone is a different thing entirely.
       */
      const parent = bone.parent.getWorldQuaternion(new THREE.Quaternion());
      const inv = parent.clone().invert();
      bone.quaternion.premultiply(inv.multiply(want).multiply(parent));
    };

    const head = this.rig.thorax[this.rig.thorax.length - 1];
    // Pitch is negated: the player's aim is negative looking down, and a
    // rotation about her right by a negative angle tips her face up.
    turn(head, pose.headYaw, -pose.headPitch);
    // The counterweight. Yaw only — a gaster that pitched with the head
    // would see-saw her whole body every time she looked at the floor.
    turn(this.rig.gaster[0], -pose.headYaw * GASTER_COUNTER, 0);
  }

  update(dt: number, input: QueenPoseInput): void {
    if (!this.loaded) return;
    this.clock += dt;
    /*
     * The leg cycle is integrated at THIS frame's cadence, so the phase carries
     * over continuously when the throttle changes. Cadence is proportional to
     * speed, which makes the accumulated cycle proportional to DISTANCE
     * TRAVELLED — a foot advances one stride per stride of ground covered, at
     * any pace, through any acceleration. That is what stops the skating.
     */
    this.cycle += cadenceFor(gaitSpeed(input.speed, input.turn, this.rig)) * dt;
    const pose = gaitPose({ ...input, clock: this.clock, cycle: this.cycle }, this.rig);

    for (const [name, euler] of pose.rotations) {
      const bone = this.bones.get(name);
      const rest = this.rest.get(name);
      if (!bone || !rest) continue;
      /*
       * Offset FROM the rest pose every frame, never applied on top of the
       * previous frame. Rotating the live quaternion instead would integrate
       * rounding error and the legs would slowly wind themselves off the body —
       * the bug that makes procedural rigs look fine for ten seconds.
       */
      bone.quaternion.copy(rest).multiply(
        new THREE.Quaternion().setFromEuler(new THREE.Euler(euler[0], euler[1], euler[2])),
      );
    }

    this.aimHead(pose);

    /*
     * Snapshot what the correction passes are allowed to build on, while the
     * answer is still knowable — here, before anything has run, is the only
     * point in the frame where a bone the gait skipped is distinguishable from
     * one it wrote. Read a moment later and yesterday's correction is folded
     * into today's base and we are integrating again.
     */
    for (const [name, base] of this.poseBase) {
      const bone = this.bones.get(name);
      if (!bone) continue;
      base.copy(pose.rotations.has(name) ? bone.quaternion : this.rest.get(name) ?? bone.quaternion);
    }

    // Body bob rides on the bone, so it stays in her own frame — she bobs along
    // her own up axis whether she is on the floor, a wall or a ceiling.
    if (this.bodyRoot) this.bodyRoot.position.y = this.baseY + pose.lift;
  }

  /**
   * Bend the lower legs until every foot is ON the ground rather than through
   * it. Call AFTER `update`, and after the root has been placed, with a
   * function giving ground height in world units at a world x and z.
   *
   * Returns how far the worst foot was under the soil BEFORE solving, which is
   * the number worth watching: it says whether the solver is doing anything,
   * and a caller can assert it against what the feet end up at afterwards.
   */
  solveFeet(
    /**
     * Ground height under a point, asked from that point's OWN height.
     *
     * The third argument is not decoration. A burrow makes "the ground here"
     * depend on where you are standing, and passing the BODY's height for all
     * six feet asks about her, not about them: a foot pressed into the wall of
     * a shaft is inside soil, so the query climbs out of it — and climbing out
     * from her body's height, in a column that is solid all the way up, lands
     * on the rim overhead. Measured mid-dive, the six feet were reported 15 mm
     * under a ground that was really the summit ten millimetres above her, and
     * the solver duly hauled her legs up toward it.
     */
    groundAt: (x: number, z: number, y: number) => number,
    clearance: number,
    band: number,
    /**
     * Where a planted leg's foot should BE, in world space, if something else
     * is deciding that — the tripod stepper is.
     *
     * Without it this solver can only move a foot up and down, because the gait
     * owns where the foot is fore and aft and this only corrects for terrain.
     * That division is what made the feet skate: nothing in the whole pipeline
     * ever knew where a foot was in the world from one frame to the next, so
     * nothing could hold one still. Given an anchor, a stance foot is simply
     * put back on the same world point every frame and its ground speed is
     * exactly zero.
     */
    anchorFor?: (limbId: string) => readonly [number, number, number] | null,
    /**
     * The walk's frame when she is NOT on level ground — climbing.
     *
     * `up` is her surface normal and `surface` answers "the elevation, ALONG
     * THAT UP, of the surface under this world point". Every height in this
     * solver is really an elevation along up — on level ground up is world Y
     * and elevation is just `.y`, which is why the code below reads the same
     * as it always did. Omitted, the solver behaves exactly as before, to the
     * digit: the legacy `groundAt` is consulted and up is world vertical.
     */
    frame?: {
      up: readonly [number, number, number];
      surface: (x: number, y: number, z: number) => number;
    },
  ): number {
    if (!this.loaded) return 0;
    const upX = frame?.up[0] ?? 0;
    const upY = frame?.up[1] ?? 1;
    const upZ = frame?.up[2] ?? 0;
    /** Elevation of a point along the frame's up. On level ground: its y. */
    const elev = (v: THREE.Vector3): number => v.x * upX + v.y * upY + v.z * upZ;
    const surfaceUnder = frame
      ? frame.surface
      : (x: number, y: number, z: number): number => groundAt(x, z, y);
    /*
     * Every joint this solver may rotate goes back to its base first.
     *
     * CCD premultiplies onto whatever it finds, and it climbs three joints up
     * each limb while the gait writes only the first — so joints two and three
     * were never cleared and each frame's correction landed on top of the last
     * one's. Standing still, the antennae wandered off by 14.9 mm and 10.5 mm
     * in six seconds. The legs hid it better because the gait happens to write
     * their knee and ankle, so only their remaining joint crept.
     *
     * Undoing the pass before redoing it also makes it idempotent, which is
     * what the caller actually wants from a corrective solver: solving twice
     * against the same ground is the same as solving once.
     */
    for (const limb of this.limbs()) {
      for (const name of limb.bones) {
        const bone = this.bones.get(name);
        const base = this.poseBase.get(name);
        if (bone && base) bone.quaternion.copy(base);
      }
    }
    this.root.updateMatrixWorld(true);
    let worstPenetration = 0;

    for (const limb of this.limbs()) {
      /*
       * The chain STOPS at the last bone anything is drawn on.
       *
       * Past that point a leg is markers, and on this rig those markers do not
       * even continue its line — they fold back up above the foot. Solving to
       * one of them put a point that renders as nothing onto the soil and left
       * the claw a millimetre in the air, which is what the close-up showed.
       */
      const tipName = this.limbTip.get(limb.id);
      const chain: THREE.Bone[] = [];
      for (const name of limb.bones) {
        const bone = this.bones.get(name);
        if (bone) chain.push(bone);
        if (name === tipName) break;
      }
      if (chain.length < 3) continue;
      const foot = chain[chain.length - 1]!;

      /*
       * The clearance THIS BONE needs. The mesh is a tube around the skeleton,
       * so its underside hangs the tube's radius below the bone line — and that
       * radius is a different number at the tarsus than at the femur. Sharing
       * one per limb meant the claw was held up on the thigh's half-millimetre,
       * so every foot hovered however well the solver hit its target.
       */
      const soleOf = (bone: THREE.Bone): number =>
        clearance + (this.limbRadius.get(bone.name) ?? 0);
      const sole = soleOf(foot);
      const lowest = Math.max(0, chain.length - 1 - IK_JOINTS);

      foot.getWorldPosition(FOOT);
      const ground = surfaceUnder(FOOT.x, FOOT.y, FOOT.z);
      worstPenetration = Math.max(worstPenetration, ground + sole - elev(FOOT));
      /*
       * A leg is trying to STAND on the ground and an antenna is not — she
       * sweeps them ahead of her and they should stay where the gait waves
       * them, only never through the soil. A zero band gives exactly that:
       * `footTarget` lifts anything below the surface and leaves everything
       * else alone. Without it the antennae were the last thing still clipping,
       * because nothing here was looking at them at all.
       */
      const anchor = limb.plant ? anchorFor?.(limb.id) ?? null : null;
      /*
       * The target is a BASE POINT plus a lift along up. On level ground this
       * is the old x/z-plus-height in different clothes; on a wall it is what
       * lets "raise the foot clear of the surface" mean away from the bark
       * rather than toward the sky.
       */
      if (anchor) {
        // The stepper's world point, raised by this bone's own thickness so the
        // drawn claw rests ON the soil rather than inside it.
        BASE.set(anchor[0], anchor[1], anchor[2]).addScaledVector(UP_SCRATCH.set(upX, upY, upZ), sole);
      } else {
        const wanted = footTarget(elev(FOOT), ground, sole, limb.plant ? band : 0);
        if (Math.abs(wanted - elev(FOOT)) < 1e-7) continue;
        BASE.copy(FOOT).addScaledVector(UP_SCRATCH.set(upX, upY, upZ), wanted - elev(FOOT));
      }

      let lift = 0;
      for (let attempt = 0; attempt < IK_ATTEMPTS; attempt += 1) {
        TARGET.copy(BASE).addScaledVector(UP_SCRATCH.set(upX, upY, upZ), lift);

        // Tip-first: cyclic coordinate descent converges from either end, and
        // starting at the joint nearest the foot spends the correction on the
        // smallest bones, which keeps the leg's silhouette close to the gait's.
        for (let pass = 0; pass < IK_PASSES; pass += 1) {
          for (let j = chain.length - 2; j >= lowest; j -= 1) {
            const joint = chain[j]!;
            joint.getWorldPosition(JOINT);
            foot.getWorldPosition(FOOT);
            const swing = aimRotation(
              [JOINT.x, JOINT.y, JOINT.z],
              [FOOT.x, FOOT.y, FOOT.z],
              [TARGET.x, TARGET.y, TARGET.z],
            );
            if (swing.angle < 1e-7) continue;

            /*
             * The rotation is computed in WORLD space and a bone stores a
             * LOCAL one, so it is conjugated by the parent's world rotation on
             * the way in. Applying a world-space quaternion straight to a
             * local one is the classic version of this mistake: it is correct
             * for a bone whose parents happen to be unrotated, which every one
             * of these is in the bind pose and none of them is once she turns.
             */
            AXIS.set(swing.axis[0], swing.axis[1], swing.axis[2]);
            // Scaled by this joint's own weight, so the correction is taken up
            // by the light end of the limb rather than swung out of the hip.
            const mobility = this.boneMobility.get(joint.name) ?? 1;
            WORLD_SPIN.setFromAxisAngle(AXIS, Math.min(swing.angle, IK_MAX_STEP) * mobility);
            if (joint.parent) joint.parent.getWorldQuaternion(PARENT);
            else PARENT.identity();
            LOCAL_SPIN.copy(PARENT).invert().multiply(WORLD_SPIN).multiply(PARENT);
            joint.quaternion.premultiply(LOCAL_SPIN);
            joint.updateMatrixWorld(true);
          }
        }

        // Nothing above the foot may be under the soil either. Measure the
        // worst of them and lift the whole target by it; the leg can only
        // unfold, so this converges rather than chasing itself.
        let deepest = 0;
        for (let j = chain.length - 1; j >= lowest; j -= 1) {
          const joint = chain[j]!;
          joint.getWorldPosition(JOINT);
          // Each joint against its OWN thickness. The femur is the fat one and
          // has to clear the soil by more than the tarsus does; one shared
          // number either buries the thigh or floats the foot, and it floated.
          deepest = Math.max(
            deepest, surfaceUnder(JOINT.x, JOINT.y, JOINT.z) + soleOf(joint) - elev(JOINT),
          );
        }
        if (deepest <= 1e-6) break;
        lift += deepest;
      }
    }
    return worstPenetration;
  }

  /**
   * Every chain of bones that can end up in the dirt, and whether it is trying
   * to stand on it.
   *
   * The legs plant; the antennae only have to stay out of the soil. Listing
   * them together is what stops the next limb from being forgotten the way the
   * antennae were — they were never legs, so a solver written for feet had
   * nothing to say about them.
   */
  private limbs(): Array<{ id: string; bones: string[]; plant: boolean }> {
    return [
      ...this.rig.legs.map((leg) => ({ id: leg.slot, bones: leg.bones, plant: true })),
      { id: 'antennaLeft', bones: this.rig.antennaLeft, plant: false },
      { id: 'antennaRight', bones: this.rig.antennaRight, plant: false },
    ];
  }

  /**
   * How far she must rise for no bone of hers to be INSIDE the soil.
   *
   * The fail-safe, and deliberately the crudest thing here: whatever the
   * solvers did or failed to do, nothing she is made of should be embedded in
   * the world. It covers the parts no solver owns — mandibles, the tip of a
   * gaster on a steep bank — and it costs one pass over the skeleton.
   *
   * `escapeAt` asks whether a POINT is in solid soil, not whether it is below
   * the surface, and the difference is the whole of why this used to fight
   * her. A height query is a claim about a column, so standing in a shaft with
   * a leg near the wall it answers "the rim, several millimetres over your
   * head" — and the guard dutifully hauled her out of her own burrow by two
   * and a half millimetres. Whether a point is inside soil is a question about
   * that point, and a burrow is exactly the case where the two disagree.
   *
   * Returns a LIFT for the whole model rather than bending anything, because a
   * fail-safe that tries to be clever is a fail-safe with its own bugs. If it
   * is doing visible work, the answer is a solver for whatever it is catching,
   * not a bigger lift.
   */
  groundGuard(escapeAt: (x: number, y: number, z: number) => number): number {
    if (!this.loaded) return 0;
    this.root.updateMatrixWorld(true);
    let lift = 0;
    /*
     * The parts NO SOLVER OWNS, which is what this was always for: mandibles,
     * the tip of a gaster on a steep bank. The legs and antennae have their own
     * solver with its own per-joint clearance, and second-guessing it here is
     * actively harmful — the guard is a rigid lift of the whole model, so one
     * leg it dislikes raises all six feet off ground they were correctly
     * planted on. Measured: 0.29 mm of float on every foot, to rescue a single
     * limb the IK had already placed.
     */
    const solved = new Set(this.limbs().map((limb) => limb.id));
    for (const [group, names] of this.limbGroups()) {
      if (solved.has(group)) continue;
      for (const name of names) {
        /*
         * Only bones that any geometry is DRAWN on. "Nothing she is made of may
         * be in the soil" is the rule, and a marker with no vertices skinned to
         * it is not something she is made of.
         *
         * This is the same category error as the solver's, one level down, and
         * it was hiding the fix for it. Once the IK stopped planting the
         * undrawn terminals, those markers hung below the surface — so the
         * guard saw six buried bones and lifted the WHOLE ant 0.448 mm to
         * rescue them, carrying all six correctly planted feet up with it. Six
         * legs floating by exactly the same amount was the clue: a rigid
         * translation, not six independent solver failures.
         */
        if ((this.limbRadius.get(name) ?? 0) <= 0) continue;
        const bone = this.bones.get(name);
        if (!bone) continue;
        bone.getWorldPosition(JOINT);
        /*
         * The BONE, not the underside of the mesh around it.
         *
         * Dropping the probe by the limb's radius was tried and is worse: a
         * radius is the widest the mesh gets anywhere around that bone, and
         * pushing it straight DOWN assumes the widest part hangs directly
         * below. On her gaster that radius is 1.53 mm — most of her abdomen —
         * so the probe sat well under her belly and the guard lifted her
         * 0.27 mm off ground she was standing on perfectly well, taking all six
         * planted feet with it. Same over-estimate as using the thigh's
         * thickness at the claw, one body part over.
         */
        lift = Math.max(lift, escapeAt(JOINT.x, JOINT.y, JOINT.z));
      }
    }
    return lift;
  }

  /**
   * Each leg's neutral foot position in HER OWN frame, and its reach.
   *
   * Measured off the bind pose, so it is the rig's own idea of where a leg
   * stands rather than a number somebody chose. The stepper needs both: the
   * home to know when a foot has trailed too far behind its shoulder, and the
   * reach to turn a sweep in degrees into a stride in millimetres — which is
   * what lets one angle give the queen and a worker each their own stride.
   */
  legPlan(): Array<{ slot: string; home: Vec3; reach: number }> {
    return this.legHome.slice();
  }

  /**
   * Where her head is, in her own frame — the honest place to put a
   * first-person eye.
   *
   * Taken from the rig rather than chosen, because "on the queen's head" is a
   * different offset on every caste and picking a constant means picking one
   * that is wrong for the other two. Measured off the bind pose, like the leg
   * plan, so the root's transform is not in it.
   *
   * Null when the rig names no mouth, which the queen's very nearly does not —
   * her mouthparts are barely rigged.
   */
  headOffset(): Vec3 | null {
    return this.head;
  }

  private measureHead(): void {
    this.head = null;
    const mouth = this.rig.mouth[this.rig.mouth.length - 1];
    const bone = mouth ? this.bones.get(mouth) : undefined;
    if (!bone) return;
    bone.getWorldPosition(FOOT);
    this.head = [FOOT.x, FOOT.y, FOOT.z];
  }

  private measureLegPlan(): void {
    this.legHome.length = 0;
    for (const leg of this.rig.legs) {
      const tipName = this.limbTip.get(leg.slot);
      const tip = tipName ? this.bones.get(tipName) : undefined;
      const hip = this.bones.get(leg.bones[0]!);
      if (!tip || !hip) continue;
      tip.getWorldPosition(FOOT);
      hip.getWorldPosition(JOINT);
      // Bind pose, root untransformed, so world IS her frame here.
      this.legHome.push({
        slot: leg.slot,
        home: [FOOT.x, FOOT.y, FOOT.z],
        reach: JOINT.distanceTo(FOOT),
      });
    }
  }

  /**
   * Which bone is actually this limb's foot — the last one with geometry
   * skinned to it. Exposed so a probe can measure to the same point the
   * solver plants, rather than to the auto-rig terminals beyond it.
   */
  limbTipName(limb: string): string | null {
    return this.limbTip.get(limb) ?? null;
  }

  /** Every named group of bones, for measuring thickness and for the guard. */
  private limbGroups(): Array<[string, string[]]> {
    const groups: Array<[string, string[]]> = [
      ['body', this.rig.body],
      ['thorax', this.rig.thorax],
      ['mouth', this.rig.mouth],
      ['gaster', this.rig.gaster],
      ['antennaLeft', this.rig.antennaLeft],
      ['antennaRight', this.rig.antennaRight],
    ];
    if (this.rig.mandibleLeft) groups.push(['mandibleLeft', this.rig.mandibleLeft]);
    if (this.rig.mandibleRight) groups.push(['mandibleRight', this.rig.mandibleRight]);
    for (const leg of this.rig.legs) groups.push([leg.slot, leg.bones]);
    return groups;
  }

  /**
   * How far each limb's mesh reaches beyond its own bones, measured once.
   *
   * Derived from the model rather than tuned, so a re-export with chunkier
   * legs does not silently start clipping again. Vertices are attributed to
   * whichever bone holds their largest skin weight and measured against the
   * POLYLINE through the last few bones of that leg, which is the tube's
   * radius; measuring to the nearest joint instead would read a vertex halfway
   * along a bone as a bone-length away and stand her in the air.
   */
  private measureLimbs(): void {
    const ownerOf = new Map<string, string>();
    const spineOf = new Map<string, Vec3[]>();
    this.root.updateMatrixWorld(true);
    for (const [group, names] of this.limbGroups()) {
      const spine: Vec3[] = [];
      for (const name of names) {
        ownerOf.set(name, group);
        const bone = this.bones.get(name);
        if (!bone) continue;
        bone.getWorldPosition(JOINT);
        spine.push([JOINT.x, JOINT.y, JOINT.z]);
      }
      spineOf.set(group, spine);
      for (const name of names) this.limbRadius.set(name, 0);
    }

    const vertex = new THREE.Vector3();
    this.root.traverse((node) => {
      const mesh = node as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      const position = mesh.geometry.getAttribute('position');
      const skinIndex = mesh.geometry.getAttribute('skinIndex');
      const skinWeight = mesh.geometry.getAttribute('skinWeight');
      if (!position || !skinIndex || !skinWeight) return;

      for (let i = 0; i < position.count; i += 1) {
        let best = 0;
        let bestWeight = -1;
        for (let k = 0; k < 4; k += 1) {
          const weight = skinWeight.getComponent(i, k);
          if (weight > bestWeight) { bestWeight = weight; best = skinIndex.getComponent(i, k); }
        }
        const bone = mesh.skeleton.bones[best];
        const group = bone ? ownerOf.get(bone.name) : undefined;
        if (!group) continue;
        const spine = spineOf.get(group);
        if (!spine || spine.length === 0) continue;

        mesh.getVertexPosition(i, vertex);
        mesh.localToWorld(vertex);
        /*
         * Still measured to the whole limb's POLYLINE — that part was right,
         * and measuring to the nearest joint would read a vertex halfway along
         * a bone as a bone-length away. What changed is where the answer is
         * filed: under the bone this vertex is skinned to, rather than under
         * the limb, so a leg gets a thickness profile instead of one number
         * taken from its fattest part.
         */
        const reach = distanceToPolyline([vertex.x, vertex.y, vertex.z], spine);
        if (reach > (this.limbRadius.get(bone!.name) ?? 0)) {
          this.limbRadius.set(bone!.name, reach);
        }
      }
    });

    /*
     * Now the tips: the last bone of each limb that anything is drawn on.
     *
     * A bone still sitting at exactly zero after that sweep had no vertex claim
     * it, so it is a marker rather than a part of her. Walking back from the
     * end of each chain until something has width is what finds the real foot.
     */
    this.limbTip.clear();
    this.boneMobility.clear();
    for (const [group, names] of this.limbGroups()) {
      for (let i = names.length - 1; i >= 0; i -= 1) {
        const name = names[i]!;
        if ((this.limbRadius.get(name) ?? 0) > 0) { this.limbTip.set(group, name); break; }
      }
      /*
       * And the weights, relative to the tip of this limb. A joint as thin as
       * the claw is free; anything fatter is proportionally more reluctant, so
       * a correction is absorbed by the light end of the leg the way a real one
       * absorbs it — which is the whole of "assign weights so it is more stable
       * and heavier".
       */
      const tip = this.limbTip.get(group);
      const tipRadius = tip ? this.limbRadius.get(tip) ?? 0 : 0;
      if (tipRadius <= 0) continue;
      for (const name of names) {
        const radius = this.limbRadius.get(name) ?? 0;
        const mobility = radius > 0 ? Math.min(1, tipRadius / radius) : 1;
        this.boneMobility.set(name, Math.max(IK_MIN_MOBILITY, mobility));
      }
    }
  }

  /** World position of a named bone, for callers that need to aim at one. */
  boneWorldPosition(name: string, into: THREE.Vector3): boolean {
    const bone = this.bones.get(name);
    if (!bone) return false;
    this.root.updateMatrixWorld(true);
    bone.getWorldPosition(into);
    return true;
  }

  /**
   * The LAG between her segments, not their absolute pitch.
   *
   * Her whole body points down the bore — that is done by the scene, in the
   * basis it builds — and this only adds the difference between where each
   * segment has got to and where the one in front of it is. Head, then thorax,
   * then gaster: a train.
   *
   * It has to be the residual rather than the angle, because of how she is
   * rigged. Every one of the six legs hangs off the same hub as the body root,
   * so putting ninety degrees on the root swings her legs up into the air with
   * her. The residuals are a few degrees and touch only the segments behind
   * the head.
   *
   * Applied on top of the base `update` recorded, which is the gait's pose for
   * a bone the gait writes and the rest pose for one it does not. Set rather
   * than accumulated, so holding a steady lag holds a steady angle — call this
   * a thousand times with the same numbers and she is in the same shape.
   */
  leanSegments(thoraxLag: number, gasterLag: number): void {
    if (!this.loaded) return;
    const groups: Array<[string[], number]> = [
      [this.rig.thorax, thoraxLag],
      [this.rig.gaster, gasterLag],
    ];
    for (const [names, angle] of groups) {
      const first = names[0];
      if (first === undefined) continue;
      const bone = this.bones.get(first);
      const base = this.poseBase.get(first);
      if (!bone || !base) continue;
      bone.quaternion.copy(base);
      if (Math.abs(angle) < 1e-6) continue;
      TILT.setFromAxisAngle(RIGHT, angle);
      bone.quaternion.multiply(TILT);
    }
  }

  /**
   * Hide her head from the CAMERA while leaving her shadow whole.
   *
   * For first person underground, where her own skull fills the lens. The two
   * halves of that sentence pull in opposite directions and three.js has
   * exactly the seam needed: the shadow map is drawn with a mesh's
   * `customDepthMaterial` rather than its visible one, so a discard patched
   * into the visible material alone takes the head out of the picture and
   * leaves it in the shadow.
   *
   * The head cannot simply be hidden as an object — she is one skinned mesh,
   * so there is nothing to toggle. It is masked per VERTEX instead, by which
   * bone each one is weighted to, which is the same question `measureLimbs`
   * already asks and the only honest definition of "the head" on a rig whose
   * bones are called Bone_041.
   */
  showHead(show: boolean): void {
    this.hideHead = !show;
    for (const material of this.headMaterials) {
      const uniform = (material.userData as { headHidden?: { value: number } }).headHidden;
      if (uniform) uniform.value = show ? 0 : 1;
    }
  }

  /** Is the head currently hidden from the camera? */
  get headHidden(): boolean {
    return this.hideHead;
  }

  /**
   * Mark every vertex that belongs to her head, and teach the material to drop
   * them on request.
   *
   * The mask is an attribute rather than a uniform range because the head's
   * vertices are scattered through the buffer in whatever order the exporter
   * felt like; there is no contiguous slice to skip.
   */
  private maskHead(): void {
    const head = new Set<string>([
      ...this.rig.mouth,
      ...(this.rig.mandibleLeft ?? []),
      ...(this.rig.mandibleRight ?? []),
      ...this.rig.antennaLeft,
      ...this.rig.antennaRight,
    ]);
    // The last thorax bone IS the head — it is the one the gait dips to dig.
    const crown = this.rig.thorax[this.rig.thorax.length - 1];
    if (crown) head.add(crown);

    this.headMaterials.length = 0;
    this.root.traverse((node) => {
      const mesh = node as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      const position = mesh.geometry.getAttribute('position');
      const skinIndex = mesh.geometry.getAttribute('skinIndex');
      const skinWeight = mesh.geometry.getAttribute('skinWeight');
      if (!position || !skinIndex || !skinWeight) return;

      const mask = new Float32Array(position.count);
      for (let i = 0; i < position.count; i += 1) {
        let best = 0;
        let bestWeight = -1;
        for (let k = 0; k < 4; k += 1) {
          const weight = skinWeight.getComponent(i, k);
          if (weight > bestWeight) { bestWeight = weight; best = skinIndex.getComponent(i, k); }
        }
        const bone = mesh.skeleton.bones[best];
        mask[i] = bone && head.has(bone.name) ? 1 : 0;
      }
      mesh.geometry.setAttribute('headMask', new THREE.BufferAttribute(mask, 1));

      const material = mesh.material as THREE.Material;
      const uniform = { value: 0 };
      material.userData.headHidden = uniform;
      material.onBeforeCompile = (shader) => {
        shader.uniforms.headHidden = uniform;
        shader.vertexShader = `attribute float headMask;\nvarying float vHeadMask;\n${shader.vertexShader}`
          .replace('void main() {', 'void main() {\n  vHeadMask = headMask;');
        shader.fragmentShader = `uniform float headHidden;\nvarying float vHeadMask;\n${shader.fragmentShader}`
          .replace('void main() {', 'void main() {\n  if (headHidden > 0.5 && vHeadMask > 0.5) discard;');
      };
      // A material's compiled program is cached by this key, so the patched and
      // unpatched versions must not share one.
      material.customProgramCacheKey = () => 'queen-head-mask';
      material.needsUpdate = true;
      this.headMaterials.push(material);
    });
  }

  /**
   * How wide her BODY is, in world units — the radius of the tube her thorax
   * and gaster are drawn as, ignoring her legs.
   *
   * This is the footprint she has to fit THROUGH, which is a different question
   * from how far her feet can reach and wants a different number. Her legs fold;
   * her abdomen does not. Measured off the mesh, so it stays true across castes
   * and re-exports.
   */
  bodyRadius(): number {
    let widest = 0;
    for (const group of [this.rig.body, this.rig.thorax, this.rig.gaster]) {
      for (const name of group) widest = Math.max(widest, this.limbRadius.get(name) ?? 0);
    }
    return widest;
  }

  /** Her mouthparts, in world space. False when the rig has not loaded. */
  jawPosition(into: THREE.Vector3): boolean {
    const mouth = this.rig.mouth[this.rig.mouth.length - 1];
    return mouth !== undefined && this.boneWorldPosition(mouth, into);
  }

  dispose(): void {
    this.root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    });
    this.bones.clear();
    this.rest.clear();
    this.poseBase.clear();
    this.limbRadius.clear();
    this.limbTip.clear();
    this.boneMobility.clear();
  }
}
