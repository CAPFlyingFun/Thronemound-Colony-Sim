/**
 * Can she walk over the edge of the block onto a side, and round onto the
 * underside, without falling off?
 *
 * That is the whole claim of the block room, and it is the one thing a
 * screenshot cannot answer: a still frame of an ant on a wall looks the same
 * whether she is gripping it or halfway through falling past it. So this
 * holds the stick forward and reports her up vector once a second — +Y on
 * top, horizontal on a side, -Y underneath.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4340/Thronemound-Colony-Sim/?scene=block';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene, null, { timeout: 45000 });
await page.waitForTimeout(3000);

const out = await page.evaluate(() => {
  const lab = window.blockScene;
  const snap = (tag) => ({
    tag,
    up: [lab.up.x, lab.up.y, lab.up.z].map((n) => +n.toFixed(2)),
    at: [lab.at.x, lab.at.y, lab.at.z].map((n) => +(n * 5).toFixed(1)),
    gripping: lab.gripping,
  });
  const trail = [snap('start')];
  lab.input.walk = 1;
  for (let i = 0; i < 14; i += 1) {
    lab.stepForTest(1 / 60, 60);
    trail.push(snap(`${i + 1}s`));
  }
  lab.input.walk = 0;
  return { trail, ready: lab.ready };
});

console.log(JSON.stringify({ errors: errors.slice(0, 3), ready: out.ready }));
for (const t of out.trail) {
  console.log(
    t.tag.padStart(5), 'up', JSON.stringify(t.up).padEnd(22),
    'at', JSON.stringify(t.at).padEnd(24), t.gripping ? '' : 'FALLING',
  );
}
await browser.close();
