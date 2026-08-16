/*
 * THE HUD'S MODE TABLE.
 *
 * The report: ten action plates on screen at once, in every situation, all
 * at the same volume — and the plates were eating the drag that turns the
 * camera. These are the rules that stop that coming back, written against
 * the pure table rather than the DOM. `probe:hudmodes` checks the pixels;
 * this checks the intent.
 */
import { describe, expect, it } from 'vitest';
import {
  HUD_LAYOUTS, partsIn, pickMode, rankOf,
  type HudMode, type HudPart,
} from '../src/scenes/hudModes';

const MODES = Object.keys(HUD_LAYOUTS) as HudMode[];

const ALL_PARTS: HudPart[] = [
  'dig', 'scoop', 'instruments', 'aim', 'roll', 'heading', 'depth',
  'view', 'dodge', 'bite', 'sting', 'carry', 'interact',
  'pace', 'ride', 'tilt', 'poseRow',
];

const quiet = {
  digging: false, posed: false, fighting: false, carrying: false,
};

describe('which mode she is in', () => {
  it('is exploring when nothing else is true', () => {
    expect(pickMode(quiet)).toBe('explore');
  });

  it('lets what the PLAYER armed beat what the world is doing', () => {
    /* The rule that keeps the controls hers. A beetle wandering into reach
     * must not yank the shovel out of her jaws mid-tunnel. */
    expect(pickMode({ ...quiet, digging: true, fighting: true })).toBe('dig');
    expect(pickMode({ ...quiet, posed: true, fighting: true })).toBe('pose');
  });

  it('puts a fight ahead of a load', () => {
    /* A load can wait and can still be put down; a fight cannot. */
    expect(pickMode({ ...quiet, fighting: true, carrying: true })).toBe('combat');
  });

  it('dresses for carrying when her jaws are full and nothing else is on', () => {
    expect(pickMode({ ...quiet, carrying: true })).toBe('carry');
  });
});

describe('what each mode shows', () => {
  it('NEVER shows everything — the whole point', () => {
    /* The bug, as an assertion. Ten plates at once in every situation is
     * what this table exists to make impossible. */
    for (const mode of MODES) {
      expect(partsIn(mode).length).toBeLessThan(ALL_PARTS.length);
    }
  });

  /*
   * SIX PLATES IS WHAT THE CLUSTER HOLDS — measured, not guessed, and it
   * used to be five.
   *
   * The five was honest when it was taken: six wrapped the cluster to a
   * second row and the far end of the FANNED ARC landed on the quest card's
   * text. What has changed is the cluster. It is a two-column grid in the
   * corner now, not an arc, and the plates are smaller — so the old number
   * was measuring a layout that no longer exists.
   *
   * Re-measured by `shot:hudmodes` when the worker caste made six real: as
   * the stinging worker, at 932x430 and at two smaller landscapes, combat
   * draws six in a 122 x 188 box, clear of the quest card and on the glass
   * at every size. The pictures are in `shots/`.
   *
   * This stays as arithmetic in the unit run so a SEVENTH fails here rather
   * than surviving to a device — which is what the five was for.
   *
   * The plates a mode shows are not all "actions": `dig` mode's readouts
   * (instruments, aim, heading, depth) are text, not tappable art, and do
   * not sit in the cluster at all. So this counts the ACTION parts, which
   * are the ones that fan.
   */
  it('never asks the cluster to hold more plates than it fits', () => {
    const READOUTS = new Set(['instruments', 'aim', 'roll', 'heading', 'depth', 'poseRow']);
    for (const mode of Object.keys(HUD_LAYOUTS) as (keyof typeof HUD_LAYOUTS)[]) {
      const plates = partsIn(mode).filter((p) => !READOUTS.has(p));
      /* Named in the assertion so a failure says WHICH mode overflowed.
       * SEVEN, re-measured when the weapons moved into explore: as the
       * worker (the caste that sees all seven), `shot:hudmodes` draws the
       * cluster clear of the quest card at 932x430, 844x390 and 667x375.
       * The pictures are in `shots/`. */
      expect({ mode, over: plates.length > 7 }).toEqual({ mode, over: false });
    }
  });

  /*
   * VIEW IS REACHABLE FROM EVERY MODE THE WORLD CAN DROP YOU INTO.
   *
   * Reported: "realized VIEW wasn't available when I was attacking the
   * beetle, but should allow both 1st and 3rd person." Combat is entered by
   * something ELSE walking up to her, so a camera she had a second ago must
   * not vanish without her choosing it. The same holds for CARRY and plain
   * EXPLORE, and POSE keeps it as its hero.
   *
   * DIG IS THE DELIBERATE EXCEPTION, and this test used to demand the
   * opposite. Arming the shovel IS choosing the first-person aiming eye —
   * the look is the aim — so a VIEW plate there was a button whose only
   * effect was to break the mode's own premise, and it left in the same
   * trim that gave the row its roll instrument. The way out of first
   * person is the way out of the dig: the DIG plate, pinned reachable by
   * the test above.
   */
  it('keeps VIEW reachable in every mode the world chooses', () => {
    for (const mode of ['explore', 'combat', 'carry', 'pose'] as HudMode[]) {
      expect({ mode, view: partsIn(mode).includes('view') })
        .toEqual({ mode, view: true });
    }
  });

  it('and keeps it OUT of the dig, where the look is the aim', () => {
    expect(rankOf('dig', 'view')).toBe('hidden');
  });


  it('keeps normal exploration small, with the weapons dimmed on her hip', () => {
    /*
     * A CHANGE OF MIND, RECORDED. This test used to pin "exploration does
     * not need a sting button", and the player has since asked for the
     * opposite by name: bite and sting at hand for the worker and major,
     * bite for the queen — not parked until a beetle crosses the notice
     * radius. So the weapons ride in explore as CONTEXTUAL plates, dimmed
     * until something is in reach, and the standing controls stay three.
     * Which caste sees which weapon is the ability list's job, not this
     * table's.
     */
    expect(partsIn('explore').sort()).toEqual(
      ['bite', 'carry', 'dig', 'interact', 'pace', 'sting', 'view'].sort(),
    );
    for (const weapon of ['bite', 'sting'] as HudPart[]) {
      expect(rankOf('explore', weapon)).toBe('contextual');
    }
  });

  it('keeps dodging out of exploration and digging out of combat', () => {
    /* Dodge stays a fight-only reflex; the jaws travel everywhere now. */
    expect(rankOf('explore', 'dodge')).toBe('hidden');
    expect(rankOf('combat', 'scoop')).toBe('hidden');
    expect(rankOf('combat', 'dig')).toBe('hidden');
  });

  it('gives every mode exactly one hero', () => {
    for (const mode of MODES) {
      const primaries = ALL_PARTS.filter((p) => rankOf(mode, p) === 'primary');
      expect(primaries).toHaveLength(1);
    }
  });

  it('never ranks a part twice', () => {
    for (const mode of MODES) {
      const named = partsIn(mode);
      expect(new Set(named).size).toBe(named.length);
    }
  });
});

