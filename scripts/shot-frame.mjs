/** Portrait of the formicarium frame, from near the world's western edge. */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL
  ?? 'http://localhost:4308/Thronemound-Colony-Sim/?map=densityterrainlab&nomenu=1';
const OUT = process.env.SHOT_OUT ?? '/tmp/frame.png';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({
  viewport: { width: 932, height: 430 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true,
});
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.labScene?.queenReady === true, null, { timeout: 60000 });
await page.evaluate(() => {
  const lab = window.labScene;
  lab.antPosition.set(7, 0, 32);
  lab.resetDynamics();
  lab.stepForTest(1 / 60, 30);
  // The window recentres from the locomotion path, so a parked teleport
  // never scrolls it — arrive the honest way, with a moment of walking.
  lab.input.walk = 1;
  lab.stepForTest(1 / 60, 30);
  lab.input.walk = 0;
  lab.stepForTest(1 / 60, 120);
  // Face her at the wall and swing the camera to see her, the corner and the rails.
  lab.follow.orbit(2.6, 0.15);
  lab.follow.zoom(1.6);
  lab.stepForTest(1 / 60, 90);
});
// The teleport scrolls the window to the world's edge, which queues most of
// it for remesh; photograph the terrain, not the backlog.
await page.waitForFunction(
  () => window.labScene.pending.length === 0, null, { timeout: 60000 },
);
await page.waitForTimeout(800);
await page.screenshot({ path: OUT });
await browser.close();
console.log(OUT);
