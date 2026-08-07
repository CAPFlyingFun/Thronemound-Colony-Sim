/**
 * The egg scoop — the tunnel builder's one dig, as a brush.
 *
 * The spec is dimensional: 9 mm across, 6 mm tall, 3 mm deep, wide face
 * toward the ant. These tests measure the hole, not the formula — extents
 * read off the field's sign changes, volume against the ellipsoid it claims
 * to be, orientation by carving the same egg two ways.
 */

import { describe, expect, it } from 'vitest';
import { DensityField } from '../src/density/DensityField';

const SEMIS = { deep: 1.5, wide: 4.5, tall: 3 };

function solidBlock(): DensityField {
  const field = new DensityField({ cellsX: 40, cellsY: 40, cellsZ: 40, cellSize: 0.5 });
  field.fill(() => 5);
  return field;
}

/** The carved extent along a ray from the centre, by 0.1 mm march. */
function reach(field: DensityField, from: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number }): number {
  let r = 0;
  for (let s = 0; s <= 8; s += 0.1) {
    const d = field.sample(from.x + dir.x * s, from.y + dir.y * s, from.z + dir.z * s);
    if (d < 0) r = s;
  }
  return r;
}

describe('subtractEllipsoid', () => {
  it('cuts the spec: ~9 wide, ~6 tall, ~3 deep', () => {
    const field = solidBlock();
    const c = { x: 10, y: 10, z: 10 };
    const result = field.subtractEllipsoid(c, { x: 0, y: 0, z: 1 }, SEMIS);
    expect(result.changedSamples).toBeGreaterThan(0);

    const deep = reach(field, c, { x: 0, y: 0, z: 1 }) + reach(field, c, { x: 0, y: 0, z: -1 });
    const wide = reach(field, c, { x: 1, y: 0, z: 0 }) + reach(field, c, { x: -1, y: 0, z: 0 });
    const tall = reach(field, c, { x: 0, y: 1, z: 0 }) + reach(field, c, { x: 0, y: -1, z: 0 });
    expect(deep).toBeGreaterThan(2.4); expect(deep).toBeLessThan(3.8);
    expect(wide).toBeGreaterThan(8.2); expect(wide).toBeLessThan(9.8);
    expect(tall).toBeGreaterThan(5.2); expect(tall).toBeLessThan(6.8);
  });

  it('holds the volume of the ellipsoid it claims to be', () => {
    const field = solidBlock();
    const result = field.subtractEllipsoid(
      { x: 10, y: 10, z: 10 }, { x: 0, y: 0, z: 1 }, SEMIS,
    );
    const ideal = (4 / 3) * Math.PI * SEMIS.deep * SEMIS.wide * SEMIS.tall;
    expect(result.removedVolume).toBeGreaterThan(ideal * 0.8);
    expect(result.removedVolume).toBeLessThan(ideal * 1.2);
  });

  it('turns with the dig: aimed along +X, the depth is the X axis', () => {
    const field = solidBlock();
    const c = { x: 10, y: 10, z: 10 };
    field.subtractEllipsoid(c, { x: 1, y: 0, z: 0 }, SEMIS);
    const alongX = reach(field, c, { x: 1, y: 0, z: 0 }) * 2;
    const acrossZ = reach(field, c, { x: 0, y: 0, z: 1 }) * 2;
    expect(alongX).toBeLessThan(4);      // the deep axis
    expect(acrossZ).toBeGreaterThan(8);  // the wide axis
  });

  it('a vertical dig still has a width and a height', () => {
    const field = solidBlock();
    const c = { x: 10, y: 10, z: 10 };
    const result = field.subtractEllipsoid(
      c, { x: 0, y: -1, z: 0 }, SEMIS, { x: 1, y: 0, z: 0 },
    );
    expect(result.changedSamples).toBeGreaterThan(0);
    const down = reach(field, c, { x: 0, y: -1, z: 0 }) * 2;
    const acrossX = reach(field, c, { x: 1, y: 0, z: 0 }) * 2;
    expect(down).toBeLessThan(4);        // deep axis points down now
    expect(acrossX).toBeGreaterThan(8);  // width took the hint
  });

  it('refuses nonsense axes', () => {
    const field = solidBlock();
    expect(() => field.subtractEllipsoid(
      { x: 10, y: 10, z: 10 }, { x: 0, y: 0, z: 1 },
      { deep: 0, wide: 4.5, tall: 3 },
    )).toThrow();
  });
});
