import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE ROOT LAYOUT, GUARDED AS TEXT.
 *
 * A browser test cannot catch what this catches. The bug was `#app` carrying
 * `top: 0`, `bottom: 0` AND `height: 100dvh` at once — over-constrained, so
 * CSS drops `bottom`, the height wins, and the element is pinned to the top
 * with a band of page showing beneath it. In Chromium `dvh` and `vh` are the
 * same number, so the box came out exactly right and every geometry probe
 * passed while the device showed a gap.
 *
 * So the check is on the RULE rather than on the rendered box: an element
 * that spans its edges must not also be told how tall it is. That is a
 * statement about the stylesheet, and the stylesheet is where it can be
 * tested.
 */
const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

/** Every top-level rule in the sheet, comments already stripped. */
const RULES = [...css.replace(/\/\*[\s\S]*?\*\//g, '')
  .matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selector, body]) => ({
    selectors: (selector ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    body: body!,
  }));

/** The rule whose selector list is exactly this one selector. */
const ruleFor = (selector: string): string => (
  RULES.find((r) => r.selectors.length === 1 && r.selectors[0] === selector)?.body ?? ''
);

/** Declarations of a rule body. */
const declarations = (body: string): string[] => body
  .split(';')
  .map((d) => d.trim())
  .filter(Boolean);

describe('#app fills the viewport', () => {
  const body = ruleFor('#app');

  it('exists as its own rule', () => {
    expect(body).not.toBe('');
  });

  it('is fixed and spans every edge', () => {
    const decls = declarations(body).join(';');
    expect(decls).toMatch(/position:\s*fixed/);
    expect(decls).toMatch(/inset:\s*0/);
  });

  /*
   * THE ONE THAT WOULD HAVE CAUGHT IT. `inset: 0` already says how tall the
   * element is — from the top edge to the bottom edge. Saying it a second
   * time can only disagree, and when it disagrees the browser believes the
   * height and abandons the bottom edge.
   */
  it('does not also declare a height or width', () => {
    for (const d of declarations(body)) {
      expect(d).not.toMatch(/^(height|max-height|min-height)\s*:/);
      expect(d).not.toMatch(/^(width|max-width|min-width)\s*:/);
    }
  });

  /* And it must not inherit one from a shared rule either — which is exactly
   * how it acquired `height: 100dvh` without anybody writing it here. */
  it('is not swept into a shared rule that sizes it', () => {
    const offenders = RULES
      .filter((r) => r.selectors.includes('#app')
        && /(^|;)\s*(height|width)\s*:/.test(r.body))
      .map((r) => r.selectors.join(', '));
    expect(offenders).toEqual([]);
  });
});

describe('the page is the colour of the scene behind it', () => {
  /* A full-bleed 3D canvas with a different colour behind it turns any inset
   * the browser imposes into a visible stripe. `probe:fill` checks this
   * against the live scene; this checks nobody edited the value back. */
  it('paints html, body and #app the scene dark', () => {
    const backgrounds = RULES
      .filter((r) => r.selectors.some((sel) => ['html', 'body', '#app'].includes(sel)))
      .flatMap((r) => [...r.body.matchAll(/(?:^|;)\s*background:\s*([^;]+)/g)]
        .map((m) => m[1]!.trim()));
    expect(backgrounds.length).toBeGreaterThan(0);
    for (const bg of backgrounds) expect(bg).toBe('#1a1d22');
  });
});
