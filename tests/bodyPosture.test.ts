/**
 * What the posture controls promise, pinned.
 *
 * The three that are easy to break and impossible to see in a screenshot:
 * forward on the stick means DOWN (asked for by name, and the opposite of
 * every other forward in the game), letting go HOLDS the pose rather than
 * dropping it, and neither control can ask for more than her legs can give.
 */
import { describe, expect, it } from 'vitest';
import { BodyPosture, POSTURE_LIMITS } from '../src/scenes/bodyPosture';
import { REACH_DOWN_MM } from '../src/anim/legDrive';

/** Run the ease to rest, so a target can be compared against a value. */
const settle = (p: BodyPosture): void => {
  for (let i = 0; i < 400; i += 1) p.update(1 / 60);
};

describe('BodyPosture', () => {
  it('starts neutral and ignores a stick nobody armed', () => {
    const p = new BodyPosture();
    expect(p.neutral).toBe(true);
    expect(p.armed).toBe(false);
    p.command(1, 1);
    settle(p);
    expect(p.rideMm).toBe(0);
    expect(p.pitch).toBe(0);
  });

  it('lowers her when the stick goes FORWARD, raises when it comes back', () => {
    const p = new BodyPosture();
    p.toggle('ride');
    p.command(0, 1);
    settle(p);
    expect(p.rideMm).toBeCloseTo(-POSTURE_LIMITS.crouchMm, 3);
    p.command(0, -1);
    settle(p);
    expect(p.rideMm).toBeCloseTo(POSTURE_LIMITS.riseMm, 3);
  });

  it('tilts nose-down on a forward stick and banks right on a right one', () => {
    const p = new BodyPosture();
    p.toggle('tilt');
    p.command(1, 1);
    settle(p);
    /* Both axes follow the stick with the sign the SCREEN showed, not the
     * sign the quaternion was reasoned to want — the roll was reported
     * backwards from a phone and this is the corrected direction. */
    expect(p.pitch).toBeCloseTo(POSTURE_LIMITS.tiltRad, 4);
    expect(p.roll).toBeCloseTo(POSTURE_LIMITS.tiltRad, 4);
  });

  /* A stick pushed LEFT must not come out as a roll to the right. It is the
   * whole of the bug report, and it is one sign away from happening again. */
  it('banks the way the stick is pushed, on both sides', () => {
    const left = new BodyPosture();
    left.toggle('tilt');
    left.command(-1, 0);
    settle(left);
    const right = new BodyPosture();
    right.toggle('tilt');
    right.command(1, 0);
    settle(right);
    expect(Math.sign(left.roll)).toBe(-Math.sign(right.roll));
    expect(left.roll).toBeCloseTo(-POSTURE_LIMITS.tiltRad, 4);
  });

  it('never exceeds its limits however hard the stick is pushed', () => {
    const p = new BodyPosture();
    p.toggle('ride');
    p.command(0, -99);
    settle(p);
    expect(p.rideMm).toBeLessThanOrEqual(POSTURE_LIMITS.riseMm + 1e-6);
    p.toggle('ride');
    p.toggle('tilt');
    p.command(-99, -99);
    settle(p);
    expect(Math.abs(p.pitch)).toBeLessThanOrEqual(POSTURE_LIMITS.tiltRad + 1e-6);
    expect(Math.abs(p.roll)).toBeLessThanOrEqual(POSTURE_LIMITS.tiltRad + 1e-6);
  });

  it('HOLDS the pose when the control is disarmed — that is the point of it', () => {
    const p = new BodyPosture();
    p.toggle('tilt');
    p.command(0, 1);
    settle(p);
    const held = p.pitch;
    expect(held).toBeGreaterThan(0);
    p.disarm();
    settle(p);
    expect(p.armed).toBe(false);
    expect(p.pitch).toBeCloseTo(held, 6);
    expect(p.neutral).toBe(false);
  });

  it('comes home only when centred, and reset snaps', () => {
    const p = new BodyPosture();
    p.toggle('tilt');
    p.command(1, 1);
    settle(p);
    p.centre();
    settle(p);
    expect(p.pitch).toBeCloseTo(0, 5);
    expect(p.roll).toBeCloseTo(0, 5);
    expect(p.neutral).toBe(true);

    p.toggle('ride');
    p.command(0, 1);
    p.update(1 / 60);
    p.reset();
    expect(p.rideMm).toBe(0);
    expect(p.mode).toBe('off');
    expect(p.neutral).toBe(true);
  });

  it('never asks a leg to reach further down than it physically can', () => {
    /*
     * The bug this pins: a uniform body rise raises every leg's home by the
     * same amount, which is the identical demand a downward lip makes on a
     * walking leg. A rise that used the tightest leg's WHOLE spare left
     * nothing for a lip on top of it, and the report from play was exactly
     * that — a foot held its old anchor while the body kept rising. So the
     * rise must sit strictly under the tightest leg's reach, with something
     * left over.
     */
    const tightest = Math.min(...Object.values(REACH_DOWN_MM));
    expect(POSTURE_LIMITS.riseMm).toBeLessThan(tightest);
    expect(tightest - POSTURE_LIMITS.riseMm).toBeGreaterThan(0.2);
  });

  it('only one control owns the stick at a time', () => {
    const p = new BodyPosture();
    p.toggle('ride');
    expect(p.mode).toBe('ride');
    p.toggle('tilt');
    expect(p.mode).toBe('tilt');
    /* A ride command while TILT is armed must not move her height. */
    p.command(0, 1);
    settle(p);
    expect(p.rideMm).toBe(0);
    expect(p.pitch).not.toBe(0);
  });
});
