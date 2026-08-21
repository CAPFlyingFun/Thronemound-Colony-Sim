/**
 * WHERE HER BODY IS, AS SOMETHING THE SOIL CAN REFUSE.
 *
 * Phase 1 of the foundation pass. Until now the movement system asked only
 * "where is the floor?" — `AntBody.seat` solves a height and writes `y`, and
 * nothing anywhere tested whether her HEAD, THORAX or GASTER were standing in
 * dirt. Measured on v0.8.2, walking and not digging: head 5.08 mm, thorax
 * 5.42 mm, gaster 5.63 mm inside solid soil, with some core segment inside on
 * 52 - 77 % of frames. Her gaster is 2.54 mm wide. She walked with it two
 * body-widths into the ground.
 *
 * ## Measured off the rig, not invented
 *
 * Three capsules — head, thorax, gaster — each a polyline through that
 * segment's own bones with the tube radius the SKIN actually reaches. This is
 * the method `QueenModel.measureLimbs` already uses for the legs, for the
 * reason given there: a re-export with a chunkier abdomen must not silently
 * start clipping. Nothing here is tuned.
 *
 * Vertices are attributed to whichever bone holds their largest skin weight,
 * and the radius is the largest distance from any of that segment's vertices
 * to that segment's spine.
 *
 * ## Held in the ROOT's frame
 *
 * The spine is stored relative to `model.root`, so a PROPOSED body transform
 * can be tested by transforming these points with it — which is what makes
 * this a constraint on a movement rather than a correction after one. Her
 * internal flex (the gaster's swing, the thorax's lean) is one frame stale
 * when a proposal is tested; that is a sub-millimetre effect against
 * millimetres of penetration, and correcting it would mean re-posing the
 * whole skeleton per bisection step.
 *
 * ## The field is a distance, so a capsule is one sample
 *
 * The soil field is a `min()` of plane and capsule distances, so its value at
 * a point is how far inside the soil that point is. A sphere of radius r
 * centred at p therefore overlaps solid exactly when `sample(p) > -r`, and by
 * `sample(p) + r`. That is ONE field query per spine sample, not a shell of
 * them — the difference between a test that can run in a bisection loop and
 * one that cannot.
 *
 * Because the field takes a `min`, its value near an edge UNDER-states the
 * true distance to the surface. That direction is the safe one: this can
 * report a clearance smaller than the truth and refuse a movement that would
 * just barely have fitted. It cannot report clear when she is buried.
 */

import * as THREE from 'three';
import type { RigMap } from '../anim/hexapod';

/** Anything that can answer how far inside the soil a point is. */
export interface SignedField {
  sample(x: number, y: number, z: number): number;
}

export type SegmentName = 'head' | 'thorax' | 'gaster';

interface Segment {
  name: SegmentName;
  /** Spine samples in her own frame, already subdivided. */
  spine: THREE.Vector3[];
  /**
   * The tube radius at each of those samples, world units — one per entry in
   * `spine`, not one per segment.
   *
   * A SINGLE MAX RADIUS BALLOONS THE ENDS, and it is not a small effect.
   * Measured: the gaster's widest cross-section is 1.53 mm from its bone, so
   * a uniform capsule put a 1.53 mm sphere on the tail-most spine sample —
   * which at rest sits 1.32 mm above the floor. She was 0.22 mm inside solid
   * soil standing perfectly still, before any movement was proposed, so the
   * clip could find no fraction of any frame that fitted and she froze: 3 mm
   * travelled in two minutes, not one bore started.
   *
   * Per-sample is also what `QueenModel.measureLimbs` does for the legs, and
   * for the same stated reason.
   */
  radii: number[];
}

/** Scratch, so a clearance test allocates nothing. */
const P = new THREE.Vector3();
const A = new THREE.Vector3();
const B = new THREE.Vector3();
const AB = new THREE.Vector3();
const AP = new THREE.Vector3();

