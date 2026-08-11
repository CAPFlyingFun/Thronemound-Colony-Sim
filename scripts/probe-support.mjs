/**
 * DOES SHE STAND ON WHAT HER FEET SAY, OR ON WHAT IS UNDER HER BELLY?
 *
 * Her attitude comes from the density gradient sampled at her own centre —
 * one point, the ground beneath her middle. A hexapod's support is the
 * polygon its six planted feet make, and those contacts know about a crest,
 * a dip, or a hole she has just dug that the single sample underneath her
 * cannot. `LegDrive.supportNormal` fits that polygon; this measures how far
 * the two answers actually differ, and where.
 *
 * MEASURED BEFORE IT WAS WIRED IN, deliberately. A support plane is the
 * textbook answer and it would have been easy to adopt on the strength of
 * that alone — but if the two agreed everywhere it would be a rewrite that
 * bought nothing, and if they disagreed wildly on a corner it would be one
 * that broke climbing. So the disagreement was reported per situation, with
 * the fit's own confidence beside it, and the blend weight chosen from the
 * numbers rather than assumed. What it read with her attitude still coming
 * entirely from her belly:
 *
 *   standing  6.67   walking  5.44 (peak 15.15)
 *   afterDig  44.04 mean, 53.40 peak      climbing  16.58 (peak 22.13)
 *   and 49.87° of net turn over seven seconds of standing still afterwards
 *
 * The figures this prints NOW are the RESIDUAL, with her feet already
 * getting half a say — so they are smaller by construction, and the row
 * that matters is the last one. It is a regression check from here on: the
 * fit must keep working, the flat-ground control must stay small, and she
 * must not go back to turning tens of degrees while standing still.
 *
 * What each situation is for:
 *
 *   - STANDING and WALKING are the control. Flattish ground, six feet down:
 *     the two should very nearly agree, and a large split here would mean
 *     the fit is wrong rather than informative.
 *   - AFTER A DIG is the case that prompted this. She removes the ground
 *     from under her own centre, so the belly sample is reading a hole her
 *     feet are standing around the rim of.
 *   - CLIMBING is the danger case. Feet straddling floor and wall make a
 *     plane through both, which is a real thing to know but NOT something
 *     that should quietly overrule the corner scheduler mid-fold.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/probe-support.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({
  viewport: { width: 900, height: 600 },
  /* The built app registers a service worker, and a probe that silently
   * measures a cached bundle is worse than one that fails. */
  serviceWorkers: 'block',
});
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 200000 });
await page.waitForFunction(
  () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 200000 },
);
await page.waitForTimeout(1200);

