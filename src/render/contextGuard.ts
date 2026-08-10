/**
 * Surviving a lost GPU context — and, failing that, admitting to it.
 *
 * A mobile browser may take the WebGL context away at any moment, and the
 * moment it most likes is a rotate: turning the device reallocates the
 * drawing buffer, and doing that while a cold-cached build is still fetching
 * a megabyte of model, decoding textures and building terrain is exactly when
 * the GPU process can least afford it. Which is why this is reported as
 * "portrait to landscape, sometimes, after a new update" — an update empties
 * the cache, so the first launch after one is the heaviest launch there is.
 *
 * three.js already listens for the event and rebuilds its own state if the
 * context comes back. What it does NOT do is tell the application anything:
 * `WebGLRenderer.render` opens with `if ( _isContextLost === true ) return;`,
 * so a lost context turns every draw into a silent no-op. The simulation
 * keeps stepping, the HUD keeps updating, requestAnimationFrame keeps firing,
 * and the player sees a black screen with nothing to press and no way back
 * but killing the app and opening it again. That is the failure this guards:
 * not the loss itself, which is the device's call, but the silence after it.
 *
 * Deliberately free of THREE and of the DOM beyond `addEventListener`, so the
 * decision it encodes — wait a little, then stop pretending — is testable
 * without a GPU.
 */

/** What the scene does at each of the three moments that matter. */
export interface ContextGuardHooks {
  /** The context is gone. Stop the loop; the draws are no-ops from here. */
  onLost(): void;
  /** It came back. Re-size, reset the clock, start drawing again. */
  onRestored(): void;
  /** It did not come back, and is not going to. Tell the player. */
  onAbandoned(): void;
}

/** Injectable timers, so a test does not have to wait four real seconds. */
export interface ContextGuardClock {
  setTimer(fn: () => void, ms: number): number;
  clearTimer(id: number): void;
}

/**
 * How long to wait for `webglcontextrestored` before calling it.
 *
 * A browser that intends to restore does it promptly — the event follows the
 * loss by well under a second on every engine that sends it at all. The wait
 * is generous against a device that is still thrashing, and short enough that
 * a player is not left staring at nothing wondering whether to force-quit.
 */
export const RESTORE_GRACE_MS = 4_000;

const realClock: ContextGuardClock = {
  setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimer: (id) => clearTimeout(id),
};

/**
 * Watch `canvas` for context loss. Returns the unsubscribe.
 *
 * Restoration is still honoured after {@link ContextGuardHooks.onAbandoned}
 * has fired: a late `webglcontextrestored` is a recovery, not a curiosity,
 * and the scene should take it and clear whatever it put on screen.
 */
export function guardContext(
  canvas: EventTarget,
  hooks: ContextGuardHooks,
  clock: ContextGuardClock = realClock,
  graceMs: number = RESTORE_GRACE_MS,
): () => void {
  let timer: number | null = null;
  let lost = false;

  const onLost = (event: Event): void => {
    /*
     * WITHOUT THIS THE CONTEXT CAN NEVER COME BACK. An unprevented
     * `webglcontextlost` tells the browser the page has given up, and
     * `webglcontextrestored` is then never sent. three.js calls it too, but
     * only for as long as it holds its own listener on this canvas; saying it
     * here as well costs nothing and does not depend on that staying true.
     */
    event.preventDefault();
    /* Chromium can send the event more than once for one loss. */
    if (lost) return;
    lost = true;
    hooks.onLost();
    timer = clock.setTimer(() => {
      timer = null;
      if (lost) hooks.onAbandoned();
    }, graceMs);
  };

  const onRestored = (): void => {
    if (!lost) return;
    lost = false;
    if (timer !== null) {
      clock.clearTimer(timer);
      timer = null;
    }
    hooks.onRestored();
  };

  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  return () => {
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    if (timer !== null) clock.clearTimer(timer);
  };
}