/** Distance from a point to a polyline, world units. */
function distanceToSpine(point: THREE.Vector3, spine: THREE.Vector3[]): number {
  if (spine.length === 0) return Infinity;
  if (spine.length === 1) return point.distanceTo(spine[0]!);
  let best = Infinity;
  for (let i = 0; i < spine.length - 1; i += 1) {
    A.copy(spine[i]!);
    B.copy(spine[i + 1]!);
    AB.subVectors(B, A);
    const len2 = AB.lengthSq();
    AP.subVectors(point, A);
    const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, AP.dot(AB) / len2));
    const d = AP.addScaledVector(AB, -t).length();
    if (d < best) best = d;
  }
  return best;
}

export class BodyShell {
  private constructor(readonly segments: readonly Segment[]) {}

  /** How many field queries one full clearance test costs. */
  get sampleCount(): number {
    return this.segments.reduce((n, s) => n + s.spine.length, 0);
  }

  /**
   * Measure her core body off the loaded rig. Returns null when the model has
   * no skinned mesh, which is a load failure rather than a shape this cannot
   * describe — the caller should treat it as "no collision available" and say
   * so rather than silently letting her walk through walls.
   */
  static measure(root: THREE.Object3D, rig: RigMap): BodyShell | null {
    let skinned: THREE.SkinnedMesh | null = null;
    root.traverse((node) => {
      const mesh = node as THREE.SkinnedMesh;
      if (mesh.isSkinnedMesh && !skinned) skinned = mesh;
    });
    if (!skinned) return null;
    const mesh: THREE.SkinnedMesh = skinned;

    root.updateMatrixWorld(true);
    /*
     * INTO HER FRAME BY POSITION AND ROTATION ONLY — NOT by the root matrix.
     *
     * The rig is drawn at a scale of about 0.4, so `root.matrixWorld` carries
     * it, and its inverse divides it back out. That is right for a point that
     * will later be pushed back through the same matrix and wrong for one
     * that will be placed by a quaternion and a position, which is what a
     * PROPOSED pose is — there is no matrix for a pose that does not exist
     * yet. The first cut did exactly that and put every capsule two and a
     * half times too far from her origin: she was inside the soil wherever
     * she stood, the clip could find no fraction of any frame that fitted,
     * and she froze — 3 mm travelled in two minutes and not one bore.
     *
     * Radii are unaffected: those are distances between WORLD points and are
     * already in world units.
     */
    const origin = root.getWorldPosition(new THREE.Vector3());
    const spin = root.getWorldQuaternion(new THREE.Quaternion()).invert();
    const toLocal = (v: THREE.Vector3): THREE.Vector3 =>
      v.sub(origin).applyQuaternion(spin);

    /*
     * WHICH BONES ARE WHICH SEGMENT.
     *
     * `rig.thorax[0]` is the HEAD — the table's naming is the auto-rigger's,
     * and `QueenModel.update` already reads it that way when it aims her
     * face. The rest of `thorax` plus `body` is the middle she stands on.
     * The MOUTH is deliberately part of the head here; whether the head is
     * allowed to be in soil at all is a question for the caller, because
     * while she is cutting it is in soil by definition.
     */
    const groups: Array<[SegmentName, string[]]> = [
      ['head', [rig.thorax[0]!, ...(rig.mouth ?? [])]],
      ['thorax', [...rig.thorax.slice(1), ...rig.body]],
      ['gaster', [...rig.gaster]],
    ];

    const boneByName = new Map<string, THREE.Bone>();
    for (const bone of mesh.skeleton.bones) boneByName.set(bone.name, bone);

    const segmentOf = new Map<string, SegmentName>();
    const spineWorld = new Map<SegmentName, THREE.Vector3[]>();
    for (const [name, bones] of groups) {
      const spine: THREE.Vector3[] = [];
      for (const b of bones) {
        segmentOf.set(b, name);
        const bone = boneByName.get(b);
        if (!bone) continue;
        spine.push(bone.getWorldPosition(new THREE.Vector3()));
      }
      spineWorld.set(name, spine);
    }

    const position = mesh.geometry.attributes.position!;
    const skinIndex = mesh.geometry.attributes.skinIndex!;
    const skinWeight = mesh.geometry.attributes.skinWeight!;
    const vertex = new THREE.Vector3();
    /*
     * THE SPINE REACHES THE SKIN'S ENDS, NOT JUST THE LAST BONE.
     *
     * Her gaster's mesh runs well past its final bone. Attribution gives
     * those vertices to the end sample, so their AXIAL overhang is recorded
     * as RADIUS and the cap balloons into a sphere the width of the whole
     * tail: measured, 1.533 mm on a sample sitting 1.316 mm above the floor,
     * which is 0.219 mm of penetration while she stands perfectly still. Per
     * sample radii did not fix it because the fault was never the sharing —
     * it was that the length had nowhere else to go.
     *
     * So each end is extended along its own terminal direction as far as the
     * furthest vertex projects, and the cap tapers instead.
     */
    for (const [name, bones] of groups) {
      void bones;
      const spine = spineWorld.get(name)!;
      if (spine.length === 0) continue;
      const head = spine[0]!;
      const tail = spine[spine.length - 1]!;
      const axis = spine.length > 1
        ? new THREE.Vector3().subVectors(tail, head).normalize()
        : new THREE.Vector3(0, 0, 1);
      let front = 0;
      let back = 0;
      const v = new THREE.Vector3();
      for (let i = 0; i < position.count; i += 1) {
        let best = -1;
        let bestWeight = -1;
        for (let c = 0; c < 4; c += 1) {
          const w = skinWeight.getComponent(i, c);
          if (w > bestWeight) { bestWeight = w; best = skinIndex.getComponent(i, c); }
        }
        const owner = mesh.skeleton.bones[best]?.name;
        if (owner === undefined || segmentOf.get(owner) !== name) continue;
        v.fromBufferAttribute(position, i);
        mesh.applyBoneTransform(i, v);
        v.applyMatrix4(mesh.matrixWorld);
        const beyondTail = v.clone().sub(tail).dot(axis);
        const beforeHead = -v.clone().sub(head).dot(axis);
        if (beyondTail > front) front = beyondTail;
        if (beforeHead > back) back = beforeHead;
      }
      if (back > 1e-6) spine.unshift(head.clone().addScaledVector(axis, -back));
      if (front > 1e-6) spine.push(tail.clone().addScaledVector(axis, front));
    }

    /*
     * SUBDIVIDE, then attribute vertices to the sample they are
     * nearest. Measuring against raw bones and subdividing afterwards would
     * hand every interpolated sample the whole segment's fattest radius,
     * which is the ballooning this is here to avoid.
     */
    const dense = new Map<SegmentName, THREE.Vector3[]>();
    const denseR = new Map<SegmentName, number[]>();
    for (const [name] of groups) {
      const world = spineWorld.get(name)!;
      const pts: THREE.Vector3[] = [];
      /* Spacing is set below off the coarse radius; a millimetre is finer
       * than any tube on this ant and keeps the pass independent of it. */
      const step = 0.1;
      for (let i = 0; i < world.length; i += 1) {
        const a = world[i]!;
        pts.push(a.clone());
        const b = world[i + 1];
        if (!b) continue;
        const span = a.distanceTo(b);
        const cuts = Math.floor(span / step);
        for (let k = 1; k <= cuts; k += 1) pts.push(a.clone().lerp(b, (k * step) / span));
      }
      dense.set(name, pts);
      denseR.set(name, new Array(pts.length).fill(0));
    }
    for (let i = 0; i < position.count; i += 1) {
      let best = -1;
      let bestWeight = -1;
      for (let c = 0; c < 4; c += 1) {
        const w = skinWeight.getComponent(i, c);
        if (w > bestWeight) { bestWeight = w; best = skinIndex.getComponent(i, c); }
      }
      const owner = mesh.skeleton.bones[best]?.name;
      const seg = owner === undefined ? undefined : segmentOf.get(owner);
      if (seg === undefined) continue;
      vertex.fromBufferAttribute(position, i);
      mesh.applyBoneTransform(i, vertex);
      vertex.applyMatrix4(mesh.matrixWorld);
      const pts = dense.get(seg)!;
      const rs = denseR.get(seg)!;
      let near = -1;
      let nearest = Infinity;
      for (let k = 0; k < pts.length; k += 1) {
        const d = vertex.distanceToSquared(pts[k]!);
        if (d < nearest) { nearest = d; near = k; }
      }
      if (near >= 0) {
        const d = Math.sqrt(nearest);
        if (d > rs[near]!) rs[near] = d;
      }
    }
    /*
     * A SAMPLE NO VERTEX CHOSE STILL HAS TO BE FAT ENOUGH. Nearest-vertex
     * attribution leaves gaps — a sample tucked between two bulges may own
     * nothing — and a zero there is a hole in the collision. Each empty
     * sample takes the larger of its filled neighbours.
     */
    for (const [name] of groups) {
      const rs = denseR.get(name)!;
      for (let k = 0; k < rs.length; k += 1) {
        if (rs[k]! > 0) continue;
        let lo = k; let hi = k;
        while (lo > 0 && rs[lo]! <= 0) lo -= 1;
        while (hi < rs.length - 1 && rs[hi]! <= 0) hi += 1;
        rs[k] = Math.max(rs[lo] ?? 0, rs[hi] ?? 0);
      }
    }

    /*
     * THINNED SO NO GAP IS WIDER THAN THE TUBE THERE.
     *
     * The measuring pass ran at a fixed 0.1 world units; the test does not
     * need that many. Keep every sample whose own radius would otherwise
     * leave a waist — half a radius apart, the spacing `DigJob` uses for the
     * same geometry — and drop the rest.
     */
    const segments: Segment[] = [];
    for (const [name] of groups) {
      const pts = dense.get(name)!;
      const rs = denseR.get(name)!;
      if (pts.length === 0) continue;
      const spine: THREE.Vector3[] = [];
      const radii: number[] = [];
      let lastKept = -Infinity;
      let travelled = 0;
      for (let k = 0; k < pts.length; k += 1) {
        if (k > 0) travelled += pts[k]!.distanceTo(pts[k - 1]!);
        const r = rs[k]!;
        const keep = k === 0 || k === pts.length - 1
          || travelled - lastKept >= Math.max(r * 0.5, 1e-3);
        if (!keep) continue;
        lastKept = travelled;
        spine.push(toLocal(pts[k]!.clone()));
        radii.push(r);
      }
      if (spine.length > 0) segments.push({ name, spine, radii });
    }
    return new BodyShell(segments);
  }

  /** The widest tube radius of one segment, world units. */
  radiusOf(name: SegmentName): number {
    const seg = this.segments.find((s) => s.name === name);
    return seg ? Math.max(...seg.radii) : 0;
  }

  /**
   * How deep her core body would be inside solid soil at a proposed pose,
   * in world units. Zero means clear.
   *
   * `skip` names segments to leave out. The head is the one that needs it:
   * while a bore is running her mandibles are ON the work face, and a face
   * is solid — that is what makes it a face — so holding the head to the
   * same rule as the gaster would forbid her to dig at all.
   */
  worstInside(
    field: SignedField,
    position: THREE.Vector3,
    quaternion: THREE.Quaternion,
    skip?: ReadonlySet<SegmentName>,
  ): number {
    let worst = 0;
    for (const segment of this.segments) {
      if (skip?.has(segment.name)) continue;
      for (let i = 0; i < segment.spine.length; i += 1) {
        P.copy(segment.spine[i]!).applyQuaternion(quaternion).add(position);
        const depth = field.sample(P.x, P.y, P.z) + segment.radii[i]!;
        if (depth > worst) worst = depth;
      }
    }
    return worst;
  }
}
