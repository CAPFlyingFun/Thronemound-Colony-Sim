/**
 * KAUAI AT 1:1000 — is the island real, whole, and walkable?
 *
 *   1. all 64 sections build (vertex/triangle census matches the maths)
 *   2. the ant spawns mid-island on the summit plateau, ~1,300 m up
 *   3. real-Kauai sanity: the centre is high, the corners are ocean,
 *      the shoreline exists (a walk from summit toward the coast descends)
 *   4. a walk simulates without pops
 *   5. the red-sky test: fog off, background red, whole-island view — not
 *      one red pixel below the horizon line means not one hole anywhere
 *   6. no page errors
 *
 *   SMOKE_URL=http://localhost:4173/Thronemound-Colony-Sim/ node scripts/probe-island.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://localhost:4173/Thronemound-Colony-Sim/')
  .replace(/\/$/, '');

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
page.on('pageerror', (e) => errs.push(e.message));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 60000 });
await page.evaluate(() => window.islandScene.setPausedForTest(true));

console.log('\nTHE ISLAND');
const stats = await page.evaluate(() => window.islandScene.statsForTest());
check('all 64 sections built', stats.verts === 64 * 65 * 65 && stats.tris === 64 * 64 * 64 * 2,
  `${stats.verts.toLocaleString()} verts, ${stats.tris.toLocaleString()} tris`);

const geo = await page.evaluate(() => {
  const s = window.islandScene;
  return {
    centre: s.heightAtMm(28000, 28000),
    cornerNW: s.heightAtMm(2000, 2000),
    cornerSE: s.heightAtMm(54000, 54000),
    midwayWest: s.heightAtMm(14000, 28000),
    antX: s.at.x * 5,
    antZ: s.at.z * 5,
    antElev: s.heightAtMm(s.at.x * 5, s.at.z * 5),
  };
});
check('ant stands mid-island', Math.abs(geo.antX - 28000) < 100 && Math.abs(geo.antZ - 28000) < 100,
  `at (${geo.antX.toFixed(0)}, ${geo.antZ.toFixed(0)}) mm`);
check('the centre is the high country', geo.centre > 900,
  `${geo.centre.toFixed(0)} m elevation`);
check('the north-west corner is ocean', geo.cornerNW < 0,
  `${geo.cornerNW.toFixed(0)} m`);
check('the south-east corner is ocean', geo.cornerSE < 0,
  `${geo.cornerSE.toFixed(0)} m`);
check('west midway is lower than the summit (island falls to the sea)',
  geo.midwayWest < geo.centre, `${geo.midwayWest.toFixed(0)} m vs ${geo.centre.toFixed(0)} m`);

console.log('\nTHE WALK (600 steps west off the plateau)');
const walk = await page.evaluate(() => {
  const s = window.islandScene;
  s.setFacingForTest(-Math.PI / 2);
  s.input.walk = 1;
  let worstStepMm = 0;
  let lastY = null;
  for (let i = 0; i < 600; i += 1) {
    s.stepForTest(1 / 60, 1);
    const y = s.at.y * 5;
    if (lastY !== null) worstStepMm = Math.max(worstStepMm, Math.abs(y - lastY));
    lastY = y;
  }
  s.input.walk = 0;
  return { worstStepMm, travelledMm: 28000 - s.at.x * 5 };
});
check('no pop underfoot', walk.worstStepMm < 2.0,
  `worst single-step height change ${walk.worstStepMm.toFixed(2)} mm over ${walk.travelledMm.toFixed(0)} mm`);

console.log('\nTHE RED-SKY TEST (fog off, red background, island panorama)');
await page.evaluate(() => {
  const s = window.islandScene;
  s.teleportMm(28000, 28000);
  s.scene.fog = null;
  s.scene.background.setHex(0xff0000);
  s.camPitch = 0.35;
  s.camDist = 900;
  s.setPausedForTest(false);
});
await page.waitForTimeout(800);
const holes = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  // readPixels is bottom-up: rows 0..h*0.45 are the LOWER 45% of the screen,
  // safely below the horizon from this boom height — sky must not appear.
  let red = 0;
  const rows = Math.floor(h * 0.45);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      if (px[o] > 200 && px[o + 1] < 60 && px[o + 2] < 60) red += 1;
    }
  }
  return { red, sampled: rows * w };
});
check('not one hole in the island', holes.red === 0,
  `${holes.red} red pixels of ${holes.sampled.toLocaleString()} below the horizon`);

console.log('\nERRORS');
check('no page errors', errs.length === 0, errs.join(' | ').slice(0, 200));

// Pretty shots: a reload puts the real sky and haze back.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 60000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: '/tmp/island-summit.png' });
await page.evaluate(() => {
  const s = window.islandScene;
  s.setPausedForTest(true);
  s.teleportMm(20000, 10000);
  s.camPitch = 0.22;
  s.camDist = 500;
  s.setPausedForTest(false);
});
await page.waitForTimeout(700);
await page.screenshot({ path: '/tmp/island-coast.png' });

await browser.close();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECKS FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
