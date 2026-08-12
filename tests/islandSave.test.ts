import { describe, expect, it } from 'vitest';

import { IslandStream } from '../src/world/IslandStream';
import { makeIslandSoil } from '../src/world/islandSoil';

/**
 * Ground everywhere, gently rolling.
 *
 * A dome was the first cut and it made the far-tile test dig nothing at all:
 * at 50 m it had fallen below zero, so there was no soil to remove and the
 * test passed its format check on an empty save. Terrain for a save test has
 * to exist wherever the test goes.
 */
const heightMm = (xMm: number, zMm: number): number => (
  900 + 40 * Math.sin(xMm / 9000) + 40 * Math.cos(zMm / 11000)
);

const streamAt = (wx: number, wz: number): IslandStream => {
  const stream = new IslandStream(makeIslandSoil(heightMm), heightMm, wx, wz);
  stream.recentreOn(wx, wz);
  return stream;
};

const fresh = (): IslandStream => streamAt(28000 / 5, 28000 / 5);

/** Chew a few spheres out of the hill, and say how many samples changed. */
const dig = (stream: IslandStream, n = 6): number => {
  const surface = stream.surfaceHeightAt(28000 / 5, 28000 / 5) ?? 0;
  for (let i = 0; i < n; i += 1) {
    stream.subtractSphere(
      { x: 28000 / 5 + i * 0.4, y: surface - 0.2 - i * 0.15, z: 28000 / 5 },
      0.9,
    );
  }
  return stream.editedSamples;
};

describe('saving the island', () => {
  it('round-trips every dig through bytes, exactly', () => {
    const stream = fresh();
    const edited = dig(stream);
    expect(edited).toBeGreaterThan(0);
    const before = Float32Array.from(stream.field.values);
    const bytes = stream.serializeEdits();

    /* A second stream of the same world, dug differently, then restored. */
    const other = fresh();
    dig(other, 2);
    other.restoreEdits(bytes);

    expect(other.editedSamples).toBe(edited);
    let differing = 0;
    let worst = 0;
    const back = other.field.values;
    for (let i = 0; i < back.length; i += 1) {
      const delta = Math.abs(back[i]! - before[i]!);
      if (delta > 1e-6) differing += 1;
      worst = Math.max(worst, delta);
    }
    expect({ differing, worst }).toEqual({ differing: 0, worst: 0 });
  });

  it('writes tile keys wide enough for THIS island', () => {
    /*
     * THE ONE THAT MATTERS, and it is here because the format it was modelled
     * on gets this wrong on purpose-built terrain. `TerrainStream` writes the
     * tile key as a uint16 and its own comment warns to check that against
     * the arithmetic. Checked: the island is 56 m across in 32 mm tiles, so
     * `tx + 1750 * tz` reaches 3,062,499 — forty-six times a uint16. Sixteen
     * bits would wrap modulo 65,536 and fold thousands of tiles onto one
     * another's keys, which a Map collapses silently on load. The symptom is
     * not a crash: it is a tunnel that partly heals itself on resume.
     *
     * So this digs at a HIGH tile index, where the key cannot fit in sixteen
     * bits, and insists the soil comes back.
     */
    const far = 50000 / 5; // 50 m along both axes: tile ~1562 of 1750
    const stream = streamAt(far, far);
    const surface = stream.surfaceHeightAt(far, far) ?? 0;
    stream.subtractSphere({ x: far, y: surface - 0.3, z: far }, 1.1);
    const edited = stream.editedSamples;
    expect(edited).toBeGreaterThan(0);

    const bytes = stream.serializeEdits();
    /* The key really is past what a uint16 could carry — otherwise this test
     * would pass on a broken format and prove nothing. */
    const key = new DataView(bytes.buffer).getUint32(4, true);
    expect(key).toBeGreaterThan(0xffff);

    const other = streamAt(far, far);
    other.restoreEdits(bytes);
    expect(other.editedSamples).toBe(edited);
  });

  it('refuses a truncated save rather than half-restoring one', () => {
    /*
     * Some tunnels back and some not, with no way to tell which, is worse
     * than a save that says it is broken.
     */
    const stream = fresh();
    dig(stream);
    const bytes = stream.serializeEdits();

    const other = fresh();
    const wasEdited = dig(other, 3);
    expect(() => other.restoreEdits(bytes.slice(0, bytes.length - 5))).toThrow();
    /* And it kept what it had rather than being left half-written. */
    expect(other.editedSamples).toBe(wasEdited);
  });

  it('refuses trailing rubbish', () => {
    const stream = fresh();
    dig(stream);
    const bytes = stream.serializeEdits();
    const longer = new Uint8Array(bytes.length + 3);
    longer.set(bytes);
    expect(() => fresh().restoreEdits(longer)).toThrow();
  });

  it('refuses a count that runs off the end', () => {
    /* A save claiming more samples than it carries must not be believed into
     * reading whatever is next in memory. */
    const stream = fresh();
    dig(stream);
    const bytes = stream.serializeEdits();
    new DataView(bytes.buffer).setUint32(8, 0xffff, true);
    expect(() => fresh().restoreEdits(bytes)).toThrow();
  });

  it('an untouched island saves to almost nothing', () => {
    /* The soil is a pure function of position, so a save stores only what she
     * changed — which is what makes it kilobytes rather than megabytes. */
    expect(fresh().serializeEdits().length).toBe(4);
  });
});
