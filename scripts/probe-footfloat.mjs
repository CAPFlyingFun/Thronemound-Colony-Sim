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
  s.input.walk = 0; s.input.yaw = 0; s.input.dig = false;
  s.stepForTest(1 / 60, 120); // 2 seconds

  const up = s.up.clone();
  const legs = s.drive.legs.map((leg) => {
    const foot = leg.at.clone();
    // march from foot + up*1 toward -up in 0.01 steps
    const START = 1.0, STEP = 0.01, MAX = 400; // covers 1 unit above -> 3 units below
    let hit = null;
    let firstSolidT = null;
    for (let i = 0; i <= MAX; i++) {
      const t = START - i * STEP; // signed offset along up from foot
      const p = foot.clone().addScaledVector(up, t);
      if (s.solidAt(p)) { firstSolidT = t; break; }
    }
    let dist = null;
    if (firstSolidT !== null) {
      // distance from foot to surface point along up. Positive t => surface above foot
      // foot floats above soil when surface is BELOW foot => t negative => gap = -t? no:
      // signed distance foot-above-surface = firstSolidT is offset of surface from foot along +up.
      // If surface is below foot, firstSolidT < 0, foot floats by |firstSolidT|.
      dist = -firstSolidT;
    }
    return {
      slot: leg.slot,
      planted: leg.planted,
      down: leg.down,
      footFloatUnits: dist,
      footFloatMm: dist === null ? null : dist * 5,
      surfaceFound: firstSolidT !== null,
      footSolid: s.solidAt(foot),
      density: s.densityAt(foot.x, foot.y, foot.z),
      at: [leg.at.x, leg.at.y, leg.at.z],
    };
  });

  return {
    legs,
    report: s.report,
    ride: s.ride,
    rideMm: s.ride * 5,
    up: [up.x, up.y, up.z],
    at: [s.at.x, s.at.y, s.at.z],
  };
});

console.log(JSON.stringify(out, null, 2));
const vals = out.legs.filter((l) => l.footFloatMm !== null).map((l) => l.footFloatMm);
if (vals.length) {
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const worst = vals.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
  console.log('MEAN_MM', mean.toFixed(5), 'WORST_MM', worst.toFixed(5), 'N', vals.length);
}
await browser.close();
