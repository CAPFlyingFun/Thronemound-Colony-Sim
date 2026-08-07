/**
 * MANDIBLE REACH — the arithmetic of picking something up with your face.
 *
 * The design rule, straight from the brief: HEAD handles small aiming
 * corrections, BODY handles large ones, and nothing ever teleports into an
 * inventory. This module owns the numbers that make that judgement — where
 * on an object the jaws should close, whether the head can reach it from
 * here, and what a given caste can do with a given weight — as pure math a
 * test can hold still. The scene animates whatever this decides.
 *
 * All positions in millimetres, all angles in degrees, +Z is "ahead" the
 * way every ant room here has it.
 */

/** What the neck can do without the body's help. Not final numbers. */
export const HEAD_LIMITS = {
  yawDeg: 45,
  pitchDownDeg: 30,
  pitchUpDeg: 30,
  rollDeg: 25,
};

export type GrabKind = 'seed' | 'crumb' | 'twig' | 'leaf' | 'rock' | 'bug';

export interface GrabbableSpec {
  kind: GrabKind;
  /** Where it sits, mm. */
  x: number; y: number; z: number;
  /** Its long axis heading in degrees, for shapes that have one. */
  yawDeg: number;
  /** Rough half-extent along its longest axis, mm. */
  halfLenMm: number;
  /** Rough half-extent across, mm. */
  halfWideMm: number;
  weightMg: number;
}

export interface GrabPoint {
  /** Where the jaws should close, mm. */
  x: number; y: number; z: number;
  /** Which way the ant should FACE while grabbing, degrees. */
  approachDeg: number;
  /** How the head should roll to line the jaws up, degrees. */
  rollDeg: number;
}

const DEG = Math.PI / 180;

const wrapDeg = (d: number): number => {
  let v = d % 360;
  if (v > 180) v -= 360;
  if (v < -180) v += 360;
  return v;
};

/**
 * Where should the jaws close, approaching from `fromX/fromZ`?
 *
 * Each kind has a preferred grab, per the brief: a seed from wherever you
 * meet it, a twig ACROSS its width near the closest point of its length, a
 * leaf by its nearest edge, a rock by its nearest low edge, a bug around
 * the thorax. The roll is the twig's tilt handed to the head, so the jaws
 * lie across the stick rather than skew to it.
 */
export function grabPointFor(
  spec: GrabbableSpec,
  fromX: number,
  fromZ: number,
): GrabPoint {
  const toAntDeg = Math.atan2(fromX - spec.x, fromZ - spec.z) / DEG;
  switch (spec.kind) {
    case 'twig': {
      /* The closest point along the stick's axis, pulled in from the tips
       * so the grip is never a fingertip on the very end — and approached
       * square-on: the jaws want to be ~90° across the long axis. */
      const ax = Math.sin(spec.yawDeg * DEG);
      const az = Math.cos(spec.yawDeg * DEG);
      const along = Math.max(
        -spec.halfLenMm * 0.7,
        Math.min(spec.halfLenMm * 0.7,
          (fromX - spec.x) * ax + (fromZ - spec.z) * az),
      );
      const px = spec.x + ax * along;
      const pz = spec.z + az * along;
      /* Face the stick from whichever side the ant already is. */
      const side = Math.sign(
        (fromX - px) * az - (fromZ - pz) * ax,
      ) || 1;
      const approach = wrapDeg(spec.yawDeg + 90 * side + 180);
      return { x: px, y: spec.y, z: pz, approachDeg: approach, rollDeg: 0 };
    }
    case 'leaf': {
      /* The nearest EDGE: from the centre, step out toward the ant by the
       * half-width — the jaws take the rim, not the middle of the blade. */
      const px = spec.x + Math.sin(toAntDeg * DEG) * spec.halfWideMm * 0.9;
      const pz = spec.z + Math.cos(toAntDeg * DEG) * spec.halfWideMm * 0.9;
      return {
        x: px, y: spec.y, z: pz,
        approachDeg: wrapDeg(toAntDeg + 180), rollDeg: 0,
      };
    }
    case 'rock': {
      /* A LOW edge on the near side — this one gets dragged, not lifted. */
      const px = spec.x + Math.sin(toAntDeg * DEG) * spec.halfWideMm * 0.95;
      const pz = spec.z + Math.cos(toAntDeg * DEG) * spec.halfWideMm * 0.95;
      return {
        x: px, y: Math.max(0.2, spec.y - spec.halfWideMm * 0.5), z: pz,
        approachDeg: wrapDeg(toAntDeg + 180), rollDeg: 0,
      };
    }
    case 'bug':
      /* Round the thorax: centre mass, from wherever the fight is. */
      return {
        x: spec.x, y: spec.y, z: spec.z,
        approachDeg: wrapDeg(toAntDeg + 180), rollDeg: 0,
      };
    default:
      /* Seed, crumb: near side, mostly head pitch. */
      return {
        x: spec.x, y: spec.y, z: spec.z,
        approachDeg: wrapDeg(toAntDeg + 180), rollDeg: 0,
      };
  }
}

