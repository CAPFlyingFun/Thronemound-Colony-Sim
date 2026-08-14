import { describe, expect, it } from 'vitest';

import {
  MAJOR_RIG, QUEEN_RIG, WORKER_RIG, bodyBones, headChain, headFrontBone,
  neckBone, thoraxBone,
} from '../src/anim/hexapod';
import {
  blendInto, boneLabels, emptyPose, IDENTITY, parsePose, poseBones, poseGroups,
  type PoseQuat,
} from '../src/anim/pose';

const ALL_RIGS = [QUEEN_RIG, WORKER_RIG, MAJOR_RIG];

describe('what the handles are called', () => {
  it('puts every handle where that part of her actually is', () => {
    /*
     * Reported from the animator, both halves true at once: "the head is at
     * the antenna bone, and what's labeled as Thorax is actually the Head."
     * The rig table's groups are a segment forward of the anatomy — see the
     * measurements above `headChain` — so HEAD was the single joint at her
     * antenna sockets, THORAX was her neck and the back of her head, and
     * nothing at all was on her actual thorax.
     *
     * A round before that, HEAD was the mouth chain and was reported in the
     * same words. Twice wrong in one place is why this test names the parts
     * rather than the table.
     */
    for (const rig of ALL_RIGS) {
      const by = new Map(poseGroups(rig).map((g) => [g.key, g]));
      /* HEAD is her whole head, neck base first — not one joint at her face. */
      expect(by.get('head')?.bones).toEqual([...headChain(rig)]);
      expect(by.get('head')?.bones[0]).toBe(neckBone(rig));
      expect(by.get('head')?.label).toBe('Head');
      /* THORAX is the hub her legs and head hang off, and nothing else. */
      expect(by.get('thorax')?.bones).toEqual([thoraxBone(rig)]);
      expect(by.get('body')?.bones).toEqual([...bodyBones(rig)]);
      expect(by.get('mouth')?.bones).toEqual([...rig.mouth]);
      expect(by.get('mouth')?.label).toBe('Mouth');
      /* The two faults that were reported, stated as the test that fails. */
      expect(by.get('head')?.bones).toContain(headFrontBone(rig));
      expect(by.get('thorax')?.bones).not.toContain(neckBone(rig));
      /* Every bone still belongs to exactly one handle. */
      const all = poseGroups(rig).flatMap((g) => g.bones);
      expect(new Set(all).size).toBe(all.length);
    }
  });

  it('gives every bone its own name, and no two the same', () => {
    for (const rig of ALL_RIGS) {
      const names = boneLabels(rig);
      for (const bone of poseGroups(rig).flatMap((g) => g.bones)) {
        expect(names.get(bone)).toBeTruthy();
      }
      expect(new Set(names.values()).size).toBe(names.size);
      /* A chain reads root to tip, so those two words have to appear. */
      const leg = rig.legs[0]!;
      expect(names.get(leg.bones[0]!)).toMatch(/root$/);
      expect(names.get(leg.bones[leg.bones.length - 1]!)).toMatch(/tip$/);
      /* A one-bone group is just its own name, with nothing appended. */
      expect(names.get(thoraxBone(rig)!)).toBe('Thorax');
      /* Her neck is named, not called "Head root" — it is the joint an
       * animator reaches for to turn her head. */
      expect(names.get(neckBone(rig)!)).toBe('Neck');
      expect(names.get(headFrontBone(rig)!)).toBe('Head tip');
    }
  });

  it('never files a bone under both sides', () => {
    /*
     * The handedness fix swapped whole chains between the Left and Right
     * entries — see the note above `QUEEN_RIG`. Swapping one and forgetting
     * its partner would put the same bones under both names, and every
     * downstream count would still look perfectly plausible.
     */
    for (const rig of ALL_RIGS) {
      const lefts = new Set([...rig.antennaLeft, ...(rig.mandibleLeft ?? [])]);
      for (const bone of [...rig.antennaRight, ...(rig.mandibleRight ?? [])]) {
        expect(lefts.has(bone)).toBe(false);
      }
      const seen = new Set<string>();
      for (const leg of rig.legs) {
        for (const bone of leg.bones) {
          expect(seen.has(bone)).toBe(false);
          seen.add(bone);
        }
      }
      expect(rig.legs.filter((l) => l.side === -1)).toHaveLength(3);
      expect(rig.legs.filter((l) => l.side === 1)).toHaveLength(3);
    }
  });
});

