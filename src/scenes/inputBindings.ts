/**
 * THE BINDINGS AND THE MODE — what a key MEANS, and which hand is driving.
 *
 * The other half of the intent seam. `playerIntent.ts` is the ARBITER: it
 * remembers what each hand is holding and resolves the overlap (a stick
 * released while W is still down, a SCOOP released while Space is still
 * held). This file is the VOCABULARY: which key means which action, and
 * whether the game should be wearing thumbs or a keyboard at all.
 *
 * Two files because they answer different questions and change for
 * different reasons — a new keybind never touches the arbitration, and a
 * new input source never touches the keymap.
 *
 * Foundation Pass step 3 (ChatGPT's plan, Joshua's go, 2026-08-18): "the
 * ant shouldn't care whether BITE came from a gold button or the E key."
 *
 * WHAT WAS ALREADY TRUE, and worth saying before adding anything: the seam
 * half-existed. Every plate on the rail routes through `useAbility(id)`,
 * and the stick and the WASD keys have written the SAME `input` struct
 * since the island had keys at all. So Move and Dig already had one sink
 * with two sources; what was missing was a NAME for the vocabulary, keys
 * for the actions that had none, and a way for the game to KNOW which
 * hand is driving rather than guess.
 *
 * WHAT LIVES HERE: the vocabulary, the default bindings, and the rule that
 * picks which hand is driving. Pure — no DOM, no THREE, no scene — because
 * "which mode should we be in" is the part worth testing without a browser,
 * and every earlier input bug in this repo was a rule, not a listener.
 *
 * WHAT LIVES ELSEWHERE: `pcInput.ts` attaches the hardware listeners and
 * pushes what it reads through `PlayerIntent` — the same door the plates
 * and the stick use. The sinks do not know it exists, which is the point.
 */

/** Every command the ant answers to. The card's list, and no more. */
export type IntentAction =
  | 'bite' | 'sting' | 'carry' | 'interact'
  | 'dig' | 'dodge' | 'view' | 'pace'
  /**
   * THE LEFT BUTTON'S JOB, WHICHEVER IT IS. Asked for: "digging should be
   * LMB as well as normal bite." One button, and what it means is read off
   * the shovel — armed, it cuts; idle, it bites. That is the same rule the
   * HUD already draws, where arming DIG swaps the plate row.
   */
  | 'primary'
  /**
   * THE TWO SIGNATURE SLOTS, bound now and empty until there is something
   * to put in them. See `antKinds.ts`: no ant has a signature ability yet
   * (Trello card 31), so these resolve to nothing and say so rather than
   * pretending. The binding exists so the mapping is decided once, in the
   * table, rather than invented later next to a mechanic.
   */
  | 'ability1' | 'ability2';

/**
 * WHICH HAND IS DRIVING. Two presentations of one game — the mechanics are
 * identical either way, which is the acceptance the card asks for.
 */
export type InputMode = 'touch' | 'pc';

/** What the player asked for in Settings. `auto` follows the last hand used. */
export type InputPref = 'auto' | 'touch' | 'pc';

export interface KeyBind {
  /** Lower-case `KeyboardEvent.key`. Space is `' '`. */
  readonly key: string;
  readonly action: IntentAction;
  /** A label for the plate's key hint — usually the key, made readable. */
  readonly hint: string;
}

/**
 * THE DEFAULT BINDINGS.
 *
 * MOVEMENT IS NOT IN THIS TABLE, and that is not an omission: W/A/S/D,
 * the arrows, Shift and C have driven `input` from `islandHud`'s own key
 * handler since long before this file, alongside the stick, and moving
 * working bindings to prove a point would be churn with a regression
 * attached. Space is likewise already the shovel's stroke. What is here
 * is what had NO key at all — the four jaw actions, the dodge, and the
 * two presentation toggles — plus the ones that had one, listed so the
 * HUD can print a complete key hint.
 *
 * CHOSEN TO BE GUESSABLE rather than clever: E interacts because every
 * game interacts with E, F fetches, Q and R are the two attacks under the
 * left hand, G grounds the shovel, V is the view it already was.
 *
 * SHIFT IS NOT HERE ANY MORE, and its absence is a bug fix. `islandHud`
 * has read Shift as a held run since long before this file, and this table
 * also cycled the pace latch with it — so one press did both, and the two
 * disagreed about what Shift means. It is a MODIFIER now, per the device
 * spec: Shift plus a mouse button picks a signature ability. The held run
 * stays where it always was.
 *
 * MOUSE BUTTONS LIVE IN THEIR OWN TABLE below, not this one, because they
 * carry a modifier and a key does not.
 */
