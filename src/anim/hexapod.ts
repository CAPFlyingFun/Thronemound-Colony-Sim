/**
 * Procedural walking for a six-legged rig.
 *
 * The queen's model arrives from an auto-rigger with no animation clips at all
 * and 53 bones named `Bone_000` through `Bone_052`, so there is nothing to play
 * and nothing to look up by name. Both facts point the same way: drive the
 * skeleton from code.
 *
 * That turns out to be the better answer for this game anyway. A baked walk
 * cycle plays at one speed and in one direction, and this ant walks on floors,
 * walls and ceilings — the six-axis surface frames mean "down" is whatever her
 * frame says it is, and a clip has no idea. A gait computed from her actual
 * speed keeps its feet under her at any pace, on any surface, and slows to a
 * stop instead of sliding.
 *
 * PURE on purpose. No three.js: this returns plain rotation triples, so the
 * gait can be unit tested headlessly and the scene is left to apply them.
 */

/** Which of the six legs, front to back. */
export type LegSlot =
  | 'frontLeft' | 'frontRight'
  | 'midLeft' | 'midRight'
  | 'rearLeft' | 'rearRight';

export interface LegChain {
  slot: LegSlot;
  /** Bone names root-first: coxa through to the foot. */
  bones: string[];
  /** -1 for her left, +1 for her right. */
  side: -1 | 1;
}

export interface RigMap {
  /** Which ant this is, for messages and for picking a model. */
  caste: 'queen' | 'worker' | 'major';
  /** Body root, then thorax toward the head. */
  body: string[];
  thorax: string[];
  /** Head chain, ending at the mouthparts. */
  mouth: string[];
  /**
   * Jaws, when the rigger gave us any.
   *
   * OPTIONAL, and that is the whole point. The workers and the major have
   * three- and two-bone mandible chains; the queen's auto-rig left hers out.
   * The gait has to scrape with real jaws when they exist and fall back to a
   * head dip when they do not, rather than assuming every ant is built the
   * same — which is exactly the assumption that would have broken the moment
   * the second model arrived.
   */
  mandibleLeft?: string[];
  mandibleRight?: string[];
  antennaLeft: string[];
  antennaRight: string[];
  gaster: string[];
  legs: LegChain[];
  /**
   * How long this model measures along Z in its OWN units.
   *
   * Every export is height-normalised to 1.7 — all three arrived that way — so
   * in-model size says nothing about real size. A major is smaller in units
   * than a worker while being larger in life. Each model is therefore scaled
   * from its own measured length to its caste's true millimetres.
   */
  lengthUnits: number;
}

/**
 * The queen's rig, read off the model rather than guessed.
 *
 * Derived from the inverse bind matrices: every foot tip rests at y ~= 0.01 so
 * the origin is already on the ground, the head runs toward +Z so that is her
 * forward, and each leg's tip Z sorts it into front (+2.2), middle (0) or rear
 * (-2.2) while the sign of its X gives the side. Recorded here as a table
 * because the names carry no meaning — if the model is ever re-rigged, this is
 * the one thing that has to be re-derived.
 */
export const QUEEN_RIG: RigMap = {
  caste: 'queen',
  lengthUnits: 4.49,
  body: ['Bone_000', 'Bone_001'],
  thorax: ['Bone_004', 'Bone_003', 'Bone_002'],
  mouth: ['Bone_046', 'Bone_045'],
  // No mandibles: the auto-rigger left hers out, so digging is carried by the
  // head and antennae instead.
  antennaLeft: ['Bone_049', 'Bone_048', 'Bone_047'],
  antennaRight: ['Bone_052', 'Bone_051', 'Bone_050'],
  gaster: ['Bone_006', 'Bone_005'],
  legs: [
    { slot: 'frontLeft', side: -1, bones: ['Bone_024', 'Bone_023', 'Bone_022', 'Bone_021', 'Bone_020', 'Bone_019'] },
    { slot: 'frontRight', side: 1, bones: ['Bone_030', 'Bone_029', 'Bone_028', 'Bone_027', 'Bone_026', 'Bone_025'] },
    { slot: 'midLeft', side: -1, bones: ['Bone_012', 'Bone_011', 'Bone_010', 'Bone_009', 'Bone_008', 'Bone_007'] },
    { slot: 'midRight', side: 1, bones: ['Bone_018', 'Bone_017', 'Bone_016', 'Bone_015', 'Bone_014', 'Bone_013'] },
    { slot: 'rearLeft', side: -1, bones: ['Bone_037', 'Bone_036', 'Bone_035', 'Bone_034', 'Bone_033', 'Bone_032', 'Bone_031'] },
    { slot: 'rearRight', side: 1, bones: ['Bone_044', 'Bone_043', 'Bone_042', 'Bone_041', 'Bone_040', 'Bone_039', 'Bone_038'] },
  ],
};

