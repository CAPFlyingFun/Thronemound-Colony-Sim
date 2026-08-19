import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { LegDrive, REACH_UP_MM } from '../src/anim/legDrive';

const MM = 5;

const setup = () => ['frontLeft', 'frontRight', 'midLeft', 'midRight', 'rearLeft', 'rearRight']
  .map((slot, i) => ({
    slot,
    home: new THREE.Vector3(i % 2 ? 0.2 : -0.2, 0.05, (i - 2.5) * 0.1),
    reach: 0.4,
  }));

/*
 * HER FEET STAY UNDER HER.
 *
 * Asked for from the device: "the IK should have a max search height to be
 * no higher then the top of the body (Thorax) height to ground... most ants
 * keep their feet below their body so they don't lose their balance."
 *
 * The bound is the TIGHTER of two numbers — the guessed fold limit that was
 * always here, and her own back measured off the bind-pose skin — because
 * measured on this rig her back is the LOOSER of the two (3.17 mm against
 * 2.50 for the queen, 1.37 against 1.11 for the worker). Swapping one for
 * the other would have raised the ceiling by a quarter, which is the
 * opposite of the ask.
 */
describe('how high a foot may reach', () => {
  it('never exceeds the top of her back', () => {
    const low = 0.1;                       // a very low-backed animal, wu
    const drive = new LegDrive(setup(), 1, low);
    expect(drive.reachUpWu).toBe(low);
  });

  it('and never exceeds the fold limit either', () => {
    const tall = 99;                       // a back far above any fold
    const drive = new LegDrive(setup(), 1, tall);
    expect(drive.reachUpWu).toBeCloseTo(REACH_UP_MM / MM, 12);
  });

  it('takes the tighter of the two, whichever that is', () => {
    const fold = REACH_UP_MM / MM;
    for (const back of [0.01, fold / 2, fold, fold * 2, 10]) {
      expect(new LegDrive(setup(), 1, back).reachUpWu).toBeCloseTo(
        Math.min(fold, back), 12,
      );
    }
  });

  it('an unloaded model has NO opinion rather than a limit of nought', () => {
    /* `bodyTopAboveSole` answers 0 before her mesh arrives. Treating that as
     * a real ceiling would forbid every foothold and freeze her mid-stride,
     * so it has to mean "no measurement yet". */
    expect(new LegDrive(setup(), 1, 0).reachUpWu).toBeCloseTo(REACH_UP_MM / MM, 12);
    expect(new LegDrive(setup(), 1).reachUpWu).toBeCloseTo(REACH_UP_MM / MM, 12);
  });

  it('scales with the caste, like every other millimetre in the drive', () => {
    /* A worker is under half a queen; her fold limit shrinks with her, and
     * a ceiling that did not would be a queen's ceiling on a worker. */
    const worker = new LegDrive(setup(), 0.444, 99);
    expect(worker.reachUpWu).toBeCloseTo((REACH_UP_MM * 0.444) / MM, 12);
  });
});
