/**
 * DOES SHE LEAN INTO IT — AND DO HER FEET NOTICE?
 *
 * Body orientation control, taken from the hexapod rigs: the body pitches
 * and rolls over feet that stay exactly where they are, and the legs absorb
 * the difference. The rig's own diagram writes it as a roll-pitch-yaw matrix
 * applied to every foot's start position; here it is the same rotation the
 * other way round — the drawn body turns and her feet, which are anchored in
 * the WORLD, simply stay put.
 *
 * That framing is the whole safety argument, and it is what this checks:
 *
 *   1. she pitches NOSE DOWN as she takes off and NOSE UP as she pulls up —
 *      the acceleration term, which is the half an eye actually notices;
 *   2. she banks INTO a turn, inside shoulder down;
 *   3. it is all bounded — a lean is a lean, not a stumble;
 *   4. and none of it reaches the simulation. `at` is the physics root the
 *      walker seats and the corner scheduler reasons about, so the same walk
 *      run with `?lean=0` must end in the same place — but "the same place"
 *      has to be measured against this engine's own scatter, which is about
 *      a millimetre a route. See the noise floor below.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/probe-lean.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];

/** Walk a fixed scripted route and report both the lean and where she ended. */
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
    const DEG = 180 / Math.PI;
    const peak = (fn, steps) => {
      let lo = 0;
      let hi = 0;
      for (let i = 0; i < steps; i += 1) {
        s.stepForTest(0.023, 1);
        const v = fn();
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      return { lo: lo * DEG, hi: hi * DEG };
    };
    const lean = () => s.bodyLean;
    const bank = () => s.bodyBank;

    /* Standing, then a standing start, then a dead stop. */
    s.input.walk = 0;
    const rest = peak(lean, 60);
    s.input.walk = 1;
    s.input.sprint = true;
    const start = peak(lean, 45);
    s.stepForTest(0.023, 90);
    const cruise = peak(lean, 60);
    s.input.walk = 0;
    s.input.sprint = false;
    const stop = peak(lean, 45);
    s.stepForTest(0.023, 60);

    /* Then a hard turn each way, to see the bank. */
    s.input.walk = 1;
    s.input.yaw = 1;
    const left = peak(bank, 120);
    s.input.yaw = -1;
    const right = peak(bank, 160);
    s.input.walk = 0;
    s.input.yaw = 0;

    /* And exactly where the physics root ended up. */
    return {
      rest, start, cruise, stop, left, right,
      at: [s.at.x, s.at.y, s.at.z],
    };
  });
  await page.close();
  return out;
}

const on = await run('');
/*
 * THE SAME ROUTE TWICE, IDENTICALLY, FIRST — because this engine is not
 * deterministic across page loads and pretending otherwise makes the last
 * check below a lie. Measured: two runs with the same settings land about a
 * millimetre apart, which is the same order as the difference the lean was
 * being blamed for. Chunk meshing is asynchronous and the ground she samples
 * depends on what has been built, so a route drifts a little every time.
 *
 * So the question is not "did she land in exactly the same place" — she
 * never does — but "did the lean move her further than the engine moves
 * itself". That has an honest answer and this measures it.
 */
const again = await run('');
const off = await run('&lean=0');

const n = (v) => Number(v).toFixed(2);
console.log(`at rest        : ${n(on.rest.lo)}° .. ${n(on.rest.hi)}°`);
console.log(`standing start : ${n(on.start.lo)}° .. ${n(on.start.hi)}°  (nose down is +)`);
console.log(`cruising       : ${n(on.cruise.lo)}° .. ${n(on.cruise.hi)}°`);
console.log(`pulling up     : ${n(on.stop.lo)}° .. ${n(on.stop.hi)}°`);
console.log(`turning left   : ${n(on.left.lo)}° .. ${n(on.left.hi)}°`);
console.log(`turning right  : ${n(on.right.lo)}° .. ${n(on.right.hi)}°`);
const apart = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 5;
const noise = apart(on.at, again.at);
const drift = apart(on.at, off.at);
console.log(`\nrun-to-run noise floor      : ${noise.toFixed(4)} mm (same settings, twice)`);
console.log(`same route with the lean off: ${drift.toFixed(4)} mm away`);

const fail = [];
/* Still is still: nothing to accelerate into. */
if (Math.abs(on.rest.lo) > 0.3 || Math.abs(on.rest.hi) > 0.3) {
  fail.push(`she leans ${n(on.rest.hi)}° standing still`);
}
/* Taking off pitches her nose DOWN; pulling up pitches it back UP. */
if (on.start.hi < 1) fail.push(`no nose-down on a standing start (${n(on.start.hi)}°)`);
if (on.stop.lo > -0.5) fail.push(`no nose-up when pulling up (${n(on.stop.lo)}°)`);
/* Cruising holds a small steady set forward rather than falling back to nothing. */
if (on.cruise.hi < 0.5) fail.push(`no set forward at speed (${n(on.cruise.hi)}°)`);
/* Banking is signed: the two directions must lean opposite ways. */
if (on.left.hi <= 0.5 && on.right.lo >= -0.5) fail.push('no bank in either direction');
if (Math.sign(on.left.hi + on.left.lo) === Math.sign(on.right.hi + on.right.lo)) {
  fail.push('both turns bank the same way');
}
/* Bounded — the clamps are 9° pitch and 7° roll. */
for (const [what, r] of Object.entries({ start: on.start, stop: on.stop, cruise: on.cruise })) {
  if (Math.max(Math.abs(r.lo), Math.abs(r.hi)) > 9.5) fail.push(`${what} exceeded the pitch clamp`);
}
for (const [what, r] of Object.entries({ left: on.left, right: on.right })) {
  if (Math.max(Math.abs(r.lo), Math.abs(r.hi)) > 7.5) fail.push(`${what} exceeded the roll clamp`);
}
/*
 * THE ONE THAT MATTERS. A drawn pose may not move the animal — and the test
 * for it has to clear the engine's own noise, which is why the floor above
 * is measured rather than assumed. Three times it, with a millimetre of
 * headroom: real feedback would grow with the route, not sit inside the
 * scatter of running the same route twice.
 */
const allowed = Math.max(noise * 3, 1);
if (drift > allowed) {
  fail.push(`the lean moved the physics root ${drift.toFixed(2)} mm, `
    + `past the ${allowed.toFixed(2)} mm the engine's own scatter allows`);
}

console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
if (fail.length) {
  console.log(`\nFAILED: ${fail.join('; ')}`);
  process.exit(1);
}
console.log('\nall green — she leans and banks, and her feet never hear about it');
