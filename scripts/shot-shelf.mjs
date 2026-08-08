/**
 * LOOK AT THE SHELF, AND AT WHAT THE SHOVEL ACTUALLY DOES.
 *
 * Two reports to reproduce on this end rather than guess at: a flat, wrongly
 * painted patch of ground around her on steep country, and a dig that does
 * not always take. This walks her onto a slope, photographs it, prints the
 * numbers behind the picture (band ceiling versus the ground overhead), then
 * taps the shovel and reports what each press removed.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/shot-shelf.mjs
 */

import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
page.on('pageerror', (e) => errs.push(e.message));

await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 90000 });
await page.waitForFunction(
  () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 90000 },
);
await page.evaluate(() => window.islandScene.setPausedForTest(true));

/* THE BAND VERSUS THE HILL. The window is 192 mm across and the band is a
 * fixed 256 mm tall, so the question is simply how much of the ground inside
 * the window sits above the ceiling. Anything over it is the capped country
 * that draws as a flat lid. */
const survey = await page.evaluate(() => {
  const s = window.islandScene;
  const st = s.stream;
  const MM = 5;
  const ceil = s.bandTop.value;
  let above = 0;
  let total = 0;
  let worst = -Infinity;
  const step = 8;
  for (let cz = 0; cz <= 192; cz += step) {
    for (let cx = 0; cx <= 192; cx += step) {
      const wx = st.originWorldX + cx * 0.2;
      const wz = st.originWorldZ + cz * 0.2;
      const g = s.groundHeightAt(wx, wz);
      total += 1;
      if (g > ceil) above += 1;
      worst = Math.max(worst, (g - ceil) * MM);
    }
  }
  return {
    ceilMm: ceil * MM,
    floorMm: st.bandFloorWu * MM,
    hereMm: s.at.y * MM,
    aboveShare: above / total,
    worstOverMm: worst,
  };
});
console.log('\nTHE BAND AND THE HILL');
console.log(`  band floor ${survey.floorMm.toFixed(1)} mm, ceiling ${survey.ceilMm.toFixed(1)} mm`);
console.log(`  she is at ${survey.hereMm.toFixed(1)} mm`);
console.log(`  ground above the ceiling: ${(survey.aboveShare * 100).toFixed(1)}% of the window`);
console.log(`  worst overrun: ${survey.worstOverMm.toFixed(1)} mm`);

await page.evaluate(() => window.islandScene.setPausedForTest(false));
await page.waitForTimeout(600);
await page.screenshot({ path: '/tmp/shot-here.png', timeout: 90000 });

/* WALK HER ONTO THE STEEP FLANK — where the report's screenshots were taken. */
await page.evaluate(() => {
  const s = window.islandScene;
  s.setFacingForTest(Math.PI * 0.75);
  s.input.walk = 1;
  s.input.sprint = true;
});
await page.waitForTimeout(6000);
await page.evaluate(() => { window.islandScene.input.walk = 0; });
await page.waitForTimeout(1200);
await page.screenshot({ path: '/tmp/shot-slope.png', timeout: 90000 });

const onSlope = await page.evaluate(() => {
  const s = window.islandScene;
  const MM = 5;
  return {
    upY: s.up.y,
    hereMm: s.at.y * MM,
    ceilMm: s.bandTop.value * MM,
    groundMm: s.groundHeightAt(s.at.x, s.at.z) * MM,
  };
});
console.log('\nAFTER A WALK UPHILL');
console.log(`  her up.y ${onSlope.upY.toFixed(3)} (1 = level, 0 = a wall)`);
console.log(`  she is at ${onSlope.hereMm.toFixed(1)} mm, ceiling ${onSlope.ceilMm.toFixed(1)} mm, `
  + `ground ${onSlope.groundMm.toFixed(1)} mm`);

/* THE SHOVEL, TAP BY TAP. Aim into the hill and press. */
console.log('\nTHE SHOVEL, ONE TAP AT A TIME');
await page.evaluate(() => {
  const s = window.islandScene;
  s.aimPitchForTest(-0.35);
});
console.log('  ' + JSON.stringify(await page.evaluate(() => window.islandScene.biteProbeForTest())));
for (let i = 0; i < 6; i += 1) {
  const took = await page.evaluate(async () => {
    const s = window.islandScene;
    const before = s.stream.editedSamples;
    s.input.dig = true;
    await new Promise((r) => setTimeout(r, 90));
    s.input.dig = false;
    await new Promise((r) => setTimeout(r, 380));
    return { gained: s.stream.editedSamples - before, seat: s.biteProbeForTest().seatMm };
  });
  console.log(`  tap ${i + 1}: ${took.gained} samples, seat ${took.seat.toFixed(2)} mm out`);
}
await page.waitForTimeout(800);
await page.screenshot({ path: '/tmp/shot-dug.png', timeout: 90000 });

console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
