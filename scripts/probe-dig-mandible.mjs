/**
 * Read-only probe: does digging at the mandible still remove soil?
 * Three independent page loads so each measurement starts from pristine terrain.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

async function fresh() {
  const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  await page.goto('http://localhost:4380/Thronemound-Colony-Sim/?scene=block', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.blockScene?.drive, null, { timeout: 90000 });
  await page.waitForTimeout(800);
  return page;
}

const snap = (s) => ({
  removed: s.removed,
  at: [s.at.x, s.at.y, s.at.z],
  up: [s.up.x, s.up.y, s.up.z],
  forward: [s.forward.x, s.forward.y, s.forward.z],
  aimPitch: s.aimPitch,
  ride: s.ride,
  report: s.report ? JSON.parse(JSON.stringify(s.report)) : null,
  planted: s.drive?.legs?.filter((l) => l.planted).length ?? null,
  legs: s.drive?.legs?.length ?? null,
});

// ---- shape check on one page first
{
  const page = await fresh();
  const shape = await page.evaluate(() => {
    const s = window.blockScene;
    return {
      keys: Object.keys(s),
      removedType: typeof s.removed,
      removed: s.removed,
      aimPitchType: typeof s.aimPitch,
      aimPitch: s.aimPitch,
      input: JSON.parse(JSON.stringify(s.input)),
      legs: s.drive.legs.length,
    };
  });
  console.log('SHAPE', JSON.stringify(shape, null, 1));
  await page.close();
}

// ---- Test A: aimPitch -40 deg
async function digTest(pitchDeg, walkSeconds) {
  const page = await fresh();
  const out = await page.evaluate(async ([pitchDeg, walkSeconds]) => {
    const s = window.blockScene;
    const grab = () => ({
      removed: s.removed,
      at: [s.at.x, s.at.y, s.at.z].map((n) => +n.toFixed(4)),
      up: [s.up.x, s.up.y, s.up.z].map((n) => +n.toFixed(4)),
      forward: [s.forward.x, s.forward.y, s.forward.z].map((n) => +n.toFixed(4)),
      aimPitch: s.aimPitch,
      ride: s.ride,
      report: s.report ? JSON.parse(JSON.stringify(s.report)) : null,
      planted: s.drive.legs.filter((l) => l.planted).length,
    });
    const res = { spawn: grab(), walkSeconds };

    if (walkSeconds > 0) {
      s.input.walk = 1; s.input.yaw = 0; s.input.dig = false;
      // walk in one-second chunks so we can watch .up roll over the edge
      res.walkTrace = [];
      for (let i = 0; i < walkSeconds; i++) {
        s.stepForTest(1 / 60, 60);
        res.walkTrace.push({
          t: i + 1,
          up: [s.up.x, s.up.y, s.up.z].map((n) => +n.toFixed(3)),
          at: [s.at.x, s.at.y, s.at.z].map((n) => +n.toFixed(2)),
        });
      }
      s.input.walk = 0;
      s.stepForTest(1 / 60, 30);
    }

    res.beforeDig = grab();
    s.aimPitch = (pitchDeg * Math.PI) / 180;
    s.input.walk = 0; s.input.yaw = 0;
    s.input.dig = true;
    s.stepForTest(1 / 60, 180); // 3 seconds
    s.input.dig = false;
    res.afterDig = grab();
    res.removedDelta = res.afterDig.removed - res.beforeDig.removed;
    return res;
  }, [pitchDeg, walkSeconds]);
  await page.close();
  return out;
}

const A = await digTest(-40, 0);
console.log('TEST_A_pitch-40_flat', JSON.stringify({ ...A, walkTrace: undefined }, null, 1));

const B = await digTest(0, 0);
console.log('TEST_B_pitch0_flat', JSON.stringify({ ...B, walkTrace: undefined }, null, 1));

const C = await digTest(-40, 14);
console.log('TEST_C_pitch-40_underside', JSON.stringify(C, null, 1));

await browser.close();
