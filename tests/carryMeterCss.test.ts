import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const INDEX = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/**
 * Regression for the light-load CARRY meter seen on iPhone.
 *
 * The old fill shrank a nine-sliced element whose two end caps kept fixed
 * widths. Around ten percent load the caps consumed the whole element, so
 * the green reading collapsed into a round coin instead of a short bar.
 *
 * The replacement keeps the source mask at the FULL channel size and clips
 * that fixed mask with the element's changing width. That makes 10% mean
 * 10% of the run, without squeezing two caps into the same few pixels.
 *
 * This file intentionally landed before the fix so the branch has a real
 * RED state rather than a regression test written after the answer.
 */
describe('carry meter fill rendering contract', () => {
  it('loads the dedicated carry-meter correction stylesheet', () => {
    expect(INDEX).toContain('/src/scenes/carryMeter.css');
  });

  it('clips a fixed-size fill mask instead of nine-slicing a shrinking one', () => {
    const css = readFileSync(
      new URL('../src/scenes/carryMeter.css', import.meta.url),
      'utf8',
    );

    expect(css).toContain('width: calc(var(--tm-level, 0) * 131.5px)');
    expect(css).toContain('-webkit-mask-size: 131.5px 17.2px');
    expect(css).toContain('mask-size: 131.5px 17.2px');
    expect(css).toContain('-webkit-mask-box-image: none');
    expect(css).toContain('mask-border: none');
    expect(css).not.toMatch(/mask-box-image:\s*url\(/);
  });
});
