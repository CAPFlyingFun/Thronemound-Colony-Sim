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
 * It is ON by default now, because the pace chip has a CRAWL on it: a gear
 * that names itself a crawl and then runs the same tripod as a run is a
 * label, not a gait. `?gait=tripod` is the control, and the last section
 * here drives the chip itself — the gears must come back in gear order and
 * the crawl must be the one that changes gait, by odometer and not by name.
 *
 * The number that shows it is MOST FEET UP, not the mean: at a crawl she is
 * barely stepping, so the mean is dominated by standing in either gait. What
 * changes is the moments she does step — three feet off at once becomes one.
 * Measured, the mean barely moves and can move the WRONG way; see the note
 * on the creep assertion below, which was written expecting otherwise.
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

    /*
     * THE CHIP ITSELF — the latch, not the raw flags. Two seconds of held
     * stick per gear, measured on the odometer, exactly as the density
     * lab's own gear check does it.
     */
    const gear = (n) => {
      s.pace = n;
      s.applyPace();
      const label = s.paceChip?.textContent ?? '';
      s.input.walk = 1;
      s.stepForTest(0.023, 60);
      const from = { x: s.at.x, y: s.at.y, z: s.at.z };
      let mostUp = 0;
      for (let i = 0; i < 130; i += 1) {
        s.stepForTest(0.023, 1);
        mostUp = Math.max(mostUp, 6 - (s.driveReport?.planted ?? 6));
      }
      s.input.walk = 0;
      s.pace = 1;
      s.applyPace();
      s.stepForTest(0.023, 30);
      return {
        mm: Math.hypot(s.at.x - from.x, s.at.y - from.y, s.at.z - from.z) * MM,
        mostUp,
        label,
      };
    };

    /* Gears FIRST, from her spawn, where there is open ground to measure an
     * odometer against — after four sweeps of walking she is wherever the
     * island put her, and three distances taken against a tree trunk say
     * nothing about the gears. */
    return {
      gears: { crawl: gear(0), walk: gear(1), run: gear(2) },
      creep: pace(0.18, false, 260),
      middling: pace(0.5, false, 260),
      walking: pace(1, false, 260),
      sprinting: pace(1, true, 260),
    };
  });
  await page.close();
  return out;
}

const adaptive = await run('');
const tripod = await run('&gait=tripod');

const n = (v) => Number(v).toFixed(2);
console.log('                 mean feet planted      most feet up      travelled');
for (const key of ['creep', 'middling', 'walking', 'sprinting']) {
  const a = adaptive[key];
  const t = tripod[key];
  console.log(`${key.padEnd(10)} adaptive ${n(a.planted)}  tripod ${n(t.planted)}`
    + `    ${String(a.mostUp).padStart(2)} vs ${t.mostUp}`
    + `        ${n(a.travelledMm).padStart(6)} vs ${n(t.travelledMm)} mm`);
}

const g = adaptive.gears;
console.log('\nthe pace chip, by odometer over three seconds of held stick');
for (const key of ['crawl', 'walk', 'run']) {
  console.log(`  ${key.padEnd(6)} "${g[key].label}"  ${n(g[key].mm).padStart(7)} mm  `
    + `most feet up ${g[key].mostUp}`);
}

const fail = [];
/* The `?gait=tripod` control must be unchanged — it is the thing to compare
 * against, so if it ever starts choosing gaits there is nothing to compare. */
if (tripod.creep.mostUp < 3) {
  fail.push(`?gait=tripod lifted only ${tripod.creep.mostUp} at a creep — the control is gone`);
}
/* Adaptive: fewer feet up when slow, and the tripod back at pace. */
if (adaptive.creep.mostUp > 2) {
  fail.push(`creeping still lifts ${adaptive.creep.mostUp} feet — no wave gait`);
}
if (adaptive.sprinting.mostUp < 3) {
  fail.push(`sprinting lifts only ${adaptive.sprinting.mostUp} — the tripod is gone`);
}
/*
 * THE MEAN DOES NOT RISE, AND EXPECTING IT TO WAS WRONG — recorded so it is
 * not expected again.
 *
 * The first cut of this probe asserted that a wave gait keeps MORE feet down
 * on average than a tripod. Measured at a creep: 5.52 against the tripod's
 * 5.54, which is the wrong side of the line. It is not a fault. A wave lifts
 * one foot instead of three, but it has to lift SIX of them to cycle where
 * the tripod lifts two groups, so the feet-in-the-air integral comes out
 * almost exactly the same — and at a creep the mean is dominated by standing
 * in either gait anyway, which the comment above already said before the
 * assertion ignored it.
 *
 * So what is pinned is what actually changes: the PEAK simultaneous lift
 * (the `mostUp` checks above), and the fact that the wave does not BUY that
 * with extra airtime. A quarter of a foot of slack — a real regression here
 * would be the gait thrashing, which costs whole feet, not hundredths.
 */
if (adaptive.creep.planted < tripod.creep.planted - 0.25) {
  fail.push(`creeping keeps only ${n(adaptive.creep.planted)} feet down against the `
    + `tripod's ${n(tripod.creep.planted)} — the wave is paying in airtime`);
}
/* And she must still walk. A wave gait that cannot move is not a gait. */
for (const key of ['creep', 'middling', 'walking', 'sprinting']) {
  if (adaptive[key].travelledMm < tripod[key].travelledMm * 0.6) {
    fail.push(`${key}: adaptive covered ${n(adaptive[key].travelledMm)} mm `
      + `against the tripod's ${n(tripod[key].travelledMm)} — it is holding her up`);
  }
}

/*
 * THREE REAL GEARS, AND THE CRAWL IS THE ONE THAT CHANGES GAIT.
 *
 * By odometer rather than by label, because a chip that reads CRAWL over a
 * speed that is still a walk is exactly the kind of lie a screenshot cannot
 * catch — the same reasoning as the density lab's own gear check.
 */
for (const [key, want] of [['crawl', 'CRAWL'], ['walk', 'WALK'], ['run', 'RUN']]) {
  if (g[key].label !== want) fail.push(`the chip reads "${g[key].label}" at ${key}`);
}
if (!(g.crawl.mm < g.walk.mm && g.walk.mm < g.run.mm)) {
  fail.push(`the gears are out of order: crawl ${n(g.crawl.mm)}, walk ${n(g.walk.mm)}, `
    + `run ${n(g.run.mm)} mm`);
}
if (g.crawl.mostUp > 2) {
  fail.push(`the CRAWL gear lifts ${g.crawl.mostUp} feet — the chip is a label, not a gait`);
}
if (g.walk.mostUp < 3 || g.run.mostUp < 3) {
  fail.push(`walk/run lift ${g.walk.mostUp}/${g.run.mostUp} — they must keep the tripod`);
}
/* And it must still be a crawl she can travel at, not a stall. */
if (g.crawl.mm < 3) fail.push(`the CRAWL gear covered ${n(g.crawl.mm)} mm — that is a stall`);

console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
if (fail.length) {
  console.log(`\nFAILED: ${fail.join('; ')}`);
  process.exit(1);
}
console.log('\nall green — three gears on the chip, and the crawl picks its way '
  + 'one foot at a time');
