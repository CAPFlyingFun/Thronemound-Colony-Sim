/**
 * Which side face locks? Walk off each of the four edges and see.
 *
 * Reloads the page between runs so each starts from the same spawn, turns her
 * with yaw until her forward points at the chosen edge, then holds walk=1.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4401/Thronemound-Colony-Sim/?scene=block';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const run = async (yawSign, yawSecs, label) => {
  const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.blockScene?.drive, null, { timeout: 60000 });
  await page.waitForTimeout(2000);
  const out = await page.evaluate(({ yawSign, yawSecs }) => {
    const lab = window.blockScene;
    const MM = 5;
    lab.input.walk = 0;
    lab.input.yaw = yawSign;
    lab.stepForTest(1 / 60, Math.round(yawSecs * 60));
    lab.input.yaw = 0;
    const facing = [lab.forward.x, lab.forward.y, lab.forward.z].map((n) => +n.toFixed(3));
    lab.input.walk = 1;
    const trail = [];
    for (let s = 0; s < 22; s += 1) {
      let moved = 0; let held = 0; let minAllowed = 1; let swaps = 0; let prevP = 6;
      let strainMax = -99; let strainMin = 99;
      for (let i = 0; i < 60; i += 1) {
        lab.stepForTest(1 / 60, 1);
        const r = lab.report;
        moved += r.movedMm; held += r.heldBackMm;
        minAllowed = Math.min(minAllowed, r.allowed);
        strainMax = Math.max(strainMax, r.strain);
        strainMin = Math.min(strainMin, r.strain);
        if (r.planted < prevP) swaps += 1;
        prevP = r.planted;
      }
      trail.push({
        s: s + 1, moved: +moved.toFixed(2), held: +held.toFixed(2),
        minAllowed: +minAllowed.toFixed(3), swaps,
        strain: [+strainMin.toFixed(2), +strainMax.toFixed(2)],
        up: [lab.up.x, lab.up.y, lab.up.z].map((n) => +n.toFixed(2)),
        at: [lab.at.x, lab.at.y, lab.at.z].map((n) => +(n * MM).toFixed(2)),
        grip: lab.gripping,
      });
    }
    lab.input.walk = 0;
    return { facing, trail };
  }, { yawSign, yawSecs });
  console.log(`\n=== ${label}  facing ${JSON.stringify(out.facing)}  errors ${errors.length}`);
  console.log(' s   moved   held  minAllow swaps  strain          up                  at(mm)');
  for (const t of out.trail) {
    console.log(
      String(t.s).padStart(2), t.moved.toFixed(2).padStart(7), t.held.toFixed(2).padStart(6),
      t.minAllowed.toFixed(3).padStart(8), String(t.swaps).padStart(4),
      JSON.stringify(t.strain).padEnd(15),
      JSON.stringify(t.up).padEnd(19), JSON.stringify(t.at), t.grip ? '' : 'FALLING',
    );
  }
  await page.close();
  return out;
};

// forward starts at +Z. yaw>0 rotates forward about +Y by +YAW_RATE*dt.
// 90 deg at 2.2 rad/s is 0.714 s.
await run(1, 0.714, 'turn left 90 -> walk');
await run(-1, 0.714, 'turn right 90 -> walk');
await run(1, 1.428, 'turn 180 -> walk');
await browser.close();
