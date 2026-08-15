import { describe, expect, it } from 'vitest';
import { hudArtUrls } from '../src/scenes/hudArt';

/** A stand-in for a stylesheet: rules are just their text. */
const sheet = (...cssText: string[]) => ({ cssRules: cssText.map((t) => ({ cssText: t })) });

describe('the plate art a HUD can wear', () => {
  /*
   * Reported: "sometimes when I press a button, it shows a square border the
   * first time and then the next time, actually is the correct round shape".
   * Half of the plates are classes nothing wears until it is pressed, so
   * their pictures are not fetched until the press. This is the list that
   * gets warmed first.
   */
  it('finds every /ui/ picture the sheet can paint', () => {
    const urls = hudArtUrls([sheet(
      ".tm-art-sprint { background-image: url('/ui/sprint.webp'); }",
      '.tm-art-crawl { background-image: url("/ui/crawl.webp"); }',
      '.tm-art-drop { background-image: url(/ui/drop.webp); }',
      '.tm-meter { background: url(/ui/mask-meter.png) center / contain no-repeat; }',
    )]);
    expect(urls.sort()).toEqual([
      '/ui/crawl.webp', '/ui/drop.webp', '/ui/mask-meter.png', '/ui/sprint.webp',
    ]);
  });

  it('finds them under the Pages base path too', () => {
    /* The build Joshua tests serves from a sub-path, and an earlier draft of
     * the pattern anchored to a leading `/ui/` — which would have warmed
     * exactly nothing in the only build that matters. */
    const urls = hudArtUrls([sheet(
      ".tm-art-bite { background-image: url('/Thronemound-Colony-Sim/ui/bite.webp'); }",
    )]);
    expect(urls).toEqual(['/Thronemound-Colony-Sim/ui/bite.webp']);
  });

  it('takes several pictures out of one rule, and says each once', () => {
    const urls = hudArtUrls([sheet(
      ".a { background: url('/ui/plate-round.webp'), url('/ui/frame-bar.webp'); }",
      ".b { background-image: url('/ui/plate-round.webp'); }",
    )]);
    expect(urls.sort()).toEqual(['/ui/frame-bar.webp', '/ui/plate-round.webp']);
  });

  it('leaves alone what is not our art', () => {
    const urls = hudArtUrls([sheet(
      "@font-face { src: url('/fonts/x.woff2'); }",
      ".m { background-image: url('https://example.com/ui/other.webp'); }",
      '.n { background-image: url(/models/queen.glb); }',
    )]);
    /* A remote sheet's art is not ours to warm, and neither a font nor a
     * model is a plate. The one cross-origin case is kept deliberately: it
     * proves the pattern is about OUR `/ui/`, not any path containing it. */
    expect(urls).toEqual([]);
  });

  it('skips a sheet that will not open rather than falling over', () => {
    /* A cross-origin stylesheet THROWS on `cssRules`. There is no art of
     * ours in one, and a boot that dies on the title screen because a
     * browser extension injected a sheet is not a trade worth making. */
    const hostile = { get cssRules(): never { throw new Error('SecurityError'); } };
    const urls = hudArtUrls([hostile, sheet(".p { background-image: url('/ui/dig.webp'); }")]);
    expect(urls).toEqual(['/ui/dig.webp']);
  });
});
