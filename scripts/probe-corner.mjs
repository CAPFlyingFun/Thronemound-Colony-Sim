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
 * ## WHY A GRIP IS LOST, measured — and why the obvious repairs are worse
 *
 * "She had it and lost it" has one mechanism, and every step of it is
 * observable in the columns below. A foot that has crossed is dragged past
 * its own workspace; the strain release in `legDrive` step 2 lets it go —
 * blind, unlike the tripod release, which refuses to lift a crossed foot
 * unless the corner can aim it RIGHT NOW; `leg.t = 0` clears `crossing`, so
 * the swing falls through to the ordinary `nearest`, which searches along
 * her up, which still belongs to the FLOOR. The foot lands on soil and
 * `landed` writes 'old' over a grip that was real. Both front feet 'old'
 * means `leanToward` returns nought, the pre-tilt is withdrawn, and the fold
 * springs back — measured, 58° to 86° in a dozen frames.
 *
 * The two adversarial halves are worth naming, because they make the timing
 * inevitable rather than unlucky: the frame in which a foot is furthest past
 * its home is exactly the frame in which its foothold ray is least likely to
 * still reach the face. Of 14 blind re-steps of a crossed foot, 13 failed
 * their re-aim with the ray returning NULL — her body had carried that
 * foot's home INTO the bark, so the probe started in solid.
 *
 * Which is the upstream fault, and it is not in the gait: after the leading
 * row crosses, `CornerCommand.hold` is withdrawn (`crossed` only grows), and
 * nothing then keeps her off the face. Measured on the failing corner: fold
 * pinned at 58°, both fronts gripping, and she walks 6 mm further forward
 * over 25 frames with the clip reporting `allowed` = 1 the whole way — until
 * the homes are inside the wood and no foothold can ever be found again.
 *
 * TWO REPAIRS INSIDE THE GAIT WERE MEASURED AND BOTH ARE WORSE, over 6 x 78s:
 *
 *              settled          armed frozen (`clamped`)
 *   as it is    12/24 (50%)      9%
 *   (a)         14/29 (48%)     27%
 *   (b)          9/22 (41%)     55%
 *
 *   (a) give the release the same limit the clip already gives a crossed
 *       foot (`spread * 1.35` rather than bare `spread`), so one foot is not
 *       simultaneously "fine" to the clip and "out of leg" to the release.
 *   (b) (a), plus seeding `crossing` from the corner's ledger so a re-step
 *       the corner cannot aim is a step in place ON THE FACE.
 *
 * (b) does what it says — grip demotions fall to ZERO — and she still does
 * not finish, because losing the grip was the only thing RELIEVING her: the
 * clip is a stay-inside test, so once a foot is outside it refuses every
 * fraction and she freezes at `allowed` = 0. The violation is created by
 * `SurfaceWalker` re-seating and re-orienting her AFTER the clip has run,
 * which the drive cannot see coming and cannot prevent.
 *
 * The ordering is the lesson: the release threshold must stay TIGHTER than
 * the clip's, or the clip binds before the escape valve opens. They are not
 * meant to be the same number. Fixing this properly means holding her off
 * the face for the whole transfer, in `cornerTurn.ts`, not letting go later
 * in `legDrive.ts`.
 *
 *   npx vite --port 5173                                  # then, in another shell
 *   SMOKE_URL=http://127.0.0.1:5173/ npm run probe:corner
 *
 * NOT `vite preview`, which the old instruction named and which cannot work
 * here: the build's base is `/Thronemound-Colony-Sim/` and preview resolves
 * `command` as `serve`, so it serves at `/` and every asset misses. That is
 * the same trap `scripts/serveDist.mjs` was written to avoid — serveDist on
 * 4700 works too, at `http://127.0.0.1:4700/Thronemound-Colony-Sim/`.
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
    /* Last frame's surface label per foot, so a grip HANDED BACK can be
     * counted. `onNew` alone cannot: it falls by one both when a foot is
     * lifted for an honest re-step and when it is lost, and the whole
     * question here is which of those happened. */
    let was = {};
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
          endFold: 0, finished: false, groped: 0, lost: 0,
        };
        was = {};
      }
      if (now && cur) {
        cur.frames += 1;
        cur.peakFold = Math.max(cur.peakFold, rep.corner.fold * DEG);
        cur.peakOnNew = Math.max(cur.peakOnNew, rep.corner.onNew);
        cur.endFold = rep.corner.fold * DEG;
        if (rep.movedMm < 0.05) cur.clamped += 1;
        if (rep.corner.feet.some((f) => f.state === 'GROPE')) cur.groped += 1;
        /*
         * A GRIP HANDED BACK: a foot that carried the new surface's label
         * and is now PLANTED on the old one. Standing is the point — a
         * label that lapses while the foot is in the air is a re-step, and
         * a re-step is how the corner is supposed to advance.
         */
        for (const f of rep.corner.feet) {
          if (was[f.slot] === 'new' && f.owner === 'old' && f.state === 'PLANT') {
            cur.lost += 1;
          }
          was[f.slot] = f.owner;
        }
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
console.log('  run     t   peak fold   end fold   most feet across   armed   clamped'
  + '   grips lost   outcome');
runs.forEach((arms, r) => {
  for (const a of arms) {
    console.log(`${String(r + 1).padStart(5)} ${(a.at * DT).toFixed(1).padStart(5)}s   `
      + `${a.peakFold.toFixed(1).padStart(7)}°   ${a.endFold.toFixed(1).padStart(6)}°   `
      + `${String(a.peakOnNew).padStart(14)}   ${(a.frames * DT).toFixed(2).padStart(5)}s   `
      + `${(a.clamped * DT).toFixed(2).padStart(5)}s   ${String(a.lost).padStart(10)}   `
      + `${a.finished ? 'settled' : 'BENCHED'}`);
  }
});

const done = all.filter((a) => a.finished).length;
const shallow = all.filter((a) => a.peakFold < 45).length;
const slipped = all.filter((a) => !a.finished && a.peakOnNew >= 2).length;
console.log(`\narmings: ${all.length}, settled ${done}, benched ${all.length - done}`);
console.log(`armings that never reached the 45° entry threshold: ${shallow}`);
console.log(`benched AFTER getting two or more feet across — she had it and lost it: ${slipped}`);

/*
 * THE TWO WAYS A CORNER DIES, told apart — because a repair that swaps one
 * for the other reads as progress on the completion count alone, and both
 * candidate repairs above did exactly that.
 *
 * Frozen time is the symptom the device report was actually about: the stick
 * held down and nothing moving. A change that lifts completions while
 * doubling this has not helped her.
 */
const armedS = all.reduce((s, a) => s + a.frames, 0) * DT;
const frozenS = all.reduce((s, a) => s + a.clamped, 0) * DT;
const lost = all.reduce((s, a) => s + a.lost, 0);
console.log(`grips handed back to the old surface, over every arming: ${lost}`);
console.log(`armed ${armedS.toFixed(1)}s, of which frozen `
  + `${frozenS.toFixed(1)}s (${(100 * frozenS / Math.max(armedS, 1e-9)).toFixed(0)}%)`);

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