describe('the editable groups of a rig', () => {
  it('offers every bone the rig owns, exactly once', () => {
    for (const rig of [QUEEN_RIG, WORKER_RIG]) {
      const groups = poseGroups(rig);
      const flat = groups.flatMap((g) => g.bones);
      /* Once each: a bone in two groups would be written twice a frame and
       * the second write would silently win. */
      expect(new Set(flat).size).toBe(flat.length);
      /* And all six legs, which is the half a body-only list would miss. */
      for (const leg of rig.legs) {
        expect(flat).toEqual(expect.arrayContaining(leg.bones));
      }
      expect(groups.every((g) => g.bones.length > 0)).toBe(true);
      expect(groups.every((g) => g.label.length > 0)).toBe(true);
    }
  });

  it('does not invent jaws the queen does not have', () => {
    /*
     * The whole reason the groups are derived rather than tabulated. Her
     * auto-rig left the mandibles out; the workers have three-bone chains.
     * A fixed list would hand her two empty handles that do nothing.
     */
    expect(QUEEN_RIG.mandibleLeft).toBeUndefined();
    expect(poseGroups(QUEEN_RIG).some((g) => g.key === 'mandibleLeft')).toBe(false);
    expect(poseGroups(WORKER_RIG).some((g) => g.key === 'mandibleLeft')).toBe(true);
  });

  it('hands out copies, so an editor cannot edit the rig itself', () => {
    const groups = poseGroups(QUEEN_RIG);
    const legs = groups.find((g) => g.key === 'frontLeft')!;
    legs.bones.push('Bone_999');
    expect(poseGroups(QUEEN_RIG).find((g) => g.key === 'frontLeft')!.bones)
      .not.toContain('Bone_999');
  });
});

describe('reading a pose back', () => {
  it('keeps what this rig has and reports what it dropped', () => {
    const bone = QUEEN_RIG.gaster[0]!;
    const read = parsePose({
      name: 'Sting',
      rotations: {
        [bone]: [0, 0.3, 0, 0.954],
        Bone_997: [0, 0, 0, 1],
      },
    }, QUEEN_RIG);
    expect(read).not.toBeNull();
    expect(read!.pose.name).toBe('Sting');
    expect(read!.pose.rotations[bone]).toEqual([0, 0.3, 0, 0.954]);
    /* Dropped rather than written onto a bone that is not there — and NAMED,
     * so a pose authored on the worker does not quietly lose a jaw. */
    expect(read!.dropped).toEqual(['Bone_997']);
    expect(read!.pose.rotations.Bone_997).toBeUndefined();
  });

  it('refuses rubbish instead of half-loading it', () => {
    expect(parsePose(null, QUEEN_RIG)).toBeNull();
    expect(parsePose('a pose', QUEEN_RIG)).toBeNull();
    expect(parsePose({ rotations: {} }, QUEEN_RIG)).toBeNull();
    expect(parsePose({ name: 'x' }, QUEEN_RIG)).toBeNull();
    const bone = QUEEN_RIG.gaster[0]!;
    /* A short, non-numeric or non-finite quaternion is dropped, not stored:
     * a NaN here propagates into the bone and the limb vanishes. */
    for (const bad of [[0, 0, 1], [0, 0, 0, 'w'], [0, 0, 0, NaN]]) {
      const read = parsePose({ name: 'x', rotations: { [bone]: bad } }, QUEEN_RIG);
      expect(read!.dropped).toEqual([bone]);
      expect(read!.pose.rotations[bone]).toBeUndefined();
    }
  });

  it('has nowhere to put a position, which is the point', () => {
    /*
     * "doesn't save the x/y/z, only body bones". Enforced by the shape rather
     * than by discipline — where she stands belongs to the walker, and a pose
     * carrying a root translation would fight the seat, the support plane and
     * the gait at once.
     */
    const read = parsePose({
      name: 'Climb', rotations: {}, position: [1, 2, 3], root: [4, 5, 6],
    }, QUEEN_RIG);
    expect(Object.keys(read!.pose)).toEqual(['name', 'rotations']);
  });
});

