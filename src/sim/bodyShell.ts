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
const OFFSET = new THREE.Vector3();
const AXIS_R = new THREE.Vector3(1, 0, 0);
const AXIS_U = new THREE.Vector3(0, 1, 0);

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

  /**
   * HOW FAR HER BODY HANGS BELOW HER ORIGIN, world units.
   *
   * Her origin is not her lowest point, and on open ground that barely
   * matters because the seater works off a measured belly. Inside a tube it
   * matters completely: seating the ORIGIN on the floor of a three
   * millimetre bore puts everything under it inside the wall. Measured off
   * the shell itself so it cannot drift from the shape being tested.
   */
  get dropBelowOrigin(): number {
    let drop = 0;
    for (const seg of this.segments) {
      for (let i = 0; i < seg.spine.length; i += 1) {
        const d = seg.radii[i]! - seg.spine[i]!.y;
        if (d > drop) drop = d;
      }
    }
    return drop;
  }

  /**
   * HER CROSS-SECTIONAL RADIUS ABOUT HER OWN ORIGIN, world units — how much
   * room she needs in a tube, measured across her forward axis.
   *
   * `dropBelowOrigin` answers a different question and answered it usefully
   * on open ground: how far under her origin does she hang. In a tube that
   * is not enough, because a tunnel is round and she has sides. Seating her
   * origin ON the floor of a 6 mm bore put her gaster a millimetre through
   * the wall on every bend — measured against her own skin, and visible.
   */
  get crossRadius(): number {
    let worst = 0;
    for (const seg of this.segments) {
      for (let i = 0; i < seg.spine.length; i += 1) {
        const p = seg.spine[i]!;
        const r = Math.hypot(p.x, p.y) + seg.radii[i]!;
        if (r > worst) worst = r;
      }
    }
    return worst;
  }

  /** How long she is nose to tail, world units, off the same spheres. */
  get lengthAlongForward(): number {
    let lo = Infinity;
    let hi = -Infinity;
    for (const seg of this.segments) {
      for (let i = 0; i < seg.spine.length; i += 1) {
        lo = Math.min(lo, seg.spine[i]!.z - seg.radii[i]!);
        hi = Math.max(hi, seg.spine[i]!.z + seg.radii[i]!);
      }
    }
    return hi > lo ? hi - lo : 0;
  }

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
    /** Per station, how far her skin reaches across her own right and up. */
    const denseOwn = new Map<SegmentName, Array<{ right: number; up: number }>>();
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
      denseOwn.set(name, pts.map(() => ({ right: 0, up: 0 })));
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
      const own = denseOwn.get(seg)!;
      let near = -1;
      let nearest = Infinity;
      for (let k = 0; k < pts.length; k += 1) {
        const d = vertex.distanceToSquared(pts[k]!);
        if (d < nearest) { nearest = d; near = k; }
      }
      if (near < 0) continue;
      /* The offset from its station, in HER frame, so right and up mean
       * across her body and over her back rather than world axes. */
      OFFSET.copy(vertex).sub(pts[near]!).applyQuaternion(spin);
      const slot = own[near]!;
      slot.right = Math.max(slot.right, Math.abs(OFFSET.x));
      slot.up = Math.max(slot.up, Math.abs(OFFSET.y));
    }
    /*
     * A STATION NO VERTEX CHOSE IS SIMPLY SKIPPED below — with stations a
     * tenth of a unit apart along a body millimetres thick, an unclaimed one
     * lies between two that are claimed and its neighbours' spheres already
     * cover the gap.
     */

    /*
     * A LATTICE OF SPHERES THAT FITS THE SECTION, not one sphere that
     * swallows it.
     *
     * A single sphere per station has to reach the widest vertex there, so
     * on a cross-section 1.89 mm wide and 2.36 mm tall it takes the larger
     * half-extent and applies it in EVERY direction — fat where the body is
     * thin. The first thin-radius replacement solved that overstatement, but
     * it accidentally collapsed the promised two-dimensional lattice into a
     * one-dimensional row: because the sphere radius equalled the thin
     * half-extent, `mine.thin - radius` was always zero on one axis.
     *
     * Give each bead three quarters of the thin half-extent instead. That
     * leaves a quarter of the measured section available for off-axis bead
     * centres, so both right and up participate in the shell. Keeping the
     * small corner beads is deliberate: those diagonal skin regions are
     * exactly what the one-dimensional stadium missed against curved tunnel
     * walls. The existing skin-vs-shell probe is the authority on whether
     * this conservative coverage has become too fat again.
     */
    const segments: Segment[] = [];
    for (const [name] of groups) {
      const pts = dense.get(name)!;
      const own = denseOwn.get(name)!;
      if (pts.length === 0) continue;
      const spine: THREE.Vector3[] = [];
      const radii: number[] = [];
      let lastKept = -Infinity;
      let travelled = 0;
      for (let k = 0; k < pts.length; k += 1) {
        if (k > 0) travelled += pts[k]!.distanceTo(pts[k - 1]!);
        const mine = own[k]!;
        if (mine.right <= 0 && mine.up <= 0) continue;
        const thin = Math.max(1e-4, Math.min(mine.right, mine.up));
        if (k > 0 && k < pts.length - 1 && travelled - lastKept < thin * 0.5) continue;
        lastKept = travelled;

        const bead = Math.max(1e-4, thin * 0.75);
        const here = toLocal(pts[k]!.clone());
        const spanR = Math.max(0, mine.right - bead);
        const spanU = Math.max(0, mine.up - bead);
        const nR = Math.max(1, Math.ceil(spanR / bead) * 2 + 1);
        const nU = Math.max(1, Math.ceil(spanU / bead) * 2 + 1);
        for (let a = 0; a < nR; a += 1) {
          for (let b = 0; b < nU; b += 1) {
            const tr = nR === 1 ? 0 : (a / (nR - 1)) * 2 - 1;
            const tu = nU === 1 ? 0 : (b / (nU - 1)) * 2 - 1;
            spine.push(here.clone()
              .addScaledVector(AXIS_R, tr * spanR)
              .addScaledVector(AXIS_U, tu * spanU));
            radii.push(bead);
          }
        }
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
