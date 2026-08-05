/**
 * Collapsible wrapper for the island's developer telemetry.
 *
 * IslandScene rewrites a status <div> (class "density-lab-status") once per
 * second with island/soil/fps numbers. Handy while tuning, but it covered the
 * island in every screenshot and read as UI to a player. This panel hides that
 * body behind a small "STATS" chip in the top-left corner: collapsed by
 * default, one tap to expand, one tap to fold away again — all the telemetry
 * kept, none of it imposed.
 *
 * The scene keeps producing the exact same telemetry string — it just calls
 * setHTML() here instead of touching innerHTML itself. While collapsed we only
 * store the string (an innerHTML parse every second for a hidden element is
 * pure waste); the freshest snapshot is flushed to the DOM the moment the
 * panel opens, so it never shows stale data.
 *
 * The chip sits top-LEFT because the island's action buttons (DIG, the mode
 * chip, SONAR, VIEW) own the bottom-right and the joystick spawns on the
 * bottom-left — the top-left is the one corner gameplay never touches.
 */
export class DebugStatsPanel {
  private readonly chip: HTMLButtonElement;

  private readonly body: HTMLDivElement;

  private open = false;

  // Last telemetry string handed to setHTML(), and whether the DOM has seen
  // it yet — collapsed updates only mark it dirty.
  private latestHTML = '';

  private domDirty = false;

  constructor(hud: HTMLElement) {
    injectStyles();

    this.chip = document.createElement('button');
    this.chip.type = 'button';
    this.chip.className = 'tm-stats-chip';
    this.chip.textContent = 'STATS';
    this.chip.setAttribute('aria-expanded', 'false');
    this.chip.addEventListener('click', this.onChipTap);

    // Reuse the class the shared stylesheet already targets so the expanded
    // body keeps its existing look — only visibility is managed here. Inline
    // display (rather than a class) so we never fight the shared CSS on
    // specificity: '' simply hands control back to it.
    this.body = document.createElement('div');
    this.body.className = 'density-lab-status';
    this.body.style.display = 'none';
    // Telemetry is read, never tapped — clicks must fall through to the game.
    this.body.style.pointerEvents = 'none';

    hud.appendChild(this.chip);
    hud.appendChild(this.body);
  }

  /** True while the stats body is expanded on screen. */
  get bodyVisible(): boolean {
    return this.open;
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  /**
   * Accepts the scene's once-a-second telemetry string. Writes the DOM only
   * while expanded; collapsed snapshots are stored so opening shows current
   * data instead of whatever was on screen when the panel last closed.
   */
  setHTML(html: string): void {
    this.latestHTML = html;
    if (this.open) {
      this.body.innerHTML = html;
      this.domDirty = false;
    } else {
      this.domDirty = true;
    }
  }

  // Deterministic hooks for tests (and headless probes) — same path as a tap,
  // minus the event plumbing.
  openForTest(): void {
    this.setOpen(true);
  }

  closeForTest(): void {
    this.setOpen(false);
  }

  dispose(): void {
    this.chip.removeEventListener('click', this.onChipTap);
    this.chip.remove();
    this.body.remove();
  }

  // Field arrow-fn so the listener can be removed in dispose() without a bind.
  private readonly onChipTap = (): void => {
    this.toggle();
  };

  private setOpen(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    if (open && this.domDirty) {
      this.body.innerHTML = this.latestHTML;
      this.domDirty = false;
    }
    this.body.style.display = open ? '' : 'none';
    this.chip.textContent = open ? 'STATS ✕' : 'STATS';
    this.chip.classList.toggle('tm-stats-chip--open', open);
    this.chip.setAttribute('aria-expanded', String(open));
  }
}

// Injected once per page — instances share one <style> tag, and it
// deliberately outlives dispose() (re-adding it on every scene entry would
// just pile up duplicates).
let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
.tm-stats-chip {
  position: fixed;
  /* Clear notches / rounded corners on phones; 12px floor elsewhere. */
  top: max(12px, env(safe-area-inset-top));
  left: max(12px, env(safe-area-inset-left));
  z-index: 60;
  padding: 6px 12px;
  border: 1px solid rgba(120, 200, 255, 0.3);
  border-radius: 10px;
  background: rgba(8, 14, 24, 0.6);
  color: #cfe8ff;
  font: 600 10px/1.6 ui-monospace, monospace;
  letter-spacing: 0.14em;
  cursor: pointer;
  pointer-events: auto;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.tm-stats-chip--open {
  background: rgba(14, 22, 32, 0.9);
  color: #e8f3ff;
}
`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
}
