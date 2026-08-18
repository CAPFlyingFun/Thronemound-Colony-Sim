import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEYS, bindFor, hintFor, pickInputMode, saysKeyboard,
  type InputPref, type IntentAction,
} from '../src/scenes/inputBindings';

/*
 * THE RULES, PINNED — the listeners are a browser's business, but which
 * hand is driving and what a key means are decisions, and every input bug
 * this repo has had was a decision rather than a listener.
 */
describe('the bindings', () => {
  it('covers every action the card names', () => {
    const want: IntentAction[] = [
      'bite', 'sting', 'carry', 'interact', 'dig', 'dodge', 'view', 'pace',
    ];
    for (const action of want) {
      expect(hintFor(action), action).toBeTruthy();
    }
  });

  it('binds no key twice — a key that does two things does neither', () => {
    const keys = DEFAULT_KEYS.map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never steals a movement key', () => {
    /* W/A/S/D, the arrows, Space and C are `islandHud`'s and were working
     * long before this table. A binding that shadowed one would break
     * walking to add a shortcut. */
    for (const b of DEFAULT_KEYS) {
      expect(['w', 'a', 's', 'd', ' ', 'c'], b.key).not.toContain(b.key);
    }
  });

  it('is case-insensitive, because a shouted key is the same key', () => {
    expect(bindFor('E')?.action).toBe('interact');
    expect(bindFor('e')?.action).toBe('interact');
  });

  it('says nothing about keys it does not know', () => {
    expect(bindFor('z')).toBeNull();
    expect(bindFor('F13')).toBeNull();
  });
});

describe('which hand is driving', () => {
  const auto: InputPref = 'auto';

  it('obeys an explicit choice, whatever the hardware says', () => {
    /* A player who says TOUCH on a laptop wants touch. A mode that
     * overrides them is a mode that argues. */
    expect(pickInputMode({ lastUsed: 'key', finePointer: true }, 'touch')).toBe('touch');
    expect(pickInputMode({ lastUsed: 'touch', finePointer: false }, 'pc')).toBe('pc');
  });

  it('on auto, the last hand used wins', () => {
    expect(pickInputMode({ lastUsed: 'key', finePointer: false }, auto)).toBe('pc');
    expect(pickInputMode({ lastUsed: 'touch', finePointer: true }, auto)).toBe('touch');
  });

  it('and falls back to the pointer before anyone has acted', () => {
    expect(pickInputMode({ lastUsed: null, finePointer: true }, auto)).toBe('pc');
    expect(pickInputMode({ lastUsed: null, finePointer: false }, auto)).toBe('touch');
  });

  it('switches BOTH ways — the phone goes back in the hand', () => {
    /* The reason last-used beats a sticky first guess: a phone in a stand
     * with a keyboard has both hands available all session. */
    expect(pickInputMode({ lastUsed: 'key', finePointer: false }, auto)).toBe('pc');
    expect(pickInputMode({ lastUsed: 'touch', finePointer: false }, auto)).toBe('touch');
  });
});

describe('what counts as evidence of a keyboard', () => {
  it('a game key does', () => {
    expect(saysKeyboard('e')).toBe(true);
    expect(saysKeyboard('w')).toBe(true);
    expect(saysKeyboard(' ')).toBe(true);
  });

  it('a bare modifier does NOT', () => {
    /* An on-screen keyboard, an accessibility switch and a browser
     * shortcut all produce these. Flipping the whole HUD because someone
     * brushed Shift would be a control that argues. */
    for (const k of ['shift', 'control', 'alt', 'meta']) {
      expect(saysKeyboard(k), k).toBe(false);
    }
  });

  it('and neither does a key the game has no use for', () => {
    expect(saysKeyboard('F5')).toBe(false);
    expect(saysKeyboard('z')).toBe(false);
  });
});
