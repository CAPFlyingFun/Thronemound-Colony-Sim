/**
 * THE CARVED AIR IS AUTHORITATIVE.
 *
 * The camera's terrain question walks a chain — fine streamed window first,
 * coarse island heightfield only if the window has no answer — and the one
 * way that chain can go wrong is to treat "the window says AIR" as if it
 * were "the window has nothing to say", and serve the coarse answer
 * instead. Every point inside a tunnel is under the original surface, so
 * the coarse heightfield calls all of it solid; a guard that believed it
 * would shove the camera out of a corridor she has legitimately dug.
 *
 * This pins the three states apart at the level they are decided.
 */
import { describe, expect, it } from 'vitest';
import { DensityField } from '../src/density/DensityField';

/** The chain as IslandScene implements it, in miniature. */
type Fine = { state: 'solid' | 'air'; density: number } | { state: 'unavailable' };

const fineOf = (raw: number | null): Fine => (raw === null
  ? { state: 'unavailable' }
  : { state: raw > 0 ? 'solid' : 'air', density: raw });

/** groundDensityAt's rule: the fine window wins whenever it HAS an answer. */
const groundDensity = (fine: Fine, coarse: number): number =>
  (fine.state === 'unavailable' ? coarse : fine.density);

/** soilDensityAt's rule: real solids union in AFTER the ground is decided. */
const soilDensity = (ground: number, tree?: number): number =>
  (tree !== undefined && tree > ground ? tree : ground);

describe('the camera terrain query', () => {
  it('keeps carved air OPEN even where the coarse island calls it buried', () => {
    /* A point 120 mm under the original surface, inside a tunnel. */
    const fine = fineOf(-3.2);          // the window: air, 3.2 mm of it
    const coarse = 120;                 // the island: 120 mm of overburden
    expect(fine.state).toBe('air');
    expect(groundDensity(fine, coarse)).toBe(-3.2);
    expect(groundDensity(fine, coarse)).toBeLessThan(0);
  });

  it('serves the coarse answer ONLY when the window has none', () => {
    const fine = fineOf(null);
    expect(fine.state).toBe('unavailable');
    expect(groundDensity(fine, 120)).toBe(120);
  });

  it('does not confuse air with unavailable at the zero crossing', () => {
    /* Exactly on the drawn surface is an ANSWER, and it is not solid. */
    expect(fineOf(0).state).toBe('air');
    expect(groundDensity(fineOf(0), 120)).toBe(0);
  });

  it('lets a tree stand in a carved tunnel — solids union AFTER', () => {
    const ground = groundDensity(fineOf(-3.2), 120);
    /* Bark occupying the same point is still bark. */
    expect(soilDensity(ground, 2.5)).toBe(2.5);
    /* ...and wood that is not there does not make air solid. */
    expect(soilDensity(ground, -40)).toBe(-3.2);
  });

  it('a real field carved to air reads air, not overburden', () => {
    /* The same statement against the real DensityField rather than a
     * stand-in: fill solid, carve a sphere, and read the middle of it. */
    const field = new DensityField({ cellsX: 16, cellsY: 16, cellsZ: 16, cellSize: 1 });
    field.fill(() => 5);
    field.subtractSphere({ x: 8, y: 8, z: 8 }, 3);
    const inside = field.sample(8, 8, 8);
    expect(inside).toBeLessThan(0);
    expect(groundDensity(fineOf(inside), 120)).toBeLessThan(0);
  });
});
