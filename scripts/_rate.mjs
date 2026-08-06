/** With only mouthfuls, how long to chew a hole she can actually get into? */
import { chromium } from 'playwright';
const base = (process.env.SMOKE_URL ?? 'http://localhost:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 60000 });
await page.waitForFunction(() => document.querySelector('.tm-loading-root') === null, null, { timeout: 60000 });
await page.evaluate(() => window.islandScene.setPausedForTest(true));
const r = await page.evaluate(() => {
  const s = window.islandScene;
  s.teleportMm(27100, 27100);
  s.drainQueueForTest();
  s.setFacingForTest(0);
  const y0 = s.at.y * 5;
  s.input.dig = true;
  s.input.walk = 1;
  // A player sweeping the face: aim wanders around the bore while chewing.
  let frames = 0;
  let advanced = 0;
  const MAX = 30 * 120;            // two minutes of game time
  let t = 0;
  while (frames < MAX) {
    t += 1 / 30;
    // Sweep a rosette around a downward aim, the way a thumb would.
    s.aimPitch = -0.75 + Math.sin(t * 2.1) * 0.35;
    s.setFacingForTest(Math.sin(t * 1.3) * 0.35);
    s.stepForTest(1 / 30, 1);
    frames += 1;
    if (frames % 60 === 0) s.drainQueueForTest();
    advanced = y0 - s.at.y * 5;
    if (advanced > 20) break;
  }
  s.input.dig = false; s.input.walk = 0;
  s.drainQueueForTest();
  return {
    seconds: frames / 30,
    advanced,
    edited: s.statsForTest().edited,
    reached20: advanced > 20,
  };
});
console.log('\nMOUTHFULS ONLY — TIME TO CHEW IN 20 mm');
console.log(`  advanced ${r.advanced.toFixed(1)} mm in ${r.seconds.toFixed(1)} s of digging`);
console.log(`  soil removed: ${r.edited} samples`);
console.log(`  ${r.reached20 ? `rate ≈ ${(r.advanced / r.seconds).toFixed(2)} mm/s` : 'did NOT reach 20 mm in two minutes'}`);
await browser.close();
