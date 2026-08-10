/**
 * WALKING ON EVERYTHING, checked against shapes with known answers.
 *
 * The claim is that she has no world down — only a surface — so the tests are
 * the cases where those two disagree: a wall, a ceiling, and the trip over an
 * edge between them. A sphere of soil is the sharpest version of it, because
 * every direction is somebody's floor and world +Y is right exactly once.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SurfaceWalker, type WalkFrame } from '../src/world/surfaceWalk';

const TUNE = {
  cell: 0.2,
  ride: 0.26,
  gripLift: 0.6,
  gripReach: 1.8,
  align: 12,
  maxTiltRate: (240 * Math.PI) / 180,
  snap: 14,
  deadband: 0.06,
  gravity: 9,
};

/** A ball of soil centred on the origin: density falls off with radius. */
const ball = (radius: number) =>
  (x: number, y: number, z: number): number => radius - Math.hypot(x, y, z);

/** A slab of soil with a flat top at y = 0, and a wall at x = 4. */
const slabAndWall = (x: number, y: number, z: number): number => Math.max(-y, x - 4);

function frameAt(at: THREE.Vector3, up: THREE.Vector3, forward: THREE.Vector3): WalkFrame {
  return { at: at.clone(), up: up.clone().normalize(), forward: forward.clone().normalize() };
}

/** Run her forward at `speed` for `seconds`, settling every step. */
function walk(
  walker: SurfaceWalker, frame: WalkFrame, speed: number, seconds: number, dt = 1 / 60,
): void {
  for (let t = 0; t < seconds; t += dt) {
    frame.at.addScaledVector(frame.forward, speed * dt);
    walker.settle(frame, dt);
  }
}

