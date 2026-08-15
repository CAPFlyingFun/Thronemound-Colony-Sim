/**
 * A WORM, DRAWN LYING IN THE HOLE IT DUG.
 *
 * Asked for: "go ahead and draw them following the path they dug." Which is
 * the only way this can look right, and it is worth saying why rather than
 * treating it as polish. A worm is seventeen times the queen's length; a
 * rigid one laid along its heading would have most of its body outside the
 * 6 mm tube it just made, sticking through soil in every direction. The
 * path is not decoration, it is the only place the body fits.
 *
 * ## The rig makes this easy, and the reason is in `wormPose`
 *
 * Solving the S out of the bind pose turned up something better than a
 * pose: every bone below the root straightens to IDENTITY, so the S lives
 * entirely in the rest rotations. That means a bone chain laid along a
 * curve is a plain sequence of "point this bone at the next breadcrumb" —
 * no correction table, no offsets from a shape nobody can read.
 *
 * ## Aiming a bone at a point
 *
 * Each bone's child hangs at a fixed offset in the bone's own space. To
 * point that child at a target, rotate the offset's direction onto the
 * direction of the target, in the PARENT's frame — the same solve
 * `probe:worm` does, run every frame against a moving target instead of
 * once against a straight line.
 *
 * ## What it measures, and what is still wrong
 *
 * `probe:worms` asks the density field about every bone. Laying the body on
 * the path took it from 3 bones of 35 in air to 26 of 51 — the mechanism
 * works and is worth having. The remaining half is NOT a fault in this
 * file: a worm has only dug about 120 mm of burrow when the probe looks,
 * and the body is 150, so the tail is still lying in ground its owner has
 * not reached yet. It cannot dig further because it has left the streamed
 * window and the window follows HER — measured by running the probe for
 * 300 seconds instead of 90 and getting the identical distance travelled.
 *
 * In play she moves, the window goes with her, and a worm gets going
 * again. A worm that stalls out of reach is a worm nobody is looking at.
 *
 * ## One model, several worms
 *
 * A `SkinnedMesh` cannot be shared between worms — each needs its own bone
 * transforms — so each worm gets its own clone. Three of them at 0.18 MB
 * is cheaper than the leaf, and `SkeletonUtils.clone` is what makes a
 * skinned clone actually work: a plain `Object3D.clone` copies the bones
 * but leaves every clone's skeleton pointing at the ORIGINAL's, so they
 * all move together and none of them move right.
 */
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CREATURES } from './creatureScale';

const S_WANT = new THREE.Vector3();
const S_HAVE = new THREE.Vector3();
const S_PARENT = new THREE.Quaternion();
const S_Q = new THREE.Vector3();
const S_AT = new THREE.Vector3();
const S_NEXT = new THREE.Vector3();
const S_HEAD = new THREE.Vector3();

/**
 * The bone chain of one worm, and the object it lives in.
 *
 * Built from a loaded template rather than loading its own: the scene
 * fetches the GLB once and hands it to however many of these it wants.
 */
export class WormBody {
  readonly root: THREE.Object3D;

  private readonly chain: THREE.Bone[] = [];

  constructor(template: THREE.Object3D) {
    this.root = cloneSkinned(template);
    /* Scaled to a real earthworm — see `creatureScale`, where the number
     * is solved against the model's own spine rather than its box. */
    this.root.scale.setScalar(CREATURES.earthworm!.fit);

    /* The longest single-child run of bones IS the worm — the same walk
     * `probe:worm` does, for the same reason. */
    const roots: THREE.Bone[] = [];
    this.root.traverse((n) => {
      const b = n as THREE.Bone;
      if (b.isBone && !(b.parent as THREE.Bone | null)?.isBone) roots.push(b);
    });
    for (const r of roots) {
      const run: THREE.Bone[] = [r];
      let at: THREE.Bone = r;
      for (;;) {
        const kids = at.children.filter((c) => (c as THREE.Bone).isBone) as THREE.Bone[];
        const only = kids.length === 1 ? kids[0] : undefined;
        if (!only) break;
        at = only;
        run.push(at);
      }
      if (run.length > this.chain.length) this.chain.push(...run.splice(0));
    }
  }

