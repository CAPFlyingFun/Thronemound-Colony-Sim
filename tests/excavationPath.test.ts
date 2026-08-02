import { describe, expect, it } from 'vitest';
import {
  advanceManualFrame,
  buildPresetPath,
  makeDigFrame,
  type Vec3,
} from '../src/scenes/excavationPath';

const near = (a: number, b: number, eps = 1e-5) => expect(Math.abs(a - b)).toBeLessThan(eps);
const nearVec = (a: Vec3, b: Vec3, eps = 1e-5) => {
  near(a.x, b.x, eps);
  near(a.y, b.y, eps);
  near(a.z, b.z, eps);
};

describe('excavation path primitives', () => {
  const start = makeDigFrame(
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 1, z: 0 },
  );

  it('builds a straight path in physical millimetres', () => {
    const path = buildPresetPath(start, { kind: 'straight', lengthMm: 20 });
    expect(path.branches).toHaveLength(1);
    expect(path.branches[0]!.points).toHaveLength(2);
    nearVec(path.branches[0]!.points[0]!.position, { x: 0, y: 0, z: 0 });
    nearVec(path.branches[0]!.points[1]!.position, { x: 0, y: 0, z: 20 });
  });

  it('builds a ninety degree elbow without teleporting at the joint', () => {
    const path = buildPresetPath(start, {
      kind: 'elbow',
      radiusMm: 10,
      angleDeg: 90,
      direction: 'right',
      steps: 8,
    });
    const points = path.branches[0]!.points;
    expect(points.length).toBe(9);
    nearVec(points[0]!.position, start.position);
    nearVec(points.at(-1)!.forward, { x: 1, y: 0, z: 0 }, 1e-4);
    expect(points.at(-1)!.position.x).toBeGreaterThan(9.9);
    expect(points.at(-1)!.position.z).toBeGreaterThan(9.9);
  });

  it('builds a tee as one trunk and one branch sharing a junction', () => {
    const path = buildPresetPath(start, {
      kind: 'tee',
      trunkLengthMm: 20,
      branchLengthMm: 12,
      side: 'left',
    });
    expect(path.branches).toHaveLength(2);
    const trunk = path.branches[0]!;
    const branch = path.branches[1]!;
    const junction = trunk.points.at(-1)!.position;
    nearVec(branch.points[0]!.position, junction);
    expect(branch.points.at(-1)!.position.x).toBeLessThan(junction.x - 11.9);
  });

  it('represents a chamber as an expansion connector without inventing a locomotion surface', () => {
    const path = buildPresetPath(start, { kind: 'chamber', radiusMm: 18 });
    expect(path.branches).toHaveLength(1);
    expect(path.branches[0]!.points).toHaveLength(1);
    expect(path.connectors).toEqual([
      { kind: 'chamber', center: { x: 0, y: 0, z: 0 }, radiusMm: 18 },
    ]);
  });

  it('manual advance changes the stable dig frame, not an external terrain normal', () => {
    const next = advanceManualFrame(start, {
      distanceMm: 5,
      yawDeg: 30,
      pitchDeg: -20,
    });
    expect(next.position.z).toBeGreaterThan(3.9);
    expect(next.position.y).toBeLessThan(-1.6);
    near(Math.hypot(next.forward.x, next.forward.y, next.forward.z), 1);
    near(Math.hypot(next.up.x, next.up.y, next.up.z), 1);
    near(
      next.forward.x * next.up.x + next.forward.y * next.up.y + next.forward.z * next.up.z,
      0,
    );
  });
});
