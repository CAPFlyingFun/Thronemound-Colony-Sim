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
