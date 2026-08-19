/**
 * THE FRONT DOOR SAYS NOTHING WHILE YOU STAND AT IT.
 *
 *     npm run probe:menu          # against the built Pages artifact
 *
 * The island builds behind the menu, and it used to narrate that at you —
 * "Preparing the island…", "Waking the queen…" — while you sat on the title
 * screen with nothing to do about it. A progress report for a wait nobody
 * asked to start, which makes a front door look like a loading screen.
 *
 * THE MEASUREMENT HAS TO BE OVER TIME, and that is the whole reason this is
 * a probe rather than a unit test. Sampling the status line once proves
 * nothing: it is empty on the first frame no matter what, and the words
 * arrive later, from a boot running on its own clock. So it watches — every
 * 250 ms, from the moment the menu paints until the island reports ready —
 * and any non-empty frame in that window is a failure with the text quoted.
 *
 * The other half is that the words must STILL appear where they belong. A
 * silent preload that also swallowed the loading screen would pass a test
 * for silence and be a worse bug: press START before the island is up and
 * the curtain has to say what is happening.
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4700/Thronemound-Colony-Sim/')
  .replace(/\/$/, '');

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const p = await b.newPage({ viewport: { width: 932, height: 430 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

const log = [];
const ok = (what, cond) => log.push([what, cond === true]);

await p.goto(`${base}/?scene=menu`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('.main-menu__button[data-key="onStart"]', { timeout: 120000 });

/* --- 1. START is live from the first frame, with no island behind it --- */
const first = await p.evaluate(() => ({
  start: !document.querySelector('.main-menu__button[data-key="onStart"]').disabled,
  status: document.querySelector('.main-menu__status')?.textContent ?? '',
  ready: window.islandScene?.playerReady === true,
}));
ok('START is pressable before the island is up', first.start && !first.ready);
ok('and the door says nothing', first.status.trim() === '');

/*
 * --- 2. THE WATCH. Every 250 ms until she is standing. ---
 *
 * Installed in the page so no sample is lost to the round trip: under
 * SwiftShader the main thread is busy enough that polling from node would
 * miss whole seconds of the boot, which is exactly where the words were.
 */
await p.evaluate(() => {
  window.__said = [];
  window.__watch = setInterval(() => {
    const t = document.querySelector('.main-menu__status')?.textContent ?? '';
    if (t.trim()) window.__said.push(t.trim());
  }, 250);
});
await p.waitForFunction(
  () => window.islandScene?.playerReady === true, null, { timeout: 300000 },
);
/* A beat past ready — the last status writes land after the world does. */
await p.waitForTimeout(1200);
const watch = await p.evaluate(() => {
  clearInterval(window.__watch);
  return {
    said: [...new Set(window.__said)],
    status: document.querySelector('.main-menu__status')?.textContent ?? '',
    resume: !document.querySelector('.main-menu__button[data-key="onResume"]')
      ?.disabled,
    hasSave: !!window.localStorage.getItem('thronemound.island.v1'),
  };
});
ok(`nothing was announced while idle${watch.said.length ? ` — saw ${JSON.stringify(watch.said)}` : ''}`,
  watch.said.length === 0);
ok('and it is still silent once she is standing', watch.status.trim() === '');
/* RESUME tracks the SAVE, not the boot: it is a localStorage read, so a
 * greyed RESUME must mean "no save", never "not finished loading". */
ok('RESUME reflects whether a save exists', watch.resume === watch.hasSave);

/*
 * --- 3. THE CURTAIN STILL SPEAKS. ---
 *
 * Reload and press START immediately, before the island can finish. The
 * words the title screen no longer shows have to be on the curtain, or the
 * silence was bought by deleting the loading screen.
 */
await p.goto(`${base}/?scene=menu`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('.main-menu__button[data-key="onStart"]', { timeout: 120000 });
await p.evaluate(() => document.querySelector(
  '.main-menu__button[data-key="onStart"]',
).click());
const curtain = await p.evaluate(async () => {
  const seen = [];
  for (let i = 0; i < 40; i += 1) {
    /*
     * THE STATUS LINE, not the curtain's `textContent`. The overlay injects
     * its stylesheet as a child `<style>`, so reading the root returned two
     * kilobytes of CSS and the assertion passed on that alone — it would
     * have gone green with the status line completely empty, which is
     * exactly the failure it is here to catch.
     */
    const el = document.querySelector('.tm-loading-status');
    if (!document.querySelector('.tm-loading-root')) break;
    const t = el?.textContent?.trim() ?? '';
    if (t) seen.push(t);
    await new Promise((r) => setTimeout(r, 250));
  }
  return { seen: [...new Set(seen)], gone: !document.querySelector('.tm-loading-root') };
});
ok(`the curtain reports the boot${curtain.seen.length ? ` — ${JSON.stringify(curtain.seen.slice(0, 3))}` : ' — SAW NOTHING'}`,
  curtain.seen.length > 0);

await p.waitForFunction(
  () => window.islandScene?.playerReady === true, null, { timeout: 300000 },
);
await p.waitForFunction(
  () => document.querySelector('.tm-loading-root') === null, null, { timeout: 120000 },
);
ok('and lifts by itself when she is standing', true);
ok('the menu is gone', await p.evaluate(() => !document.querySelector('.main-menu')));

let bad = 0;
for (const [what, good] of log) {
  if (!good) bad += 1;
  console.log(`  ${good ? 'ok  ' : 'FAIL'}  ${what}`);
}
console.log(`\npage errors: ${errs.length ? errs.slice(0, 3).join(' | ') : 'none'}`);
console.log(bad === 0 && errs.length === 0
  ? '\nall green — the door is quiet, and the curtain is not'
  : `\n${bad} step(s) failed`);
await b.close();
process.exit(bad === 0 && errs.length === 0 ? 0 : 1);
