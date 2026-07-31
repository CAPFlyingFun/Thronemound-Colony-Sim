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
  QUEEN_RIG, RIGS, gaitPose, rigBones, rigLengthVoxels, rigScale,
  type GaitInput, type RigMap,
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
const IK_PASSES = 4;
const IK_MAX_STEP = 0.9;

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
const WORLD_SPIN = new THREE.Quaternion();
const LOCAL_SPIN = new THREE.Quaternion();
const PARENT = new THREE.Quaternion();

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
  /** How fat each limb is around its own bones, in world units. See `measureLimbs`. */
  private readonly limbRadius = new Map<string, number>();
  private clock = 0;
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
  update(dt: number, input: QueenPoseInput): void {
    if (!this.loaded) return;
    this.clock += dt;
    const pose = gaitPose({ ...input, clock: this.clock }, this.rig);

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
    groundAt: (x: number, z: number) => number,
    clearance: number,
    band: number,
  ): number {
    if (!this.loaded) return 0;
    this.root.updateMatrixWorld(true);
    let worstPenetration = 0;

    for (const limb of this.limbs()) {
      const chain: THREE.Bone[] = [];
      for (const name of limb.bones) {
        const bone = this.bones.get(name);
        if (bone) chain.push(bone);
      }
      if (chain.length < 3) continue;
      const foot = chain[chain.length - 1]!;

      /*
       * The clearance a LIMB needs, not the clearance a bone needs. The mesh is
       * a tube around the skeleton, so its underside hangs the tube's radius
       * below the bone line — measured at load, per limb, rather than guessed.
       */
      const sole = clearance + (this.limbRadius.get(limb.id) ?? 0);
      const lowest = Math.max(0, chain.length - 1 - IK_JOINTS);

      foot.getWorldPosition(FOOT);
      const ground = groundAt(FOOT.x, FOOT.z);
      worstPenetration = Math.max(worstPenetration, ground + sole - FOOT.y);
      /*
       * A leg is trying to STAND on the ground and an antenna is not — she
       * sweeps them ahead of her and they should stay where the gait waves
       * them, only never through the soil. A zero band gives exactly that:
       * `footTarget` lifts anything below the surface and leaves everything
       * else alone. Without it the antennae were the last thing still clipping,
       * because nothing here was looking at them at all.
       */
      let wanted = footTarget(FOOT.y, ground, sole, limb.plant ? band : 0);
      if (Math.abs(wanted - FOOT.y) < 1e-7) continue;

      for (let attempt = 0; attempt < IK_ATTEMPTS; attempt += 1) {
        foot.getWorldPosition(FOOT);
        TARGET.set(FOOT.x, wanted, FOOT.z);

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
            WORLD_SPIN.setFromAxisAngle(AXIS, Math.min(swing.angle, IK_MAX_STEP));
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
          chain[j]!.getWorldPosition(JOINT);
          deepest = Math.max(deepest, groundAt(JOINT.x, JOINT.z) + sole - JOINT.y);
        }
        if (deepest <= 1e-6) break;
        wanted += deepest;
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
    for (const [, names] of this.limbGroups()) {
      for (const name of names) {
        const bone = this.bones.get(name);
        if (!bone) continue;
        bone.getWorldPosition(JOINT);
        lift = Math.max(lift, escapeAt(JOINT.x, JOINT.y, JOINT.z));
      }
    }
    return lift;
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
      this.limbRadius.set(group, 0);
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
        const reach = distanceToPolyline([vertex.x, vertex.y, vertex.z], spine);
        if (reach > (this.limbRadius.get(group) ?? 0)) this.limbRadius.set(group, reach);
      }
    });
  }

  /** World position of a named bone, for callers that need to aim at one. */
  boneWorldPosition(name: string, into: THREE.Vector3): boolean {
    const bone = this.bones.get(name);
    if (!bone) return false;
    this.root.updateMatrixWorld(true);
    bone.getWorldPosition(into);
    return true;
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
  }
}
