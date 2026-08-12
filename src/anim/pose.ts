/**
 * NAMED POSES — bone rotations, and deliberately nothing else.
 *
 * Asked for as an animation editor: pose her by hand against terrain, for
 * climbing, jumping, stinging, and save it — "could add where you can move
 * it in space just to get the pose/animation correct but doesn't save the
 * x/y/z, only body bones."
 *
 * That last clause is the whole design and it is exactly right, so it is
 * enforced by the type rather than by discipline: a pose IS a map of bone
 * name to quaternion, and there is nowhere in it to put a position. Where
 * she stands is the walker's business — the seat, the support plane, the
 * gait — and a pose that carried a root translation would fight all three
 * the moment it was applied on real ground.
 *
 * PORTED IN SHAPE FROM BEYOND EXTINCTION, whose editor solved this already:
 * its `AnimStore` serialises tracks as bone name plus quaternions and stores
 * no translation either, and its rig config is a plain group-to-bones map
 * that already drives a non-humanoid (a dinosaur with a ten-bone tail). The
 * ant is therefore a configuration of that idea rather than a new one, which
 * is why this file is a hundred lines instead of a thousand.
 *
 * WHAT THIS IS NOT is a clip. Her legs are IK'd to world foot anchors and
 * her body is driven every frame by gait, spine and walker; a recorded leg
 * track played back over real terrain fights the solver that is putting her
 * feet on the ground. A POSE is a target the existing system can be blended
 * toward by a weight, which composes with all of it instead of overriding
 * it. See `blendInto`.
 */

import type { RigMap } from './hexapod';

/** A quaternion as it is stored: x, y, z, w. */
export type PoseQuat = readonly [number, number, number, number];

export interface AntPose {
  name: string;
  /** Bone name to rotation, RELATIVE to the model's rest pose. */
  rotations: Record<string, PoseQuat>;
}

/**
 * An editable handle: one label over the bones it turns together.
 *
 * Grouped rather than per-bone because a three-bone antenna or a six-bone leg
 * is one thing to a person and six sliders to a machine, and the editor is
 * for the person. The bones stay listed so a group can still be applied,
 * cleared or keyed as a unit.
 */
export interface PoseGroup {
  key: string;
  label: string;
  bones: string[];
}

const LEG_LABELS: Record<string, string> = {
  frontLeft: 'Front L', frontRight: 'Front R',
  midLeft: 'Middle L', midRight: 'Middle R',
  rearLeft: 'Rear L', rearRight: 'Rear R',
};

/**
 * The editable groups of a rig, in the order a person would work down them.
 *
 * Derived from the rig rather than tabulated, because the three castes do not
 * have the same bones — the queen's auto-rig left her mandibles out entirely
 * — and a hard-coded list would silently produce empty handles for her and
 * miss the workers' jaws. A group with no bones is not offered at all.
 */
export function poseGroups(rig: RigMap): PoseGroup[] {
  const out: PoseGroup[] = [];
  const add = (key: string, label: string, bones?: string[]): void => {
    if (bones && bones.length) out.push({ key, label, bones: [...bones] });
  };
  add('body', 'Body', rig.body);
  add('thorax', 'Thorax', rig.thorax);
  add('mouth', 'Head', rig.mouth);
  add('mandibleLeft', 'Jaw L', rig.mandibleLeft);
  add('mandibleRight', 'Jaw R', rig.mandibleRight);
  add('antennaLeft', 'Antenna L', rig.antennaLeft);
  add('antennaRight', 'Antenna R', rig.antennaRight);
  add('gaster', 'Gaster', rig.gaster);
  for (const leg of rig.legs) add(leg.slot, LEG_LABELS[leg.slot] ?? leg.slot, leg.bones);
  return out;
}

/** Every bone a pose may legally name, for validating what is loaded. */
export function poseBones(rig: RigMap): Set<string> {
  return new Set(poseGroups(rig).flatMap((g) => g.bones));
}

export const IDENTITY: PoseQuat = [0, 0, 0, 1];

/** An empty pose — every bone at its rest rotation. */
export function emptyPose(name: string): AntPose {
  return { name, rotations: {} };
}

/**
 * Read a pose back from JSON, keeping only what this rig actually has.
 *
 * A pose authored against the worker names bones the queen does not own, and
 * the honest thing is to drop those rather than to refuse the file or to
 * write rotations onto bones that are not there. What is dropped is
 * returned, so a caller can say so instead of silently losing a jaw.
 */
export function parsePose(
  raw: unknown, rig: RigMap,
): { pose: AntPose; dropped: string[] } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { name?: unknown; rotations?: unknown };
  if (typeof o.name !== 'string' || !o.rotations || typeof o.rotations !== 'object') return null;
  const known = poseBones(rig);
  const rotations: Record<string, PoseQuat> = {};
  const dropped: string[] = [];
  for (const [bone, q] of Object.entries(o.rotations as Record<string, unknown>)) {
    if (!Array.isArray(q) || q.length !== 4 || q.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      dropped.push(bone);
      continue;
    }
    if (!known.has(bone)) { dropped.push(bone); continue; }
    rotations[bone] = [q[0] as number, q[1] as number, q[2] as number, q[3] as number];
  }
  return { pose: { name: o.name, rotations }, dropped };
}

/**
 * Blend a pose into a rotation map that something else has already written.
 *
 * `into` is the frame's live bone rotations — what the gait, the spine and
 * the aim have asked for — and the pose is mixed toward at `weight`. This is
 * the composition point, and it is a blend rather than an assignment on
 * purpose: at weight 0 she is exactly what she was, at 1 she is the pose, and
 * a scene can ease between them without either system knowing about the
 * other. Bones the pose does not mention are left entirely alone, so a pose
 * that only bends the gaster does not flatten her legs.
 *
 * NLERP, not slerp, and shortest-path: these are small corrective angles at
 * animation rates, where the two are indistinguishable by eye and one of
 * them is four trigonometric calls per bone per frame.
 */
export function blendInto(
  into: Map<string, PoseQuat>, pose: AntPose, weight: number,
): Map<string, PoseQuat> {
  const w = Math.min(1, Math.max(0, weight));
  if (w <= 0) return into;
  for (const [bone, q] of Object.entries(pose.rotations)) {
    const from = into.get(bone) ?? IDENTITY;
    /* Shortest path: q and -q are the same rotation, and mixing toward the
     * far one takes her the long way round — visible as a limb whipping
     * through the body to reach a pose it was already next to. */
    const dot = from[0] * q[0] + from[1] * q[1] + from[2] * q[2] + from[3] * q[3];
    const s = dot < 0 ? -1 : 1;
    const x = from[0] + (q[0] * s - from[0]) * w;
    const y = from[1] + (q[1] * s - from[1]) * w;
    const z = from[2] + (q[2] * s - from[2]) * w;
    const k = from[3] + (q[3] * s - from[3]) * w;
    const len = Math.hypot(x, y, z, k) || 1;
    into.set(bone, [x / len, y / len, z / len, k / len]);
  }
  return into;
}
