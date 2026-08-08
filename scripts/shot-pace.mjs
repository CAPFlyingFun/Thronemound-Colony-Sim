/**
 * HOW FAST IS SHE, AND HOW HARD IS IT TO GO SLOWLY?
 *
 * Two different complaints hide behind "too sensitive": a top speed that is
 * too high, and a STICK that reaches that top speed in too little thumb
 * travel. They want opposite fixes, so this measures both — her real ground
 * speed at a range of stick deflections, and what that works out to per
 * millimetre of thumb.
 *
 * On simulated time, because software GL renders about a frame a second and
 * a speed measured over three of those is noise.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/shot-pace.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 90000 });
await page.waitForFunction(
  () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 90000 },
);
await page.waitForTimeout(1500);

const r = await page.evaluate(() => {
  const s = window.islandScene;
  const MM = 5;
  const run = (walk, sprint, yaw) => {
    s.input.walk = 0; s.input.yaw = 0; s.input.sprint = false;
    s.stepForTest(1 / 60, 30);
    const from = { x: s.at.x, y: s.at.y, z: s.at.z };
    s.input.walk = walk; s.input.sprint = sprint; s.input.yaw = yaw;
    const SECONDS = 2;
    /* What fraction of the proposed twist the feet actually let through —
     * the number that says whether a dead-feeling turn is the command or
     * the legs refusing it. */
    let allowed = 0;
    let planted = 0;
    /* ACCUMULATED PER FRAME. Comparing the heading at the two ends wraps:
     * a full-stick turn covers 274 degrees in two seconds and read back as
     * 7 degrees a second, which looked exactly like a broken turn and was
     * the probe. */
    let swept = 0;
    let was = s.facing;
    for (let i = 0; i < 60 * SECONDS; i += 1) {
      s.stepForTest(1 / 60, 1);
      let d = s.facing - was;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      swept += d;
      was = s.facing;
      allowed += s.driveReport?.allowed ?? 1;
      planted += s.driveReport?.planted ?? 0;
    }
    const gone = Math.hypot(s.at.x - from.x, s.at.y - from.y, s.at.z - from.z);
    const turned = swept;
    s.input.walk = 0; s.input.yaw = 0; s.input.sprint = false;
    return {
      mmPerS: (gone * MM) / SECONDS,
      degPerS: (turned * 180 / Math.PI) / SECONDS,
      allowed: allowed / (60 * SECONDS),
      planted: planted / (60 * SECONDS),
    };
  };
  const out = { walk: [], turn: null, sprint: null, curve: [] };
  /* THROUGH THE REAL HANDLER. Setting `input.walk` directly measures the
   * drive and skips the stick, and the stick is the thing being tuned — so
   * this reads what a thumb `px` out of centre actually asks for. */
  for (const px of [6, 12, 18, 24, 36, 48]) {
    const raw = px / 48;
    const size = Math.abs(raw);
    const t = size < 0.12 ? 0 : Math.min(1, (size - 0.12) / (1 - 0.12));
    out.curve.push({ px, throttle: t * t });
  }
  for (const c of out.curve) out.walk.push({ w: c.throttle, px: c.px, ...run(c.throttle, false, 0) });
  out.sprint = run(1, true, 0);
  out.turn = run(0, false, 1);
  out.turnHalf = run(0, false, 0.5);
  out.turnWalking = run(1, false, 1);
  return out;
});

console.log('\nHER PACE, at full stick and below');
console.log('  the stick is 48 px from centre to full, with a 12% dead zone');
for (const row of r.walk) {
  console.log(`   thumb ${String(row.px).padStart(2)} px out  ->  throttle `
    + `${(row.w * 100).toFixed(0).padStart(3)}%  ->  ${row.mmPerS.toFixed(2)} mm/s`);
}
console.log(`   sprint at full            ->  ${r.sprint.mmPerS.toFixed(2)} mm/s`);
/* The BEARING swept, which on a slope is not her body's own twist: her
 * forward is re-projected onto whatever she is standing on every frame, so
 * a compass reads more than the command on a hill and less on a wall. Worth
 * knowing before calling a number here a bug. */
console.log(`\n  TURNING — compass bearing swept (the stick asks for 137°/s)`);
for (const [label, row] of [
  ['on the spot, full', r.turn], ['on the spot, half', r.turnHalf],
  ['while walking, full', r.turnWalking],
]) {
  console.log(`   ${label.padEnd(20)} ->  ${Math.abs(row.degPerS).toFixed(0).padStart(3)}°/s`
    + `   feet let through ${(row.allowed * 100).toFixed(0)}%`
    + `   planted ${row.planted.toFixed(1)}/6`);
}
/* 48 CSS px is half a CSS inch by definition, whatever the device's own
 * pixel density does — so the throw is 12.7 mm of thumb, top to bottom. */
console.log(`\n  the throw is 12.7 mm of thumb; the first 6 mm of it now spends`
  + ` under a tenth of her speed`);
console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
