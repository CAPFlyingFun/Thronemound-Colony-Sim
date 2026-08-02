import { describe, expect, it } from 'vitest';
import { samplesForPath, estimateTubeVolumeMm3 } from '../src/scenes/excavationCarver';
import { buildPresetPath, makeDigFrame } from '../src/scenes/excavationPath';

const start = makeDigFrame(
  { x: 0, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 1, z: 0 },
);

describe('excavation carver', () => {
  it('samples a straight path densely enough that adjacent spherical cuts overlap', () => {
    const path = buildPresetPath(start, { kind: 'straight', lengthMm: 20 });
    const samples = samplesForPath(path, 5, 2.5);
    expect(samples.length).toBeGreaterThanOrEqual(9);
    for (let i = 1; i < samples.length; i += 1) {
      const a = samples[i - 1]!.center;
      const b = samples[i]!.center;
      expect(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)).toBeLessThanOrEqual(2.50001);
    }
  });

  it('covers both branches of a tee', () => {
    const path = buildPresetPath(start, {
      kind: 'tee',
      trunkLengthMm: 20,
      branchLengthMm: 12,
      side: 'left',
    });
    const samples = samplesForPath(path, 5, 2.5);
    expect(samples.some((sample) => sample.branchId === 'trunk')).toBe(true);
    expect(samples.some((sample) => sample.branchId === 'branch')).toBe(true);
  });

  it('emits a chamber connector cut in addition to path samples', () => {
    const path = buildPresetPath(start, { kind: 'chamber', radiusMm: 18 });
    const samples = samplesForPath(path, 5, 2.5);
    expect(samples).toContainEqual({
      kind: 'sphere',
      branchId: 'connector:chamber',
      center: { x: 0, y: 0, z: 0 },
      radiusMm: 18,
    });
  });

  it('estimates cylindrical excavation volume from centerline length', () => {
    const path = buildPresetPath(start, { kind: 'straight', lengthMm: 20 });
    const volume = estimateTubeVolumeMm3(path, 5);
    expect(volume).toBeCloseTo(Math.PI * 25 * 20, 5);
  });
});