/**
 * Worker — 61 joints, and the first with jaws.
 *
 * Note the leg numbering bears no relation to the queen's: her middle-left is
 * Bone_012, his is Bone_014. Nothing about one auto-rig transfers to another,
 * which is why each of these is derived from its own file rather than adapted
 * from the last.
 */
export const WORKER_RIG: RigMap = {
  caste: 'worker',
  lengthUnits: 4.83,
  body: ['Bone_000', 'Bone_001'],
  thorax: ['Bone_004', 'Bone_003', 'Bone_002'],
  mouth: ['Bone_046', 'Bone_045'],
  mandibleLeft: ['Bone_057', 'Bone_056', 'Bone_055'],
  mandibleRight: ['Bone_060', 'Bone_059', 'Bone_058'],
  antennaLeft: ['Bone_050', 'Bone_049', 'Bone_048', 'Bone_047'],
  antennaRight: ['Bone_054', 'Bone_053', 'Bone_052', 'Bone_051'],
  gaster: ['Bone_008', 'Bone_007', 'Bone_006', 'Bone_005'],
  legs: [
    { slot: 'frontLeft', side: -1, bones: ['Bone_032', 'Bone_031', 'Bone_030', 'Bone_029', 'Bone_028', 'Bone_027'] },
    { slot: 'frontRight', side: 1, bones: ['Bone_026', 'Bone_025', 'Bone_024', 'Bone_023', 'Bone_022', 'Bone_021'] },
    { slot: 'midLeft', side: -1, bones: ['Bone_014', 'Bone_013', 'Bone_012', 'Bone_011', 'Bone_010', 'Bone_009'] },
    { slot: 'midRight', side: 1, bones: ['Bone_020', 'Bone_019', 'Bone_018', 'Bone_017', 'Bone_016', 'Bone_015'] },
    { slot: 'rearLeft', side: -1, bones: ['Bone_044', 'Bone_043', 'Bone_042', 'Bone_041', 'Bone_040', 'Bone_039'] },
    { slot: 'rearRight', side: 1, bones: ['Bone_038', 'Bone_037', 'Bone_036', 'Bone_035', 'Bone_034', 'Bone_033'] },
  ],
};

/**
 * Major — 64 joints, two-bone jaws, and a deeper spine.
 *
 * Its front legs hang off the HEAD chain rather than the body, which is an
 * auto-rig quirk and harmless here: this only ever sets rotations, so where a
 * chain is parented changes nothing about how it bends.
 */
export const MAJOR_RIG: RigMap = {
  caste: 'major',
  lengthUnits: 3.59,
  body: ['Bone_000', 'Bone_001', 'Bone_003'],
  thorax: ['Bone_002', 'Bone_024', 'Bone_023'],
  mouth: ['Bone_039', 'Bone_038', 'Bone_037'],
  mandibleLeft: ['Bone_053', 'Bone_052'],
  mandibleRight: ['Bone_055', 'Bone_054'],
  antennaLeft: ['Bone_059', 'Bone_058', 'Bone_057', 'Bone_056'],
  antennaRight: ['Bone_063', 'Bone_062', 'Bone_061', 'Bone_060'],
  gaster: ['Bone_008', 'Bone_007', 'Bone_006', 'Bone_005', 'Bone_004'],
  legs: [
    { slot: 'frontLeft', side: -1, bones: ['Bone_045', 'Bone_044', 'Bone_043', 'Bone_042', 'Bone_041', 'Bone_040'] },
    { slot: 'frontRight', side: 1, bones: ['Bone_051', 'Bone_050', 'Bone_049', 'Bone_048', 'Bone_047', 'Bone_046'] },
    { slot: 'midLeft', side: -1, bones: ['Bone_036', 'Bone_035', 'Bone_034', 'Bone_033', 'Bone_032', 'Bone_031'] },
    { slot: 'midRight', side: 1, bones: ['Bone_030', 'Bone_029', 'Bone_028', 'Bone_027', 'Bone_026', 'Bone_025'] },
    { slot: 'rearLeft', side: -1, bones: ['Bone_022', 'Bone_021', 'Bone_020', 'Bone_019', 'Bone_018', 'Bone_017', 'Bone_016'] },
    { slot: 'rearRight', side: 1, bones: ['Bone_015', 'Bone_014', 'Bone_013', 'Bone_012', 'Bone_011', 'Bone_010', 'Bone_009'] },
  ],
};

