declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

/**
 * Full-screen DOM loading overlay for the island scene.
 *
 * The island build is front-loaded and heavy — height data, textures, the
 * island mesh itself, the soil stream, first chunks, the queen model — and
 * until the first real frame renders the WebGL canvas is just black (or, worse,
 * the clear colour: the blue flash the playtest kept catching). This overlay
 * exists so the player never sees that: it is plain DOM, so it paints
 * immediately on construction, sits above every HUD layer, and eats all input
 * until {@link LoadingOverlay.finish} fades it away.
 *
 * Everything is self-contained on purpose: styles are injected via a private
 * `<style>` element (unique `tm-loading-` class prefix) that lives *inside*
 * the overlay root, so no shared stylesheet is touched and tearing the overlay
 * out of the DOM removes its CSS with it. The host is only ever appended to —
 * never cleared — so it is safe to hand in the same element the game HUD
 * lives in.
 */

/** How long the farewell fade runs (ms). Mirrored into the injected CSS. */
const FADE_MS = 450;

/**
 * Comfortably above any HUD layer the game stacks up (menus, dev tools,
 * toasts). Not MAX_INT — leaving headroom means a future "you really must see
 * this" layer (crash reporter, update prompt) can still get on top if it must.
 */
const Z_INDEX = 100000;

/**
 * The stylesheet, built once per overlay. Interpolating {@link FADE_MS} keeps
 * the CSS transition and the JS resolution timer describing the same fade.
 */
function buildStyles(): string {
  return `
.tm-loading-root {
  position: fixed;
  inset: 0;
  z-index: ${Z_INDEX};
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1.1rem;
  background: #0b0d10;
  /* Block every click/touch from reaching the HUD or canvas underneath. */
  pointer-events: auto;
  user-select: none;
  opacity: 1;
  transition: opacity ${FADE_MS}ms ease-out;
}
.tm-loading-root.tm-loading-out {
  opacity: 0;
}
.tm-loading-title {
  margin: 0;
  font-family: Georgia, "Iowan Old Style", "Times New Roman", serif;
  font-size: clamp(2rem, 6vw, 3.4rem);
  font-weight: 400;
  color: #d8d2c4;
  letter-spacing: 0.38em;
  /* Letter-spacing trails a phantom gap after the final D; indenting by the
     same amount recentres the visible glyphs. */
  text-indent: 0.38em;
  text-align: center;
}
.tm-loading-version {
  margin: 6px 0 0;
  font: 500 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.08em;
  color: rgba(216, 206, 186, 0.42);
}

.tm-loading-status {
  margin: 0;
  font-family: Georgia, "Iowan Old Style", "Times New Roman", serif;
  font-size: 0.95rem;
  color: #79818c;
  letter-spacing: 0.06em;
  text-align: center;
  max-width: 32rem;
  padding: 0 1rem;
}
.tm-loading-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #c9a35c;
  animation: tm-loading-pulse 1.4s ease-in-out infinite;
}
@keyframes tm-loading-pulse {
  0%, 100% { transform: scale(0.7); opacity: 0.35; }
  50%      { transform: scale(1);   opacity: 0.9;  }
}
/* Error state: the title stays put (never a blank screen), the status turns a
   warm ember tone, and the dot freezes — a stopped heartbeat reads as "this is
   not still loading" without anything vanishing. */
.tm-loading-root.tm-loading-failed .tm-loading-version {
  margin: 6px 0 0;
  font: 500 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.08em;
  color: rgba(216, 206, 186, 0.42);
}

.tm-loading-status {
  color: #e0956b;
}
.tm-loading-root.tm-loading-failed .tm-loading-dot {
  animation: none;
  opacity: 0.25;
}
@media (prefers-reduced-motion: reduce) {
  .tm-loading-dot { animation: none; opacity: 0.6; }
}
`;
}

export class LoadingOverlay {
  private readonly root: HTMLDivElement;
  private readonly statusLine: HTMLParagraphElement;
  private finishPromise: Promise<void> | null = null;
  private removed = false;

