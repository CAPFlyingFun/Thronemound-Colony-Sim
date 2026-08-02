import { describe, expect, it } from 'vitest';
import { MODES, cycleMode } from '../src/scenes/modes';
import {
  HEAD_BIND_PITCH, HEAD_PITCH_DOWN, HEAD_PITCH_UP, QUEEN_RIG, gaitPose,
} from '../src/anim/hexapod';

const base = { clock: 0, cycle: 0, speed: 0, turn: 0, digging: 0, carrying: 0 };

describe('mode ring', () => {
  it('wraps in both directions, so the last mode is one step from the first', () => {
    expect(cycleMode(MODES.length - 1)).toBe(0);
    expect(cycleMode(0, -1)).toBe(MODES.length - 1);
  });

  it('has more than two, because a cycle of two is a toggle', () => {
    expect(MODES.length).toBeGreaterThan(2);
    expect(new Set(MODES.map((m) => m.id)).size).toBe(MODES.length);
  });

  it('pitches her head in exactly one mode, and it is digging', () => {
    /*
     * The whole point of the split. Yaw is universal and is not listed on a
     * mode at all; pitch is what would have her nosing at the floor every
     * time the camera glanced down while walking.
     */
    const pitching = MODES.filter((m) => m.pitchHead);
    expect(pitching).toHaveLength(1);
    expect(pitching[0]!.id).toBe('dig');
  });

  it('only offers an action where there is one to offer', () => {
    // A mode with no verb hides its button rather than greying it out, so an
    // inert mode must genuinely declare no action.
    expect(MODES.find((m) => m.id === 'dig')!.action?.id).toBe('dig');
    expect(MODES.find((m) => m.id === 'walk')!.action).toBeNull();
    expect(MODES.find((m) => m.id === 'fight')!.action).toBeNull();
  });
});

describe('head aim', () => {
  it('takes an ABSOLUTE aim and clamps it there', () => {
    /*
     * The contract is the simple one: the bone's pitch IS the camera's. So
     * what goes in is where her face should point, not an offset from
     * anything, and what comes out is the rotation from the bind pose that
     * lands it there.
     */
    const down = gaitPose({ ...base, headPitch: -3 }, QUEEN_RIG);
    const up = gaitPose({ ...base, headPitch: 3 }, QUEEN_RIG);
    expect(down.headPitch).toBeCloseTo(-HEAD_PITCH_DOWN - HEAD_BIND_PITCH, 6);
    expect(up.headPitch).toBeCloseTo(HEAD_PITCH_UP - HEAD_BIND_PITCH, 6);
    // Asymmetric, because she works with her face on the floor.
    expect(HEAD_PITCH_DOWN).toBeGreaterThan(HEAD_PITCH_UP);
  });

  it('holds her BIND pose when no aim is given, rather than snapping level', () => {
    // Which is what WALK mode passes: her head is not the player's to point.
    expect(gaitPose({ ...base }, QUEEN_RIG).headPitch).toBeCloseTo(0, 9);
  });

  it('keeps the aim OUT of the bone rotations', () => {
    /*
     * It has to travel as intent rather than as a bone-local Euler: measured
     * on the queen's head, thirty degrees about local Y swings her face 2.4
     * degrees, because Y runs along the neck. `QueenModel` applies it in her
     * frame instead. If the aim ever leaks back into `rotations`, the head
     * would be turned twice and mostly in the wrong direction.
     */
    const head = QUEEN_RIG.thorax[QUEEN_RIG.thorax.length - 1]!;
    const still = gaitPose({ ...base }, QUEEN_RIG).rotations.get(head)!;
    const turned = gaitPose({ ...base, headYaw: 0.9, headPitch: -0.6 }, QUEEN_RIG)
      .rotations.get(head)!;
    expect(turned).toEqual(still);
  });

  it('still dips her head for a dig, which is what puts her jaw on the soil', () => {
    // The dip takes the jaw from 1.121 mm over the soil to 0.070 mm, and it
    // is the only reason a bite at the mandible reaches ground at a level aim.
    const head = QUEEN_RIG.thorax[QUEEN_RIG.thorax.length - 1]!;
    const rest = gaitPose({ ...base }, QUEEN_RIG).rotations.get(head)![0];
    const dig = gaitPose({ ...base, digging: 1 }, QUEEN_RIG).rotations.get(head)![0];
    expect(dig).toBeGreaterThan(rest + 0.3);
  });
});