  /** How many bones its body has — for probes. */
  get bones(): number { return this.chain.length; }

  /** Every bone's world position — for probes that ask the soil about it. */
  boneWorld(): number[][] {
    this.root.updateMatrixWorld(true);
    return this.chain.map((b) => {
      const p = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
      return [p.x, p.y, p.z];
    });
  }

  /**
   * Lay the body along a path, newest point first.
   *
   * The head goes to `path[0]` and each bone is aimed at the point a bone's
   * length further back. Points are in WORLD space; the bones are solved in
   * the root's frame, so the root is placed first and the path brought into
   * it.
   */
  layAlong(path: readonly THREE.Vector3[]): void {
    if (path.length < 2 || this.chain.length < 2) return;
    const spacing = this.spacing();

    /*
     * SOLVED AGAINST EACH BONE'S REAL PARENT, not an assumed frame.
     *
     * A first cut started the accumulated parent at identity and multiplied
     * the new rotations along the chain. That ignores everything between
     * the object root and the first bone — the armature's own transform,
     * which these rigs carry — and it measured: 3 bones of 35 ended up in
     * air, the other 32 drawn through the wall of the very tube they dug.
     *
     * Asking `matrixWorld` for the parent's rotation costs an update per
     * bone and cannot be wrong about a frame it did not have to model.
     */
    for (let i = 0; i + 1 < this.chain.length; i += 1) {
      const bone = this.chain[i]!;
      const child = this.chain[i + 1]!;
      /* Where this bone sits along the path, and where the next one wants
       * to be — by ARC LENGTH, so a seat does not slide as the crumbs
       * bunch up on a turn. */
      walkPath(path, spacing * i, S_AT);
      walkPath(path, spacing * (i + 1), S_NEXT);
      S_WANT.copy(S_NEXT).sub(S_AT);
      if (S_WANT.lengthSq() < 1e-12) continue;
      S_WANT.normalize();

      /*
       * THE HEAD BONE CARRIES THE WHOLE WORM. Placing the OBJECT at the
       * head puts the object's origin there, and the root bone is somewhere
       * else inside the model — so the body arrived offset by however far
       * apart those two are. The first bone is moved onto the path and the
       * object follows it.
       */
      if (i === 0) {
        this.root.position.copy(S_AT);
        this.root.quaternion.identity();
        this.root.updateMatrixWorld(true);
        bone.getWorldPosition(S_HEAD);
        this.root.position.add(S_AT.clone().sub(S_HEAD));
        this.root.updateMatrixWorld(true);
      }

      (bone.parent ?? this.root).getWorldQuaternion(S_PARENT);
      S_HAVE.copy(child.position).normalize();
      S_Q.copy(S_WANT).applyQuaternion(S_PARENT.invert());
      bone.quaternion.setFromUnitVectors(S_HAVE, S_Q);
      bone.updateMatrixWorld(true);
    }
  }

  /** One bone's length, in the root's own units. */
  private spacing(): number {
    const a = this.chain[0]!;
    const b = this.chain[1]!;
    return b.position.length() * this.root.scale.x;
  }

  dispose(): void {
    this.root.traverse((n) => {
      const m = n as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
  }
}

/** A point `dist` along a path, walking from its head. */
function walkPath(
  path: readonly THREE.Vector3[], dist: number, into: THREE.Vector3,
): THREE.Vector3 {
  let left = dist;
  for (let i = 0; i + 1 < path.length; i += 1) {
    const seg = path[i]!.distanceTo(path[i + 1]!);
    if (seg <= 1e-9) continue;
    if (left <= seg) {
      return into.copy(path[i]!).lerp(path[i + 1]!, left / seg);
    }
    left -= seg;
  }
  /* Past the end of what it remembers: the tail simply stops there rather
   * than being extrapolated into soil it never dug. */
  return into.copy(path[path.length - 1]!);
}