  /** True once the overlay has fully faded out and left the DOM. */
  get done(): boolean {
    return this.removed;
  }

  constructor(host: HTMLElement) {
    const doc = host.ownerDocument;

    this.root = doc.createElement('div');
    this.root.className = 'tm-loading-root';

    // The <style> rides inside the root: removing the overlay removes its CSS,
    // and two overlays coexisting (shouldn't happen, but cheap to survive)
    // just duplicate identical rules instead of fighting over a shared node.
    const style = doc.createElement('style');
    style.textContent = buildStyles();
    this.root.appendChild(style);

    const title = doc.createElement('h1');
    title.className = 'tm-loading-title';
    title.textContent = 'THRONEMOUND';
    this.root.appendChild(title);

    this.statusLine = doc.createElement('p');
    this.statusLine.className = 'tm-loading-status';
    // Polite live region: screen readers narrate stage changes without the
    // overlay needing focus.
    this.statusLine.setAttribute('aria-live', 'polite');
    this.statusLine.textContent = 'Preparing the island…';
    this.root.appendChild(this.statusLine);

    /*
     * WHICH BUILD IS THIS. A phone caches aggressively, and a report of
     * "still broken" against code two versions old costs more than the
     * line of text that would have settled it. The lab menu already
     * carries the same stamp; the island had no way to show one.
     */
    const version = doc.createElement('p');
    version.className = 'tm-loading-version';
    /* The VERSION is what identifies a build to the person testing it. The
     * timestamp stays as a tiebreaker, small and second — "is 0.0.12 live
     * yet" is the question actually being asked. */
    version.textContent = `v${__APP_VERSION__}`;
    this.root.appendChild(version);

    const dot = doc.createElement('div');
    dot.className = 'tm-loading-dot';
    dot.setAttribute('aria-hidden', 'true');
    this.root.appendChild(dot);

    // Append — never replace — so a host shared with the game HUD keeps all
    // of the HUD's children intact underneath us.
    host.appendChild(this.root);
  }

  /**
   * Update the status line. The scene calls this as each loading stage lands
   * (height data, textures, island build, soil stream, first chunks, queen
   * model). A no-op once the overlay has left the DOM.
   */
  setStatus(text: string): void {
    if (this.removed) return;
    this.statusLine.textContent = text;
  }

  /**
   * Switch to the error state: the status line carries the message in a warm
   * error tone and the pulse stops. The overlay deliberately stays on screen —
   * a frozen loading screen with a readable message beats a blank canvas.
   * Ignored once {@link finish} has begun; the overlay is already leaving
   * because the scene declared success.
   */
  fail(message: string): void {
    if (this.removed || this.finishPromise !== null) return;
    this.root.classList.add('tm-loading-failed');
    this.statusLine.textContent = message;
  }

  /**
   * Fade out over ~{@link FADE_MS} ms, remove the overlay from the DOM, and
   * resolve. Idempotent — every call returns the same promise, so the scene
   * can call it from several completion paths without double-removal.
   */
  finish(): Promise<void> {
    if (this.finishPromise !== null) return this.finishPromise;

    this.finishPromise = new Promise<void>((resolve) => {
      const settle = (): void => {
        if (this.removed) return;
        this.removed = true;
        this.root.remove();
        resolve();
      };

      this.root.classList.add('tm-loading-out');
      this.root.addEventListener('transitionend', (event: TransitionEvent) => {
        // Only our own opacity fade counts — a stray transition bubbling from
        // a child must not cut the farewell short.
        if (event.target === this.root && event.propertyName === 'opacity') {
          settle();
        }
      });
      // transitionend can be swallowed entirely (backgrounded tab, an ancestor
      // going display:none, jsdom in tests). The timer backstop guarantees the
      // promise resolves and the overlay leaves either way.
      setTimeout(settle, FADE_MS + 150);
    });

    return this.finishPromise;
  }
}
