/**
 * Headless smoke test for the density terrain lab.
 *
 * Runs at a real phone's DEVICE PIXEL RATIO, which is the whole point of it
 * existing. The lab shipped with `renderer.setSize(w, h, false)` — the third
 * argument suppresses the canvas CSS size — and a canvas with no CSS size
 * displays at its attribute size in CSS pixels, which is the buffer, which is
 * viewport x pixel ratio. On a ratio-2 phone that is a canvas twice the
 * viewport pinned to the top left and clipped, so the middle of the render sat
 * half a screen down and right of the crosshair and digging landed in the
 * corner. Reported from play as "not happening at the crosshair but bottom
 * right", in both orientations, because the ratio does not change when you
 * rotate.
 *
 * It survived a headless check because that check ran at ratio 1, where the
 * bug is exactly invisible: attribute size and CSS size agree. So this runs
 * every ratio, and it asserts the geometry directly rather than by eye.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL
  ?? 'http://localhost:4173/Thronemound-Colony-Sim/?map=densityterrainlab';
const OUT = process.env.SMOKE_OUT ?? '/tmp/density-smoke';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

let failed = false;
const fail = (msg) => { console.error(`FAIL: ${msg}`); failed = true; };
const ok = (msg) => console.log(`  ok  ${msg}`);

/** Portrait and landscape, at the pixel ratios phones actually report. */
const CASES = [
  { name: 'portrait  ratio 1', width: 430, height: 932, dpr: 1 },
  { name: 'portrait  ratio 2', width: 430, height: 932, dpr: 2 },
  { name: 'portrait  ratio 3', width: 430, height: 932, dpr: 3 },
  { name: 'landscape ratio 2', width: 932, height: 430, dpr: 2 },
];

for (const view of CASES) {
  const page = await browser.newPage({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: view.dpr,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas', { timeout: 30000 });
  await page.waitForTimeout(2500);

  const geom = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const host = document.querySelector('.density-lab-host') ?? document.getElementById('app');
    const cross = document.querySelector('.density-lab-crosshair');
    const cr = canvas.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const xr = cross?.getBoundingClientRect();
    return {
      host: [Math.round(hr.width), Math.round(hr.height)],
      canvasCss: [Math.round(cr.width), Math.round(cr.height)],
      canvasBuffer: [canvas.width, canvas.height],
      // Where the CENTRE OF THE RENDER lands on screen, versus where the
      // crosshair says the player is aiming. The dig ray is NDC (0,0), so
      // these two must be the same point or the dig lands somewhere else.
      renderCentre: [Math.round(cr.x + cr.width / 2), Math.round(cr.y + cr.height / 2)],
      crosshair: xr ? [Math.round(xr.x + xr.width / 2), Math.round(xr.y + xr.height / 2)] : null,
    };
  });

  const [dx, dy] = geom.crosshair
    ? [geom.renderCentre[0] - geom.crosshair[0], geom.renderCentre[1] - geom.crosshair[1]]
    : [NaN, NaN];

  // The canvas must OCCUPY the host, not overflow it. Two pixels of slack for
  // sub-pixel layout rounding; the failure this guards was 430 and 932 out.
  const fits = Math.abs(geom.canvasCss[0] - geom.host[0]) <= 2
    && Math.abs(geom.canvasCss[1] - geom.host[1]) <= 2;
  if (!fits) fail(`${view.name}: canvas ${geom.canvasCss} does not fill host ${geom.host}`);
  else ok(`${view.name}: canvas fills the host (${geom.canvasCss})`);

  // And the buffer should still be the ratio-scaled size, capped at 2 — losing
  // the fix by dropping setPixelRatio would pass the test above and look soft.
  const cap = Math.min(view.dpr, 2);
  const sharp = geom.canvasBuffer[0] >= geom.host[0] * cap - 2;
  if (!sharp) fail(`${view.name}: buffer ${geom.canvasBuffer} is below ratio ${cap}`);
  else ok(`${view.name}: buffer is ratio-${cap} sharp (${geom.canvasBuffer})`);

  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
    fail(`${view.name}: aim is off by ${dx},${dy} px — dig will not land at the crosshair`);
  } else ok(`${view.name}: render centre sits under the crosshair (off by ${dx},${dy})`);

  if (errors.length) fail(`${view.name}: ${errors.slice(0, 2).join(' | ')}`);
  await page.close();
}

