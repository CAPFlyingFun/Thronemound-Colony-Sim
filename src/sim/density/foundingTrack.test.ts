/**
 * THE TRACK IS THE SHAPE IT SAYS IT IS.
 *
 * Geometry only, no renderer and no soil: the rail is arithmetic over the
 * pieces, so everything the digger will rely on can be checked here rather
 * than inferred from a hole in a probe.
 */
import { describe, expect, it } from 'vitest';
import { ENTRANCE_DROP, ShaftTrack, advanceRateMmS, foundingTrack } from './foundingTrack';
import { MM_PER_UNIT, boreRadiusMm } from './casteDig';

/** Mulberry32, so a test reads the same track every run. */
function seeded(seed: number): () => number {
  let n = seed >>> 0;
  return () => {
    n = (n + 0x6d2b79f5) >>> 0;
    let t = n;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const START = { x: 10, y: 10, z: 10 };
const DOWN = { x: 0, y: 0, z: 1 };

describe('the founding track', () => {
  it('starts with a plumb drop of ten millimetres', () => {
    expect(ENTRANCE_DROP.pitch).toBe(-90);
    expect(ENTRANCE_DROP.length).toBe(10);
    const track = foundingTrack(seeded(1));
    expect(track[0]).toMatchObject({ pitch: -90, length: 10 });
  });

  it('eases off vertical without ever climbing', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      for (const piece of foundingTrack(seeded(seed))) {
        expect(piece.pitch).toBeLessThanOrEqual(-15);
        expect(piece.pitch).toBeGreaterThanOrEqual(-90);
      }
    }
  });

  it('is the same track for the same seed', () => {
    expect(foundingTrack(seeded(7))).toEqual(foundingTrack(seeded(7)));
  });

  /*
   * THE DROP ACTUALLY DROPS. `railFromPlan` carries the heading through a
   * plumb run as integrator state rather than deriving it from the frame —
   * this is the check that says so from the outside.
   */
  it('sinks ten millimetres of shaft before it leans anywhere', () => {
    const shaft = new ShaftTrack('queen', [ENTRANCE_DROP], START, DOWN);
    const mouth = shaft.station(1e9)!;
    shaft.advance(10, boreRadiusMm('queen') / MM_PER_UNIT);
    const face = shaft.face()!;
    const dropMm = (mouth.at.y - face.at.y) * MM_PER_UNIT;
    expect(dropMm).toBeGreaterThan(9.5);
    expect(Math.hypot(face.at.x - START.x, face.at.z - START.z) * MM_PER_UNIT)
      .toBeLessThan(0.5);
  });

  it('opens the mouth on the first beat, not a step below it', () => {
    const shaft = new ShaftTrack('queen', [ENTRANCE_DROP], START, DOWN);
    const first = shaft.advance(1, boreRadiusMm('queen') / MM_PER_UNIT);
    expect(first.length).toBeGreaterThan(1);
    expect((first[0]!.y - START.y) * MM_PER_UNIT).toBeCloseTo(0, 1);
  });

  /*
   * NO WAIST BETWEEN CONSECUTIVE SAMPLES. Two spheres a whole radius apart
   * leave a pinch; this is the same half-radius rule `DigJob` uses, checked
   * on the points the carve will actually receive.
   */
  it('hands back points that deeply overlap, ACROSS beats as well as within', () => {
    const r = boreRadiusMm('queen') / MM_PER_UNIT;
    const shaft = new ShaftTrack('queen', foundingTrack(seeded(3)), START, DOWN);
    /*
     * EVERY POINT THE CARVE WILL EVER SEE, in order — not each beat's batch
     * on its own. The first cut of this checked within a batch only and
     * passed happily with the spacing set four times too coarse: a small
     * advance yields a single point, and one point has no gaps in it. The
     * soil sees the union of all the beats, so the union is what has to be
     * gapless.
     */
    const all: Array<{ x: number; y: number; z: number }> = [];
    for (let i = 0; i < 400 && !shaft.done; i += 1) all.push(...shaft.advance(2, r));
    expect(all.length).toBeGreaterThan(20);
    let worst = 0;
    for (let k = 1; k < all.length; k += 1) {
      const a = all[k - 1]!;
      const b = all[k]!;
      worst = Math.max(worst, Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
    }
    expect(worst).toBeLessThanOrEqual(r * 0.75);
  });

  it('excavates the whole planned length and then stops', () => {
    const r = boreRadiusMm('queen') / MM_PER_UNIT;
    const shaft = new ShaftTrack('queen', foundingTrack(seeded(5)), START, DOWN);
    const planned = shaft.plannedMm;
    expect(planned).toBeGreaterThan(20);
    for (let i = 0; i < 500 && !shaft.done; i += 1) shaft.advance(1, r);
    expect(shaft.done).toBe(true);
    expect(shaft.dugMm).toBeCloseTo(planned, 5);
    expect(shaft.advance(1, r)).toEqual([]);
  });

  /*
   * A STATION IS BEHIND THE FACE, therefore in air. This is the property the
   * whole design rests on: a place to stand is a coordinate, not a search.
   */
  it('puts a working station behind the face, on ground already cut', () => {
    const r = boreRadiusMm('queen') / MM_PER_UNIT;
    const shaft = new ShaftTrack('queen', foundingTrack(seeded(9)), START, DOWN);
    for (let i = 0; i < 20; i += 1) shaft.advance(1, r);
    const face = shaft.face()!;
    const station = shaft.station(5)!;
    expect(station.s).toBeLessThan(face.s);
    expect(station.s).toBeCloseTo(face.s - 5, 6);
  });

  it('digs at the caste rate, derived from the volumetric one', () => {
    /* 30 mm3/s through a 6 mm bore. Stated so a change to either is caught. */
    expect(advanceRateMmS('queen')).toBeCloseTo(30 / (Math.PI * 9), 4);
    expect(advanceRateMmS('worker')).toBeGreaterThan(advanceRateMmS('queen'));
  });
});
