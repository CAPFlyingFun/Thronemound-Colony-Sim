import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
await page.goto('http://localhost:4380/Thronemound-Colony-Sim/?scene=block', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.drive, null, { timeout: 90000 });
await page.waitForTimeout(800);

const out = await page.evaluate(() => {
  const s = window.blockScene;
  const r = {};
  // level bite
  s.aimPitch = 0;
  s.input.dig = true;
  s.stepForTest(1 / 60, 180);
  s.input.dig = false;
  r.level = { removed: s.removed, why: s.lastBiteWhy, status: s.status,
    solidAhead: [0.5, 1, 1.5, 2, 3].map((d) => ({ d,
      solid: s.solidAt(s.at.clone().addScaledVector(s.forward, d)),
      dens: +s.densityAt(s.at.x + s.forward.x * d, s.at.y + s.forward.y * d, s.at.z + s.forward.z * d).toFixed(4) })) };
  // pitched bite on same page
  s.aimPitch = (-40 * Math.PI) / 180;
  s.input.dig = true;
  s.stepForTest(1 / 60, 180);
  s.input.dig = false;
  r.pitched = { removed: s.removed, why: s.lastBiteWhy, status: s.status };
  return r;
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
