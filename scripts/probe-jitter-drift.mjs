import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });

const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') {
    consoleErrors.push(`[${m.type()}] ${m.text()}`);
  }
});
page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
page.on('requestfailed', (r) => pageErrors.push(`REQFAIL ${r.url()} ${r.failure()?.errorText}`));

await page.goto('http://localhost:4380/Thronemound-Colony-Sim/?scene=block', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.drive, null, { timeout: 90000 });
await page.waitForTimeout(800);

// Everything below runs in ONE synchronous evaluate so the page's own RAF loop
// cannot interleave with our deterministic stepForTest stepping.
const out = await page.evaluate(() => {
  const s = window.blockScene;
  const MM = 5; // 1 world unit = 5 mm
  const DEG = 180 / Math.PI;

  const angleBetween = (a, b) => {
    const d = Math.min(1, Math.max(-1, a.dot(b) / (a.length() * b.length())));
    return Math.acos(d) * DEG;
  };

  const sane = {
    legs: s.drive.legs.length,
    plantedAtStart: s.drive.legs.filter((l) => l.planted).length,
    ride: s.ride,
    atStart: [s.at.x, s.at.y, s.at.z],
    upStart: [s.up.x, s.up.y, s.up.z],
    footSpreadMm: (() => {
      const pts = s.drive.legs.map((l) => l.at);
      let mx = 0;
      for (let i = 0; i < pts.length; i++)
        for (let j = i + 1; j < pts.length; j++) mx = Math.max(mx, pts[i].distanceTo(pts[j]));
      return mx * MM;
    })(),
  };

  // ---------- 1 & 2: STANDING STILL, 6 s ----------
  s.input.walk = 0; s.input.yaw = 0; s.input.dig = false;

  const N_STILL = 360; // 6 s at 1/60
  let prevAt = s.at.clone();
  let prevUp = s.up.clone();
  const startAt = s.at.clone();
  const startUp = s.up.clone();

  let pathMm = 0;          // total arc length travelled
  let worstStepMm = 0;
  let worstStepFrame = -1;
  let worstUpDeg = 0;
  let worstUpFrame = -1;
  let upDegSum = 0;
  const perSecondNetMm = [];
  let secAnchor = s.at.clone();

  for (let i = 0; i < N_STILL; i++) {
    s.stepForTest(1 / 60, 1);
    const at = s.at.clone();
    const up = s.up.clone();

    const stepMm = at.distanceTo(prevAt) * MM;
    pathMm += stepMm;
    if (stepMm > worstStepMm) { worstStepMm = stepMm; worstStepFrame = i; }

    const dUp = angleBetween(prevUp, up);
    upDegSum += dUp;
    if (dUp > worstUpDeg) { worstUpDeg = dUp; worstUpFrame = i; }

    if ((i + 1) % 60 === 0) {
      perSecondNetMm.push(+(at.distanceTo(secAnchor) * MM).toFixed(4));
      secAnchor = at.clone();
    }
    prevAt = at; prevUp = up;
  }

  const still = {
    netDriftMm: s.at.distanceTo(startAt) * MM,
    pathLengthMm: pathMm,
    worstFrameMm: worstStepMm,
    worstFrameIndex: worstStepFrame,
    meanFrameMm: pathMm / N_STILL,
    perSecondNetMm,
    netDriftVecMm: [
      (s.at.x - startAt.x) * MM,
      (s.at.y - startAt.y) * MM,
      (s.at.z - startAt.z) * MM,
    ],
    upWorstPerFrameDeg: worstUpDeg,
    upWorstFrameIndex: worstUpFrame,
    upMeanPerFrameDeg: upDegSum / N_STILL,
    upTotalDriftDeg: angleBetween(startUp, s.up),
    upEnd: [s.up.x, s.up.y, s.up.z],
    reportAfterStill: JSON.parse(JSON.stringify(s.report ?? null)),
    plantedAfterStill: s.drive.legs.filter((l) => l.planted).length,
  };

  // ---------- 3: WALKING, 4 s ----------
  s.input.walk = 1; s.input.yaw = 0; s.input.dig = false;

  const N_WALK = 240; // 4 s at 1/60
  let prevW = s.at.clone();
  const walkStart = s.at.clone();
  let walkPathMm = 0;
  let walkWorstMm = 0;
  let walkWorstFrame = -1;
  let heldSum = 0;
  let heldWorst = 0;
  let heldSamples = 0;
  let movedSum = 0;
  let movedSamples = 0;
  let gropingFrames = 0;
  let plantedSum = 0;
  const heldSeries = [];

  for (let i = 0; i < N_WALK; i++) {
    s.stepForTest(1 / 60, 1);
    const at = s.at.clone();
    const d = at.distanceTo(prevW) * MM;
    walkPathMm += d;
    if (d > walkWorstMm) { walkWorstMm = d; walkWorstFrame = i; }
    prevW = at;

    const r = s.report;
    if (r) {
      if (typeof r.heldBackMm === 'number') {
        heldSum += r.heldBackMm;
        heldWorst = Math.max(heldWorst, r.heldBackMm);
        heldSamples++;
        if (i % 24 === 0) heldSeries.push(+r.heldBackMm.toFixed(3));
      }
      if (typeof r.movedMm === 'number') { movedSum += r.movedMm; movedSamples++; }
      if (r.groping) gropingFrames++;
      if (typeof r.planted === 'number') plantedSum += r.planted;
    }
  }

  const walk = {
    meanFrameMm: walkPathMm / N_WALK,
    worstFrameMm: walkWorstMm,
    worstFrameIndex: walkWorstFrame,
    netDisplacementMm: s.at.distanceTo(walkStart) * MM,
    pathLengthMm: walkPathMm,
    impliedSpeedMmPerSec: (s.at.distanceTo(walkStart) * MM) / 4,
    heldBackMeanMm: heldSamples ? heldSum / heldSamples : null,
    heldBackWorstMm: heldSamples ? heldWorst : null,
    heldBackSamples: heldSamples,
    heldBackSeries: heldSeries,
    reportMovedMeanMm: movedSamples ? movedSum / movedSamples : null,
    gropingFrames,
    meanPlanted: plantedSum / N_WALK,
    reportKeys: s.report ? Object.keys(s.report) : null,
    reportAfterWalk: JSON.parse(JSON.stringify(s.report ?? null)),
  };

  s.input.walk = 0;
  return { sane, still, walk };
});

// Give the page a moment for any deferred/async errors to surface.
await page.waitForTimeout(500);

console.log(JSON.stringify({
  ...out,
  consoleErrors: consoleErrors.slice(0, 25),
  consoleErrorCount: consoleErrors.length,
  pageErrors: pageErrors.slice(0, 25),
  pageErrorCount: pageErrors.length,
}, null, 2));

await browser.close();
