/**
 * Does she STAY DOWN once she is underground?
 *
 * Reported three times now, in three disguises: teleported to the surface
 * while moving in a tunnel; the model and camera spinning weirdly underground;
 * and jumping straight back out the moment she gets in.
 *
 * One cause. `cast` reports a hit at zero range when its origin is already
 * solid — correct for a ray, ruinous for a grip. `hold()` started its cast
 * three millimetres off her back without asking whether there were three
 * millimetres of room, and her own tunnels are about five millimetres across,
 * so underground that start sits in the CEILING. The "contact" came back at
 * zero range, she was seated a body-height above it, and it repeated every
 * frame: an elevator to the surface wearing a grip's clothes.
 *
 * So: bury her, then leave her alone and watch her depth. Anything that climbs
 * is the elevator. Also asked with the gyro on, since holding a nose-up grade
 * underground is what the report was doing at the time.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL
  ?? 'http://localhost:4536/Thronemound-Colony-Sim/?scene=block';
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];

/** Bury her by walking and biting, then run `after` and watch what happens. */
const run = async (label, after) => {
  const page = await b.newPage({ viewport: { width: 932, height: 430 } });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
  /*
   * Paused the INSTANT she is ready, before anything else.
   *
   * Pausing inside the measurement is too late: the live loop had already run
   * a second of wall-clock simulation by then, at whatever frame rate the
   * machine managed, so she started each run from a different place and facing
   * a different way. That is why the same probe on the same build reported her
   * thirteen millimetres down on one run and never underground on the next.
   * Settling is then done with `stepForTest`, which is the same every time.
   */
  await page.evaluate(() => window.blockScene.setPausedForTest(true));
  await page.waitForTimeout(400);
  const row = await page.evaluate((mode) => {
    const lab = window.blockScene;
    const MM = 5;
    lab.setPausedForTest(true);
    lab.stepForTest(1 / 60, 120);
    lab.setMode(1);
    lab.setAimPitchForTest(-Math.PI / 2.4);
    /*
     * Dig UNTIL she is under, rather than for a fixed spell.
     *
     * A fixed spell is a race against the block's edge: she walks about eight
     * millimetres a second from the middle of a sixty-four millimetre cube, so
     * a run that took a moment longer to break the surface spent the rest of
     * its budget walking off the side instead of tunnelling. Half the runs
     * then had nothing buried to test, and read as failures of a property
     * they never got to exercise.
     */
    let digging = 0;
    while (lab.buriedDepth(lab.at) * MM < 6 && digging < 400) {
      lab.input.dig = true; lab.input.walk = 1; lab.digCooldown = 0;
      lab.stepForTest(1 / 60, 6);
      digging += 1;
    }
    lab.input.dig = false;
    const buried0 = lab.buriedDepth(lab.at) * MM;
    if (mode === 'gyro') lab.setTrim(true, lab.gradeDeg() * Math.PI / 180);
    if (mode === 'gyroUp') lab.setTrim(true, (16.71 * Math.PI) / 180);
    // Now stand still for five seconds. Nothing should move her.
    lab.input.walk = 0;
    const depths = [];
    const ys = [];
    const y0 = lab.at.y * MM;
    for (let r = 0; r < 60; r += 1) {
      lab.stepForTest(1 / 60, 5);
      depths.push(lab.buriedDepth(lab.at) * MM);
      ys.push(lab.at.y * MM);
    }
    const buried1 = depths[depths.length - 1];
    return {
      buriedAfterDigMm: +buried0.toFixed(2),
      buriedAfterRestMm: +buried1.toFixed(2),
      roseMm: +(buried0 - buried1).toFixed(2),
      shallowest: +Math.min(...depths).toFixed(2),
      surfacedFrames: depths.filter((d) => d <= 0.01).length,
      gripping: lab.gripping,
      digSteps: digging,
      climbedMm: +(ys[ys.length - 1] - y0).toFixed(2),
      peakClimbMm: +(Math.max(...ys) - y0).toFixed(2),
      upY: +lab.up.y.toFixed(3),
    };
  }, after);
  await page.close();
  return { label, ...row };
};

const rows = [
  await run('gyro off', 'none'),
  await run('gyro holding her grade', 'gyro'),
  await run('gyro holding +17 (nose up)', 'gyroUp'),
];
console.log(JSON.stringify({ rows, errs }, null, 2));
for (const r of rows) {
  console.log(`${r.label.padEnd(28)} buried ${r.buriedAfterDigMm} → `
    + `${r.buriedAfterRestMm} mm (rose ${r.roseMm}, shallowest ${r.shallowest}, `
    + `${r.surfacedFrames} frames on the surface, climbed ${r.climbedMm} mm, peak ${r.peakClimbMm}, up.y ${r.upY})`);
}
/*
 * Judged on her WORLD HEIGHT, which cannot lie about this.
 *
 * It was judged on `buriedDepth` first, and that measures how much soil sits
 * along HER OWN UP — so once she tilts onto a tunnel wall the reading swings
 * with her orientation rather than her position. It read her going from nine
 * millimetres deep to nought while her actual height fell by 0.8 mm. She was
 * descending the whole time the instrument said she was surfacing. The
 * elevator being tested for is a RISE, so measure the rise.
 *
 * A little sink is fine and expected — she settles onto the floor. Anything
 * that climbs is the bug.
 */
const ok = rows.every((r) => r.buriedAfterDigMm >= 6 && r.peakClimbMm < 1);
console.log(ok && errs.length === 0 ? 'STAYS_DOWN' : 'RIDES_OUT');
console.log('(buried* is soil along HER up, so it swings as she tilts — climb is the real signal)');
await b.close();
