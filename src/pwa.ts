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

import { decideUpdate, isDifferentBuild as isNewBuild } from './pwaPolicy';

declare const __BUILD_TIME__: string;

/** How long after boot the update check runs, so it never fights the load. */
const FIRST_CHECK_MS = 8_000;
/** And how often after that, for a session left open on a phone all day. */
const RECHECK_MS = 30 * 60_000;
/** When to stop waiting for a scene that never reports itself loaded. */
const LOAD_BACKSTOP_MS = 90_000;

/**
 * And how soon after the app comes BACK that it looks again.
 *
 * The gap this closes, reported from the device: "playing it as the PWA, so
 * maybe the workers are lazy and didn't update it yet as I don't see any
 * version number yet."
 *
 * They were lazy, and by omission. An installed PWA resumed from the app
 * switcher does not navigate, so `register()` never runs again and the only
 * remaining check is the half-hourly interval — which only ticks while the
 * app is actually open and awake. Put the phone down on Tuesday's build,
 * pick it up on Thursday, and the first look for a new one is up to thirty
 * minutes away. A tester who launches, glances, and closes can miss every
 * deploy indefinitely.
 *
 * So the app asks whenever it becomes visible again, which is exactly the
 * moment somebody is about to look at it. Throttled, because iOS fires
 * `visibilitychange` for a notification shade as readily as for a relaunch,
 * and an update check is a network request.
 */
const RESUME_CHECK_MS = 60_000;

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
 * At LAUNCH, updates are taken automatically — a banner says so and the page
 * reloads itself once the new worker is in charge. Nothing has been played
 * yet, so there is no tunnel to eat; making the player load the game twice to
 * get today's build was the real cost.
 *
 * WHAT "AT LAUNCH" MEANS IS NOT A CLOCK. It used to be, and the clock was
 * broken: a twenty-second window from boot, against a first update check at
 * eight seconds, meant every update the check found reloaded the app
 * unattended — during the load, with the height field, the biome textures and
 * the ant model all in flight. See `pwaPolicy.ts`. The question is now
 * whether there is anything to lose, which the app answers itself through
 * {@link markLoaded} and a first touch.
 *
 * A session flag still stops a broken update from reload-looping: the second
 * automatic attempt in one tab falls back to the prompt.
 */
const AUTO_FLAG = 'tm-auto-updated';

/**
 * The app has not said it finished loading yet. It starts true and is only
 * ever cleared, so a scene that never reports in cannot leave an update held
 * for ever — see the backstop in {@link registerServiceWorker}.
 */
let loading = true;
/** A pointer or a key has reached the page: something is being played. */
let interacted = false;
/** An update that installed mid-load, kept until the curtain lifts. */
let held: ServiceWorkerRegistration | null = null;

/**
 * The app is up and drawing. Called by the scene when its load settles —
 * whether it settled in success or in failure, because an update held behind
 * a load that has failed is an update that never arrives.
 */
export function markLoaded(): void {
  if (!loading) return;
  loading = false;
  const waiting = held;
  held = null;
  if (waiting) offer(waiting);
}

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

  /*
   * One touch is enough to mean "being played". Capture, so a scene that
   * stops the event on its own controls does not hide it from here.
   */
  const touched = (): void => { interacted = true; };
  window.addEventListener('pointerdown', touched, { once: true, capture: true });
  window.addEventListener('keydown', touched, { once: true, capture: true });

  window.addEventListener('load', () => {
    /*
     * The backstop. Every route is supposed to call `markLoaded`, but a scene
     * that throws before it gets there, or one added later that never learns
     * to, must not be able to strand an update in `held` for the life of the
     * session. Generous, because a cold first load of the island on a phone
     * is genuinely slow, and it only ever fires when something else is wrong.
     */
    window.setTimeout(markLoaded, LOAD_BACKSTOP_MS);
    const url = `${import.meta.env.BASE_URL}sw.js?v=${encodeURIComponent(__BUILD_TIME__)}`;
    void navigator.serviceWorker.register(url, { scope: import.meta.env.BASE_URL })
      .then((registration) => {
        /*
         * A worker already waiting when the page loads is an update that
         * arrived last visit and was never taken up.
         */
        if (registration.waiting && navigator.serviceWorker.controller) {
          if (isDifferentBuild(registration)) offer(registration);
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
              if (isDifferentBuild(registration)) offer(registration);
            }
          });
        });
        window.setTimeout(() => void registration.update(), FIRST_CHECK_MS);
        window.setInterval(() => void registration.update(), RECHECK_MS);
        /*
         * AND WHENEVER SHE COMES BACK TO IT. See `RESUME_CHECK_MS` — this is
         * the one that matters for an installed app, which is resumed far
         * more often than it is launched.
         *
         * `visibilitychange` rather than `focus`: a standalone PWA on iOS
         * does not reliably fire window focus, and visibility is the event
         * that actually tracks "on screen and being looked at".
         */
        let lastCheck = 0;
        const checkOnResume = (): void => {
          if (document.visibilityState !== 'visible') return;
          const now = performance.now();
          if (now - lastCheck < RESUME_CHECK_MS) return;
          lastCheck = now;
          void registration.update();
        };
        document.addEventListener('visibilitychange', checkOnResume);
        window.addEventListener('pageshow', checkOnResume);
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

/**
 * IS THE THING WAITING ACTUALLY A DIFFERENT BUILD?
 *
 * Reported as a restart loop: the game loaded v0.1.9, START went into the
 * island, and then it announced an update to the build it was already
 * running and did it again.
 *
 * The cause is that a WAITING worker was being treated as proof of a new
 * version, and it is not. A worker can sit in `waiting` for reasons that
 * have nothing to do with there being newer code — activation still
 * pending, or another tab of the game holding the old one alive. Accepting
 * it posts SKIP_WAITING, `controllerchange` fires, the page reloads, the
 * worker is STILL waiting, and the same offer is made again. The loop guard
 * below could not help: it only decides whether an update is applied
 * silently or with a prompt, never whether there is one.
 *
 * So the script's own `?v=` — the build time it was registered with — is
 * compared against the build time of the code doing the asking. Same stamp,
 * same build, nothing to offer.
 */
function isDifferentBuild(registration: ServiceWorkerRegistration): boolean {
  const worker = registration.waiting ?? registration.installing;
  return isNewBuild(worker?.scriptURL ?? null, __BUILD_TIME__);
}

function offer(registration: ServiceWorkerRegistration): void {
  let looped = false;
  try {
    looped = sessionStorage.getItem(AUTO_FLAG) === '1';
  } catch { /* storage refused: treat as first time */ }

  const take = (): void => {
    accepted = true;
    registration.waiting?.postMessage('SKIP_WAITING');
  };

  switch (decideUpdate({ loading, interacted, looped })) {
    case 'hold':
      /* Keep the newest one. An older held registration is the same
       * registration object anyway, but the intent is: whatever is waiting
       * when the curtain lifts is what gets offered. */
      held = registration;
      return;
    case 'auto':
      try {
        sessionStorage.setItem(AUTO_FLAG, '1');
      } catch { /* refused storage only costs the loop guard */ }
      autoBanner();
      take();
      return;
    default:
      prompt(take);
  }
}
