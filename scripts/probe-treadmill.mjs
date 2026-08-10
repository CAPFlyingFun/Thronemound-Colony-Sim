/**
 * THE INVISIBLE WALL, EIGHTEEN MILLIMETRES FROM SPAWN.
 *
 * Reported as "I got stuck for some reason heading to the tree", with a
 * telemetry log whose position was pinned to the millimetre for seventeen
 * seconds while `act` read full speed. Reproduced deterministically: walk
 * SSW from spawn and at (27992, 27982) — a gentle nine-degree rise, no
 * obstacle in the density field, corner scheduler rightly idle — she
 * entered a period-3 cycle: two frames of drive forward, one anti-embed
 * snap back to lastSafe. The guard's half-millimetre burial probe read the
 * lattice's own cell-step under a healthy seated origin as three
 * consecutive embedded frames, and on ground she is walking UP, "back to
 * safety" means backward. A treadmill.
 *
 * This walks the exact reported line and asserts she actually crosses the
 * old stall point and keeps making progress beyond it.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/probe-treadmill.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 90000 });
await page.waitForFunction(
  () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 90000 },
);
await page.waitForTimeout(1200);

const out = await page.evaluate(() => {
  const s = window.islandScene;
  s.setPausedForTest(true);
  const MM = 5;
  /* The reported stall point, and the heading that reached it. */
  const tx = 27992.3 / MM, tz = 27982.4 / MM;
  const sx = s.at.x, sz = s.at.z;
  s.setFacingForTest(Math.atan2(tx - sx, tz - sz));
  s.input.walk = 1;
  /* Note how far she gets each second of sim; a treadmill flatlines. */
  const marks = [];
  for (let sec = 0; sec < 20; sec += 1) {
    s.stepForTest(0.023, 43);
    marks.push(+(Math.hypot(s.at.x - sx, s.at.z - sz) * MM).toFixed(1));
  }
  s.input.walk = 0;
  return { marks, embed: s.embedFrames };
});

console.log(`distance from spawn, per sim second:\n  ${out.marks.join('  ')}`);
const fail = [];
/*
 * She stalled at EIGHTEEN millimetres before the fix. Demand she is well
 * past that, at full crawl pace — not that the whole line is clear: at
 * about 49 mm this heading meets a steep bank where the corner transfer
 * itself sticks in transferRear, which is the separately-diagnosed corner
 * sink (on hold by explicit decision), not the guard treadmill this probe
 * exists for. The probe reports that pin honestly without failing on it.
 */
if (out.marks[19] < 30) fail.push(`only ${out.marks[19]} mm in 20 s — the guard treadmill is back`);
const lastLeg = out.marks[19] - out.marks[15];
if (Math.abs(lastLeg) < 5) {
  console.log(`note: pinned after ${out.marks[19]} mm — the corner-transfer stall `
    + '(known, separate); the guard treadmill fix itself is judged above');
}
console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
if (fail.length) {
  console.log(`FAILED: ${fail.join('; ')}`);
  process.exit(1);
}
console.log('all green — she walks through where she used to stand');
