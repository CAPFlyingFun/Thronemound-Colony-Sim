/**
 * THE BUZZ, MEASURED WITH HER STANDING PERFECTLY STILL.
 *
 * Reported as: walk, stop, and the body vibrates up and down, fast. The
 * telemetry shows it as a `seat` column that changes SIGN almost every frame,
 * about a tenth of a millimetre each way, with all six feet down and the
 * stick at zero — so it is not the gait and it is not the player.
 *
 * The per-frame log can only carry sixteen frames either side of an event.
 * This samples every frame for as long as you like and reports the three
 * numbers that separate a limit cycle from ordinary settling: the amplitude,
 * how often the sign flips, and whether her UP is wobbling with it — the last
 * being the difference between a body bouncing on a fixed surface and a body
 * chasing a surface its own movement keeps redefining.
 *
 * Stepped through `stepForTest` rather than watched through the animation
 * loop: this island renders at about one frame a second under swiftshader,
 * which is far too coarse to see a cycle whose period IS one frame. Stepping
 * the simulation directly gives hundreds of samples at a fixed timestep, and
 * fixing the timestep also removes frame pacing as a suspect.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/probe-standstill.mjs
 *   DT=0.023 STEPS=400 node scripts/probe-standstill.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
/* 23 ms is what the reported log actually ran at: 43 fps. */
const dt = Number(process.env.DT ?? 0.023);
const steps = Number(process.env.STEPS ?? 400);
const walkFirst = process.env.WALK !== '0';

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

const out = await page.evaluate(({ dt, steps, walk }) => {
  const s = window.islandScene;
  /* The animation loop must not also be stepping her while we do. */
  s.setPausedForTest(true);

  /* Walk first, then stop — the report is about the stop, and a stop only
   * exists after a walk. */
  if (walk) {
    s.input.walk = 1;
    s.stepForTest(dt, 90);
    s.input.walk = 0;
  }
  /* Let the gait put its feet down before sampling. */
  s.stepForTest(dt, 30);

  const rows = [];
  for (let i = 0; i < steps; i += 1) {
    s.stepForTest(dt, 1);
    const r = s.driveReport;
    rows.push({
      seat: s.seatLiftMm,
      y: s.at.y,
      upY: s.up.y, upX: s.up.x, upZ: s.up.z,
      planted: r?.planted ?? -1,
      clear: r?.clearanceMm ?? 0,
      /* WHICH BRANCH OF hold(). Her centre being inside solid takes the
       * nearestSurface path, which pushes OUT; her centre being in air takes
       * the downward cast, which pulls DOWN. If this flips with the seat, the
       * two are taking turns and that is the whole cycle. */
      inside: s.walker.solidAt(s.at.x, s.at.y, s.at.z) ? 1 : 0,
    });
  }
  return rows;
}, { dt, steps, walk: walkFirst });

const n = out.length;
if (n < 20) {
  console.log(`only ${n} frames — nothing to say`);
  await browser.close();
  process.exit(1);
}

/* ------------------------------------------------------------- the numbers */
const seats = out.map((r) => r.seat).filter((v) => Number.isFinite(v));
const absMean = seats.reduce((a, v) => a + Math.abs(v), 0) / seats.length;
const peak = Math.max(...seats.map(Math.abs));

/* Sign flips are the whole question. A body settling onto a seat moves one
 * way and stops; a body in a limit cycle changes its mind every frame. */
let flips = 0;
for (let i = 1; i < seats.length; i += 1) {
  if (seats[i] !== 0 && seats[i - 1] !== 0 && Math.sign(seats[i]) !== Math.sign(seats[i - 1])) {
    flips += 1;
  }
}
const span = n * dt;

/* Net travel against total travel: a limit cycle goes a long way and arrives
 * nowhere, which is exactly what makes it a buzz and not a settle. */
const travel = seats.reduce((a, v) => a + Math.abs(v), 0);
const net = Math.abs(seats.reduce((a, v) => a + v, 0));

/* And is her UP moving while she stands still? */
const upDeg = [];
for (let i = 1; i < n; i += 1) {
  const a = out[i - 1];
  const b = out[i];
  const dot = Math.min(1, Math.max(-1, a.upX * b.upX + a.upY * b.upY + a.upZ * b.upZ));
  upDeg.push((Math.acos(dot) * 180) / Math.PI);
}
const upMean = upDeg.reduce((a, v) => a + v, 0) / upDeg.length;
const upPeak = Math.max(...upDeg);

const ys = out.map((r) => r.y);
const ySpanMm = (Math.max(...ys) - Math.min(...ys)) * 5;

console.log(`STANDING STILL — ${n} steps of ${(dt * 1000).toFixed(0)} ms `
  + `(${span.toFixed(1)}s of sim, ${(1 / dt).toFixed(0)} fps)\n`);
console.log(`  seat move per frame   : ${absMean.toFixed(3)} mm mean, ${peak.toFixed(3)} mm peak`);
console.log(`  sign flips            : ${flips} of ${seats.length - 1} frames `
  + `(${((flips / (seats.length - 1)) * 100).toFixed(0)}%, ~${(flips / span / 2).toFixed(1)} Hz)`);
console.log(`  travelled / arrived   : ${travel.toFixed(2)} mm / ${net.toFixed(3)} mm net`);
console.log(`  body height range     : ${ySpanMm.toFixed(3)} mm peak to peak`);
console.log(`  up rotation per frame : ${upMean.toFixed(4)}° mean, ${upPeak.toFixed(4)}° peak`);
console.log(`  feet down             : ${Math.min(...out.map((r) => r.planted))}`
  + `–${Math.max(...out.map((r) => r.planted))}`);

const insideCount = out.filter((r) => r.inside).length;
let branchFlips = 0;
for (let i = 1; i < n; i += 1) if (out[i].inside !== out[i - 1].inside) branchFlips += 1;
console.log(`  centre inside soil    : ${insideCount} of ${n} steps, `
  + `${branchFlips} branch changes`);

/* The period of whatever she is doing, if she is doing anything: the smallest
 * lag at which her height repeats itself. Two is the seat fighting itself;
 * three is the anti-embed guard, which snaps back after three bad frames. */
let period = 0;
for (let lag = 1; lag <= 8 && !period; lag += 1) {
  let worst = 0;
  for (let i = lag; i < n; i += 1) worst = Math.max(worst, Math.abs(out[i].y - out[i - lag].y) * 5);
  if (worst < 0.004) period = lag;
}
console.log(`  height repeats every  : ${period ? `${period} frames` : 'never (no cycle)'}`);

console.log('\nfirst 20 steps    seat    clear         y      up.y  centre');
for (const r of out.slice(0, 20)) {
  console.log(`  ${r.seat.toFixed(3).padStart(16)}  ${r.clear.toFixed(3).padStart(7)}`
    + `  ${(r.y * 5).toFixed(3).padStart(11)}  ${r.upY.toFixed(6)}`
    + `  ${r.inside ? 'IN SOIL' : 'in air '}`);
}

console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
