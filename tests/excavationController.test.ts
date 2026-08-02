import { describe, expect, it } from 'vitest';
import { ExcavationController } from '../src/scenes/ExcavationController';
import { makeDigFrame } from '../src/scenes/excavationPath';

describe('ExcavationController', () => {
  const frame = () => makeDigFrame(
    { x: 10, y: 20, z: 30 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 1, z: 0 },
  );

  it('owns pose and camera rules only while excavation is active', () => {
    const controller = new ExcavationController();
    expect(controller.active).toBe(false);
    expect(controller.cameraCollidesWithTerrain).toBe(true);
    expect(controller.xrayMix).toBe(0);

    controller.enter(frame());
    expect(controller.active).toBe(true);
    expect(controller.cameraCollidesWithTerrain).toBe(false);
    expect(controller.xrayMix).toBe(1);

    controller.exit();
    expect(controller.active).toBe(false);
    expect(controller.cameraCollidesWithTerrain).toBe(true);
    expect(controller.xrayMix).toBe(0);
  });

  it('advances from its captured frame without reading a terrain normal', () => {
    const controller = new ExcavationController();
    controller.enter(frame());
    const beforeUp = { ...controller.frame!.up };

    controller.step({ distanceMm: 5, yawDeg: 0, pitchDeg: -30 });

    expect(controller.frame!.position.y).toBeLessThan(20);
    expect(controller.frame!.position.z).toBeGreaterThan(34);
    expect(beforeUp).toEqual({ x: 0, y: 1, z: 0 });
    expect(controller.samples).toHaveLength(2);
  });

  it('records one centerline shared by manual excavation and later terrain carving', () => {
    const controller = new ExcavationController();
    controller.enter(frame());
    controller.step({ distanceMm: 2, yawDeg: 0, pitchDeg: 0 });
    controller.step({ distanceMm: 2, yawDeg: 15, pitchDeg: 0 });

    const path = controller.path();
    expect(path.branches).toHaveLength(1);
    expect(path.branches[0]!.points).toHaveLength(3);
    expect(path.branches[0]!.points[0]!.position).toEqual({ x: 10, y: 20, z: 30 });
  });

  it('returns the final stable frame on exit for crawler reacquisition', () => {
    const controller = new ExcavationController();
    controller.enter(frame());
    controller.step({ distanceMm: 4, yawDeg: 20, pitchDeg: -10 });
    const handoff = controller.exit();

    expect(handoff).not.toBeNull();
    expect(handoff!.frame.position).not.toEqual({ x: 10, y: 20, z: 30 });
    expect(handoff!.path.branches[0]!.points.length).toBe(2);
  });
});
