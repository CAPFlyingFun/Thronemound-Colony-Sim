/** A close third-person portrait of the camera pod parked on her head. */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL
  ?? 'http://localhost:4304/Thronemound-Colony-Sim/?map=densityterrainlab&nomenu=1';
const OUT = process.env.SHOT_OUT ?? '/tmp/pod.png';

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
  lab.stepForTest(1 / 60, 120);
  lab.follow.zoom(0.45);
  // Swing round to a front three-quarter, a touch lower, so the pod and its
  // lens face the camera instead of hiding behind her gaster.
  lab.follow.orbit(2.4, -0.25);
  lab.stepForTest(1 / 60, 90);
});
await page.waitForTimeout(600);
await page.screenshot({ path: OUT });
await browser.close();
console.log(OUT);
