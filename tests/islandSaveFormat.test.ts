import { describe, expect, it } from 'vitest';

import {
  fromBase64, ISLAND_SAVE_V, parseIslandSave, savedAgo, toBase64,
} from '../src/scenes/islandSave';

const good = {
  v: ISLAND_SAVE_V,
  when: 1_700_000_000_000,
  at: [1, 2, 3],
  up: [0, 1, 0],
  fwd: [0, 0, 1],
  facing: 1.5,
  dug: 'AAAAAA==',
};

describe('reading a saved island', () => {
  it('takes a whole one', () => {
    const save = parseIslandSave(JSON.stringify(good));
    expect(save).not.toBeNull();
    expect(save!.at).toEqual([1, 2, 3]);
    expect(save!.facing).toBeCloseTo(1.5, 9);
  });

  it('returns null rather than throwing on anything it cannot use', () => {
    /*
     * The only caller is a menu deciding whether to offer RESUME, on the boot
     * path. A save from an older build, a half-written one, or something else
     * living under the same key must all read as "there is no save" — an
     * exception here is a game that will not start.
     */
    for (const bad of [
      null,
      '',
      'not json',
      '[]',
      '"a string"',
      JSON.stringify({ ...good, v: 999 }),
      JSON.stringify({ ...good, at: [1, 2] }),
      JSON.stringify({ ...good, at: [1, 2, 'three'] }),
      JSON.stringify({ ...good, up: null }),
      JSON.stringify({ ...good, facing: 'north' }),
      JSON.stringify({ ...good, facing: Number.NaN }),
      JSON.stringify({ ...good, dug: 12 }),
    ]) {
      expect(parseIslandSave(bad as string | null)).toBeNull();
    }
  });

  it('survives a missing timestamp instead of refusing the save', () => {
    /* The dig is the valuable part; a menu that cannot say "2m ago" should
     * still offer the resume. */
    const { when, ...rest } = good;
    expect(when).toBeTruthy();
    const save = parseIslandSave(JSON.stringify(rest));
    expect(save).not.toBeNull();
    expect(save!.when).toBe(0);
  });
});

describe('base64 for a dug nest', () => {
  it('round-trips bytes exactly', () => {
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7) & 0xff;
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
  });

  it('handles a nest far past btoa\'s argument limit', () => {
    /*
     * THE ONE THAT WOULD HAVE BITTEN IN PLAY. The obvious encoder is
     * `btoa(String.fromCharCode(...bytes))`, which spreads every byte into an
     * argument list and throws a range error somewhere past a hundred
     * thousand — which is to say, exactly once a save is worth having. A dug
     * nest reaches that easily at eight bytes a sample.
     */
    const bytes = new Uint8Array(600_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i & 0xff;
    const back = fromBase64(toBase64(bytes));
    expect(back.length).toBe(bytes.length);
    expect(back[0]).toBe(bytes[0]);
    expect(back[123_456]).toBe(bytes[123_456]);
    expect(back.at(-1)).toBe(bytes.at(-1));
  });

  it('round-trips an empty dig', () => {
    expect(fromBase64(toBase64(new Uint8Array(0))).length).toBe(0);
  });
});

describe('how long ago it was saved', () => {
  const now = 1_700_000_000_000;
  it('reads as a person would say it', () => {
    expect(savedAgo(now, now)).toBe('saved just now');
    expect(savedAgo(now - 5 * 60_000, now)).toBe('saved 5m ago');
    expect(savedAgo(now - 3 * 3_600_000, now)).toBe('saved 3h ago');
    expect(savedAgo(now - 26 * 3_600_000, now)).toBe('saved yesterday');
    expect(savedAgo(now - 5 * 86_400_000, now)).toBe('saved 5d ago');
  });

  it('says something sensible with no timestamp at all', () => {
    expect(savedAgo(0, now)).toBe('saved');
  });

  it('never reads as being from the future', () => {
    expect(savedAgo(now + 60_000, now)).toBe('saved just now');
  });
});