describe('the ways out, which are the ones that strand a player', () => {
  it('leaves DIG reachable from inside digging', () => {
    /* A mode you can enter and cannot leave is the failure that put a
     * hard ceiling on the old rail: the toggle went off the top of the
     * screen and took the way out with it. */
    expect(rankOf('dig', 'dig')).not.toBe('hidden');
  });

  it('clears the deck while the stick is driving her body', () => {
    /* POSE owns no plates now — TILT and RIDE are in the DEV drawer, which
     * is where they are armed from. What the mode does is get everything
     * else out of the way and leave the readout it is driving. The way OUT
     * is the same drawer, so nothing here can strand anyone. */
    expect(rankOf('pose', 'poseRow')).not.toBe('hidden');
    for (const p of ['bite', 'sting', 'dodge', 'scoop'] as HudPart[]) {
      expect(rankOf('pose', p)).toBe('hidden');
    }
  });

  it('lets her put a load down in a FIGHT', () => {
    /* She can be holding a beetle when a second one arrives. A DROP that
     * vanished because the HUD decided this was combat would strand the
     * load with no way to free her jaws. */
    expect(rankOf('combat', 'carry')).toBe('contextual');
  });

  it('offers CARRY in every mode that is not a deliberate rig', () => {
    for (const mode of ['explore', 'combat', 'carry'] as HudMode[]) {
      expect(rankOf(mode, 'carry')).not.toBe('hidden');
    }
  });
});

describe('the dig instruments belong to the dig', () => {
  it('shows the full attitude panel while tunnelling', () => {
    /* Pitch, roll, heading, depth — the four that answer "am I actually
     * going down?", which a loop-de-loop proved a player cannot answer
     * from the picture alone. */
    for (const part of ['instruments', 'aim', 'roll', 'heading', 'depth'] as HudPart[]) {
      expect(rankOf('dig', part)).toBe('secondary');
    }
  });

  it('and nowhere near ordinary walking about', () => {
    for (const part of ['instruments', 'aim', 'roll', 'heading', 'depth'] as HudPart[]) {
      expect(rankOf('explore', part)).toBe('hidden');
    }
  });
});

describe('a stinging caste in a fight', () => {
  /*
   * The founding hands the player a worker, and a worker stings. This file
   * had already written down what that would cost: "if a stinging caste
   * becomes playable, six needs re-measuring rather than re-arguing."
   *
   * It was re-measured and the answer was that five still holds, so DODGE
   * left the combat cluster. The mechanic is untouched — only the plate is
   * gone, and only in a fight.
   */
  it('offers the sting, which is what a worker is for', () => {
    expect(partsIn('combat')).toContain('sting');
  });

  it('keeps dodge, because combat is the only place it has', () => {
    /*
     * Dropping dodge was the first answer and it was withdrawn on
     * measurement: combat is the ONLY mode that shows it, so taking its
     * seat would not have moved it, it would have removed dodging from the
     * HUD altogether. On a phone that is the mechanic gone.
     */
    expect(partsIn('combat')).toContain('dodge');
    const elsewhere = MODES.filter((m) => m !== 'combat')
      .some((m) => partsIn(m).includes('dodge'));
    expect(elsewhere).toBe(false);
  });

  it('is six, which was RE-measured rather than re-argued', () => {
    const READOUT = new Set<HudPart>(['instruments', 'aim', 'heading', 'depth']);
    expect(partsIn('combat').filter((p) => !READOUT.has(p)).length).toBe(6);
  });

  it('keeps the camera, which was asked for by name', () => {
    /* "realized VIEW wasn't available when I was attacking the beetle, but
     * should allow both 1st and 3rd person." Whatever else moves, this
     * stays. */
    expect(partsIn('combat')).toContain('view');
  });
});
