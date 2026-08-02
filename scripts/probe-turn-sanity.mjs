/**
 * Sanity: do feet move at all during the on-the-spot turn, and do legs
 * actually re-plant? Confirms the zero-slip result is real.
 */
import { chromium } from 'playwright';

const URL = 'http://localhost:4380/Thronemound-Colony-Sim/?scene=block';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.drive, null, { timeout: 90000 });
await page.waitForTimeout(800);

const out = await page.evaluate(() => {
  const s = window.blockScene;
  const DT = 1 / 60;
  s.input.walk = 0;
  s.input.yaw = 1;
  s.input.dig = false;
  s.stepForTest(DT, 6);

  const frames = [];
  for (let i = 0; i < 180; i++) {
    s.stepForTest(DT, 1);
    frames.push(
      s.drive.legs.map((l) => ({ slot: l.slot, p: !!l.planted, at: [l.at.x, l.at.y, l.at.z] })),
    );
  }
  s.input.yaw = 0;

  const legs = {};
  for (let k = 0; k < frames[0].length; k++) {
    const slot = frames[0][k].slot;
    let transitions = 0;
    let airborneMoveMax = 0;
    let totalTravelMm = 0;
    let plantedFrames = 0;
    const anchors = new Set();
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1][k];
      const b = frames[i][k];
      if (a.p !== b.p) transitions++;
      if (b.p) plantedFrames++;
      const d = Math.hypot(b.at[0] - a.at[0], b.at[1] - a.at[1], b.at[2] - a.at[2]) * 5;
      totalTravelMm += d;
      if (!b.p || !a.p) airborneMoveMax = Math.max(airborneMoveMax, d);
      anchors.add(b.at.map((v) => v.toFixed(4)).join(','));
    }
    legs[slot] = {
      plantStateTransitions: transitions,
      plantedFrames,
      distinctFootPositions: anchors.size,
      totalFootTravelMm: totalTravelMm,
      maxSingleFrameMoveMm: airborneMoveMax,
    };
  }
  return { legs, sceneKeys: Object.keys(s.drive.legs[0]) };
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
