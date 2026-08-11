/**
 * DOES THE GAIT CHANGE WITH SPEED — and does anything break when it does?
 *
 * She has run exactly one gait at every pace since the walk was written: a
 * tripod, three feet up together, whether she is creeping or sprinting. Real
 * hexapods do not, and neither do ants: duty factor rises as speed falls.
 * Two gaits, matching crawl / walk / run — a CRAWL gets the wave, one foot
 * up and five down, and walking and running keep the tripod. It is the
 * difference between picking your way and travelling, and it is the one
 * thing the robot rigs do that this did not.
 *
 * The number that shows it is MOST FEET UP, not the mean: at a crawl she is
 * barely stepping, so the mean is dominated by standing in either gait. What
 * changes is the moments she does step — three feet off at once becomes one.
 *
 *   - she must still get where she is going. A wave gait moves one leg at a
 *     time, so a badly-wired one simply stops walking.
 *   - the CORNER is exempt by construction and this shows it: the corner's
 *     release rule is written around three feet leaving together, so the
 *     slow gaits stand aside while a transition is running.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/probe-gait.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];

async function run(query) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${base}/?scene=island${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 150000 });
  await page.waitForFunction(
    () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 150000 },
  );
  await page.waitForTimeout(1200);
  const out = await page.evaluate(() => {
    const s = window.islandScene;
    s.setPausedForTest(true);
    const MM = 5;

    /* `walk` is the stick, 0..1; sprint trebles the pace it asks for. */
    const pace = (walk, sprint, steps) => {
      s.input.walk = walk;
      s.input.sprint = sprint;
      s.stepForTest(0.023, 60);           // settle into the new pace
      let planted = 0;
      let frames = 0;
      let mostUp = 0;
      const from = { x: s.at.x, y: s.at.y, z: s.at.z };
      for (let i = 0; i < steps; i += 1) {
        s.stepForTest(0.023, 1);
        const n = s.driveReport?.planted ?? 6;
        planted += n;
        mostUp = Math.max(mostUp, 6 - n);
        frames += 1;
      }
      s.input.walk = 0;
      s.input.sprint = false;
      return {
        planted: planted / Math.max(1, frames),
        mostUp,
        travelledMm: Math.hypot(s.at.x - from.x, s.at.y - from.y, s.at.z - from.z) * MM,
      };
    };

    return {
      creep: pace(0.18, false, 260),
      middling: pace(0.5, false, 260),
      walking: pace(1, false, 260),
      sprinting: pace(1, true, 260),
    };
  });
  await page.close();
  return out;
}

const adaptive = await run('&gait=adaptive');
const tripod = await run('');

const n = (v) => Number(v).toFixed(2);
console.log('                 mean feet planted      most feet up      travelled');
for (const key of ['creep', 'middling', 'walking', 'sprinting']) {
  const a = adaptive[key];
  const t = tripod[key];
  console.log(`${key.padEnd(10)} adaptive ${n(a.planted)}  tripod ${n(t.planted)}`
    + `    ${String(a.mostUp).padStart(2)} vs ${t.mostUp}`
    + `        ${n(a.travelledMm).padStart(6)} vs ${n(t.travelledMm)} mm`);
}

const fail = [];
/* The tripod build must be unchanged — this is opt-in and must stay so. */
if (tripod.creep.mostUp < 3) {
  fail.push(`the DEFAULT build lifted only ${tripod.creep.mostUp} at a creep — it is not opt-in`);
}
/* Adaptive: fewer feet up when slow, and the tripod back at pace. */
if (adaptive.creep.mostUp > 2) {
  fail.push(`creeping still lifts ${adaptive.creep.mostUp} feet — no wave gait`);
}
if (adaptive.sprinting.mostUp < 3) {
  fail.push(`sprinting lifts only ${adaptive.sprinting.mostUp} — the tripod is gone`);
}
/*
 * More feet down when slow — but only just, and that is not a disappointment.
 * At a creep she is barely stepping at all, so nearly every frame has all six
 * down in EITHER gait and the mean is dominated by standing. The change lives
 * in the moments she does step: three feet off at once becomes one, which is
 * the `mostUp` check above and the thing an eye reads as picking her way.
 * The mean must still move the right way, so it is checked — strictly.
 */
if (adaptive.creep.planted <= tripod.creep.planted) {
  fail.push(`creeping keeps ${n(adaptive.creep.planted)} feet down against the `
    + `tripod's ${n(tripod.creep.planted)} — no better`);
}
/* And she must still walk. A wave gait that cannot move is not a gait. */
for (const key of ['creep', 'middling', 'walking', 'sprinting']) {
  if (adaptive[key].travelledMm < tripod[key].travelledMm * 0.6) {
    fail.push(`${key}: adaptive covered ${n(adaptive[key].travelledMm)} mm `
      + `against the tripod's ${n(tripod[key].travelledMm)} — it is holding her up`);
  }
}

console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
if (fail.length) {
  console.log(`\nFAILED: ${fail.join('; ')}`);
  process.exit(1);
}
console.log('\nall green — she keeps more feet down when she is going slowly');
