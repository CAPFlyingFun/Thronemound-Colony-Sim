import { describe, expect, it } from 'vitest';
import {
  AntFounding, FOUNDING_DEPTH_MM, RAMP_GRADE, SEEK_SECONDS,
  SHAFT_DEPTH_MM, SHAFT_RADIUS,
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

  /*
   * FLOORED, like a real world. A first cut keyed the map on the raw numbers
   * and the brain asks about integer CELLS while the seater asks under a
   * fractional POSITION — so every cut was filed under "20,39,20" and looked
   * up under "20.5,39,20.5", and the tray stayed pristine no matter how much
   * she dug. She sank a shaft and never went down an inch.
   */
  fillAt(x: number, y: number, z: number): number {
    const key = `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
    const found = this.cut.get(key);
    if (found !== undefined) return found;
    return Math.floor(y) < this.grade ? 1 : 0;
  }

  floorUnder(x: number, z: number, from: number): number | null {
    for (let y = Math.floor(from); y >= 0; y -= 1) {
      const fill = this.fillAt(x, y, z);
      if (fill > 0) return y + fill;
    }
    return null;
  }

  /** Grant a wish outright, as a dig system that never refuses would. */
  grant(cell: readonly [number, number, number], leave: number): void {
    this.cut.set(`${cell[0]},${cell[1]},${cell[2]}`, leave);
  }
}

/** Walk her through seeking, so the tests start where she commits. */
function commit(brain: AntFounding, pose: FoundingPose, soil: FlatSoil): void {
  for (let i = 0; i < Math.ceil(SEEK_SECONDS * 60) + 2; i += 1) {
    brain.step(1 / 60, pose, soil);
  }
}

/**
 * Seat her on whatever the soil now is under her — the walker's job, done by
 * hand here, because the whole design rests on this file never doing it.
 */
function settle(pose: FoundingPose, soil: FlatSoil): void {
  const floor = soil.floorUnder(pose.x, pose.z, pose.y + 2);
  if (floor !== null) pose.y = floor;
}

/** And on through the entrance shaft, granting everything she asks for. */
function sink(brain: AntFounding, pose: FoundingPose, soil: FlatSoil): void {
  commit(brain, pose, soil);
  for (let i = 0; i < 6000 && brain.state === 'shaft'; i += 1) {
    const want = brain.step(1 / 60, pose, soil);
    if (want.digAt) soil.grant(want.digAt, want.leave);
    settle(pose, soil);
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
    expect(brain.state).toBe('shaft');
  });

  /*
   * THE ENTRANCE SHAFT. Reported from the device: at the gallery's grade she
   * ploughed an open trench across the tray instead of going into the ground.
   * So she sinks a hole first, straight down, under her own feet.
   */
  it('sinks the entrance shaft straight down, without walking anywhere', () => {
    const soil = new FlatSoil();
    const brain = new AntFounding();
    const pose: FoundingPose = { x: 20.5, y: 40, z: 20.5, heading: 0 };
    commit(brain, pose, soil);
    expect(brain.state).toBe('shaft');

    for (let i = 0; i < 6000 && brain.state === 'shaft'; i += 1) {
      const want = brain.step(1 / 60, pose, soil);
      /* Never a step across the tray while the shaft is going down. */
      expect(want.walk).toBe(0);
      if (want.digAt) {
        /* And never above her own head, nor outside the shaft's radius. */
        expect(want.digAt[1]).toBeLessThanOrEqual(Math.ceil(pose.y));
        expect(Math.hypot(want.digAt[0] - 20, want.digAt[2] - 20))
          .toBeLessThanOrEqual(SHAFT_RADIUS + 1);
        soil.grant(want.digAt, want.leave);
      }
      settle(pose, soil);
    }
    expect(brain.state).toBe('sinking');
    /* She is in a hole, and it is about as deep as it was asked to be. */
    expect(40 - pose.y).toBeGreaterThanOrEqual(SHAFT_DEPTH_MM / 5 - 0.6);
    /* And she has not moved an inch across the tray to get there. */
    expect(pose.x).toBe(20.5);
    expect(pose.z).toBe(20.5);
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
    sink(brain, pose, soil);

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
    sink(brain, pose, soil);

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
    sink(brain, pose, soil);
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
    sink(brain, pose, soil);
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
    sink(brain, pose, soil);
    const from = pose.y;
    for (let i = 0; i < 3000; i += 1) {
      const want = brain.step(1 / 60, pose, soil);
      if (!want.digAt) break;
      soil.grant(want.digAt, want.leave);
    }
    /*
     * Read along the GALLERY, past the shaft. The shaft bottom is three
     * voxels below grade, so comparing it against the gallery would measure
     * the entrance rather than the ramp.
     */
    const eye = pose.y + 0.5;
    /* Both inside the cut corridor: it runs from FACE_NEAR to FACE_AHEAD
     * ahead of her, so a column past that is a face, not a floor. */
    const near = soil.floorUnder(20, 21, eye)!;
    const far = soil.floorUnder(20, 22, eye)!;
    /*
     * Read from INSIDE the tunnel, not from the sky: the gallery is roofed,
     * so a scan from above finds the roof and reports every column at grade.
     * A voxel further along should be about one grade further down.
     */
    expect(near - far).toBeGreaterThan(RAMP_GRADE * 0.5);
    expect(near - far).toBeLessThan(RAMP_GRADE * 3);
  });

  it('stops sinking once it is deep enough', () => {
    const soil = new FlatSoil();
    const brain = new AntFounding();
    const pose: FoundingPose = { x: 20.5, y: 40, z: 20.5, heading: 0 };
    sink(brain, pose, soil);
    expect(brain.state).toBe('sinking');
    pose.y = 40 - (FOUNDING_DEPTH_MM / 5) - 0.1;
    brain.step(1 / 60, pose, soil);
    expect(brain.state).toBe('turning');
  });
});
