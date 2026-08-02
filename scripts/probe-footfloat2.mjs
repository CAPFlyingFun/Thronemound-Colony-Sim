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
  s.stepForTest(1 / 60, 120);

  const up = s.up.clone();
  const solidAtT = (foot, t) => s.solidAt(foot.clone().addScaledVector(up, t));
  const densAtT = (foot, t) => {
    const p = foot.clone().addScaledVector(up, t);
    return s.densityAt(p.x, p.y, p.z);
  };

  const legs = s.drive.legs.map((leg) => {
    const foot = leg.at.clone();
    // Coarse march exactly as specified: from +1 unit down in 0.01 steps.
    let coarseT = null;
    for (let i = 0; i <= 400; i++) {
      const t = 1.0 - i * 0.01;
      if (solidAtT(foot, t)) { coarseT = t; break; }
    }
    // Refine: bracket [lo = last empty, hi = first solid] then bisect on solidAt.
    let lo = coarseT === null ? null : coarseT + 0.01; // empty
    let hi = coarseT;                                   // solid
    let bisectT = null;
    if (hi !== null && !solidAtT(foot, lo)) {
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (solidAtT(foot, mid)) hi = mid; else lo = mid;
      }
      bisectT = (lo + hi) / 2;
    }
    // Independent check: root of densityAt along up (density>0 inside soil).
    let dLo = null, dHi = null, densT = null;
    let a = coarseT + 0.01, b = coarseT;
    const fa = densAtT(foot, a), fb = densAtT(foot, b);
    if (fa < 0 && fb > 0) {
      let x0 = a, x1 = b, f0 = fa, f1 = fb;
      for (let i = 0; i < 80; i++) {
        const mid = (x0 + x1) / 2;
        const fm = densAtT(foot, mid);
        if (fm > 0) { x1 = mid; f1 = fm; } else { x0 = mid; f0 = fm; }
      }
      densT = (x0 + x1) / 2;
      dLo = fa; dHi = fb;
    }
    return {
      slot: leg.slot,
      planted: leg.planted,
      footSolid: s.solidAt(foot),
      densityAtFoot: s.densityAt(foot.x, foot.y, foot.z),
      coarseFloatMm: coarseT === null ? null : -coarseT * 5,
      bisectFloatMm: bisectT === null ? null : -bisectT * 5,
      densRootFloatMm: densT === null ? null : -densT * 5,
      densBracket: [dLo, dHi],
    };
  });

  return { legs, report: s.report, ride: s.ride, rideMm: s.ride * 5, up: [up.x, up.y, up.z] };
});

console.log(JSON.stringify(out, null, 2));
for (const key of ['coarseFloatMm', 'bisectFloatMm', 'densRootFloatMm']) {
  const v = out.legs.map((l) => l[key]).filter((x) => x !== null);
  if (!v.length) { console.log(key, 'none'); continue; }
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const worst = v.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
  console.log(key, 'per-leg', v.map((x) => x.toFixed(6)).join(' '), '| mean', mean.toFixed(6), '| worst', worst.toFixed(6));
}
await browser.close();