export const RIGS: Record<RigMap['caste'], RigMap> = {
  queen: QUEEN_RIG,
  worker: WORKER_RIG,
  major: MAJOR_RIG,
};

/** Every bone a rig map names, for validation and for resting untouched bones. */
export function rigBones(rig: RigMap): string[] {
  return [
    ...rig.body, ...rig.thorax, ...rig.mouth,
    ...(rig.mandibleLeft ?? []), ...(rig.mandibleRight ?? []),
    ...rig.antennaLeft, ...rig.antennaRight, ...rig.gaster,
    ...rig.legs.flatMap((l) => l.bones),
  ];
}

/**
 * Which tripod a leg belongs to.
 *
 * Insects walk an alternating tripod: front-left, middle-right and rear-left
 * swing together while the other three hold the ground, then they swap. Three
 * feet down at all times is what makes it look like an insect and not a horse,
 * and it is the reason this needs no balance solver — the supporting triangle
 * always contains the body.
 */
export function tripodOf(slot: LegSlot): 0 | 1 {
  return slot === 'frontLeft' || slot === 'midRight' || slot === 'rearLeft' ? 0 : 1;
}

/** How far through its own step a leg is, 0..1. */
export function legPhase(slot: LegSlot, cycle: number): number {
  const offset = tripodOf(slot) === 0 ? 0 : 0.5;
  const t = (cycle + offset) % 1;
  return t < 0 ? t + 1 : t;
}

/**
 * Stride length in body units, and the cadence that goes with it.
 *
 * Cadence rises with speed rather than stride, because an ant at a walk and an
 * ant at a run take similarly sized steps — it moves its legs faster. Tying
 * cadence to speed is also what removes foot sliding: the foot is planted for
 * the half of the cycle the body spends travelling one stride.
 */
export const STRIDE = 0.55;
/** Steps per second at one voxel per second. */
export const CADENCE = 1.35;

/**
 * The walk cycle STOPS when she stops. There is no floor under it.
 *
 * There used to be one — a sixth of a step per second, so a standing ant kept
 * shuffling and did not read as a prop. It is the wrong answer to a real
 * question, and it was visible: at rest she ran the walking gait slowly, and
 * the walking gait at a crawl is not an animal resting, it is an animal
 * walking in treacle. Six legs cycling through a stride they are not taking
 * reads as dancing, which is exactly what it was called.
 *
 * A standing ant is not a slow-motion walking ant. Idle gets its OWN motion —
 * a small desynchronised weight shift in `IDLE_SWAY`. See `gaitPose`.
 *
 * Feed this `gaitSpeed`, not a travel speed, or a spin on the spot freezes.
 */
export function cadenceFor(speed: number): number {
  return Math.abs(speed) * CADENCE;
}

/**
 * How far her feet sit from the axis she spins about, as a fraction of her
 * own length — 4.03 mm of mean stance radius on a 9 mm queen, read off the
 * rig by `scripts/probe-stanceradius.mjs` rather than picked. A fraction, so
 * the worker and the major get their own number from their own size.
 */
export const STANCE_FRACTION = 0.448;

export function stanceRadius(rig: RigMap = QUEEN_RIG): number {
  return STANCE_FRACTION * rigLengthVoxels(rig);
}

/**
 * How fast she is LOCOMOTING — travelling and turning together.
 *
 * An ant spinning on the spot covers no ground and is not remotely at rest:
 * her feet are going round at `ω × r`, which at full yaw is 8.9 mm/s against
 * a walk's 8.0. Everything downstream that asks "is she moving" has to ask
 * this rather than the travel speed, or a spin in place animates like a nap.
 *
 * This only started to matter once travel speed became honest. While a
 * standing ant still reported 6.5 mm/s of phantom speed, nothing ever read as
 * stopped, so the distinction could not show.
 */
/** Symmetric clamp, so a neck limit reads as one number rather than two. */
function clampAngle(a: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, a));
}

