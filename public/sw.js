/**
 * The service worker: offline play, without ever serving you yesterday's game.
 *
 * Staleness is the thing to be afraid of here, not cache misses. Three times
 * in development a fault was reported against code that had already been
 * fixed, because a phone was holding an old build — which is why the HUD
 * carries a build stamp at all. A cache-first worker would make that the
 * normal experience rather than an occasional one, so the policy is split by
 * what the URL can promise:
 *
 *   - Vite's hashed assets (`assets/index-BOT97mmB.js`) are IMMUTABLE by
 *     construction: the hash is of the content, so that URL can never mean
 *     anything else. Cache-first, and the network is never consulted again.
 *   - Everything else — the page itself, the manifest, the models, the
 *     textures, the sound — is mutable at a fixed URL. Network-first, with
 *     the cache as a fallback for when there is no network. Online you always
 *     get today's file; offline you get the last one that worked.
 *
 * So being online is always correct and being offline is always possible,
 * which is the pair worth having.
 *
 * The cache is versioned from the `?v=` on the registration URL, so a new
 * build registers a different script, installs beside the old one, and waits.
 * It never takes over on its own — see `SKIP_WAITING`. The player is asked.
 */

const VERSION = new URL(self.location.href).searchParams.get('v') ?? 'dev';
const CACHE = `thronemound-${VERSION}`;

/**
 * The least that has to be in the cache for a cold offline start. Everything
 * else arrives through use — precaching the models would mean a 1.4 MB
 * download before the first frame, on install, for a game that may never be
 * played offline.
 */
const SHELL = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Individually, and forgivingly: one 404 in the list must not fail the
    // whole install and leave the site with no worker at all.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n.startsWith('thronemound-') && n !== CACHE)
        .map((n) => caches.delete(n)),
    );
    await self.clients.claim();
  })());
});

/** Content-hashed by the bundler, and therefore safe to keep forever. */
function immutable(url) {
  return /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(js|css|woff2?)$/.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (immutable(url)) {
    event.respondWith((async () => {
      const hit = await caches.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
      return response;
    })());
    return;
  }

  event.respondWith((async () => {
    try {
      /*
       * Navigations dodge the browser's OWN cache too. GitHub Pages serves
       * index.html with max-age=600, so for ten minutes after a deploy a
       * plain fetch() can return yesterday's page from the HTTP cache —
       * yesterday's game, from a worker whose whole policy is freshness.
       * 'no-cache' revalidates instead: a 304 when nothing changed, the new
       * page the moment there is one.
       */
      const req = request.mode === 'navigate'
        ? new Request(request, { cache: 'no-cache' })
        : request;
      const response = await fetch(req);
      /*
       * Only complete, same-origin successes are stored. A 206 from a range
       * request cannot be replayed as a whole file, and caching an error page
       * under the URL of the game is how a worker bricks a site until someone
       * clears storage by hand.
       */
      if (response.ok && response.status === 200 && response.type === 'basic') {
        (await caches.open(CACHE)).put(request, response.clone());
      }
      return response;
    } catch (offline) {
      const hit = await caches.match(request)
        ?? (request.mode === 'navigate' ? await caches.match('./index.html') : undefined);
      if (hit) return hit;
      throw offline;
    }
  })());
});

/**
 * The handover, and the reason it is a message rather than an unconditional
 * `skipWaiting()` in `install`: taking over mid-session swaps the code under
 * a running game. The page asks the player first and only then sends this.
 */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
