import { describe, expect, it } from 'vitest';
import {
  BEDROCK, CLAY_DEPTH, RELIEF_VOXELS, TOPSOIL_DEPTH,
  habitatFill, habitatGenerator, habitatHeight, soilAt,
  type HabitatOptions,
} from '../src/sim/habitatSoil';
import { AIR, CLAY, SAND, STONE, TOPSOIL, VOXEL_MM } from '../src/voxel/VoxelWorld';

const OPTS: HabitatOptions = { surfaceY: 40, size: 96, seed: 1 };

/**
 * The queen's spare downward reach, in millimetres — the smallest of
 * `legDrive.REACH_DOWN_MM`, which is the front legs at 1.12.
 *
 * Copied as a NUMBER rather than imported, on purpose: importing it would
 * make this test pass automatically if that constant were ever loosened,
 * and the whole point is that the habitat has to suit the animal as she is
 * measured today. If her legs change, this test should fail and be read.
 */
const SPARE_REACH_MM = 1.12;

/*
 * GROUND AN ANT CAN ACTUALLY WALK ON.
 *
 * The dig room's terrain is built for a first-person player and is
 * mountainous at ant scale — measured, 0.92 mm of relief per voxel on
 * average and 5 mm at worst, against legs carrying about 1.1 mm of spare
 * reach. A third of her feet were groping. This field exists so "small
 * surface variation" means small TO HER, and these tests are what keeps it
 * that way when somebody later decides the habitat looks boring.
 */
describe('the habitat tray', () => {
  it('is never steeper than her legs can reach', () => {
    let worst = 0;
    for (let x = 2; x < OPTS.size - 2; x += 1) {
      for (let z = 2; z < OPTS.size - 2; z += 1) {
        const h = habitatHeight(x, z, OPTS);
        worst = Math.max(
          worst,
          Math.abs(habitatHeight(x + 1, z, OPTS) - h),
          Math.abs(habitatHeight(x, z + 1, OPTS) - h),
        );
      }
    }
    /* Half her spare reach, so a foot has room over the steepest cell in the
     * tank even before the gait's own stride is taken into account. */
    expect(worst * VOXEL_MM).toBeLessThan(SPARE_REACH_MM / 2);
  });

  it('is not flat either — that would test nothing', () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let x = 2; x < OPTS.size - 2; x += 4) {
      for (let z = 2; z < OPTS.size - 2; z += 4) {
        const h = habitatHeight(x, z, OPTS);
        lo = Math.min(lo, h); hi = Math.max(hi, h);
      }
    }
    /* Real relief she has to walk over: at least a body height of it. */
    expect((hi - lo) * VOXEL_MM).toBeGreaterThan(3.2);
    expect(hi - lo).toBeLessThanOrEqual(RELIEF_VOXELS + 1e-9);
  });

  it('puts solid under the surface and air over it', () => {
    const gen = habitatGenerator(OPTS);
    for (const [x, z] of [[10, 10], [48, 48], [80, 20]] as const) {
      const h = habitatHeight(x, z, OPTS);
      expect(gen(x, Math.floor(h) - 1, z)).not.toBe(AIR);
      expect(gen(x, Math.ceil(h) + 1, z)).toBe(AIR);
    }
  });

  it('lays its strata under the surface, not under a flat plane', () => {
    /* Topsoil is a skin over the swells — sliced by a flat plane it would
     * vanish on the high ground, which is the bug `terrain.ts` names. */
    const high = habitatHeight(48, 48, OPTS);
    expect(soilAt(high - 1, high)).toBe(TOPSOIL);
    expect(soilAt(high - TOPSOIL_DEPTH - 1, high)).toBe(CLAY);
    expect(soilAt(high - CLAY_DEPTH - 1, high)).toBe(SAND);
    expect(soilAt(BEDROCK - 1, high)).toBe(STONE);
  });

  it('fills only the top cell, and fills it to the drawn height', () => {
    const h = habitatHeight(30, 30, OPTS);
    const top = Math.ceil(h) - 1;
    expect(habitatFill(30, top, 30, OPTS)).toBeCloseTo(h - top, 9);
    /* Everything under it is whole soil; a partial cell halfway down would
     * be a hole she could fall through. */
    expect(habitatFill(30, top - 1, 30, OPTS)).toBe(1);
    expect(habitatFill(30, top - 7, 30, OPTS)).toBe(1);
  });

  it('agrees with itself: the fill lands exactly on the height', () => {
    /* The mesher draws `top + fill` and the ant stands on `top + fill`. If
     * these ever disagree she walks on a surface nobody can see. */
    for (const [x, z] of [[7, 61], [48, 48], [88, 12], [33, 77]] as const) {
      const h = habitatHeight(x, z, OPTS);
      const top = Math.ceil(h) - 1;
      expect(top + habitatFill(x, top, z, OPTS)).toBeCloseTo(h, 9);
    }
  });

  it('is the same tray every time, for the same seed', () => {
    /* A habitat that differs per reload cannot be compared with yesterday's
     * screenshot, and this room exists to be compared. */
    expect(habitatHeight(21, 34, OPTS)).toBe(habitatHeight(21, 34, { ...OPTS }));
    expect(habitatHeight(21, 34, { ...OPTS, seed: 2 }))
      .not.toBe(habitatHeight(21, 34, OPTS));
  });
});