export function gaitSpeed(speed: number, turn: number, rig: RigMap = QUEEN_RIG): number {
  return Math.abs(speed) + Math.abs(turn) * stanceRadius(rig);
}

export interface GaitPose {
  /** Per-bone Euler rotation offsets from the rest pose, in radians. */
  rotations: Map<string, [number, number, number]>;
  /**
   * Where her head should be AIMED, clamped to a neck's limits — and NOT
   * baked into `rotations`, on purpose.
   *
   * A bone-local Euler cannot express "turn her face toward her own up"
   * without knowing which local axis that is, and on an auto-rig it is none
   * of the obvious ones. Measured on the queen's head, `Bone_002`: thirty
   * degrees about local Y swings her face 2.4 degrees, because Y runs along
   * the neck. Yaw actually lives on Z, inverted, with a 1.26 gain, and X
   * gives pitch with fifteen degrees of yaw mixed into it.
   *
   * Hard-coding that per rig would be a third table to re-derive every time
   * a model is re-exported. So the gait states the INTENT in her own frame
   * and `QueenModel` applies it as a world rotation, where her up and her
   * right are known and no bone axis has to be guessed.
   */
  headYaw: number;
  headPitch: number;
  /** Body bob along her own up axis, in model units. */
  lift: number;
  /** Body roll and pitch, for the sway that comes off the gait. */
  roll: number;
  pitch: number;
}

export interface GaitInput {
  /** Seconds of gait time accumulated. Advanced by the caller, not wall clock. */
  clock: number;
  /**
   * Gait revolutions accumulated — the leg cycle, INTEGRATED by the caller.
   *
   * This has to be integrated rather than derived, and that is the whole of the
   * "feet going super fast, sliding on ice trying to accelerate" report. The
   * cycle used to be computed as `clock * cadenceFor(speed)`: total elapsed
   * time times the CURRENT speed. Stand still for ten seconds and then open the
   * throttle and that expression multiplies the whole accumulated phase by
   * sixteen in a single frame, so her legs rip through a dozen cycles at once
   * while her body is still easing up to speed. Every acceleration did it, and
   * only a constant speed hid it.
   *
   * Optional, with the old expression as the fallback, because at a CONSTANT
   * speed the two agree exactly — `t * c` IS the integral of `c dt` when `c`
   * does not vary. A caller that never accelerates loses nothing by omitting
   * it; a caller with a throttle must supply it.
   */
  cycle?: number;
  /** Planar speed in voxels per second. */
  speed: number;
  /** Turn rate in radians per second; leans her into the turn. */
  turn: number;
  /** 0..1. Digging overrides the front legs and dips the head. */
  digging: number;
  /** 0..1. Carrying a load spreads the mandibles and lifts the head. */
  carrying: number;
  /**
   * Where the player is LOOKING, relative to her body, in radians.
   *
   * `headYaw` is how far the camera has been orbited off her heading, and it
   * applies at all times: with the camera free to swing round her, a body
   * facing north while the view faces south should not have her staring
   * rigidly ahead. She turns her face toward it and her gaster swings the
   * other way — both what a real one does, and the only cue on screen that
   * the camera and the body have parted company.
   *
   * `headPitch` is the look's elevation, and it applies ONLY where the mode
   * asks for it — digging. An ant that noses at the floor every time the
   * camera glances down spends the whole game faceplanting.
   *
   * Both are clamped in here rather than by the caller, because the limit
   * belongs to a neck and not to a camera.
   */
  headYaw?: number;
  headPitch?: number;
}

