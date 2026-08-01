/**
 * Is it actually installable, and does it actually survive being offline?
 *
 * Every clause here is a thing that silently does not work rather than
 * visibly failing. A manifest without icons still parses; a service worker
 * that throws on install still leaves a running game; a cache-first worker
 * still serves a page — yesterday's. None of that shows up in a screenshot,
 * so it is measured.
 *
 *     npm run smoke:pwa            # needs `vite preview` running
 */
import { chromium } from 'playwright';
import { existsSync, rmSync, writeFileSync } from 'node:fs';

const URL_BASE = process.env.SMOKE_URL ?? 'http://localhost:4300/Thronemound-Colony-Sim/';

let failed = false;
const fail = (msg) => { console.error(`FAIL: ${msg}`); failed = true; };
const ok = (msg) => console.log(`  ok  ${msg}`);

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const context = await browser.newContext({
  viewport: { width: 932, height: 430 }, deviceScaleFactor: 2,
});
const page = await context.newPage();
/*
 * The colony sim is the default route now, but it is still asked for by name
 * with the menu suppressed: nothing here is about which scene loads — the
 * manifest, the icons and the worker are the same on every route because
 * they hang off the document — and `nomenu` keeps the boot deterministic.
 */
const GAME = `${URL_BASE}?map=densityterrainlab&nomenu=1`;
await page.goto(GAME, { waitUntil: 'networkidle' });

/* ---------------------------------------------------------------- manifest */
{
  const href = await page.getAttribute('link[rel=manifest]', 'href');
  if (!href) fail('the page declares no manifest');
  else {
    const response = await page.request.get(new URL(href, URL_BASE).href);
    if (!response.ok()) fail(`the manifest 404s at ${href}`);
    else {
      const manifest = await response.json();
      const missing = ['name', 'short_name', 'start_url', 'scope', 'display', 'icons']
        .filter((key) => !manifest[key]);
      if (missing.length) fail(`the manifest is missing ${missing.join(', ')}`);
      else ok(`the manifest declares ${manifest.name} (${manifest.display}, ${manifest.orientation})`);

      /*
       * Chrome will not offer to install without a 192 and a 512, and Android
       * will not round the corners without a maskable one — the difference
       * between an icon and a white square with an icon inside it.
       */
      const sizes = new Set(manifest.icons?.map((i) => i.sizes));
      const purposes = new Set(manifest.icons?.flatMap((i) => (i.purpose ?? 'any').split(' ')));
      if (!sizes.has('192x192') || !sizes.has('512x512')) {
        fail(`icons are ${[...sizes].join(', ') || 'absent'} — Chrome needs 192 and 512 to install`);
      } else if (!purposes.has('maskable')) {
        fail('no maskable icon, so Android will letterbox it');
      } else ok(`icons: ${[...sizes].join(', ')} including maskable`);

      // And every one of them has to actually be there and be an image.
      const bad = [];
      for (const icon of manifest.icons ?? []) {
        const at = new URL(icon.src, new URL(href, URL_BASE)).href;
        const got = await page.request.get(at);
        const type = got.headers()['content-type'] ?? '';
        if (!got.ok() || !type.startsWith('image/')) bad.push(`${icon.src} (${got.status()} ${type})`);
      }
      if (bad.length) fail(`icons that do not resolve: ${bad.join(', ')}`);
      else ok(`all ${manifest.icons.length} manifest icons resolve as images`);
    }
  }

  // iOS never reads the manifest for this one.
  const apple = await page.getAttribute('link[rel="apple-touch-icon"]', 'href');
  if (!apple) fail('no apple-touch-icon, so an iPhone home screen gets a screenshot');
  else {
    const got = await page.request.get(new URL(apple, URL_BASE).href);
    if (!got.ok()) fail(`the apple-touch-icon 404s at ${apple}`);
    else ok('the apple-touch-icon resolves');
  }
}

