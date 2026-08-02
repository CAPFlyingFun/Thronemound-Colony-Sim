/**
 * Turning on the spot: rate, smoothness, foot slip, planted count.
 * Measurement only. Touches nothing.
 */
import { chromium } from 'playwright';

const URL = 'http://localhost:4380/Thronemound-Colony-Sim/?scene=block';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

async function run(page, yaw) {
  return await page.evaluate((yawDir) => {
    const s = window.blockScene;
    const V = s.at.constructor;
    const DT = 1 / 60;
    const FRAMES = 180;

    const snap = () => {
      const legs = s.drive.legs.map((l) => ({
        slot: l.slot,
        planted: !!l.planted,
        at: [l.at.x, l.at.y, l.at.z],
      }));
      return {
        f: [s.forward.x, s.forward.y, s.forward.z],
        u: [s.up.x, s.up.y, s.up.z],
        p: [s.at.x, s.at.y, s.at.z],
        legs,
      };
    };

    s.input.walk = 0;
    s.input.yaw = yawDir;
    s.input.dig = false;

    // settle a few frames with the input applied before we start the clock
    s.stepForTest(DT, 6);

    const frames = [snap()];
    for (let i = 0; i < FRAMES; i++) {
      s.stepForTest(DT, 1);
      frames.push(snap());
    }
    s.input.yaw = 0;

    // ---- heading, unwrapped: sum signed per-frame angle about up ----
    const cross = (a, b) => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const D = 180 / Math.PI;

    const steps = [];
    let total = 0;
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1].f;
      const b = frames[i].f;
      const u = frames[i].u;
      const d = Math.atan2(dot(cross(a, b), u), dot(a, b)) * D;
      steps.push(d);
      total += d;
    }

    // ---- foot slip while planted (both frames planted) ----
    const slips = [];
    const perLeg = {};
    for (let i = 1; i < frames.length; i++) {
      const prev = frames[i - 1].legs;
      const cur = frames[i].legs;
      for (let k = 0; k < cur.length; k++) {
        const a = prev[k];
        const b = cur[k];
        if (!a || !b || !a.planted || !b.planted) continue;
        const dx = b.at[0] - a.at[0];
        const dy = b.at[1] - a.at[1];
        const dz = b.at[2] - a.at[2];
        const mm = Math.sqrt(dx * dx + dy * dy + dz * dz) * 5;
        slips.push(mm);
        (perLeg[b.slot] ??= []).push(mm);
      }
    }
    const med = (arr) => {
      if (!arr.length) return null;
      const v = [...arr].sort((x, y) => x - y);
      const m = v.length >> 1;
      return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
    };

    // ---- planted count ----
    const plantedCounts = frames.map((fr) => fr.legs.filter((l) => l.planted).length);

    // body drift (should be ~0 for turning on the spot)
    const p0 = frames[0].p;
    const p1 = frames[frames.length - 1].p;
    const drift =
      Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) * 5;

    const firstSec = steps.slice(0, 60).map(Math.abs);
    const allAbs = steps.map(Math.abs);

    return {
      yaw: yawDir,
      totalDeg: total,
      degPerSec: total / (FRAMES * DT),
      firstSecTotalDeg: steps.slice(0, 60).reduce((a, b) => a + b, 0),
      stepMeanDeg_1s: firstSec.reduce((a, b) => a + b, 0) / firstSec.length,
      stepWorstDeg_1s: Math.max(...firstSec),
      stepMinDeg_1s: Math.min(...firstSec),
      stepMedianDeg_1s: med(firstSec),
      zeroFrames_1s: firstSec.filter((v) => v < 1e-6).length,
      stepMeanDeg_3s: allAbs.reduce((a, b) => a + b, 0) / allAbs.length,
      stepWorstDeg_3s: Math.max(...allAbs),
      slipWorstMm: slips.length ? Math.max(...slips) : null,
      slipMedianMm: med(slips),
      slipMeanMm: slips.length ? slips.reduce((a, b) => a + b, 0) / slips.length : null,
      slipSamples: slips.length,
      slipPerLegWorstMm: Object.fromEntries(
        Object.entries(perLeg).map(([k, v]) => [k, Math.max(...v)]),
      ),
      plantedMean:
        plantedCounts.reduce((a, b) => a + b, 0) / plantedCounts.length,
      plantedMin: Math.min(...plantedCounts),
      plantedMax: Math.max(...plantedCounts),
      legCount: frames[0].legs.length,
      bodyDriftMm: drift,
      report: s.report,
      rideMm: s.ride * 5,
    };
  }, yaw);
}

const results = {};
for (const yaw of [1, -1]) {
  const page = await browser.newPage({
    viewport: { width: 932, height: 430 },
    deviceScaleFactor: 2,
  });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.blockScene?.drive, null, { timeout: 90000 });
  await page.waitForTimeout(800);
  results[yaw > 0 ? 'yaw+1' : 'yaw-1'] = await run(page, yaw);
  await page.close();
}

console.log(JSON.stringify(results, null, 2));
await browser.close();
