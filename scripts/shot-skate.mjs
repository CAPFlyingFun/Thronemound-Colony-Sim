/**
 * DO HER FEET SKATE?
 *
 * A planted foot is anchored to a world point, so while it is down its
 * ground speed must be ZERO however fast the cycle runs. That is the number
 * "walking with a running animation" is really about: not the cadence, but
 * whether the foot that is supposedly bearing weight is sliding under her.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/shot-skate.mjs
 */
import { chromium } from 'playwright';
const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 90000 });
await page.waitForFunction(() => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 90000 });
await page.waitForFunction(() => window.islandScene.drive != null, null, { timeout: 60000 });
await page.evaluate(() => window.islandScene.setPausedForTest(true));

const r = await page.evaluate(() => {
  const s = window.islandScene, MM = 5;
  const slots = s.queen.legPlan().map((l) => l.slot);
  const last = new Map();
  /*
   * A PLANTED foot is pinned to a world point, so between two frames its
   * anchor moves EXACTLY zero. A swinging one moves a lot. There is no
   * middle: any small non-zero movement is a foot that is supposed to be
   * bearing weight and is instead sliding, which is the skate.
   */
  let pinned = 0, sliding = 0, swinging = 0, worstSlide = 0;
  const before = s.at.clone();
  s.input.walk = 1;
  for (let f = 0; f < 900; f += 1) {
    s.stepForTest(1 / 60, 1);
    for (const slot of slots) {
      const a = s.drive.anchorFor(slot);
      if (!a) continue;
      const prev = last.get(slot);
      if (prev) {
        const d = Math.hypot(a[0] - prev[0], a[1] - prev[1], a[2] - prev[2]) * MM;
        if (d === 0) pinned += 1;
        else if (d > 0.25) swinging += 1;
        else { sliding += 1; worstSlide = Math.max(worstSlide, d); }
      }
      last.set(slot, [a[0], a[1], a[2]]);
    }
  }
  s.input.walk = 0;
  travel = s.at.distanceTo(before) * MM;
  return {
    pinned, sliding, swinging, worstSlideMm: worstSlide,
    travelMm: travel, secs: 900 / 60,
    groundMmPerS: s.groundSpeed * MM,
    report: s.driveReport ? {
      planted: s.driveReport.planted, groping: s.driveReport.groping,
      movedMm: +s.driveReport.movedMm.toFixed(3),
      heldBackMm: +s.driveReport.heldBackMm.toFixed(3),
    } : null,
  };
});
console.log('\nFIFTEEN SECONDS OF WALKING');
console.log(`  travelled ${r.travelMm.toFixed(0)} mm in ${r.secs} s = ${(r.travelMm / r.secs).toFixed(1)} mm/s`);
const held = r.pinned + r.sliding;
console.log(`  foot-frames pinned dead still: ${r.pinned} of ${held} weight-bearing `
  + `(${((100 * r.pinned) / Math.max(1, held)).toFixed(1)}%)`);
console.log(`  foot-frames SLIDING while down: ${r.sliding}, worst ${r.worstSlideMm.toFixed(4)} mm`);
console.log(`  foot-frames swinging (free, expected): ${r.swinging}`);
console.log(`  last step: ${JSON.stringify(r.report)}`);
console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