/* Digging actually works, and reports soil. Once is enough — the geometry
 * above is what varies by viewport, not the arithmetic. */
{
  const page = await browser.newPage({
    viewport: { width: 430, height: 932 }, deviceScaleFactor: 2,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas', { timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}-before.png` });
  for (let i = 0; i < 4; i++) {
    await page.locator('button', { hasText: 'DIG' }).first().click({ force: true });
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: `${OUT}-after.png` });
  const status = (await page.locator('.density-lab-status').innerText()).replace(/\s+/g, ' ');
  const removed = Number(/Removed: ([\d.]+)/.exec(status)?.[1] ?? 0);
  if (removed <= 0) fail(`digging removed nothing: "${status}"`);
  else ok(`four scoops removed ${removed} voxel³ — "${status}"`);
  if (errors.length) fail(`dig run: ${errors.slice(0, 2).join(' | ')}`);
  await page.close();
}

/*
 * Walking across a tile line, in a real browser.
 *
 * The stream's arithmetic is proved in `tests/terrainStream.test.ts`, which is
 * where it belongs — but that runs the class, not the scene, and everything
 * that can go wrong BETWEEN them is invisible from there: a pad button that
 * never fires, a chunk queue that starves, a mesh left at the window origin it
 * was built against three scrolls ago. So this holds the forward key down long
 * enough to cross a 16 mm tile at 12 mm/s and reads the HUD, which reports the
 * tile the scout is standing in.
 */
{
  const page = await browser.newPage({
    viewport: { width: 430, height: 932 }, deviceScaleFactor: 2,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas', { timeout: 30000 });
  await page.waitForTimeout(2500);

  const tileOf = async () => {
    const text = await page.locator('.density-lab-status').innerText();
    const m = /Tile (-?\d+),(-?\d+)/.exec(text.replace(/\s+/g, ' '));
    return m ? `${m[1]},${m[2]}` : null;
  };
  const startTile = await tileOf();
  if (!startTile) fail('HUD does not report which tile the scout is in');

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(4000);
  await page.keyboard.up('KeyW');

  /*
   * Wait for the chunk queue to drain rather than sleeping a fixed amount.
   *
   * This runs on swiftshader, where frames are several times slower than a
   * phone's, so the per-frame build budget buys several times less wall-clock
   * work. A fixed sleep would encode the software renderer's frame rate as if
   * it were the requirement. What matters is that the queue empties at all —
   * and within a few seconds, hence the bound.
   */
  let settled = false;
  for (let i = 0; i < 20 && !settled; i++) {
    await page.waitForTimeout(400);
    settled = !/queued/.test(await page.locator('.density-lab-status').innerText());
  }
  if (!settled) fail('the streamed chunk queue never drained');

  const endTile = await tileOf();
  if (startTile && endTile === startTile) {
    fail(`walking for four seconds never left tile ${startTile}`);
  } else ok(`walked from tile ${startTile} to ${endTile}`);

  // The scroll has to have actually happened AND the chunk queue has to have
  // drained: soil left queued is soil that is not on screen.
  const hud = (await page.locator('.density-lab-status').innerText()).replace(/\s+/g, ' ');
  const scrollMs = Number(/scroll ([\d.]+) ms/.exec(hud)?.[1] ?? -1);
  if (!(scrollMs > 0)) fail(`no window scroll was reported: "${hud}"`);
  else if (scrollMs > 400) fail(`a scroll took ${scrollMs} ms, which is a visible stall`);
  else ok(`window recentred in ${scrollMs} ms`);
  if (/queued/.test(hud)) fail(`chunks still queued after settling: "${hud}"`);
  else ok('streamed chunks all built');

  // And digging still lands somewhere real after the window has moved.
  await page.locator('button', { hasText: 'DIG' }).first().click({ force: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}-walked.png` });
  const after = (await page.locator('.density-lab-status').innerText()).replace(/\s+/g, ' ');
  if (!/pellet freed/.test(after)) fail(`dig after walking did not reach soil: "${after}"`);
  else ok('dig still reaches soil after the window has scrolled');
  if (errors.length) fail(`walk run: ${errors.slice(0, 2).join(' | ')}`);
  await page.close();
}

await browser.close();
console.log(failed ? '\nDENSITY SMOKE FAILED' : '\nDENSITY SMOKE PASSED');
if (failed) process.exitCode = 1;
