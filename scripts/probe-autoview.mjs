/*
 * DOES THE VIEW CHANGE WHEN SHE GOES UNDER, AND WHAT DOES IT COST?
 *
 * `auto` gives first person the moment she is submerged and third person back
 * when she is not. That mode has existed since the camera was written and has
 * never once fired, because nothing ever set `submerged` — so this is the first
 * time the switch has run in anger, and the switch is the dangerous part.
 *
 * A mode change here is a deliberate hard cut: the eye moves from twenty-five
 * millimetres behind her to her own head in one frame, and that is worth about
 * eighty degrees of view however it is done. Easing it is worse, not better —
 * measured, 82 degrees became 112, because interpolating toward an eye on her
 * head passes near the look target where direction inverts.
 *
 * So the thing to measure is not "is there a cut" — there is, by design — but
 * HOW MANY. One cut going in and one coming out is a film edit. Several in a
 * second is the "camera all over the place" report, and the difference is the
 * whole question.
 *
 *   SMOKE_URL=http://localhost:4241/ node scripts/probe-autoview.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://localhost:4241/').replace(/\/$/, '');
const URL = `${base}/?scene=block&shape=nest`;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
page.on('pageerror', e => errs.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await page.evaluate(() => window.blockScene.setPausedForTest(true));
await page.waitForTimeout(400);

const out = await page.evaluate(() => {
  const lab = window.blockScene;
  const MM = 5;
  const DEG = 180 / Math.PI;
  const V = Object.getPrototypeOf(lab.at).constructor;
  lab.setPausedForTest(true);
  lab.stepForTest(1 / 60, 120);

  /*
   * Put her down the shaft rather than hoping she walks into it. Whether she
   * FINDS the mouth is a different question — measured, she strides over a hole
   * — and this probe is about what the camera does at the boundary, which
   * needs her to actually cross it.
   */
  const plan = lab.nestForTest();
  const mouth = plan.nodes.find(n => n.kind === 'entrance');

  const flips = [];
  const swings = [];
  let lastOnboard = lab.follow.why?.onboard ?? false;
  let lastLook = lab.camera.getWorldDirection(new V());
  let frames = 0;
  let under = 0;

  const tick = () => {
    lab.stepForTest(1 / 60, 1);
    frames += 1;
    if (lab.underground) under += 1;
    const look = lab.camera.getWorldDirection(new V());
    const swing = Math.acos(Math.max(-1, Math.min(1, look.dot(lastLook)))) * DEG;
    swings.push(swing);
    const onboard = lab.follow.why?.onboard ?? false;
    if (onboard !== lastOnboard) {
      flips.push({
        frame: frames, to: onboard ? 'first' : 'third',
        swingDeg: +swing.toFixed(1),
        underground: lab.underground,
        why: { noRoom: lab.follow.why.noRoom, submerged: lab.follow.why.submerged },
      });
    }
    lastOnboard = onboard; lastLook = look;
  };

  /*
   * Then the cut ON ITS OWN, with her body held still.
   *
   * Teleporting her up and down to force a crossing does not measure the
   * camera — it measures `hold()` re-seating her on the nearest surface, which
   * it does within a few frames, so every "depth" reading came back as the
   * surface and the swings were the body being yanked. Toggling the rig's own
   * mode with her standing still is the only way to price the cut itself.
   *
   * And it has to run ON THE SURFACE. Underground, 'first' and 'auto' both
   * give first person, so toggling between them changes nothing and the run
   * comes back all zeros — which reads as "the cut is free" when it means "no
   * cut happened". Each row prints whether she was under, so a vacuous run
   * says so instead of looking like a pass.
   */
  const before = lab.follow.mode;
  const cuts = [];
  let priorLook = lab.camera.getWorldDirection(new V());
  for (const mode of ['first', 'auto', 'first', 'auto']) {
    lab.follow.mode = mode;
    lab.stepForTest(1 / 60, 1);
    const look = lab.camera.getWorldDirection(new V());
    cuts.push({
      mode,
      onboard: lab.follow.why.onboard,
      swingDeg: +(Math.acos(Math.max(-1, Math.min(1, look.dot(priorLook)))) * DEG).toFixed(1),
      underground: lab.underground,
    });
    priorLook = look;
    // Let it settle, so the next reading is a cut and not the tail of this one.
    for (let i = 0; i < 30; i += 1) lab.stepForTest(1 / 60, 1);
    priorLook = lab.camera.getWorldDirection(new V());
  }
  lab.follow.mode = before;


  // Walk her in from the spawn, straight at the mouth. This is the case that
  // actually happens in play, and the only one whose swing figures mean
  // anything about the game.
  for (let i = 0; i < 900; i += 1) { lab.input.walk = 1; tick(); }
  lab.input.walk = 0;
  const walkIn = { enteredAt: mouth ? true : false, flips: flips.length, underAt: under };

  swings.sort((a, b) => b - a);
  return {
    frames,
    undergroundFrames: under,
    flips,
    walkIn,
    cuts,
    worstSwingDeg: +swings[0].toFixed(1),
    // The bulk of frames, so one deliberate cut does not hide constant churn.
    p99SwingDeg: +swings[Math.floor(swings.length * 0.01)].toFixed(2),
    medianSwingDeg: +swings[Math.floor(swings.length * 0.5)].toFixed(3),
    fovs: lab.fovForTest(),
  };
});

console.log('\nTHE VIEW, going under and coming back');
console.log(`  frames ${out.frames}, of which underground ${out.undergroundFrames}`);
console.log(`  lenses  1st ${out.fovs.first}°  3rd ${out.fovs.third}°`);

console.log('\n  THE CUT ON ITS OWN (her body held still)');
for (const c of out.cuts) {
  console.log(`    mode=${c.mode.padEnd(5)} onboard=${String(c.onboard).padEnd(5)} `
    + `swing ${String(c.swingDeg).padStart(6)}°  under=${c.underground}`);
}

console.log(`\n  MODE CHANGES: ${out.flips.length}`);
for (const f of out.flips) {
  console.log(`    frame ${String(f.frame).padStart(4)} → ${f.to.padEnd(5)} `
    + `swing ${String(f.swingDeg).padStart(6)}°  under=${f.underground} `
    + `noRoom=${f.why.noRoom} submerged=${f.why.submerged}`);
}

console.log('\n  VIEW SWING PER FRAME');
console.log(`    worst  ${out.worstSwingDeg}°   (a mode change is a hard cut by design)`);
console.log(`    p99    ${out.p99SwingDeg}°   (this is the one that must stay small)`);
console.log(`    median ${out.medianSwingDeg}°`);
if (errs.length) console.log('\n  page errors:', errs);

await browser.close();
