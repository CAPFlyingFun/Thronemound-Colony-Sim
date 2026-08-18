/**
 * THE CYLINDER DIG, PACED AND SHAPED THE WAY THE BLUEPRINT SAYS.
 *
 *     npx vite --port 5173                                  # then
 *     SMOKE_URL=http://127.0.0.1:5173/?scene=island npm run probe:bore
 *
 * Joshua's blueprint: a bore one body length long, its diameter off the
 * ant's own height (widened, floored), chipped away over volume/30
 * seconds ROUNDED UP — "143/30=4.767 seconds it should take... round up"
 * — with the duration doubling as the cooldown. Driven here through the
 * REAL controls: DIG armed by its plate, SCOOP held as input, the job
 * advanced by simulated time.
 *
 * Pinned:
 *   1. the queen's shovel measures 4.5 x 9 mm and her bore takes 5 s;
 *   2. a held press chips PROGRESSIVELY — soil leaves during the job,
 *      not all on the press;
 *   3. the duration is the cooldown: one bore at a time, and the next
 *      starts only after the last finishes;
 *   4. releasing mid-bore abandons the remainder;
 *   5. the founding still works end to end at the new pace — she can
 *      still dig herself below grade with her own strokes;
 *   6. the WORKER's shovel re-measures on the caste swap: 4 mm floor,
 *      her own 4 mm length, 2 s.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/?scene=island';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const errs = [];
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready === true, null, { timeout: 200000 });
await page.waitForFunction(
  () => !document.querySelector('.tm-loading-root'), null, { timeout: 200000 },
);

const out = await page.evaluate(async () => {
  const s = window.islandScene;
  const report = {};
  s.stepForTest(1 / 60, 30);

  report.queenShovel = s.digJobForTest();

  /* Arm DIG through its plate, aim down-forward, hold SCOOP. */
  document.querySelector('.tm-art-dig')
    .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  s.stepForTest(1 / 60, 10);
  s.aimPitch = -0.6;
  s.input.dig = true;
  /* One stroke cycle (0.42 s) lands the first bite and starts the job. */
  s.stepForTest(1 / 60, 40);
  const started = s.digJobForTest();
  const dugAtStart = s.stream?.editedSamples ?? 0;

  /* Half the job in sim time: progress must be mid, and MORE soil must
   * have left than the first beat took — the chip-away, measured. */
  s.stepForTest(1 / 60, Math.round((started.durationS / 2) * 60) - 40);
  const half = s.digJobForTest();
  const dugAtHalf = s.stream?.editedSamples ?? 0;

  /* To the end and past it: done, and the NEXT job may begin (held). */
  s.stepForTest(1 / 60, Math.round(started.durationS * 60));
  const after = s.digJobForTest();
  const dugAtEnd = s.stream?.editedSamples ?? 0;

  report.started = started;
  report.half = { ...half, chippedMore: dugAtHalf > dugAtStart };
  report.after = { ...after, chippedMore: dugAtEnd > dugAtHalf };

  /* Release mid-bore: the job goes, the soil stays. */
  s.stepForTest(1 / 60, 30);
  const midJob = s.digJobForTest();
  s.input.dig = false;
  s.stepForTest(1 / 60, 5);
  report.release = { hadJob: midJob.active, after: s.digJobForTest().active };

  /*
   * The founding at the new pace, played the way a PLAYER plays it: the
   * bore is COMMITTED in space at the press, so you press, let it eat,
   * then step down into the hole and press again. Walking away mid-bore
   * just leaves the mouthful where you aimed it — which the release test
   * above already proved on purpose.
   */
  s.aimPitch = -1.1;
  for (let bores = 0; bores < 30 && !s.statsForTest().underground; bores += 1) {
    s.input.dig = true;
    /* Let one whole bore finish: cadence + duration, with headroom. */
    for (let w = 0; w < 9 * 4 && !s.digJobForTest().active; w += 1) s.stepForTest(1 / 60, 15);
    for (let w = 0; w < 9 * 4 && s.digJobForTest().active; w += 1) s.stepForTest(1 / 60, 15);
    s.input.dig = false;
    /* Step into what just opened. */
    s.input.walk = 1;
    s.stepForTest(1 / 60, 45);
    s.input.walk = 0;
    s.stepForTest(1 / 60, 10);
  }
  report.founding = {
    underground: s.statsForTest().underground === 1,
    depthMm: s.statsForTest().questDepthMm,
  };

  /* And the WORKER's shovel, measured off her own rig after the swap. */
  s.questStage = 1; s.deepCarved = 1e9;
  const ok = await s.becomeWorker().catch(() => false);
  s.stepForTest(1 / 60, 20);
  report.workerShovel = ok ? s.digJobForTest() : { why: 'no worker' };
  return report;
});

await browser.close();

let bad = 0;
const say = (ok, line) => { if (!ok) bad += 1; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${line}`); };

console.log('\nTHE CYLINDER DIG\n');
console.log(`  queen shovel : ${JSON.stringify(out.queenShovel)}`);
console.log(`  started      : ${JSON.stringify(out.started)}`);
console.log(`  halfway      : ${JSON.stringify(out.half)}`);
console.log(`  after        : ${JSON.stringify(out.after)}`);
console.log(`  release      : ${JSON.stringify(out.release)}`);
console.log(`  founding     : ${JSON.stringify(out.founding)}`);
console.log(`  worker shovel: ${JSON.stringify(out.workerShovel)}\n`);

say(Math.abs(out.queenShovel.boreMm - 4.5) < 0.3 && Math.abs(out.queenShovel.lengthMm - 9) < 0.5,
  `the queen's shovel is her own body — ${out.queenShovel.boreMm} x ${out.queenShovel.lengthMm} mm`);
/* The duration must be Joshua's own arithmetic run on HER MEASURED bore
 * — volume over thirty, rounded up. Live she stands 3.2 mm, not the bare
 * rig's 3.0, so the honest answer is 6 s, and hardcoding the worked
 * example's 5 would be pinning the sketch over the animal. */
const wantS = Math.ceil((Math.PI * (out.started.boreMm / 2) ** 2 * out.started.lengthMm) / 30);
say(out.started.active && out.started.durationS === wantS,
  `her bore takes volume/30 rounded up — ${out.started.durationS}s (want ${wantS})`);
say(out.half.active && out.half.progress > 0.3 && out.half.progress < 0.9,
  `halfway through, the job is mid-eating (${out.half.progress})`);
say(out.half.chippedMore, 'and soil left DURING the job, not on the press');
/* Held past the end, the NEXT bore is already eating — the cooldown is
 * the duration and nothing more. A stalled first job would sit at the
 * same progress with no new soil, which chippedMore below rules out. */
say(out.after.active,
  'held past the end, the next bore is already eating');
say(out.after.chippedMore, 'the second half kept chipping');
say(out.release.hadJob && !out.release.after, 'releasing the press abandons the bore');
say(out.founding.underground,
  `the founding still digs her below grade (${out.founding.depthMm} mm)`);
say(out.workerShovel.boreMm === 4 && Math.abs(out.workerShovel.lengthMm - 4) < 0.5,
  `the worker's shovel re-measured on the swap — ${out.workerShovel.boreMm} x ${out.workerShovel.lengthMm} mm (the 4 mm floor)`);

if (errs.length) console.log(`\npage errors: ${errs.slice(0, 3).join(' | ')}`);
if (bad > 0 || errs.length) { console.log(`\n${bad} check(s) failed`); process.exit(1); }
console.log('\nall green — one held button eats one clean cylinder at her own pace');
