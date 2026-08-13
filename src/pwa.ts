/**
 * Installing the service worker, and asking before replacing the game
 * underneath a player.
 *
 * A new build produces a new worker, which installs alongside the running one
 * and then WAITS. Nothing swaps automatically: a game that reloads itself
 * mid-dig is a game that ate your tunnel. Instead the waiting worker raises a
 * prompt, and the reload happens when the player says so.
 *
 * The registration URL carries the build stamp, which is what makes any of
 * this happen at all — browsers compare the worker script byte for byte, and
 * `public/sw.js` is copied verbatim by the bundler, so without the query the
 * file would be identical on every deploy and no update would ever be found.
 */

declare const __BUILD_TIME__: string;

/** How long after boot the update check runs, so it never fights the load. */
const FIRST_CHECK_MS = 8_000;
/** And how often after that, for a session left open on a phone all day. */
const RECHECK_MS = 30 * 60_000;

function prompt(onAccept: () => void): void {
  if (document.querySelector('.tm-update')) return;
  const bar = document.createElement('div');
  bar.className = 'tm-update';
  bar.setAttribute('role', 'status');
  bar.innerHTML = `
    <span class="tm-update__text">A newer Thronemound is ready.</span>
    <button class="tm-update__go" type="button">RELOAD</button>
    <button class="tm-update__later" type="button" aria-label="Dismiss">✕</button>
  `;
  const close = (): void => bar.remove();
  bar.querySelector('.tm-update__later')?.addEventListener('click', close);
  bar.querySelector('.tm-update__go')?.addEventListener('click', () => {
    close();
    onAccept();
  });
  document.body.appendChild(bar);
}

/** Set only when the player has pressed RELOAD on the prompt. */
let accepted = false;

/**
 * At LAUNCH, updates are taken automatically — a banner says so and the
 * page reloads itself once the new worker is in charge. Nothing has been
 * played yet, so there is no tunnel to eat; making the player load the
 * game twice to get today's build was the real cost. Mid-session updates
 * keep the ask. The window is measured from registration, and a session
 * flag stops a broken update from reload-looping: the second attempt in
 * one tab falls back to the prompt.
 */
const AUTO_UPDATE_WINDOW_MS = 20_000;
const AUTO_FLAG = 'tm-auto-updated';
let bootAt = 0;

function autoBanner(): void {
  if (document.querySelector('.tm-update')) return;
  const bar = document.createElement('div');
  bar.className = 'tm-update';
  bar.setAttribute('role', 'status');
  bar.innerHTML = '<span class="tm-update__text">New version: updating now…</span>';
  document.body.appendChild(bar);
}

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  /*
   * Not in dev. The dev server hands out unbundled modules that change every
   * save, and a worker caching them is a morning spent wondering why an edit
   * did nothing.
   */
  if (import.meta.env.DEV) return;

  window.addEventListener('load', () => {
    bootAt = performance.now();
    const url = `${import.meta.env.BASE_URL}sw.js?v=${encodeURIComponent(__BUILD_TIME__)}`;
    void navigator.serviceWorker.register(url, { scope: import.meta.env.BASE_URL })
      .then((registration) => {
        /*
         * A worker already waiting when the page loads is an update that
         * arrived last visit and was never taken up.
         */
        if (registration.waiting && navigator.serviceWorker.controller) {
          offer(registration);
        }
        registration.addEventListener('updatefound', () => {
          const next = registration.installing;
          if (!next) return;
          next.addEventListener('statechange', () => {
            /*
             * `installed` WITH a controller already in charge means this is a
             * replacement. Without one it is the very first install, which
             * needs no prompt — there is nothing to replace.
             */
            if (next.state === 'installed' && navigator.serviceWorker.controller) {
              offer(registration);
            }
          });
        });
        window.setTimeout(() => void registration.update(), FIRST_CHECK_MS);
        window.setInterval(() => void registration.update(), RECHECK_MS);
      })
      .catch(() => {
        // A refused registration costs offline play and nothing else. The
        // game has to keep starting.
      });
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    /*
     * ONLY when the player asked for it, and this is the whole of the rule.
     *
     * A first visit has no controller until the freshly installed worker
     * calls `clients.claim()`, and that fires this event too — so reloading
     * on any controller change made every first load of the game a double
     * load. Measured as the smoke test failing to find a queen at all: the
     * page threw away a scene that was still fetching a 1.4 MB model and
     * started again, and the checks that ran on the first pass found nothing
     * loaded. Chrome can also fire it more than once, which the same flag
     * covers.
     */
    if (!accepted) return;
    accepted = false;
    window.location.reload();
  });
}

function offer(registration: ServiceWorkerRegistration): void {
  const atLaunch = performance.now() - bootAt < AUTO_UPDATE_WINDOW_MS;
  let looped = false;
  try {
    looped = sessionStorage.getItem(AUTO_FLAG) === '1';
  } catch { /* storage refused: treat as first time */ }
  if (atLaunch && !looped) {
    try {
      sessionStorage.setItem(AUTO_FLAG, '1');
    } catch { /* refused storage only costs the loop guard */ }
    autoBanner();
    accepted = true;
    registration.waiting?.postMessage('SKIP_WAITING');
    return;
  }
  prompt(() => {
    accepted = true;
    registration.waiting?.postMessage('SKIP_WAITING');
  });
}
