/*
 * WHAT DOES A BIGGER BLOCK COST?
 *
 * Loads the nest room at each asked size and measures the things a phone will
 * feel: how long the first build takes, how long DIG IT takes to re-cut, how
 * much memory the page is holding, and the frame rate once it settles. The
 * desktop numbers are not the phone's numbers — a phone is roughly three to
 * four times slower — but the RATIO between sizes carries over, which is what
 * decides whether a size is offerable at all.
 *
 *   SMOKE_URL=http://localhost:4331/ node scripts/probe-blocksize.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://localhost:4331/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const SIZES = ['64', '128x128x256', '256'];
console.log('\nsize            cells         build    DIG IT   heap     fps');
for (const size of SIZES) {
  const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
  const t0 = Date.now();
  await page.goto(`${base}/?scene=block&shape=nest&block=${size}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.blockScene?.ready, null, { timeout: 120000 });
  const build = Date.now() - t0;

  // Open the designer and time a DIG IT re-carve of the same plan.
  await page.locator('.density-lab-dig').first().dispatchEvent('pointerdown');
  await page.waitForTimeout(400);
  const helpUp = await page.locator('.nest-help').isVisible();
  if (helpUp) {
    await page.locator('.nest-help .nest-designer-chip').dispatchEvent('pointerdown');
    await page.waitForTimeout(200);
  }
  // A couple of pieces so the carve has something to cut.
  for (let i = 0; i < 2; i += 1) {
    await page.locator('.nest-designer-chip', { hasText: /^\+ PLACE$/ }).first()
      .dispatchEvent('pointerdown');
    await page.waitForTimeout(120);
  }
  // DIG IT is synchronous — the carve and remesh happen inside the pointerdown
  // handler — so wall time around the dispatch IS the rebuild time.
  const digMs = await page.evaluate(async () => {
    const chipList = [...document.querySelectorAll('.nest-designer-chip')];
    const chip = chipList.find(c => c.textContent === 'DIG IT');
    const started = performance.now();
    chip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    return performance.now() - started;
  });

  const stats = await page.evaluate(() => ({
    heapMb: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(0) : -1,
  }));
  // Frame rate over two seconds, settled.
  const fps = await page.evaluate(() => new Promise((resolve) => {
    let frames = 0;
    const started = performance.now();
    const tick = () => {
      frames += 1;
      if (performance.now() - started < 2000) requestAnimationFrame(tick);
      else resolve(+(frames / ((performance.now() - started) / 1000)).toFixed(0));
    };
    requestAnimationFrame(tick);
  }));
  const cells = await page.evaluate(() => {
    const f = window.blockScene.field ?? null;
    return f ? `${f.cellsX}×${f.cellsY}×${f.cellsZ}` : '?';
  });
  console.log(`${size.padEnd(15)} ${String(cells).padEnd(13)} ${String(build + 'ms').padEnd(8)} `
    + `${String(Math.round(digMs) + 'ms').padEnd(8)} ${String(stats.heapMb + 'MB').padEnd(8)} ${fps}`);
  await page.close();
}
await browser.close();