/** Smooth 0..1 ease, for swings that should not start or stop abruptly. */
function ease(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * A leg's swing, as a pair of angles.
 *
 * `reach` drives the whole chain forward and back; `lift` bends it upward. The
 * split matters: a leg that only rotates about one axis scythes along the
 * ground and reads as a bug dragged on wires, where lifting the foot clear on
 * the swing and planting it on the stance is most of what sells the walk.
 */
export function legSwing(phase: number): { reach: number; lift: number } {
  // First half swings forward through the air, second half drives back on the
  // ground. Stance is the longer, flatter part of the curve.
  if (phase < 0.5) {
    const t = phase / 0.5;
    return { reach: -1 + 2 * ease(t), lift: Math.sin(Math.PI * t) };
  }
  const t = (phase - 0.5) / 0.5;
  return { reach: 1 - 2 * t, lift: 0 };
}

/** How far a leg rotates at full stride, in radians. */
const REACH_ANGLE = 0.42;
const LIFT_ANGLE = 0.5;
const KNEE_ANGLE = 0.34;
/** Body motion. Small — an ant's thorax barely moves; the legs do the work. */
const BOB = 0.045;
const ROLL_ANGLE = 0.035;
const LEAN_PER_TURN = 0.12;
/** Antennae never stop moving, even at rest. That is most of feeling alive. */
const ANTENNA_SWEEP = 0.3;
/** A faster, smaller search that only runs when she is standing still. */
const ANTENNA_FLICK = 0.09;
const GASTER_SWAY = 0.09;
/**
 * What a leg does when she is NOT walking: a slow weight shift, and a small
 * one — a fifth of the old standing shuffle, which is the reduction that was
 * asked for after it read as dancing.
 *
 * The old idle was the walk swing held at 12% of full: `0.12 × REACH_ANGLE`,
 * 0.050 rad, driven by the gait cycle. This is 0.010 rad, driven by the clock
 * at its own slow rate, and phase-shifted per leg by an amount that is NOT
 * the tripod split — so it can never settle into looking like a gait, which
 * is the whole point of it being a separate motion rather than a quiet one.
 */
const IDLE_SWAY = 0.010;
const IDLE_RATE = 1.1;
/** How far a leg's idle shift is offset from its neighbour's, in radians. */
const IDLE_STAGGER = 1.7;
/**
 * How wide the jaws open, and how fast they snip.
 *
 * Faster than the legs cycle on purpose: an ant working a face takes several
 * quick bites per stride, so tying the jaws to the gait would make them look
 * geared to the feet.
 */
/**
 * How far she will turn her face off her body, and how far she will pitch it.
 *
 * A neck, not a turret. Sixty degrees of yaw is generous for an ant and still
 * reads as looking rather than as a broken rig; forty of pitch is enough to
 * put her jaws on the floor and to lift them clear.
 */
const HEAD_YAW_LIMIT = 1.05;
const HEAD_PITCH_LIMIT = 0.7;
/** How much of the head's turn the gaster swings against. Her counterweight. */
export const GASTER_COUNTER = 0.30;
const MANDIBLE_OPEN = 0.55;
const MANDIBLE_RATE = 12;
/** How far they close on a carried load. Held, not chewing. */
const MANDIBLE_CLOSED = -0.25;

/**
 * Build one frame of the gait.
 *
 * Everything is an offset FROM the rest pose, so a bone this does not mention
 * simply stays where the rigger put it — which is what keeps the unrigged
 * mandibles and the rest of the head from being disturbed.
 */
export function gaitPose(input: GaitInput, rig: RigMap = QUEEN_RIG): GaitPose {
  const { clock, speed, turn, digging, carrying } = input;
  /*
   * Clamped here: the caller hands over a raw camera angle and a neck has
   * limits a camera does not. See `GaitInput.headYaw`.
   */
  const headYaw = clampAngle(input.headYaw ?? 0, HEAD_YAW_LIMIT);
  const headPitch = clampAngle(input.headPitch ?? 0, HEAD_PITCH_LIMIT);
  const rotations = new Map<string, [number, number, number]>();
  // Travelling AND turning: a spin on the spot is locomotion. See `gaitSpeed`.
  const travel = gaitSpeed(speed, turn, rig);
  const moving = Math.min(1, travel / 0.6);
  // See `GaitInput.cycle`: the caller's integrated phase when it has one, and
  // the constant-speed equivalent when it does not.
  const cycle = input.cycle ?? clock * cadenceFor(travel);

  for (let i = 0; i < rig.legs.length; i += 1) {
    const leg = rig.legs[i]!;
    const phase = legPhase(leg.slot, cycle);
    const swing = legSwing(phase);
    /*
     * The walk swing is scaled by how much she is WALKING, all the way to
     * nothing. It used to keep a twelfth of itself at rest so she was never a
     * photograph, and that twelfth — running on a cycle that never stopped —
     * is what looked like dancing.
     */
    const amount = moving;
    const front = leg.slot === 'frontLeft' || leg.slot === 'frontRight';
    // Digging: the front pair stop walking and scrape instead.
    const scrape = front ? digging : 0;
    /*
     * And in its place, a resting leg's own motion: slow, tiny, and staggered
     * so the six of them never line up into a gait. It fades out as the walk
     * swing fades in, so only one of the two is ever really speaking.
     */
    const settle = Math.sin(clock * IDLE_RATE + i * IDLE_STAGGER)
      * IDLE_SWAY * (1 - moving) * (1 - scrape);
    const reach = swing.reach * REACH_ANGLE * amount * (1 - scrape)
      + scrape * Math.sin(clock * 9) * 0.5
      + settle;
    const lift = swing.lift * LIFT_ANGLE * amount * (1 - scrape);

    // Coxa carries the fore-and-aft swing, the joints below it the lift, so
    // the foot rises rather than the whole leg pivoting about the body.
    rotations.set(leg.bones[0]!, [reach, 0, 0]);
    const knee = leg.bones[Math.min(2, leg.bones.length - 1)]!;
    rotations.set(knee, [-lift * 1.1, 0, 0]);
    const ankle = leg.bones[Math.min(3, leg.bones.length - 1)]!;
    rotations.set(ankle, [lift * KNEE_ANGLE * 2, 0, 0]);
  }

  /*
   * Body sway is derived from the tripods rather than being its own wave, so
   * it can never drift out of step with the feet. Tripod 0 down means her
   * weight is on the left at the front, so she rolls that way.
   */
  const swayPhase = Math.sin(cycle * Math.PI * 2);
  const roll = swayPhase * ROLL_ANGLE * moving + turn * LEAN_PER_TURN;
  const lift = Math.abs(Math.cos(cycle * Math.PI * 2)) * BOB * moving;
  const pitch = digging * 0.22 - carrying * 0.06;

  rotations.set(rig.body[0]!, [pitch, 0, roll]);
  // The gaster trails the turn and swings against the roll — a heavy abdomen
  // does not track the thorax instantly.
  rotations.set(rig.gaster[0]!, [
    -pitch * 0.5,
    -turn * 0.35,
    -swayPhase * GASTER_SWAY * moving,
  ]);
  // Head dips into the work and looks up when she is hauling.
  /*
   * Head dip. Deeper when there are no jaws to scrape with, because then the
   * head IS the tool — the queen's whole digging read has to come from this
   * and the antennae, where a worker's comes from its mandibles.
   */
  const jawless = !rig.mandibleLeft || !rig.mandibleRight;
  /*
   * The look is added ON TOP of the dig dip rather than replacing it, and
   * that matters: the dip is what brings her jaw from 1.121 mm over the soil
   * down to 0.070 mm, which is the only reason a bite taken at the mandible
   * reaches the ground at a level aim. Swap the dip out for the aim and
   * digging straight ahead stops working again.
   *
   * Sign is measured, not reasoned: a POSITIVE rotation here dips her head,
   * which `scripts/probe-bite.mjs` established by watching the jaw fall as
   * `digging` rose. The player's pitch is negative when looking down, so it
   * enters negated.
   */
  rotations.set(rig.thorax[rig.thorax.length - 1]!, [
    digging * (jawless ? 0.42 : 0.22) - carrying * 0.12,
    0,
    0,
  ]);

  /*
   * Jaws, when this ant has them.
   *
   * Mandibles work in OPPOSITION — they close toward each other and open away,
   * so the two sides get the same angle with the sign flipped. Driving both the
   * same way would swing the pair sideways like a pair of wipers.
   *
   * They bite faster than the legs cycle: an ant working a face makes several
   * quick snips per stride, so this runs off the clock directly rather than off
   * the gait. Carrying holds them shut on the load instead.
   */
  const grip = Math.max(digging, carrying);
  if (grip > 0 && rig.mandibleLeft && rig.mandibleRight) {
    const bite = digging > 0
      ? MANDIBLE_OPEN * (0.5 + 0.5 * Math.sin(clock * MANDIBLE_RATE)) * digging
      : MANDIBLE_CLOSED * carrying;
    for (const [chain, side] of [[rig.mandibleLeft, -1], [rig.mandibleRight, 1]] as const) {
      // The root swings the jaw; anything past it curls a little, so a long
      // three-bone mandible closes rather than pivoting rigidly.
      rotations.set(chain[0]!, [0, side * bite, 0]);
      for (let i = 1; i < chain.length; i++) {
        rotations.set(chain[i]!, [0, side * bite * 0.35, 0]);
      }
    }
  }

  /*
   * Antennae sweep continuously and out of phase with each other. They are the
   * cheapest thing in here and the most valuable: a still ant reads as a prop,
   * and two moving antennae read as an animal even when nothing else moves.
   *
   * They work HARDEST at rest, which is the other half of fixing idle. It was
   * the wrong way round — 0.6 of the sweep standing still, rising to full at
   * a walk. A moving ant has her feelers streamed forward and fairly steady;
   * a stopped one casts them about, because standing still is when she is
   * finding out about things. Now rest is the full sweep plus a second faster
   * wave, and walking is three quarters of it, so when the legs go quiet the
   * antennae are what carries the animal.
   *
   * This was tried once and REVERTED on a measurement saying it made the tips
   * move LESS. The measurement was right and the conclusion was wrong:
   * `moving` was pinned at 1 by 6.5 mm/s of phantom speed, so the antennae
   * were already sweeping at the walking amplitude and an "idle" multiplier
   * of 0.75 could only reduce it. A broken instrument reading a real number.
   * With speed honest, the same change measures 0.62 mm of idle tip travel up
   * to 1.23 — against 0.005 mm for the busiest leg bone.
   */
  const idle = 1 - moving;
  const sweep = ANTENNA_SWEEP * (1 - 0.25 * moving) * (1 + digging);
  const flick = ANTENNA_FLICK * idle * (1 + digging);
  rotations.set(rig.antennaLeft[0]!, [
    Math.sin(clock * 3.1) * sweep * 0.6,
    Math.sin(clock * 2.3) * sweep + Math.sin(clock * 5.9) * flick,
    0,
  ]);
  rotations.set(rig.antennaRight[0]!, [
    Math.sin(clock * 3.1 + 1.9) * sweep * 0.6,
    Math.sin(clock * 2.3 + 2.4) * sweep + Math.sin(clock * 5.9 + 1.2) * flick,
    0,
  ]);

  return { rotations, lift, roll, pitch, headYaw, headPitch };
}

/**
 * Real-world size, per caste, so every ant is scaled honestly rather than to
 * taste.
 *
 * Solenopsis invicta: workers are polymorphic from about 3 mm to 6 mm, majors
 * at the top of that range and a shade over, and a mated queen runs about 9.
 * One voxel is 5 mm. These are the numbers most likely to want correcting, and
 * they are all in one table so correcting them is a one-line job.
 */
export const VOXEL_MM = 5;
export const CASTE_LENGTH_MM: Record<RigMap['caste'], number> = {
  queen: 9,
  worker: 4,
  major: 6,
};

/**
 * How wide a bite each caste takes, in millimetres — the MANDIBLE, not the
 * tunnel.
 *
 * From the Godot build, where they were tuned against the models: a queen
 * bites 1.75 mm, a worker 0.75, a major 2.5. They scale with the animal, and
 * a major out-digging a queen is most of the point of a major.
 *
 * They are far smaller than the single 7 mm bite the density lab was built
 * around, and that number was itself measured rather than picked — see
 * `BITE_WIDTH_MM` in labMound: at 4 mm she could not get back into her own
 * shaft, because her stance spans 6.3 mm and every ground sample landed on
 * the rim. So a mandible-sized bite means a bore is no longer one stroke
 * wide: a tunnel she can walk down has to be CUT wide, several bites across,
 * instead of arriving free with the first one. That is the honest anatomy and
 * the harder engineering, so the fit is measured rather than assumed.
 */
export const CASTE_BITE_MM: Record<RigMap['caste'], number> = {
  queen: 1.75,
  worker: 0.75,
  major: 2.5,
};

/**
 * Model scale for a rig: its caste's true length over its own measured length.
 *
 * Both halves matter. The exports are height-normalised, so a major measures
 * FEWER units than a worker while being the larger animal — scaling by a shared
 * constant would have made every ant the same size and hidden it behind
 * plausible-looking numbers.
 */
export function rigScale(rig: RigMap): number {
  return CASTE_LENGTH_MM[rig.caste] / VOXEL_MM / rig.lengthUnits;
}

/** How long this ant is in voxels once scaled. */
export function rigLengthVoxels(rig: RigMap): number {
  return CASTE_LENGTH_MM[rig.caste] / VOXEL_MM;
}

/** Kept for the queen's existing callers. */
export const QUEEN_LENGTH_MM = CASTE_LENGTH_MM.queen;
export const MODEL_LENGTH_UNITS = QUEEN_RIG.lengthUnits;

export function queenScale(): number {
  return rigScale(QUEEN_RIG);
}
