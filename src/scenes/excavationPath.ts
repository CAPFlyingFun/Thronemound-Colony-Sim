export interface Vec3 { x: number; y: number; z: number }

export interface DigFrame {
  position: Vec3;
  forward: Vec3;
  up: Vec3;
  right: Vec3;
}

export interface PathPoint extends DigFrame {}

export interface PathBranch {
  id: string;
  points: PathPoint[];
}

export interface ChamberConnector {
  kind: 'chamber';
  center: Vec3;
  radiusMm: number;
}

export interface ExcavationPath {
  branches: PathBranch[];
  connectors: ChamberConnector[];
}

export type ExcavationPreset =
  | { kind: 'straight'; lengthMm: number }
  | { kind: 'elbow'; radiusMm: number; angleDeg: number; direction: 'left' | 'right'; steps?: number }
  | { kind: 'tee'; trunkLengthMm: number; branchLengthMm: number; side: 'left' | 'right' }
  | { kind: 'chamber'; radiusMm: number };

export interface ManualAdvance {
  distanceMm: number;
  yawDeg: number;
  pitchDeg: number;
}

const EPS = 1e-9;
const DEG = Math.PI / 180;

const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (v: Vec3, s: number): Vec3 => ({ x: v.x * s, y: v.y * s, z: v.z * s });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const length = (v: Vec3): number => Math.hypot(v.x, v.y, v.z);
const normalize = (v: Vec3): Vec3 => {
  const n = length(v);
  if (n < EPS) throw new Error('Cannot normalize a zero-length excavation vector');
  return scale(v, 1 / n);
};

/** Rodrigues rotation. Angles are radians. */
const rotateAround = (v: Vec3, axisRaw: Vec3, angle: number): Vec3 => {
  const axis = normalize(axisRaw);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, dot(axis, v) * (1 - c)));
};

const copyVec = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
const copyFrame = (frame: DigFrame): DigFrame => ({
  position: copyVec(frame.position),
  forward: copyVec(frame.forward),
  up: copyVec(frame.up),
  right: copyVec(frame.right),
});

/**
 * Build an orthonormal excavation frame from the ant's current pose.
 * This frame is deliberately independent of later terrain normals.
 */
export function makeDigFrame(position: Vec3, forwardRaw: Vec3, upRaw: Vec3): DigFrame {
  const forward = normalize(forwardRaw);
  let up = sub(upRaw, scale(forward, dot(upRaw, forward)));
  if (length(up) < EPS) {
    const fallback = Math.abs(forward.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    up = sub(fallback, scale(forward, dot(fallback, forward)));
  }
  up = normalize(up);
  const right = normalize(cross(up, forward));
  up = normalize(cross(forward, right));
  return { position: copyVec(position), forward, up, right };
}

/**
 * Advance the stable manual excavation frame. Yaw is about the captured local
 * up; pitch is about the resulting local right. No terrain sample participates.
 */
export function advanceManualFrame(frame: DigFrame, input: ManualAdvance): DigFrame {
  const yaw = input.yawDeg * DEG;
  const pitch = input.pitchDeg * DEG;

  let forward = rotateAround(frame.forward, frame.up, yaw);
  let right = rotateAround(frame.right, frame.up, yaw);
  forward = rotateAround(forward, right, -pitch);
  let up = normalize(cross(forward, right));
  right = normalize(cross(up, forward));
  forward = normalize(forward);
  up = normalize(cross(forward, right));

  const position = add(frame.position, scale(forward, input.distanceMm));
  return { position, forward, up, right };
}

const point = (frame: DigFrame): PathPoint => copyFrame(frame);

function straight(start: DigFrame, lengthMm: number, id = 'main'): PathBranch {
  if (lengthMm < 0) throw new Error('Straight excavation length cannot be negative');
  const end: DigFrame = {
    ...copyFrame(start),
    position: add(start.position, scale(start.forward, lengthMm)),
  };
  return { id, points: [point(start), point(end)] };
}

function elbow(start: DigFrame, radiusMm: number, angleDeg: number, direction: 'left' | 'right', steps = 12): PathBranch {
  if (radiusMm <= 0) throw new Error('Elbow radius must be positive');
  if (steps < 1) throw new Error('Elbow steps must be at least one');
  const signedAngle = Math.abs(angleDeg) * DEG * (direction === 'right' ? 1 : -1);
  const points: PathPoint[] = [point(start)];
  const center = add(start.position, scale(start.right, direction === 'right' ? radiusMm : -radiusMm));
  const radial0 = sub(start.position, center);

  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const theta = signedAngle * t;
    const radial = rotateAround(radial0, start.up, theta);
    const position = add(center, radial);
    const forward = normalize(rotateAround(start.forward, start.up, theta));
    const right = normalize(cross(start.up, forward));
    const up = normalize(cross(forward, right));
    points.push({ position, forward, up, right });
  }
  return { id: 'main', points };
}

function tee(start: DigFrame, trunkLengthMm: number, branchLengthMm: number, side: 'left' | 'right'): ExcavationPath {
  const trunk = straight(start, trunkLengthMm, 'trunk');
  const junction = trunk.points.at(-1)!;
  const branchForward = scale(junction.right, side === 'right' ? 1 : -1);
  const branch = makeDigFrame(junction.position, branchForward, junction.up);
  return {
    branches: [trunk, straight(branch, branchLengthMm, 'branch')],
    connectors: [],
  };
}

export function buildPresetPath(start: DigFrame, preset: ExcavationPreset): ExcavationPath {
  switch (preset.kind) {
    case 'straight':
      return { branches: [straight(start, preset.lengthMm)], connectors: [] };
    case 'elbow':
      return {
        branches: [elbow(start, preset.radiusMm, preset.angleDeg, preset.direction, preset.steps ?? 12)],
        connectors: [],
      };
    case 'tee':
      return tee(start, preset.trunkLengthMm, preset.branchLengthMm, preset.side);
    case 'chamber':
      if (preset.radiusMm <= 0) throw new Error('Chamber radius must be positive');
      return {
        branches: [{ id: 'main', points: [point(start)] }],
        connectors: [{ kind: 'chamber', center: copyVec(start.position), radiusMm: preset.radiusMm }],
      };
  }
}
