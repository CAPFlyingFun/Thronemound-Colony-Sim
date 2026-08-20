import { describe, expect, it } from 'vitest';
import {
  AntFounding, FOUNDING_DEPTH_MM, RAMP_GRADE, SEEK_SECONDS,
  type FoundingPose, type FoundingSenses,
} from '../src/sim/founding';

/**
 * A flat tray of soil with its surface at `grade`, and a fill store over it,
 * so the founding brain can be driven without a renderer or a voxel world.
 *
 * The ant is NOT simulated here. Every test drives the pose by hand, which is
 * the point: this file is about what she ASKS for, and the whole design rests
 * on her never being able to move herself.
 */
class FlatSoil implements FoundingSenses {
  private readonly cut = new Map<string, number>();

  constructor(private readonly grade = 40) {}

  fillAt(x: number, y: number, z: number): number {
    const found = this.cut.get(`${x},${y},${z}`);
    if (found !== undefined) return found;
    return y < this.grade ? 1 : 0;
  }

  floorUnder(x: number, z: number, from: number): number | null {
    for (let y = Math.floor(from); y >= 0; y -= 1) {
      if (this.fillAt(x, y, z) > 0) return y + this.fillAt(x, y, z);
    }
    return null;
  }

  /** Grant a wish outright, as a dig system that never refuses would. */
  grant(cell: readonly [number, number, number], leave: number): void {
    this.cut.set(`${cell[0]},${cell[1]},${cell[2]}`, leave);
  }
}

/** Walk her through the seeking phase so the tests start at the interesting part. */
function commit(brain: AntFounding, pose: FoundingPose, soil: FlatSoil): void {
  for (let i = 0; i < Math.ceil(SEEK_SECONDS * 60) + 2; i += 1) {
    brain.step(1 / 60, pose, soil);
  }
}

describe('AntFounding', () => {
  it('walks the surface before it commits to anywhere', () => {
    const soil = new FlatSoil();
    const brain = new AntFounding();
    const pose: FoundingPose = { x: 20, y: 40, z: 20, heading: 0 };
    const early = brain.step(1 / 60, pose, soil);
    expect(brain.state).toBe('seeking');
    expect(early.walk).toBeGreaterThan(0);
    expect(early.digAt).toBeNull();
    commit(brain, pose, soil);
    expect(brain.state).toBe('sinking');
  });

  /*
   * THE SHAPE OF THE CORRIDOR, which is the thing everything else rests on.
   * Asked of one pose over a flat tray: every cell she wants must be ahead of
   * her, inside the bore, and not below the ramp line.
   */
  it('asks only for cells ahead of it, never under its own feet', () => {
    const soil = new FlatSoil();
    const brain = new AntFounding();
    const pose: FoundingPose = { x: 20.5, y: 40, z: 20.5, heading: 0 };
    commit(brain, pose, soil);

    /* Heading 0 is +z, so everything she asks for must be forward of her. */
    for (let i = 0; i < 400; i += 1) {
      const want = brain.step(1 / 60, pose, soil);
      if (!want.digAt) continue;
      expect(want.digAt[2] + 0.5).toBeGreaterThan(pose.z);
      soil.grant(want.digAt, want.leave);
    }
  });

  /*
   * AND THE RAMP IS GRADED. Somewhere in the corridor she must ask for a cell
   * to be left PART full — that is the sloping floor, and without it the
   * tunnel is a five-millimetre staircase under a three-millimetre ant.
   */
  it('asks for a graded floor, not only for whole cells', () => {
    const soil = new FlatSoil();
    const brain = new AntFounding();
    const pose: FoundingPose = { x: 20.5, y: 40, z: 20.5, heading: 0 };
    commit(brain, pose, soil);

    const leaves = new Set<number>();
    for (let i = 0; i < 400; i += 1) {
      const want = brain.step(1 / 60, pose, soil);
      if (!want.digAt) break;
      leaves.add(want.leave);
      soil.grant(want.digAt, want.leave);
    }
    const graded = [...leaves].filter((v) => v > 0 && v < 1);
    expect(graded.length).toBeGreaterThan(0);
  });

  /*
   * SHE STANDS STILL WHILE THERE IS ANYTHING TO DIG. Walking into a corridor
   * that is only partly cut is how she ended up with six feet in the air.
   */
  it('never asks to walk and to dig in the same breath', () => {
    const soil = new FlatSoil();
    const brain = new AntFounding();
    const pose: FoundingPose = { x: 20.5, y: 40, z: 20.5, heading: 0 };
    commit(brain, pose, soil);
    for (let i = 0; i < 400; i += 1) {
      const want = brain.step(1 / 60, pose, soil);
      if (want.digAt) expect(want.walk).toBe(0);
      if (want.digAt) soil.grant(want.digAt, want.leave);
    }
  });

  /*
   * AND WHEN THE CORRIDOR IS FINISHED SHE ASKS TO WALK. A brain that runs out
   * of cells and does not move is a queen frozen at her own dig face, which
   * is exactly how the first three versions of this failed.
   */
  it('asks to walk once the corridor in front of it is cut', () => {
    const soil = new FlatSoil();
    const brain = new AntFounding();
    const pose: FoundingPose = { x: 20.5, y: 40, z: 20.5, heading: 0 };
    commit(brain, pose, soil);
    let walked = false;
    for (let i = 0; i < 2000; i += 1) {
      const want = brain.step(1 / 60, pose, soil);
      if (want.digAt) { soil.grant(want.digAt, want.leave); continue; }
      walked = want.walk > 0;
      break;
    }
    expect(walked).toBe(true);
  });

  /*
   * THE FLOOR SHE IS LEFT WITH ACTUALLY DESCENDS, at about the grade asked
   * for. Measured by granting everything she wants from a fixed pose and then
   * reading the floor height a couple of voxels ahead.
   */
  it('cuts a floor that slopes down at about the ramp grade', () => {
    const soil = new FlatSoil();
    const brain = new AntFounding();
    const pose: FoundingPose = { x: 20.5, y: 40, z: 20.5, heading: 0 };
    commit(brain, pose, soil);
    for (let i = 0; i < 3000; i += 1) {
      const want = brain.step(1 / 60, pose, soil);
      if (!want.digAt) break;
      soil.grant(want.digAt, want.leave);
    }
    const here = soil.floorUnder(20, 20, 42)!;
    const ahead = soil.floorUnder(20, 22, 42)!;
    /* Two voxels forward should be about two grades down. */
    expect(here - ahead).toBeGreaterThan(RAMP_GRADE * 1.2);
    expect(here - ahead).toBeLessThan(RAMP_GRADE * 3);
  });

  it('stops sinking once it is deep enough', () => {
    const soil = new FlatSoil();
    const brain = new AntFounding();
    const pose: FoundingPose = { x: 20.5, y: 40, z: 20.5, heading: 0 };
    commit(brain, pose, soil);
    expect(brain.state).toBe('sinking');
    pose.y = 40 - (FOUNDING_DEPTH_MM / 5) - 0.1;
    brain.step(1 / 60, pose, soil);
    expect(brain.state).toBe('turning');
  });
});