describe('blending a pose into a live frame', () => {
  const bone = QUEEN_RIG.gaster[0]!;
  const turned: PoseQuat = [0, 0.3826834, 0, 0.9238795]; // 45 deg about Y
  const pose = { name: 'Tail', rotations: { [bone]: turned } };

  it('leaves her exactly alone at nought', () => {
    const live = new Map<string, PoseQuat>([[bone, IDENTITY]]);
    blendInto(live, pose, 0);
    expect(live.get(bone)).toEqual(IDENTITY);
  });

  it('is the pose at one', () => {
    const live = new Map<string, PoseQuat>([[bone, IDENTITY]]);
    blendInto(live, pose, 1);
    const q = live.get(bone)!;
    for (let i = 0; i < 4; i += 1) expect(q[i]).toBeCloseTo(turned[i]!, 6);
  });

  it('lands between at a half, and stays a unit quaternion', () => {
    const live = new Map<string, PoseQuat>([[bone, IDENTITY]]);
    blendInto(live, pose, 0.5);
    const q = live.get(bone)!;
    expect(Math.hypot(q[0], q[1], q[2], q[3])).toBeCloseTo(1, 9);
    /* Strictly between the two, on the short way round. */
    expect(q[1]).toBeGreaterThan(0);
    expect(q[1]).toBeLessThan(turned[1]!);
  });

  it('takes the SHORT way round when the two are written oppositely', () => {
    /*
     * q and -q are the same rotation. Mixing toward the far one drags the
     * limb the long way — seen as an antenna whipping through her head to
     * reach a pose it was already beside.
     */
    const live = new Map<string, PoseQuat>([[bone, IDENTITY]]);
    const flipped = {
      name: 'Tail',
      rotations: { [bone]: turned.map((v) => -v) as unknown as PoseQuat },
    };
    blendInto(live, flipped, 0.5);
    const q = live.get(bone)!;
    /* It must land where the honestly-signed pose landed — same rotation,
     * written the other way round, so the result cannot differ. */
    const honest = new Map<string, PoseQuat>([[bone, IDENTITY]]);
    blendInto(honest, pose, 0.5);
    const h = honest.get(bone)!;
    for (let i = 0; i < 4; i += 1) expect(q[i]).toBeCloseTo(h[i]!, 9);
    expect(q[1]).toBeGreaterThan(0);
    expect(Math.hypot(q[0], q[1], q[2], q[3])).toBeCloseTo(1, 9);
  });

  it('never touches a bone it does not mention', () => {
    /* A pose that bends her tail must not flatten her legs — this is what
     * makes a pose compose with the gait instead of replacing it. */
    const leg = QUEEN_RIG.legs[0]!.bones[0]!;
    const walking: PoseQuat = [0.1, 0, 0, 0.99498];
    const live = new Map<string, PoseQuat>([[bone, IDENTITY], [leg, walking]]);
    blendInto(live, pose, 1);
    expect(live.get(leg)).toEqual(walking);
  });

  it('starts from rest for a bone the frame has not written', () => {
    const live = new Map<string, PoseQuat>();
    blendInto(live, pose, 1);
    const q = live.get(bone)!;
    for (let i = 0; i < 4; i += 1) expect(q[i]).toBeCloseTo(turned[i]!, 6);
  });

  it('an empty pose is a no-op at any weight', () => {
    const live = new Map<string, PoseQuat>([[bone, IDENTITY]]);
    blendInto(live, emptyPose('nothing'), 1);
    expect(live.get(bone)).toEqual(IDENTITY);
  });

  it('names every bone it stores as one the rig owns', () => {
    const known = poseBones(QUEEN_RIG);
    expect(known.has(bone)).toBe(true);
    expect(known.has('Bone_997')).toBe(false);
  });
});
