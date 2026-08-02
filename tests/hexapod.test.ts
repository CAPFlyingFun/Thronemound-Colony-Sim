import { describe, expect, it } from 'vitest';
import {
  CADENCE, CASTE_LENGTH_MM, MAJOR_RIG, MODEL_LENGTH_UNITS, QUEEN_LENGTH_MM,
  QUEEN_RIG, RIGS, VOXEL_MM, WORKER_RIG,
  cadenceFor, gaitPose, legPhase, legSwing, queenScale, rigBones,
  rigLengthVoxels, rigScale, tripodOf,
  type LegSlot, type RigMap,
} from '../src/anim/hexapod';

const ALL_RIGS: RigMap[] = [QUEEN_RIG, WORKER_RIG, MAJOR_RIG];
/** Joint counts read straight off the three GLBs. */
const JOINTS: Record<RigMap['caste'], number> = { queen: 53, worker: 61, major: 64 };

const SLOTS: LegSlot[] = [
  'frontLeft', 'frontRight', 'midLeft', 'midRight', 'rearLeft', 'rearRight',
];

describe('every rig map', () => {
  it('accounts for every joint in its own file, exactly once', () => {
    /*
     * Each map is hand-derived from that model's inverse bind matrices, because
     * every auto-rig names its bones `Bone_000` upward with no meaning. A bone
     * listed twice would have two parts of the gait fighting over it — the
     * symptom is a limb that twitches rather than an error — and a bone missed
     * is a limb that never moves.
     */
    for (const rig of ALL_RIGS) {
      const all = rigBones(rig);
      expect(new Set(all).size, `${rig.caste} has a duplicate bone`).toBe(all.length);
      expect(all.length, `${rig.caste} joint count`).toBe(JOINTS[rig.caste]);
    }
  });

  it('shares nothing between rigs, because auto-rigs share nothing', () => {
    // The queen's middle-left leg is Bone_012; the worker's is Bone_014. Any
    // temptation to reuse one map for another model is a bug waiting to happen.
    const queenMid = QUEEN_RIG.legs.find((l) => l.slot === 'midLeft')!.bones[0];
    const workerMid = WORKER_RIG.legs.find((l) => l.slot === 'midLeft')!.bones[0];
    expect(queenMid).not.toBe(workerMid);
  });

  it('gives six legs with matching sides to all three', () => {
    for (const rig of ALL_RIGS) {
      expect(rig.legs, `${rig.caste} leg count`).toHaveLength(6);
      expect(rig.legs.map((l) => l.slot).sort()).toEqual([...SLOTS].sort());
      for (const leg of rig.legs) {
        expect(leg.side).toBe(leg.slot.endsWith('Left') ? -1 : 1);
        expect(leg.bones.length, `${rig.caste} ${leg.slot}`).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('gives the workers jaws and the queen none', () => {
    /*
     * The whole reason mandibles are OPTIONAL. Assuming every ant has them
     * would have broken the moment the second model arrived; assuming none do
     * would waste the jaws the workers actually came with.
     */
    expect(QUEEN_RIG.mandibleLeft).toBeUndefined();
    expect(QUEEN_RIG.mandibleRight).toBeUndefined();
    for (const rig of [WORKER_RIG, MAJOR_RIG]) {
      expect(rig.mandibleLeft, `${rig.caste} left jaw`).toBeDefined();
      expect(rig.mandibleRight, `${rig.caste} right jaw`).toBeDefined();
      expect(rig.mandibleLeft!.length).toBe(rig.mandibleRight!.length);
    }
  });

  it('is reachable by caste, and every caste has a rig', () => {
    for (const caste of ['queen', 'worker', 'major'] as const) {
      expect(RIGS[caste].caste).toBe(caste);
      expect(CASTE_LENGTH_MM[caste]).toBeGreaterThan(0);
    }
  });
});

describe('queen rig map', () => {
  it('names every bone exactly once', () => {
    /*
     * The map is hand-derived from the model's inverse bind matrices, because
     * the auto-rigger named everything `Bone_000` upward. A bone listed twice
     * would have two parts of the gait fighting over it, and the symptom is a
     * limb that twitches rather than an error.
     */
    const all = [
      ...QUEEN_RIG.body, ...QUEEN_RIG.thorax, ...QUEEN_RIG.mouth,
      ...QUEEN_RIG.antennaLeft, ...QUEEN_RIG.antennaRight, ...QUEEN_RIG.gaster,
      ...QUEEN_RIG.legs.flatMap((l) => l.bones),
    ];
    expect(new Set(all).size).toBe(all.length);
    // Every joint in the skin is accounted for: 53 in the model.
    expect(all).toHaveLength(53);
  });

  it('has six legs, one per slot, with sides that match', () => {
    expect(QUEEN_RIG.legs).toHaveLength(6);
    expect(QUEEN_RIG.legs.map((l) => l.slot).sort()).toEqual([...SLOTS].sort());
    for (const leg of QUEEN_RIG.legs) {
      expect(leg.side).toBe(leg.slot.endsWith('Left') ? -1 : 1);
      // Enough joints to bend at all: coxa, knee, ankle and a foot.
      expect(leg.bones.length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('alternating tripod', () => {
  it('splits the legs into two tripods of three', () => {
    const counts = [0, 0];
    for (const slot of SLOTS) counts[tripodOf(slot)]!++;
    expect(counts).toEqual([3, 3]);
  });

  it('puts the diagonal legs together, as an insect does', () => {
    // Front-left, middle-right, rear-left swing as one. Grouping a whole side
    // together instead would read as a horse's pace, not a beetle.
    expect(tripodOf('frontLeft')).toBe(tripodOf('midRight'));
    expect(tripodOf('frontLeft')).toBe(tripodOf('rearLeft'));
    expect(tripodOf('frontLeft')).not.toBe(tripodOf('frontRight'));
    expect(tripodOf('midLeft')).not.toBe(tripodOf('midRight'));
  });

  it('never lifts both tripods at once, so three feet are always down', () => {
    /*
     * The property that makes a balance solver unnecessary: the supporting
     * triangle always contains the body. If both tripods were ever airborne
     * together she would visibly hop.
     */
    for (let cycle = 0; cycle < 2; cycle += 0.01) {
      const airborne = SLOTS.filter((slot) => legSwing(legPhase(slot, cycle)).lift > 0);
      expect(airborne.length).toBeLessThanOrEqual(3);
      // And the ones in the air are all from the same tripod.
      if (airborne.length > 0) {
        const tripods = new Set(airborne.map(tripodOf));
        expect(tripods.size).toBe(1);
      }
    }
  });

  it('keeps the two tripods exactly half a cycle apart', () => {
    for (let cycle = 0; cycle < 1; cycle += 0.05) {
      const a = legPhase('frontLeft', cycle);
      const b = legPhase('frontRight', cycle);
      const gap = Math.abs(a - b);
      expect(Math.min(gap, 1 - gap)).toBeCloseTo(0.5, 6);
    }
  });
});

describe('leg swing', () => {
  it('lifts the foot only while swinging forward, never while driving back', () => {
    // Stance has to be flat on the ground or the foot skates.
    for (let p = 0; p < 0.5; p += 0.02) expect(legSwing(p).lift).toBeGreaterThanOrEqual(0);
    for (let p = 0.5; p < 1; p += 0.02) expect(legSwing(p).lift).toBe(0);
  });

  it('plants and lifts off at the ground, with no step in between', () => {
    // The swing must start and end where the stance does, or the foot jumps
    // between phases — the classic procedural-walk pop.
    expect(legSwing(0).reach).toBeCloseTo(-1, 6);
    expect(legSwing(0).lift).toBeCloseTo(0, 6);
    expect(legSwing(0.4999).reach).toBeCloseTo(1, 2);
    expect(legSwing(0.9999).reach).toBeCloseTo(-1, 2);
  });

  it('sweeps the whole stride, forward and back', () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let p = 0; p < 1; p += 0.01) {
      const r = legSwing(p).reach;
      lo = Math.min(lo, r);
      hi = Math.max(hi, r);
    }
    expect(lo).toBeCloseTo(-1, 1);
    expect(hi).toBeCloseTo(1, 1);
  });
});

describe('cadence', () => {
  it('rises with speed, because an ant steps faster rather than further', () => {
    expect(cadenceFor(2)).toBeCloseTo(2 * CADENCE, 6);
    expect(cadenceFor(4)).toBeGreaterThan(cadenceFor(2));
  });

  it('stops dead when she does, because a slow walk is not a rest', () => {
    /*
     * This assertion used to say the opposite: cadence had a floor so a
     * standing ant kept shuffling and did not read as a prop. On device that
     * looked like dancing, and the reason is that it WAS the walking gait,
     * merely slowed down — six legs cycling through a stride they were not
     * taking. Idle now has its own motion instead; see the tests below.
     */
    expect(cadenceFor(0)).toBe(0);
  });

  it('does not run backwards when she does', () => {
    expect(cadenceFor(-3)).toBe(cadenceFor(3));
  });
});

describe('idle is its own animation, not the walk slowed down', () => {
  /** Widest a coxa swings, over a stretch of clock, at a given speed. */
  const coxaSwing = (speed: number, cycle: number): number => {
    let worst = 0;
    for (const leg of QUEEN_RIG.legs) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let clock = 0; clock < 12; clock += 0.02) {
        const pose = gaitPose(
          { clock, cycle, speed, turn: 0, digging: 0, carrying: 0 }, QUEEN_RIG,
        );
        const a = pose.rotations.get(leg.bones[0]!)![0];
        lo = Math.min(lo, a);
        hi = Math.max(hi, a);
      }
      worst = Math.max(worst, hi - lo);
    }
    return worst;
  };

  it('cuts the standing leg motion by at least 80%', () => {
    /*
     * The old idle held the walk swing at 12% of full — 0.12 × REACH_ANGLE,
     * 0.0504 rad of coxa — and ran it on a cycle that never stopped. What was
     * asked for was a fifth of that. Assert against the old number so this
     * cannot quietly drift back up.
     */
    const OLD_IDLE_PEAK_TO_PEAK = 2 * 0.12 * 0.42;
    const idle = coxaSwing(0, 0);
    expect(idle).toBeGreaterThan(0);
    expect(idle).toBeLessThanOrEqual(OLD_IDLE_PEAK_TO_PEAK * 0.2);
  });

  it('does not move a standing leg when only the gait cycle turns', () => {
    /*
     * The decisive one. Sweep the CYCLE with the clock held still: at rest
     * the legs must not care, because the walk cycle is not what is animating
     * them any more. Under the old code every one of these was a new pose.
     */
    const at = (cycle: number) => QUEEN_RIG.legs.map((leg) => gaitPose(
      { clock: 4, cycle, speed: 0, turn: 0, digging: 0, carrying: 0 }, QUEEN_RIG,
    ).rotations.get(leg.bones[0]!)![0]);
    const first = at(0);
    for (const cycle of [0.17, 0.33, 0.5, 0.71, 0.9]) {
      at(cycle).forEach((a, i) => expect(a).toBeCloseTo(first[i]!, 10));
    }
  });

  it('staggers the six legs so the rest never looks like a gait', () => {
    // Two legs of the SAME tripod must not share a phase, or the idle sway
    // reads as the tripod pattern at low amplitude — the thing being removed.
    const pose = gaitPose(
      { clock: 1.3, cycle: 0, speed: 0, turn: 0, digging: 0, carrying: 0 }, QUEEN_RIG,
    );
    const sameTripod = QUEEN_RIG.legs.filter((l) => tripodOf(l.slot) === 0);
    const angles = sameTripod.map((l) => pose.rotations.get(l.bones[0]!)![0]);
    for (let i = 1; i < angles.length; i += 1) {
      expect(Math.abs(angles[i]! - angles[0]!)).toBeGreaterThan(1e-4);
    }
  });

  it('leaves the antennae as the busiest thing on a resting ant', () => {
    /*
     * Not an amplitude claim — the antenna sweep is deliberately unchanged,
     * see the comment on it in `gaitPose`. This is the RATIO that matters
     * now the legs have gone quiet: at rest a feeler must out-move a leg, or
     * the animal reads as switched off rather than waiting.
     */
    const spread = (bone: string): number => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let clock = 0; clock < 12; clock += 0.02) {
        const a = gaitPose(
          { clock, cycle: 0, speed: 0, turn: 0, digging: 0, carrying: 0 }, QUEEN_RIG,
        ).rotations.get(bone)![1];
        lo = Math.min(lo, a);
        hi = Math.max(hi, a);
      }
      return hi - lo;
    };
    const antenna = spread(QUEEN_RIG.antennaLeft[0]!);
    for (const leg of QUEEN_RIG.legs) {
      expect(antenna).toBeGreaterThan(coxaSwing(0, 0));
      expect(leg.bones[0]).toBeTruthy();
    }
  });
});

describe('gait pose', () => {
  const base = { clock: 0, speed: 0, turn: 0, digging: 0, carrying: 0 };

  it('drives every rig without touching a bone it does not own', () => {
    /*
     * Run all three through the gait. Anything it does not mention keeps its
     * rest pose, which is what leaves the queen's unrigged mouthparts alone —
     * and a bone from ANOTHER caste's map appearing here would mean the gait
     * had a hard-coded name left in it.
     */
    for (const rig of ALL_RIGS) {
      const known = new Set(rigBones(rig));
      for (let clock = 0; clock < 3; clock += 0.25) {
        const pose = gaitPose(
          { clock, speed: 2, turn: 0.3, digging: 0.7, carrying: 0.4 },
          rig,
        );
        for (const bone of pose.rotations.keys()) {
          expect(known.has(bone), `${rig.caste} touched a foreign bone ${bone}`).toBe(true);
        }
      }
    }
  });

  it('works the jaws when they exist and the head when they do not', () => {
    for (const rig of [WORKER_RIG, MAJOR_RIG]) {
      let widest = 0;
      for (let clock = 0; clock < 2; clock += 0.01) {
        const pose = gaitPose({ ...base, clock, digging: 1 }, rig);
        const left = pose.rotations.get(rig.mandibleLeft![0]!)!;
        const right = pose.rotations.get(rig.mandibleRight![0]!)!;
        // Jaws work in OPPOSITION: same angle, opposite sign. Driving both the
        // same way swings the pair sideways like wipers.
        expect(left[1]).toBeCloseTo(-right[1], 6);
        widest = Math.max(widest, Math.abs(left[1]));
      }
      expect(widest, `${rig.caste} jaws never opened`).toBeGreaterThan(0.2);
    }
    // The jawless queen digs harder with her head to compensate.
    const head = (rig: RigMap) => gaitPose({ ...base, digging: 1 }, rig)
      .rotations.get(rig.thorax[rig.thorax.length - 1]!)![0];
    expect(head(QUEEN_RIG)).toBeGreaterThan(head(WORKER_RIG));
  });

  it('holds the jaws shut on a carried load rather than chewing it', () => {
    /*
     * Asserted as OPPOSITE SIGNS rather than a fixed direction, because which
     * way is "closed" depends on the rig's own axis convention — pinning a sign
     * here tests my guess about the model, not the behaviour. What matters is
     * that gripping a load and biting at a face are opposite motions, and that
     * a held load does not chew.
     */
    const jaw = WORKER_RIG.mandibleLeft![0]!;
    const carry = gaitPose({ ...base, carrying: 1 }, WORKER_RIG).rotations.get(jaw)![1];
    let widestBite = 0;
    for (let clock = 0; clock < 2; clock += 0.01) {
      const open = gaitPose({ ...base, clock, digging: 1 }, WORKER_RIG).rotations.get(jaw)![1];
      if (Math.abs(open) > Math.abs(widestBite)) widestBite = open;
    }
    expect(Math.sign(carry)).toBe(-Math.sign(widestBite));

    // And a carried load is HELD: the angle does not vary with the clock.
    const later = gaitPose({ ...base, clock: 1.3, carrying: 1 }, WORKER_RIG)
      .rotations.get(jaw)![1];
    expect(later).toBeCloseTo(carry, 6);
  });

  it('is deterministic — same input, same pose', () => {
    const a = gaitPose({ ...base, clock: 1.7, speed: 2 });
    const b = gaitPose({ ...base, clock: 1.7, speed: 2 });
    for (const [bone, rot] of a.rotations) expect(b.rotations.get(bone)).toEqual(rot);
  });

  it('only ever touches bones that are in the rig map', () => {
    // Anything it does not mention keeps its rest pose, which is what leaves
    // the unrigged mandibles and the rest of the head alone.
    const known = new Set([
      ...QUEEN_RIG.body, ...QUEEN_RIG.thorax, ...QUEEN_RIG.mouth,
      ...QUEEN_RIG.antennaLeft, ...QUEEN_RIG.antennaRight, ...QUEEN_RIG.gaster,
      ...QUEEN_RIG.legs.flatMap((l) => l.bones),
    ]);
    for (let clock = 0; clock < 3; clock += 0.25) {
      const pose = gaitPose({ ...base, clock, speed: 2, digging: 0.5, carrying: 1 });
      for (const bone of pose.rotations.keys()) expect(known.has(bone)).toBe(true);
    }
  });

  it('bobs and rolls only when she is moving', () => {
    const still = gaitPose({ ...base, clock: 0.4 });
    expect(still.lift).toBeCloseTo(0, 6);
    let moved = 0;
    for (let clock = 0; clock < 2; clock += 0.05) {
      moved = Math.max(moved, gaitPose({ ...base, clock, speed: 3 }).lift);
    }
    expect(moved).toBeGreaterThan(0.01);
  });

  it('leans into a turn, and the other way for the other way', () => {
    const left = gaitPose({ ...base, turn: -1 }).roll;
    const right = gaitPose({ ...base, turn: 1 }).roll;
    expect(Math.sign(left)).toBe(-Math.sign(right));
    expect(Math.abs(left)).toBeGreaterThan(0.05);
  });

  it('keeps the antennae moving even standing still and idle', () => {
    const seen = new Set<string>();
    for (let clock = 0; clock < 4; clock += 0.1) {
      const pose = gaitPose({ ...base, clock });
      const l = pose.rotations.get(QUEEN_RIG.antennaLeft[0]!)!;
      seen.add(l.map((v) => v.toFixed(3)).join(','));
    }
    // Many distinct poses, not one repeated: she is never a photograph.
    expect(seen.size).toBeGreaterThan(20);
  });

  it('sweeps the antennae out of phase with each other', () => {
    // Two antennae moving in lockstep read as a mechanism, not an animal.
    let differed = 0;
    for (let clock = 0; clock < 4; clock += 0.1) {
      const pose = gaitPose({ ...base, clock });
      const l = pose.rotations.get(QUEEN_RIG.antennaLeft[0]!)!;
      const r = pose.rotations.get(QUEEN_RIG.antennaRight[0]!)!;
      if (Math.abs(l[1] - r[1]) > 0.02) differed++;
    }
    expect(differed).toBeGreaterThan(30);
  });

  it('dips the head to dig and lifts it to carry', () => {
    const head = QUEEN_RIG.thorax[QUEEN_RIG.thorax.length - 1]!;
    const dig = gaitPose({ ...base, digging: 1 }).rotations.get(head)!;
    const haul = gaitPose({ ...base, carrying: 1 }).rotations.get(head)!;
    expect(dig[0]).toBeGreaterThan(0.2);
    expect(haul[0]).toBeLessThan(0);
  });

  it('stops walking the front legs while she digs with them', () => {
    /*
     * She cannot scrape at the face and stride with the same legs. At full
     * digging the front pair leave the gait entirely, and the middle and rear
     * legs go on holding her up.
     */
    const front = QUEEN_RIG.legs.find((l) => l.slot === 'frontLeft')!;
    const rear = QUEEN_RIG.legs.find((l) => l.slot === 'rearLeft')!;
    let frontLift = 0;
    let rearLift = 0;
    for (let clock = 0; clock < 2; clock += 0.02) {
      const pose = gaitPose({ ...base, clock, speed: 3, digging: 1 });
      frontLift = Math.max(frontLift, Math.abs(pose.rotations.get(front.bones[2]!)![0]));
      rearLift = Math.max(rearLift, Math.abs(pose.rotations.get(rear.bones[2]!)![0]));
    }
    expect(frontLift).toBeCloseTo(0, 6);
    expect(rearLift).toBeGreaterThan(0.1);
  });
});

describe('caste scale', () => {
  it('scales each model from its OWN length, not a shared constant', () => {
    /*
     * The trap this closes. All three exports are height-normalised to 1.7, so
     * a major measures FEWER units than a worker while being the larger animal.
     * A shared scale would have made every ant the same size and hidden it
     * behind numbers that looked plausible.
     */
    expect(MAJOR_RIG.lengthUnits).toBeLessThan(WORKER_RIG.lengthUnits);
    expect(CASTE_LENGTH_MM.major).toBeGreaterThan(CASTE_LENGTH_MM.worker);
    for (const rig of ALL_RIGS) {
      expect(rigScale(rig) * rig.lengthUnits).toBeCloseTo(rigLengthVoxels(rig), 6);
    }
  });

  it('orders the castes the way real fire ants are ordered', () => {
    // Workers are polymorphic 3-6mm, majors at the top of that, a mated queen
    // about 9. If these ever stop being ordered, something is wrong.
    expect(CASTE_LENGTH_MM.worker).toBeLessThan(CASTE_LENGTH_MM.major);
    expect(CASTE_LENGTH_MM.major).toBeLessThan(CASTE_LENGTH_MM.queen);
  });

  it('keeps every caste under two voxels, so passages stay diggable', () => {
    for (const rig of ALL_RIGS) {
      expect(rigLengthVoxels(rig), `${rig.caste}`).toBeLessThan(2);
      expect(rigLengthVoxels(rig), `${rig.caste}`).toBeGreaterThan(0.5);
    }
  });
});

describe('queen scale', () => {
  it('sizes her from millimetres, not to taste', () => {
    // 9 mm at 5 mm a voxel is 1.8 cubes long — which is exactly why a one-cube
    // tunnel will not take her and she has to widen her own galleries.
    expect(QUEEN_LENGTH_MM / VOXEL_MM).toBeCloseTo(1.8, 6);
    expect(queenScale() * MODEL_LENGTH_UNITS).toBeCloseTo(1.8, 6);
  });

  it('stays under two voxels, so widening is a choice and not a wall', () => {
    expect(queenScale() * MODEL_LENGTH_UNITS).toBeLessThan(2);
    expect(queenScale() * MODEL_LENGTH_UNITS).toBeGreaterThan(1);
  });
});
