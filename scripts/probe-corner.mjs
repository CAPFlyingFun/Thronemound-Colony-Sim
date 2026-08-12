/**
 * DOES SHE GET UP THE WALL?
 *
 * Reported from the device as "the legs sometimes look weird", with telemetry
 * showing the stick held down and nothing moving for forty frames in
 * `acquireFront`. Chasing that through the gait was the wrong end: the legs
 * cycling under a stationary body are her TRYING, not the fault. Two separate
 * attempts to quiet them — vetoing a strain-called turn while clamped, then
 * spacing the turns on a cooldown — both measured WORSE on every axis,
 * because the stepping is how the acquire finds the face. Suppressing it just
 * made her fail for longer. Neither shipped.
 *
 * What is actually wrong is upstream, and this is the probe that says so.
 * Over a wander long enough to meet a few of them:
 *
 *   - the corner arms RARELY and for REAL walls. Three armings in seventy-
 *     eight seconds, every one at a peak fold of 81 to 86 degrees against a
 *     45-degree entry threshold. So it is not arming for bumps, and the
 *     threshold is not the problem.
 *   - two of those three NEVER FINISH. She reaches `transferMiddle` with both
 *     front feet gripping the new face and the fold down from 80 to 57
 *     degrees — winning — and then loses the grips, falls back to
 *     `acquireFront` with the fold climbing to 77 again, and stops moving
 *     entirely until her own stall guard benches her two seconds later.
 *   - through all 107 frames of that, the tracked candidate sits at exactly
 *     3.83 mm and never closes, and no foot ever gropes: the footholds are
 *     found, taken, and then lost.
 *
 * So this counts armings and completions rather than inspecting the gait. It
 * is a RATCHET on a known failure, not a pass mark — see COMPLETED_AT_LEAST.
 *
 *   npm run probe:corner        # needs `vite preview` already running
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const DT = Number(process.env.DT ?? 0.0326);
const STEPS = Number(process.env.N ?? 2400);
/* Repeated, because this engine is not deterministic across page loads and a
 * single run of it cannot tell a change from the weather. See probe-lean. */
const RUNS = Number(process.env.RUNS ?? 2);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];

const once = async () => {
  const page = await browser.newPage({
    viewport: { width: 900, height: 600 }, serviceWorkers: 'block',
  });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 200000 });
  await page.waitForFunction(
    () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 200000 },
  );
  await page.waitForTimeout(1200);
  const out = await page.evaluate(({ dt, steps }) => {
    const s = window.islandScene;
    s.setPausedForTest(true);
    const DEG = 180 / Math.PI;
    s.input.walk = 1;
    const arms = [];
    let armed = false;
    let cur = null;
    for (let i = 0; i < steps; i += 1) {
      /* Wander, so she meets creases rather than one straight line. */
      s.input.yaw = Math.sin(i / 140) * 0.8;
      s.stepForTest(dt, 1);
      const rep = s.driveReport;
      if (!rep) continue;
      const now = rep.corner.phase !== 'normal';
      if (now && !armed) {
        cur = {
          at: i, frames: 0, clamped: 0, peakFold: 0, peakOnNew: 0,
          endFold: 0, finished: false, groped: 0,
        };
      }
      if (now && cur) {
        cur.frames += 1;
        cur.peakFold = Math.max(cur.peakFold, rep.corner.fold * DEG);
        cur.peakOnNew = Math.max(cur.peakOnNew, rep.corner.onNew);
        cur.endFold = rep.corner.fold * DEG;
        if (rep.movedMm < 0.05) cur.clamped += 1;
        if (rep.corner.feet.some((f) => f.state === 'GROPE')) cur.groped += 1;
        if (rep.corner.phase === 'settle') cur.finished = true;
      }
      if (!now && armed && cur) { arms.push(cur); cur = null; }
      armed = now;
    }
    if (cur) arms.push(cur);
    s.input.walk = 0;
    s.input.yaw = 0;
    return arms;
  }, { dt: DT, steps: STEPS });
  await page.close();
  return out;
};

const runs = [];
for (let i = 0; i < RUNS; i += 1) runs.push(await once());
await browser.close();

const all = runs.flat();
console.log(`her corners, over ${RUNS} x ${(STEPS * DT).toFixed(0)}s of wandering\n`);
console.log('  run     t   peak fold   end fold   most feet across   armed   clamped   outcome');
runs.forEach((arms, r) => {
  for (const a of arms) {
    console.log(`${String(r + 1).padStart(5)} ${(a.at * DT).toFixed(1).padStart(5)}s   `
      + `${a.peakFold.toFixed(1).padStart(7)}°   ${a.endFold.toFixed(1).padStart(6)}°   `
      + `${String(a.peakOnNew).padStart(14)}   ${(a.frames * DT).toFixed(2).padStart(5)}s   `
      + `${(a.clamped * DT).toFixed(2).padStart(5)}s   ${a.finished ? 'settled' : 'BENCHED'}`);
  }
});

const done = all.filter((a) => a.finished).length;
const shallow = all.filter((a) => a.peakFold < 45).length;
const slipped = all.filter((a) => !a.finished && a.peakOnNew >= 2).length;
console.log(`\narmings: ${all.length}, settled ${done}, benched ${all.length - done}`);
console.log(`armings that never reached the 45° entry threshold: ${shallow}`);
console.log(`benched AFTER getting two or more feet across — she had it and lost it: ${slipped}`);

const fail = [];
/* The measurement has to WORK before anything counted off it means a thing:
 * a wander that never meets a wall proves nothing about walls. */
if (all.length === 0) fail.push('she met no corners at all — this measured nothing');
/*
 * A RATCHET ON A KNOWN FAILURE. Two in three of her corners currently end at
 * the stall guard, and a threshold loose enough to call that a pass would be
 * a probe congratulating itself. This is set where it stands: it cannot say
 * "she climbs", it can say "no fewer than before", which is the honest job
 * for it until the crossing is fixed. Raise it when it is.
 */
const COMPLETED_AT_LEAST = 0.25;
if (all.length > 0 && done / all.length < COMPLETED_AT_LEAST) {
  fail.push(`only ${done}/${all.length} corners completed — under the `
    + `${(COMPLETED_AT_LEAST * 100).toFixed(0)}% this stands at`);
}
/* If she starts arming for bumps, the entry threshold has drifted and every
 * number above is measuring something else. */
if (shallow > 0) {
  fail.push(`${shallow} arming(s) never reached the 45° entry angle — `
    + 'the corner is arming for something that is not a wall');
}

console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
if (fail.length) {
  console.log(`\nFAILED: ${fail.join('; ')}`);
  process.exit(1);
}
console.log('\nno worse than it stands — see COMPLETED_AT_LEAST; she still loses'
  + '\nfront grips after taking them, and that is the open fault');