describe('the surface walker has no world down', () => {
  it('reads its up off the field, pointing out of the soil', () => {
    const walker = new SurfaceWalker(ball(3), TUNE);
    const out = new THREE.Vector3();

    walker.normalAt(new THREE.Vector3(3, 0, 0), out);
    expect(out.x).toBeCloseTo(1, 4);

    // Underneath the ball, "out" is straight DOWN in world terms.
    walker.normalAt(new THREE.Vector3(0, -3, 0), out);
    expect(out.y).toBeCloseTo(-1, 4);
  });

  it('seats her a ride height off whatever she is standing on', () => {
    const walker = new SurfaceWalker(ball(3), TUNE);
    const frame = frameAt(
      new THREE.Vector3(0, 3.5, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0),
    );
    for (let i = 0; i < 120; i += 1) walker.settle(frame, 1 / 60);
    expect(frame.at.length()).toBeCloseTo(3 + TUNE.ride, 2);
  });

  it('walks her right around a ball, underside included', () => {
    const walker = new SurfaceWalker(ball(3), TUNE);
    const frame = frameAt(
      new THREE.Vector3(0, 3.26, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0),
    );
    // A quarter of the way round puts her on the side, where up is +X.
    walk(walker, frame, 2, (Math.PI / 2) * 3.26 / 2);
    expect(walker.gripping).toBe(true);
    expect(frame.up.x).toBeGreaterThan(0.7);
    expect(frame.at.length()).toBeCloseTo(3 + TUNE.ride, 1);

    // Another quarter and she is UNDER it: her up points at the ground.
    walk(walker, frame, 2, (Math.PI / 2) * 3.26 / 2);
    // Standing still for a moment lets the rate-capped attitude finish
    // arriving — the seat is immediate, the roll deliberately is not.
    walk(walker, frame, 0, 1);
    expect(walker.gripping).toBe(true);
    expect(frame.up.y).toBeLessThan(-0.7);
    expect(frame.at.y).toBeLessThan(-3);
    expect(frame.at.length()).toBeCloseTo(3 + TUNE.ride, 1);
  });

  it('turns onto a wall instead of being stopped by it', () => {
    const walker = new SurfaceWalker(slabAndWall, TUNE);
    const frame = frameAt(
      new THREE.Vector3(0, TUNE.ride, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0),
    );
    walk(walker, frame, 2, 6);
    // She is up the wall: her up has swung to face away from it (-X), and
    // she has climbed well above the slab she started on.
    expect(walker.gripping).toBe(true);
    expect(frame.up.x).toBeLessThan(-0.7);
    expect(frame.at.y).toBeGreaterThan(2);
  });

  it('holds her nose square to her up as she turns onto a wall', () => {
    const walker = new SurfaceWalker(slabAndWall, TUNE);
    const frame = frameAt(
      new THREE.Vector3(0, TUNE.ride, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0),
    );
    for (let i = 0; i < 360; i += 1) {
      frame.at.addScaledVector(frame.forward, 2 / 60);
      walker.settle(frame, 1 / 60);
      expect(Math.abs(frame.forward.dot(frame.up))).toBeLessThan(1e-6);
      expect(frame.forward.length()).toBeCloseTo(1, 6);
    }
  });

  it('caps how fast her attitude may swing, however violent the goal', () => {
    const walker = new SurfaceWalker(ball(3), TUNE);
    const frame = frameAt(
      new THREE.Vector3(0, 3.26, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0),
    );
    const dt = 1 / 60;
    walker.aimUp(frame, new THREE.Vector3(0, -1, 0), dt);
    const swung = Math.acos(THREE.MathUtils.clamp(frame.up.y, -1, 1));
    expect(swung).toBeLessThanOrEqual(TUNE.maxTiltRate * dt + 1e-9);
  });

  it('freezes her attitude when handed a zero attitude step', () => {
    const walker = new SurfaceWalker(ball(3), TUNE);
    const frame = frameAt(
      new THREE.Vector3(3.26, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1),
    );
    const before = frame.up.clone();
    for (let i = 0; i < 60; i += 1) walker.settle(frame, 1 / 60, 0);
    expect(frame.up.distanceTo(before)).toBeLessThan(1e-9);
  });

  it('takes hold again from inside the soil rather than flying to the top', () => {
    const walker = new SurfaceWalker(ball(3), TUNE);
    // Buried a little under the side of the ball.
    const frame = frameAt(
      new THREE.Vector3(2.7, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1),
    );
    for (let i = 0; i < 120; i += 1) walker.settle(frame, 1 / 60);
    expect(frame.at.length()).toBeGreaterThan(3);
    // Out through the NEAR surface, not hauled up to the north pole.
    expect(frame.at.x).toBeGreaterThan(2.9);
    expect(frame.at.y).toBeLessThan(1);
  });

  it('is STILL when she stands still — no limit cycle against the seat', () => {
    /*
     * The vibration. hold() finds the ground two different ways and picks
     * between them on whether her centre is in soil or in air; when their
     * estimates disagree, the two seats straddle that very boundary and she
     * alternates between them at frame rate — measured on the island at
     * 0.08 mm each way, every single frame, ~22 Hz. The dead-band plus the
     * bisected outward search is the fix, and this pins both: after a brief
     * settle she must simply stop, to the last micron, and stay stopped.
     */
    const walker = new SurfaceWalker(slabAndWall, TUNE);
    const frame = frameAt(
      /* A hair inside the slab, as the leg-driven ride leaves her. */
      new THREE.Vector3(0, -0.05, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0),
    );
    for (let i = 0; i < 60; i += 1) walker.settle(frame, 1 / 60, 1 / 60, true);
    const rest = frame.at.clone();
    let travelled = 0;
    for (let i = 0; i < 240; i += 1) {
      const before = frame.at.clone();
      walker.settle(frame, 1 / 60, 1 / 60, true);
      travelled += before.distanceTo(frame.at);
    }
    expect(travelled).toBe(0);
    expect(frame.at.distanceTo(rest)).toBe(0);
  });

  it('keeps the band out of MOTION — moving callers get every correction', () => {
    /*
     * The band applied unconditionally broke cornering: at a wall base the
     * seat migrates onto the new surface in exactly the sub-band steps the
     * band eats. So it is opt-in per frame, and the default is off.
     */
    const walker = new SurfaceWalker(slabAndWall, TUNE);
    const frame = frameAt(
      new THREE.Vector3(0, TUNE.ride + 0.015, 0),
      new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0),
    );
    const before = frame.at.y;
    walker.settle(frame, 1 / 60);
    expect(frame.at.y).not.toBe(before);
  });

  it('still corrects a real disturbance, dead-band or no', () => {
    /* The band must swallow the loop's noise and nothing else: shoved a
     * full millimetre off her seat, she is drawn straight back onto it. */
    const walker = new SurfaceWalker(slabAndWall, TUNE);
    const frame = frameAt(
      new THREE.Vector3(0, TUNE.ride, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0),
    );
    for (let i = 0; i < 60; i += 1) walker.settle(frame, 1 / 60);
    frame.at.y += 0.2;
    for (let i = 0; i < 60; i += 1) walker.settle(frame, 1 / 60, 1 / 60, true);
    expect(Math.abs(frame.at.y - TUNE.ride)).toBeLessThan(TUNE.deadband + 0.02);
  });

  it('falls when there is genuinely nothing to hold, and lands', () => {
    const walker = new SurfaceWalker(ball(3), TUNE);
    const frame = frameAt(
      new THREE.Vector3(0, 20, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0),
    );
    walker.settle(frame, 1 / 60);
    expect(walker.gripping).toBe(false);
    for (let i = 0; i < 600; i += 1) walker.settle(frame, 1 / 60);
    expect(walker.gripping).toBe(true);
    expect(frame.at.length()).toBeCloseTo(3 + TUNE.ride, 1);
  });
});
