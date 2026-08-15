/**
 * WARM THE PLATE ART BEFORE A THUMB ASKS FOR IT.
 *
 * Reported: "sometimes when I press a button, it shows a square border the
 * first time and then the next time, actually is the correct round shape for
 * like the sprint for example".
 *
 * A HUD plate is a `background-image` chosen by a CLASS, and half of them
 * are classes nothing wears until something happens. The pace button starts
 * as `tm-art-walk`; `tm-art-sprint` is only ever applied at the instant you
 * press it, and `tm-art-crawl` at the instant you press it again. The
 * browser has no reason to fetch an image no element is using, and it does
 * not — measured on a booted island, before anything was pressed:
 *
 *     fetched: brood carry dig frame-bar frame-meter icon-* interact menu
 *              pad-move queen sense view walk worker
 *     absent:  sprint crawl drop bite climb scoop attack dodge sting ...
 *
 * Every one of those absent files is a state swap. So the FIRST press of any
 * of them shows a plate with no picture on it for a network round trip —
 * long enough to see on a phone, and gone by the second press because the
 * file is cached by then. That is the shape of the complaint exactly: wrong
 * the first time, right the next.
 *
 * READ FROM THE STYLESHEET RATHER THAN A LIST. A hand-kept list of art is a
 * list that goes stale the first time somebody adds a plate, and the failure
 * is silent and only shows up on a stranger's phone. The stylesheet already
 * knows every picture the HUD can wear, so it is asked. A plate added next
 * month is warmed without anyone remembering this file exists.
 *
 * It is deliberately best-effort: a cross-origin sheet throws on `cssRules`
 * and is skipped, a fetch that fails costs nothing, and nothing waits on any
 * of it. The worst case is exactly the behaviour we have today.
 */

/**
 * Only our own art, and only pictures — not a font, not a cursor.
 *
 * The path is matched WITHOUT anchoring to a leading slash on purpose: the
 * source says `/ui/sprint.webp`, and the Pages build rewrites that to
 * `/Thronemound-Colony-Sim/ui/sprint.webp`. Requiring the root form would
 * have warmed nothing in the only build Joshua actually tests.
 */
const UI_ART = /url\(\s*['"]?([^'")]*\/ui\/[^'")]+\.(?:webp|png))['"]?\s*\)/g;

/** A scheme or a protocol-relative host: somebody else's file. */
const ELSEWHERE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Every `/ui/` image the given stylesheets can paint, deduplicated.
 *
 * Pure and sheet-agnostic so it can be tested without a browser: it wants
 * things with `cssRules`, not a real CSSOM.
 */
export function hudArtUrls(sheets: Iterable<{ cssRules?: ArrayLike<{ cssText?: string }> }>): string[] {
  const found = new Set<string>();
  for (const sheet of sheets) {
    let rules: ArrayLike<{ cssText?: string }> | undefined;
    /* A sheet from another origin throws on access rather than returning
     * nothing. There is no art of ours in one, so it is not worth a word. */
    try { rules = sheet.cssRules; } catch { continue; }
    if (!rules) continue;
    for (let i = 0; i < rules.length; i += 1) {
      const text = rules[i]?.cssText;
      if (!text) continue;
      UI_ART.lastIndex = 0;
      let hit = UI_ART.exec(text);
      while (hit) {
        /* Ours means SAME ORIGIN. Dropping the leading-slash anchor for the
         * Pages base path is what lets a remote sheet's `.../ui/x.webp` in,
         * so the scheme is checked rather than the shape. */
        if (hit[1] && !ELSEWHERE.test(hit[1])) found.add(hit[1]);
        hit = UI_ART.exec(text);
      }
    }
  }
  return [...found];
}

/**
 * Fetch and decode all of it, quietly, off the critical path.
 *
 * Returns how many were started, which is what a probe can check. Nothing
 * awaits the decodes — a warm cache is the point, not a barrier.
 */
export function warmHudArt(doc: Document = document): number {
  const urls = hudArtUrls(doc.styleSheets as unknown as Iterable<CSSStyleSheet>);
  for (const url of urls) {
    const img = new Image();
    /* `decode` rather than just `src`: a fetched-but-undecoded image still
     * costs a frame the first time it is painted, and the whole complaint
     * is about the first paint. A rejection here means the file is missing,
     * which the asset audit catches — it must not become an unhandled one. */
    img.src = url;
    void img.decode().catch(() => {});
  }
  return urls.length;
}