/* --------------------------------------------------------- service worker */
const registered = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready;
  return {
    scope: reg.scope,
    script: reg.active?.scriptURL ?? '',
    controlled: !!navigator.serviceWorker.controller,
  };
});
if (!registered.script) fail('no service worker became active');
else if (!registered.script.includes('?v=')) {
  fail('the worker registered without a build stamp, so no update will ever be found');
} else ok(`the worker is active and versioned (${registered.script.split('?v=')[1]})`);

// It claims the page on the first visit, so offline works without a reload.
if (!registered.controlled) {
  const claimed = await page.evaluate(() => new Promise((resolve) => {
    if (navigator.serviceWorker.controller) return resolve(true);
    navigator.serviceWorker.addEventListener('controllerchange', () => resolve(true));
    setTimeout(() => resolve(!!navigator.serviceWorker.controller), 4000);
  }));
  if (!claimed) fail('the worker never took control of the page');
  else ok('the worker claims the page it installed on');
} else ok('the worker claims the page it installed on');

/* ---------------------------------------------------------------- offline */
{
  // Warm the cache the way a player would: load the game once.
  await page.goto(GAME, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  await context.setOffline(true);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let booted = false;
  try {
    await page.goto(GAME, { waitUntil: 'domcontentloaded' });
    booted = await page.evaluate(() => !!document.querySelector('#app'));
  } catch (offline) {
    fail(`offline reload did not load at all: ${offline.message}`);
  }
  await context.setOffline(false);
  if (booted) ok('it reloads and boots with the network switched off');
  else if (!failed) fail('the offline reload produced no app');
}

/* --------------------------------------------- and a new build gets through */
{
  /*
   * The point of network-first, proved by CHANGING THE FILE rather than by
   * fetching an unchanged one twice — which proves only that a file parses.
   *
   * A canary is written into the served directory, loaded so the worker
   * caches it, rewritten, and loaded again. Under cache-first the second read
   * returns the first body, which is exactly the staleness that had faults
   * reported against code already fixed. Skipped when the smoke is pointed at
   * a server whose files are not on this disk.
   */
  const dist = new URL('../dist/', import.meta.url).pathname;
  const canary = `${dist}sw-canary.txt`;
  if (URL_BASE.includes('localhost') && existsSync(dist)) {
    try {
      writeFileSync(canary, 'first');
      const read = async () => page.evaluate(
        async (base) => (await fetch(`${base}sw-canary.txt`)).text(), URL_BASE,
      );
      const before = (await read()).trim();
      writeFileSync(canary, 'second');
      const after = (await read()).trim();
      if (before !== 'first') fail(`the canary did not read back: got "${before}"`);
      else if (after !== 'second') {
        fail(`a changed file came back stale ("${after}") — the worker is serving yesterday's build`);
      } else ok('a file that changed on the server comes back changed, not cached');
    } finally {
      rmSync(canary, { force: true });
    }
  }
}

/* ------------------------------------------------------- the update prompt */
{
  /*
   * A new build means a new `?v=`, which installs a second worker beside the
   * running one. It must WAIT rather than take over — swapping the code under
   * a live dig is how you lose a tunnel — and the page must offer the reload
   * instead of performing it.
   */
  const shown = await page.evaluate(async (base) => {
    await navigator.serviceWorker.register(`${base}sw.js?v=smoke-next`, { scope: base });
    for (let i = 0; i < 60; i += 1) {
      if (document.querySelector('.tm-update')) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }, URL_BASE);
  if (!shown) fail('a newer worker installed and the player was never offered the reload');
  else {
    const reloadedOnItsOwn = page.url().includes('sw.js');
    if (reloadedOnItsOwn) fail('the new worker took over without being asked');
    else ok('a newer build waits and offers a reload rather than taking over');
  }
  await page.screenshot({ path: process.env.PWA_SHOT ?? '/tmp/pwa-update.png' });
}

await browser.close();
if (failed) {
  console.error('\nPWA SMOKE FAILED');
  process.exit(1);
}
console.log('\nPWA SMOKE PASSED');
