import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.goto('http://localhost:4380/Thronemound-Colony-Sim/?scene=block', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.drive, null, { timeout: 90000 });
await page.waitForTimeout(800);

const out = await page.evaluate(() => {
  const s = window.blockScene;
  const MM = 5;
  s.input.walk = 0; s.input.yaw = 0; s.input.dig = false;

  // 30 s of standing still, sampling absolute Y each second at full precision.
  const y0 = s.at.y;
  const perSecY = [];
  let monotoneUp = 0, monotoneDown = 0, zero = 0;
  let prevY = s.at.y;
  for (let sec = 0; sec < 30; sec++) {
    for (let f = 0; f < 60; f++) {
      s.stepForTest(1 / 60, 1);
      const dy = s.at.y - prevY;
      if (dy > 0) monotoneUp++; else if (dy < 0) monotoneDown++; else zero++;
      prevY = s.at.y;
    }
    perSecY.push((s.at.y - y0) * MM);
  }

  // Per-frame deltas over the LAST second only (steady state, no initial settle).
  const tail = [];
  let p = s.at.clone();
  for (let f = 0; f < 60; f++) {
    s.stepForTest(1 / 60, 1);
    tail.push(s.at.distanceTo(p) * MM);
    p = s.at.clone();
  }

  return {
    driftAfter30sMm: (s.at.y - y0) * MM,
    perSecondCumulativeMm: perSecY.map((v) => v.toExponential(3)),
    framesUp: monotoneUp, framesDown: monotoneDown, framesZero: zero,
    tailPerFrameMaxMm: Math.max(...tail).toExponential(3),
    tailPerFrameSumMm: tail.reduce((a, b) => a + b, 0).toExponential(3),
    ride: s.ride,
    upEnd: [s.up.x, s.up.y, s.up.z],
  };
});

console.log(JSON.stringify({ ...out, pageErrors }, null, 2));
await browser.close();
