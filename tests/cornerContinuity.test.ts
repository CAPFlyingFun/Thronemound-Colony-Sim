/**
 * FEET FIRST, BODY SECOND — the property the corner exists FOR.
 *
 * Adapted from the `chatgpt/continuous-corner-climb` branch, whose diagnosis
 * of this was right even though the patch it shipped changed nothing: with
 * that patch applied the first assertion below still failed at 89.99 degrees,
 * bit-for-bit identical to the branch it was patching.
 *
 * What it holds is the thing a root clamp cannot buy. Her body must not have
 * rotated onto the new surface before two real feet own it — because if it
 * has, she did not climb it, she toppled onto it and the feet caught up.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { LegDrive, type DriveInput, type Ground, type LegSetup } from '../src/anim/legDrive';
import { SurfaceWalker } from '../src/world/surfaceWalk';

const MM = 5;
const RIDE = -0.259 / MM;
const HOMES: Array<[string, number, number, number, number]> = [
  ['frontLeft', -1.796, 0.308, 3.796, 2.982],
  ['frontRight', 1.833, 0.308, 3.796, 3.000],
  ['midLeft', -3.574, 0.234, 0.093, 3.364],
  ['midRight', 3.611, 0.234, 0.093, 3.398],
  ['rearLeft', -2.314, 0.234, -3.611, 4.100],
  ['rearRight', 2.352, 0.234, -3.611, 4.117],
];

const setup = (): LegSetup[] => HOMES.map(([slot, x, y, z, reach]) => ({
  slot,
  home: new THREE.Vector3(x / MM, y / MM, z / MM),
  reach: reach / MM,
}));

function floorWall() {
  const up = new THREE.Vector3(0, 1, 0);
  const ahead = new THREE.Vector3(0, 0, 1);
  const wallAt = 0;
  const P = new THREE.Vector3();
  const density = (x: number, y: number, z: number): number => {
    P.set(x, y, z);
    return Math.max(-P.dot(up), P.dot(ahead) - wallAt);
  };
  const solid = (x: number, y: number, z: number): boolean => density(x, y, z) > 0;
  const walker = new SurfaceWalker(density, {
    cell: 0.2,
    ride: RIDE,
    gripLift: 3 / MM,
    gripReach: 9 / MM,
    align: 12,
    maxTiltRate: (240 * Math.PI) / 180,
    snap: 14,
    gravity: 9,
  }, solid);
  const S = new THREE.Vector3();
  const ground: Ground = {
    nearest: (at, u, down, rise) => walker.cast(
      S.copy(at).addScaledVector(u, rise).clone(), u.clone().negate(), rise + down,
    ),
    probeContact(origin, dir, maxDistance) {
      if (walker.solidAt(origin.x, origin.y, origin.z)) return null;
      const hit = walker.cast(origin, dir, maxDistance);
      if (!hit) return null;
      const normal = new THREE.Vector3();
      walker.normalAt(hit, normal);
      return { point: hit, normal };
    },
  };
  return { up, ahead, wallAt, walker, ground };
}

interface Snap {
  frame: number;
  phase: string;
  onNew: number;
  planted: number;
  tiltDeg: number;
  wallPenMm: number;
  movedMm: number;
}

function run(frames = 720, speedMm = 7.5) {
  const world = floorWall();
  const drive = new LegDrive(setup());
  const body = {
    at: new THREE.Vector3(0, RIDE, world.wallAt - 8 / MM),
    up: world.up.clone(),
    forward: world.ahead.clone(),
  };
  drive.plantAll(body, world.ground);
  const input: DriveInput = {
    walk: 1,
    yaw: 0,
    speed: speedMm / MM,
    yawRate: 2.53,
    spin: false,
    settle: false,
    mayTransition: true,
  };
  const track: Snap[] = [];
  for (let frame = 0; frame < frames; frame += 1) {
    const report = drive.step(1 / 60, body, input, world.ground);
    world.walker.settle(body, 1 / 60);
    const tiltDeg = Math.acos(THREE.MathUtils.clamp(body.up.dot(world.up), -1, 1)) * 180 / Math.PI;
    track.push({
      frame,
      phase: report.corner.phase,
      onNew: report.corner.onNew,
      planted: report.planted,
      tiltDeg,
      wallPenMm: (body.at.dot(world.ahead) - world.wallAt) * MM,
      movedMm: report.movedMm,
    });
  }
  return track;
}

describe('continuous corner body handoff', () => {
  it('does not start turning the body before the leading pair have real grips', () => {
    const track = run();
    const two = track.findIndex((s) => s.onNew >= 2);
    expect(two, 'never established two new-surface front contacts').toBeGreaterThan(0);
    const before = track.slice(0, two);
    expect(Math.max(...before.map((s) => s.tiltDeg))).toBeLessThan(5);
  });

  it('starts curving toward the wall after two grips before the root penetrates it', () => {
    const track = run();
    const two = track.findIndex((s) => s.onNew >= 2);
    expect(two, 'never established two new-surface front contacts').toBeGreaterThan(0);
    const guided = track.slice(two, two + 45).find((s) => s.tiltDeg >= 8);
    expect(guided, 'body never began a controlled turn after the front pair gripped').toBeTruthy();
    expect(guided!.wallPenMm, 'body had to enter the wall before it began turning').toBeLessThanOrEqual(0.05);
  });

  it('returns to ordinary tripod cadence after the corner settles', () => {
    /*
     * Sixty frames, not twelve, and the difference is recovery rather than
     * suppression. Coming off the wall her feet are strung out, and the
     * spread rule walks them back one at a time — each one is a swing, and
     * a swing blocks the tripod trigger because a tripod may not lift while
     * anything is in the air. Measured, the first tripod lands 26 frames
     * after settle. Twelve would fail on the gait working correctly.
     */
    const track = run(900);
    const done = track.findIndex((s) => s.phase === 'settle');
    expect(done, 'corner never reached settle').toBeGreaterThan(0);
    const after = track.slice(done + 1, done + 61);
    expect(after.some((s) => s.planted === 3), 'tripod gait never resumed').toBe(true);
  });

  it('is not a slow mode: she keeps her commanded speed through the handoff', () => {
    /*
     * THIS is what "post-climb slow mode" would actually mean, and it is
     * worth stating separately from cadence because the two were confused.
     * A single-foot cadence is not a slower ant: over the sixty frames after
     * settle she covers 6.86 mm/s against a commanded 7.50, which is her
     * ordinary walk minus the stance clip. Whether she is stepping one foot
     * or three at a time is a shape, not a speed.
     */
    const track = run(900);
    const done = track.findIndex((s) => s.phase === 'settle');
    expect(done, 'corner never reached settle').toBeGreaterThan(0);
    const after = track.slice(done + 1, done + 61);
    const mmPerSecond = after.reduce((sum, s) => sum + s.movedMm, 0) / (after.length / 60);
    expect(mmPerSecond).toBeGreaterThan(7.5 * 0.85);
  });

  it('keeps travelling after handoff instead of remaining in a transition slow state', () => {
    const track = run(900);
    const done = track.findIndex((s) => s.phase === 'settle');
    expect(done, 'corner never reached settle').toBeGreaterThan(0);
    const settled = track.slice(done + 30, done + 120);
    const moving = settled.filter((s) => s.movedMm > 1e-5);
    expect(moving.length, 'no meaningful movement after the corner').toBeGreaterThan(20);
    expect(moving.reduce((sum, s) => sum + s.movedMm, 0)).toBeGreaterThan(4);
  });
});