export const DEFAULT_KEYS: readonly KeyBind[] = [
  { key: 'q', action: 'bite', hint: 'Q' },
  { key: 'r', action: 'sting', hint: 'R' },
  { key: 'f', action: 'carry', hint: 'F' },
  { key: 'e', action: 'interact', hint: 'E' },
  { key: 'g', action: 'dig', hint: 'G' },
  { key: 'x', action: 'dodge', hint: 'X' },
  { key: 'v', action: 'view', hint: 'V' },
];

/**
 * THE MOUSE, as asked for from the device:
 *
 *   "digging should be LMB as well as normal bite, and RMB for Sting (if
 *   applicable), with SHIFT + LMB = (Special Ability #1), and SHIFT + RMB =
 *   (Special Ability #2)"
 *
 * Buttons are `PointerEvent.button` — 0 left, 2 right. Held state matters
 * for the left button only: digging is a stroke you hold, and `pcInput`
 * turns a held primary into `PlayerIntent.setDig` rather than a one-shot.
 *
 * THE CAPTURING CLICK STILL DOES NOT ACT. That was the whole reason there
 * were no mouse bindings before, and it is answered rather than reversed:
 * the click that takes pointer lock is swallowed, and every click after it
 * is the player's. See `pcInput.onPointerDown`.
 */
export interface MouseBind {
  readonly button: 0 | 2;
  readonly shift: boolean;
  readonly action: IntentAction;
  readonly hint: string;
}

export const DEFAULT_MOUSE: readonly MouseBind[] = [
  { button: 0, shift: false, action: 'primary', hint: 'LMB' },
  { button: 2, shift: false, action: 'sting', hint: 'RMB' },
  { button: 0, shift: true, action: 'ability1', hint: 'SHIFT+LMB' },
  { button: 2, shift: true, action: 'ability2', hint: 'SHIFT+RMB' },
];

/** What a mouse button means, with or without the modifier held. */
export function mouseBindFor(
  button: number, shift: boolean, map: readonly MouseBind[] = DEFAULT_MOUSE,
): MouseBind | null {
  return map.find((b) => b.button === button && b.shift === shift) ?? null;
}

/** The binding for a key press, or null if that key means nothing. */
export function bindFor(
  key: string, map: readonly KeyBind[] = DEFAULT_KEYS,
): KeyBind | null {
  const want = key.toLowerCase();
  return map.find((b) => b.key === want) ?? null;
}

/** Every action's hint, for the HUD's key badges. */
export function hintFor(
  action: IntentAction, map: readonly KeyBind[] = DEFAULT_KEYS,
): string | null {
  return map.find((b) => b.action === action)?.hint ?? null;
}

/**
 * WHAT THE GAME HAS SEEN. `lastUsed` is the hand that most recently did
 * something — the honest signal, because a phone plugged into a keyboard
 * has BOTH and the question is which one is in use right now.
 */
export interface ModeSignals {
  /** The hand that acted most recently, or null before anyone has. */
  readonly lastUsed: 'key' | 'touch' | null;
  /** `matchMedia('(pointer: fine)')` — a mouse-shaped pointer exists. */
  readonly finePointer: boolean;
}

/**
 * WHICH PRESENTATION TO WEAR.
 *
 * An explicit choice in Settings is obeyed, always — a player who says
 * TOUCH on a laptop wants touch, and a mode that overrides them is a mode
 * that argues. On AUTO the last hand used wins, so putting the phone in a
 * stand and reaching for the keyboard switches without a menu, and picking
 * it back up switches back. Before anyone has touched anything, a fine
 * pointer is the only evidence there is.
 */
export function pickInputMode(s: ModeSignals, pref: InputPref): InputMode {
  if (pref === 'touch') return 'touch';
  if (pref === 'pc') return 'pc';
  if (s.lastUsed === 'key') return 'pc';
  if (s.lastUsed === 'touch') return 'touch';
  return s.finePointer ? 'pc' : 'touch';
}

/**
 * IS THIS KEY PRESS EVIDENCE OF A KEYBOARD?
 *
 * A bare modifier is not: an on-screen keyboard, an accessibility switch
 * and a browser shortcut all produce them, and flipping the whole HUD
 * because someone brushed Shift would be a control that argues. A key
 * that MEANS something in the game is real evidence.
 */
export function saysKeyboard(key: string, map: readonly KeyBind[] = DEFAULT_KEYS): boolean {
  const k = key.toLowerCase();
  if (k === 'shift' || k === 'control' || k === 'alt' || k === 'meta') return false;
  if (MOVE_KEYS.has(k)) return true;
  return bindFor(k, map) !== null;
}

/** The movement keys `islandHud` owns — listed here so mode detection and
 *  the HUD's hints can speak about them without owning them. */
export const MOVE_KEYS: ReadonlySet<string> = new Set([
  'w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
  ' ', 'c',
]);
