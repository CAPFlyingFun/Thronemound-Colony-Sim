import { describe, expect, it } from 'vitest';
import {
  PREF_DEFAULTS, PREF_RANGE, sanitizePrefs,
} from '../src/scenes/devicePrefs';

/*
 * THE PREFERENCES SURVIVE ANYTHING THE STORAGE HANDS BACK.
 *
 * A settings blob outlives versions, hand edits, and half-written saves.
 * The one promise that keeps every future field safe is: whatever comes
 * in, what comes out is complete, clamped, and typed — one bad field
 * degrades itself to its default and nothing else.
 */
describe('sanitizing a stored blob', () => {
  it('an empty or missing blob is exactly the defaults', () => {
    expect(sanitizePrefs(undefined)).toEqual(PREF_DEFAULTS);
    expect(sanitizePrefs(null)).toEqual(PREF_DEFAULTS);
    expect(sanitizePrefs({})).toEqual(PREF_DEFAULTS);
  });

  it('every number is clamped to its own rails', () => {
    const wild = sanitizePrefs({
      fov1: 500, fov3: -20, lookSens: 99, resScale: 0.01, invertY: true,
    });
    expect(wild.fov1).toBe(PREF_RANGE.fov1.max);
    expect(wild.fov3).toBe(PREF_RANGE.fov3.min);
    expect(wild.lookSens).toBe(PREF_RANGE.lookSens.max);
    expect(wild.resScale).toBe(PREF_RANGE.resScale.min);
    expect(wild.invertY).toBe(true);
  });

  it('a mangled field falls back alone — its neighbours survive', () => {
    const got = sanitizePrefs({
      fov1: 'seventy', fov3: 80, lookSens: NaN, invertY: 'yes', resScale: 0.75,
    });
    expect(got.fov1).toBe(PREF_DEFAULTS.fov1);
    expect(got.fov3).toBe(80);
    expect(got.lookSens).toBe(PREF_DEFAULTS.lookSens);
    expect(got.invertY).toBe(PREF_DEFAULTS.invertY);
    expect(got.resScale).toBe(0.75);
  });

  it('keeps only a real input mode, and defaults the rest', () => {
    /* The one non-numeric, non-boolean field: three named values, and a
     * blob claiming anything else is a blob claiming nothing. */
    expect(sanitizePrefs({ inputMode: 'pc' }).inputMode).toBe('pc');
    expect(sanitizePrefs({ inputMode: 'touch' }).inputMode).toBe('touch');
    expect(sanitizePrefs({ inputMode: 'auto' }).inputMode).toBe('auto');
    expect(sanitizePrefs({ inputMode: 'gamepad' }).inputMode).toBe('auto');
    expect(sanitizePrefs({ inputMode: 7 }).inputMode).toBe('auto');
  });

  it('the defaults themselves pass through untouched', () => {
    /* An untouched panel must change nothing about the game — the
     * defaults ARE what every player had before the panel existed. */
    expect(sanitizePrefs({ ...PREF_DEFAULTS })).toEqual(PREF_DEFAULTS);
    expect(PREF_DEFAULTS.fov1).toBe(60);
    expect(PREF_DEFAULTS.fov3).toBe(60);
    expect(PREF_DEFAULTS.lookSens).toBe(1);
    expect(PREF_DEFAULTS.invertY).toBe(false);
    expect(PREF_DEFAULTS.resScale).toBe(1);
    /* AUTO by default: a phone stays a phone until a keyboard says
     * otherwise, and a laptop is a laptop from the first frame. */
    expect(PREF_DEFAULTS.inputMode).toBe('auto');
  });
});