const out = await page.evaluate(() => {
  const s = window.islandScene;
  s.setPausedForTest(true);
  const DEG = 180 / Math.PI;
  const probe = s.up.clone();

  /** Sample the split between belly-up and feet-up over `steps` frames. */
  const watch = (steps) => {
    let sum = 0;
    let peak = 0;
    let conf = 0;
    let blind = 0;
    let n = 0;
    for (let i = 0; i < steps; i += 1) {
      s.stepForTest(0.023, 1);
      const q = s.drive.supportNormal(probe, s.up);
      if (q <= 0) { blind += 1; continue; }
      const d = Math.acos(Math.max(-1, Math.min(1, probe.dot(s.up)))) * DEG;
      sum += d;
      peak = Math.max(peak, d);
      conf += q;
      n += 1;
    }
    return {
      mean: n ? sum / n : 0,
      peak,
      conf: n ? conf / n : 0,
      blind,
      frames: steps,
    };
  };

  s.input.walk = 0;
  const standing = watch(120);

  s.input.walk = 1;
  const walking = watch(300);
  s.input.walk = 0;
  s.stepForTest(0.023, 40);

  /* Dig herself a hole and then stand in it — the belly sample is now
   * reading the pit she just made, and her feet are on its rim. */
  s.aimPitchForTest(-1.0);
  s.input.dig = true;
  s.stepForTest(0.023, 130);
  s.input.dig = false;
  const afterDig = watch(200);

  /*
   * AND THE OUTCOME, which is the point of the whole exercise.
   *
   * Left alone after a dig she used to turn fifty degrees over seven
   * seconds of standing perfectly still — settling onto the pit her belly
   * was sampling rather than the rim her feet were on. NET rotation, not
   * accumulated: the distinction matters, because the accumulated figure
   * counts an ant shivering in place the same as one slowly toppling, and
   * it was the accumulated figure that sent an earlier session hunting a
   * regression that was never there.
   */
  const settleFrom = { x: s.up.x, y: s.up.y, z: s.up.z };
  s.stepForTest(0.023, 300);
  const settled = Math.acos(Math.max(-1, Math.min(1,
    settleFrom.x * s.up.x + settleFrom.y * s.up.y + settleFrom.z * s.up.z))) * DEG;

  /* And a climb, where the two SHOULD disagree and must not be allowed to
   * fight the corner scheduler. Recorded with the corner's own phase so a
   * split during a transition is distinguishable from one on open ground. */
  s.input.walk = 1;
  let cornerSum = 0;
  let cornerPeak = 0;
  let cornerFrames = 0;
  for (let i = 0; i < 700; i += 1) {
    s.stepForTest(0.023, 1);
    if ((s.driveReport?.corner.phase ?? 'normal') === 'normal') continue;
    const q = s.drive.supportNormal(probe, s.up);
    if (q <= 0) continue;
    const d = Math.acos(Math.max(-1, Math.min(1, probe.dot(s.up)))) * DEG;
    cornerSum += d;
    cornerPeak = Math.max(cornerPeak, d);
    cornerFrames += 1;
  }
  s.input.walk = 0;

  return {
    standing,
    walking,
    afterDig,
    settled,
    climbing: {
      mean: cornerFrames ? cornerSum / cornerFrames : 0,
      peak: cornerPeak,
      frames: cornerFrames,
    },
  };
});

const n = (v) => Number(v).toFixed(2);
console.log('how far her feet still disagree with her belly, in degrees');
console.log('(the residual — she is already following half of it; see the header)\n');
for (const [what, r] of Object.entries(out)) {
  if (what === 'climbing' || what === 'settled') continue;
  console.log(`${what.padEnd(9)} mean ${n(r.mean).padStart(6)}°  peak ${n(r.peak).padStart(6)}°  `
    + `confidence ${n(r.conf)}  (no fit on ${r.blind} of ${r.frames} frames)`);
}
const c = out.climbing;
console.log(`climbing  mean ${n(c.mean).padStart(6)}°  peak ${n(c.peak).padStart(6)}°  `
  + `(${c.frames} frames inside a corner transition)`);
console.log(`\nand then, standing still for seven seconds after that dig, `
  + `she turns ${n(out.settled)}° net`);

const fail = [];
/* The fit has to WORK before its answer means anything: standing on open
 * ground with six feet down, there is always a support polygon. */
if (out.standing.blind > out.standing.frames * 0.05) {
  fail.push(`no support fit on ${out.standing.blind} of ${out.standing.frames} standing frames`);
}
if (out.standing.conf < 0.2) {
  fail.push(`the standing fit's own confidence is ${n(out.standing.conf)} — it is a sliver`);
}
/* Control: on flat ground the two must broadly agree, or the fit is wrong
 * rather than informative and nothing below it can be trusted. */
if (out.standing.mean > 20) {
  fail.push(`feet and belly differ by ${n(out.standing.mean)}° STANDING STILL — the fit is wrong`);
}
/*
 * THE OUTCOME. Before her feet had a say she turned 49.9° net over these
 * same seven idle frames-worth of standing — chasing the pit her belly was
 * sampling. Thirty is comfortably under that and comfortably over the few
 * degrees of honest terrain following she should still do.
 */
if (out.settled > 30) {
  fail.push(`she still turns ${n(out.settled)}° standing still after a dig — `
    + 'her attitude is chasing the hole, not her feet');
}

console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
if (fail.length) {
  console.log(`\nFAILED: ${fail.join('; ')}`);
  process.exit(1);
}
console.log('\nthe support plane reads; the numbers above choose what to do with it');
