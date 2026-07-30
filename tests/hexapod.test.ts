import { describe, expect, it } from 'vitest';
import {
  CADENCE, MODEL_LENGTH_UNITS, QUEEN_LENGTH_MM, QUEEN_RIG, VOXEL_MM,
  cadenceFor, gaitPose, legPhase, legSwing, queenScale, tripodOf,
  type LegSlot,
} from '../src/anim/hexapod';

const SLOTS: LegSlot[] = [
  'frontLeft', 'frontRight', 'midLeft', 'midRight', 'rearLeft', 'rearRight',
];

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

  it('still shuffles when she is standing still', () => {
    // Zero cadence freezes the pose, and a frozen ant reads as a prop.
    expect(cadenceFor(0)).toBeGreaterThan(0);
  });

  it('does not run backwards when she does', () => {
    expect(cadenceFor(-3)).toBe(cadenceFor(3));
  });
});

describe('gait pose', () => {
  const base = { clock: 0, speed: 0, turn: 0, digging: 0, carrying: 0 };

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
