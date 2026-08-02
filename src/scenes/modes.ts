/**
 * What she is currently DOING, as a mode you cycle rather than a pile of
 * buttons that are all live at once.
 *
 * The point is reuse: one action button, one key, one gesture, meaning
 * different things depending on the mode — which is how a game with more
 * verbs than a phone has room for stays playable. It also gives the animation
 * somewhere to hang behaviour that only makes sense sometimes.
 *
 * Which is the head. She turns her face toward the camera in EVERY mode —
 * with the view free to swing round her, a body facing north while you look
 * south should not stare rigidly ahead. But she only PITCHES her face while
 * digging, because an ant that noses at the floor every time you glance down
 * is an ant faceplanting her way across a room.
 *
 * The list is ordered, and cycling wraps. `*` steps forward and `/` steps
 * back on a keyboard; on a phone the MODE button cycles forward on tap.
 */

export type ModeId = 'walk' | 'dig' | 'fight';

export interface Mode {
  id: ModeId;
  /** Shown on the mode button and in the readout. */
  label: string;
  /**
   * Does her head PITCH to follow the look in this mode?
   *
   * Yaw is not listed here because yaw is universal — she turns her face
   * toward the camera in every mode. Only the pitch is gated, and only
   * digging wants it: an ant that noses at the floor every time the camera
   * glances down spends the whole game faceplanting.
   */
  pitchHead: boolean;
  /** The action button this mode offers, if it offers one. */
  action: { id: 'dig'; label: string } | null;
  /** One line for the readout, so the mode explains itself. */
  hint: string;
}

export const MODES: readonly Mode[] = [
  {
    id: 'walk',
    label: 'WALK',
    pitchHead: false,
    action: null,
    hint: 'head turns to your look, stays level',
  },
  {
    id: 'dig',
    label: 'DIG',
    pitchHead: true,
    action: { id: 'dig', label: 'DIG' },
    hint: 'head turns AND pitches — aim down to dig down',
  },
  {
    /*
     * Declared and inert, on purpose and said out loud: there is no combat in
     * this game yet, so this mode changes the label and nothing else. It is
     * here because a cycle of two is not a cycle — a third entry is what
     * proves the wrap works and gives the next verb somewhere to land.
     */
    id: 'fight',
    label: 'COMBAT',
    pitchHead: false,
    action: null,
    hint: 'nothing wired yet — head turns, stays level',
  },
];

/** The next mode round the ring. `step` of -1 goes back. */
export function cycleMode(current: number, step = 1): number {
  return (current + step + MODES.length * 2) % MODES.length;
}