export interface HeadAim {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  /** Can the head reach this alone, from this body pose? */
  withinLimits: boolean;
  /** Signed degrees the BODY should turn to bring it into range (0 if none). */
  bodyTurnDeg: number;
}

/**
 * Split a wanted look direction into what the head does and what the body
 * must contribute. The head takes everything inside its limits; whatever
 * yaw is left over is the body's job — pitch and roll have no body assist
 * (an ant does not somersault to pick up a seed), so they just clamp.
 */
export function headAimFor(
  headX: number, headY: number, headZ: number,
  facingDeg: number,
  targetX: number, targetY: number, targetZ: number,
  wantRollDeg = 0,
): HeadAim {
  const dx = targetX - headX;
  const dy = targetY - headY;
  const dz = targetZ - headZ;
  const flat = Math.hypot(dx, dz);
  const worldYaw = Math.atan2(dx, dz) / DEG;
  const yaw = wrapDeg(worldYaw - facingDeg);
  const pitch = Math.atan2(dy, Math.max(1e-6, flat)) / DEG;
  const yawClamped = Math.max(-HEAD_LIMITS.yawDeg, Math.min(HEAD_LIMITS.yawDeg, yaw));
  const pitchClamped = Math.max(
    -HEAD_LIMITS.pitchDownDeg, Math.min(HEAD_LIMITS.pitchUpDeg, pitch),
  );
  const roll = Math.max(-HEAD_LIMITS.rollDeg, Math.min(HEAD_LIMITS.rollDeg, wantRollDeg));
  const overflow = yaw - yawClamped;
  return {
    yawDeg: yawClamped,
    pitchDeg: pitchClamped,
    rollDeg: roll,
    withinLimits: Math.abs(overflow) < 1e-6
      && Math.abs(pitch - pitchClamped) < 10,
    bodyTurnDeg: overflow,
  };
}

export type CarryMode = 'carry' | 'drag' | 'immobile';

export interface CarryVerdict {
  mode: CarryMode;
  /** Walk speed multiplier while hauling, 0..1. */
  speedFactor: number;
}

/** What a caste can lift outright, and what it can only drag, in mg. */
export const STRENGTH = {
  worker: { carryMg: 6, dragMg: 25 },
  major: { carryMg: 18, dragMg: 70 },
} as const;

export type SandboxCaste = keyof typeof STRENGTH;

/**
 * Carry, drag, or stay put — and how much it slows you. Carrying tapers
 * from full stride with a crumb to a laden trudge at the limit; dragging
 * is slower still and bottoms out just before the load wins entirely.
 */
export function carryVerdict(weightMg: number, caste: SandboxCaste): CarryVerdict {
  const s = STRENGTH[caste];
  if (weightMg <= s.carryMg) {
    return { mode: 'carry', speedFactor: 1 - 0.5 * (weightMg / s.carryMg) };
  }
  if (weightMg <= s.dragMg) {
    const t = (weightMg - s.carryMg) / (s.dragMg - s.carryMg);
    return { mode: 'drag', speedFactor: 0.45 * (1 - t) + 0.15 };
  }
  return { mode: 'immobile', speedFactor: 0 };
}
