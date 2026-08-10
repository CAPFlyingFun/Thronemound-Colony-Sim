/**
 * THE ROTATE THAT KILLED IT, REPRODUCED ON PURPOSE.
 *
 * Loads the island, waits for the curtain to lift, then takes the GPU context
 * away with WEBGL_lose_context — the same event a phone sends when a rotate
 * reallocates the drawing buffer on a device that cannot spare the memory.
 *
 * Checks the three things that were wrong before the guard existed:
 *   1. the loss is preventDefault-ed, so restoration is even possible;
 *   2. a loss that does NOT heal puts a message and a RELOAD button on the
 *      black screen, instead of leaving the player to force-quit the app;
 *   3. a loss that DOES heal takes the message away and starts drawing again.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/probe-context-loss.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 90000 });
await page.waitForTimeout(1500);

const fail = [];
const ok = (label, cond) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!cond) fail.push(label);
};

const rate = () => page.evaluate(async () => {
  const before = window.islandScene.renderer.info.render.frame;
  /* A long window on purpose: swiftshader draws this island at single-digit
   * frames a second, and over 600 ms the difference between healthy and dead
   * is three frames against one — noise, not a measurement. */
  await new Promise((k) => setTimeout(k, 3000));
  return window.islandScene.renderer.info.render.frame - before;
});
/* What this machine manages BEFORE anything goes wrong. Swiftshader is a
 * software rasteriser and the island is not a small scene, so the number to
 * compare against is this one, not sixty. */
const healthy = await rate();
console.log(`baseline: ${healthy} frames / 3 s`);

/* Hold the extension so the same handle can restore it later — a fresh
 * getExtension() after the loss returns a different object that cannot. */
await page.evaluate(() => {
  const canvas = window.islandScene.renderer.domElement;
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  window.__lose = gl.getExtension('WEBGL_lose_context');
  window.__prevented = null;
  canvas.addEventListener('webglcontextlost', (e) => {
    window.__prevented = e.defaultPrevented;
  });
});

/* ---------------------------------------------------- 1 & 2: it stays down */
await page.evaluate(() => window.__lose.loseContext());
await page.waitForTimeout(300);

ok('the loss is preventDefault-ed', await page.evaluate(() => window.__prevented === true));
ok('the loop stops', await page.evaluate(() => window.islandScene.frame === 0));
ok('no banner during the grace period',
  await page.$('.tm-update--alert') === null);

await page.waitForTimeout(4500);
const bar = await page.$('.tm-update--alert');
ok('an unhealed loss says so', bar !== null);
ok('and offers the one button that helps',
  await page.$('.tm-update--alert .tm-update__go') !== null);
if (bar) console.log(`      "${(await bar.innerText()).replace(/\s+/g, ' ').trim()}"`);

/* ------------------------------------------------- 3: and it takes it back */
await page.evaluate(() => window.__lose.restoreContext());
await page.waitForTimeout(800);
ok('a late restore clears the message', await page.$('.tm-update--alert') === null);
ok('and starts drawing again',
  await page.evaluate(() => window.islandScene.frame !== 0));

/* Everything the GPU held was thrown away with the context; three.js
 * re-uploads it lazily, so the first second back is spent pushing the island
 * up again. Give it that second before asking how it is doing. */
await page.waitForTimeout(1200);
const drew = await rate();
ok(`draws at its old rate again (${drew} vs ${healthy} / 3 s)`,
  drew > 0 && drew >= healthy * 0.5);

console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
if (fail.length) {
  console.log(`\n${fail.length} FAILED: ${fail.join(', ')}`);
  process.exit(1);
}
console.log('\nall green');
