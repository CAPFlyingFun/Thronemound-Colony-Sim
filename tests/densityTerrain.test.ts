import { describe, expect, it } from 'vitest';
import { DensityField } from '../src/density/DensityField';
import { buildSurfaceNets } from '../src/density/SurfaceNets';

function boundaryEdgeCount(indices: Uint32Array): number {
  const counts = new Map<string, number>();
  const add = (a: number, b: number): void => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    if (a === undefined || b === undefined || c === undefined) {
      throw new Error('Incomplete terrain triangle');
    }
    add(a, b);
    add(b, c);
    add(c, a);
  }
  return [...counts.values()].filter((count) => count === 1).length;
}

describe('DensityField', () => {
  it('subtracts a five-millimetre-radius brush and reports removed volume', () => {
    const field = new DensityField({ cellsX: 16, cellsY: 16, cellsZ: 16 });
    field.fillFromHeight(() => 8);

    const before = field.sample(8, 7.5, 8);
    const result = field.subtractSphere({ x: 8, y: 8, z: 8 }, 1);

    expect(result.changedSamples).toBeGreaterThan(0);
    expect(result.removedVolume).toBeGreaterThan(0);
    expect(field.sample(8, 7.5, 8)).toBeLessThan(before);
  });

  it('does not increase density outside the brush', () => {
    const field = new DensityField({ cellsX: 16, cellsY: 16, cellsZ: 16 });
    field.fillFromHeight(() => 8);
    const untouched = field.get(2, 6, 2);

    field.subtractSphere({ x: 12, y: 8, z: 12 }, 1);

    expect(field.get(2, 6, 2)).toBe(untouched);
  });
});

describe('buildSurfaceNets', () => {
  it('produces a closed mesh for a soil body surrounded by air', () => {
    const field = new DensityField({ cellsX: 20, cellsY: 20, cellsZ: 20 });
    field.fill((x, y, z) => 6 - Math.hypot(x - 10, y - 10, z - 10));

    const mesh = buildSurfaceNets(field);

    expect(mesh.positions.length).toBeGreaterThan(0);
    expect(mesh.indices.length).toBeGreaterThan(0);
    expect(boundaryEdgeCount(mesh.indices)).toBe(0);
  });

  it('stays closed after a scoop intersects the surface', () => {
    const field = new DensityField({ cellsX: 24, cellsY: 24, cellsZ: 24 });
    field.fill((x, y, z) => 7 - Math.hypot(x - 12, y - 12, z - 12));
    field.subtractSphere({ x: 12, y: 18.3, z: 12 }, 1.5);

    const mesh = buildSurfaceNets(field);

    expect(boundaryEdgeCount(mesh.indices)).toBe(0);
  });
});
