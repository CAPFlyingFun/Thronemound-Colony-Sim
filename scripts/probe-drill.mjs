/**
 * DRILL STRAIGHT IN, AND SEE WHAT MOVES THAT SHOULD NOT.
 *
 * The test rig this uses was the idea behind it: a flat plateau to walk in on
 * and a face at exactly ninety degrees to bore into. Level ground and a
 * vertical wall mean every correct answer is a straight line — walking in at
 * nought degrees and drilling straight ahead, her height must not change, her
 * heading must not change, and nothing may drift sideways.
 *
 * So there is no slope, no curvature and no cornering for an error to hide
 * behind. Whatever moves is the fault, and the point of measuring the body and
 * the camera side by side is that it says WHICH of them it is:
 *
 *   BODY    her position across the bore, her height, her up, her heading.
 *   CAMERA  where the eye sits across the bore, and where it points.
 *
 * If the body holds still and the view does not, it is the camera. If both
 * move together, it is her.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL
  ?? 'http://localhost:4570/Thronemound-Colony-Sim/?scene=block&shape=cliff';
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await b.newPage({ viewport: { width: 932, height: 430 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await page.evaluate(() => window.blockScene.setPausedForTest(true));
await page.waitForTimeout(400);

const run = async (digging) => {
  const p2 = await b.newPage({ viewport: { width: 932, height: 430 } });
  p2.on('pageerror', (e) => errs.push(e.message));
  await p2.goto(URL, { waitUntil: 'domcontentloaded' });
  await p2.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
  await p2.evaluate(() => window.blockScene.setPausedForTest(true));
  await p2.waitForTimeout(400);
  const r = await p2.evaluate((dig) => {
  const lab = window.blockScene;
  const MM = 5;
  const DEG = 180 / Math.PI;
  const V = Object.getPrototypeOf(lab.at).constructor;
  lab.setPausedForTest(true);
  lab.stepForTest(1 / 60, 180);

  // Square her up on the rig: level, facing the wall, so the run in is exact.
  lab.up.set(0, 1, 0);
  lab.forward.set(0, 0, 1);
  lab.stepForTest(1 / 60, 60);
  lab.setMode(1);
  lab.setAimPitchForTest(0);

  const start = {
    x: lab.at.x * MM, y: lab.at.y * MM, z: lab.at.z * MM,
    camX: lab.camera.position.x * MM, camY: lab.camera.position.y * MM,
  };
  const worst = {
    acrossMm: 0, heightMm: 0, upDeg: 0, headingDeg: 0,
    camAcrossMm: 0, camHeightMm: 0, lookDeg: 0,
    frameUpDeg: 0, frameLookDeg: 0, frameEyeMm: 0,
  };
  const bite = (v, x) => { worst[v] = Math.max(worst[v], Math.abs(x)); };
  let lastUp = lab.up.clone();
  let lastLook = lab.camera.getWorldDirection(new V());
  let lastEye = lab.camera.position.clone();
  const track = [];
  let hitWall = -1;

  for (let i = 0; i < 1500; i += 1) {
    lab.input.walk = 1;
    lab.input.dig = dig;
    lab.digCooldown = 0;
    lab.stepForTest(1 / 60, 1);

    // ACROSS the bore is x; along it is z. Height is y. All three should be
    // constant except z.
    bite('acrossMm', lab.at.x * MM - start.x);
    bite('heightMm', lab.at.y * MM - start.y);
    bite('upDeg', Math.acos(Math.max(-1, Math.min(1, lab.up.y))) * DEG);
    bite('headingDeg', Math.atan2(lab.forward.x, lab.forward.z) * DEG);
    bite('camAcrossMm', lab.camera.position.x * MM - start.camX);

    const look = lab.camera.getWorldDirection(new V());
    // The view should stay square on the bore: no yaw off +Z at all.
    bite('lookDeg', Math.atan2(look.x, look.z) * DEG);

    const dUp = Math.acos(Math.max(-1, Math.min(1, lab.up.dot(lastUp)))) * DEG;
    const dLook = Math.acos(Math.max(-1, Math.min(1, look.dot(lastLook)))) * DEG;
    const dEye = lab.camera.position.distanceTo(lastEye) * MM;
    bite('frameUpDeg', dUp);
    bite('frameLookDeg', dLook);
    bite('frameEyeMm', dEye);
    lastUp = lab.up.clone(); lastLook = look.clone(); lastEye = lab.camera.position.clone();

    if (hitWall < 0 && lab.underground) hitWall = i;
    if (i % 100 === 0) {
      track.push({
        i,
        alongMm: +(lab.at.z * MM - start.z).toFixed(2),
        acrossMm: +(lab.at.x * MM - start.x).toFixed(2),
        heightMm: +(lab.at.y * MM - start.y).toFixed(2),
        headingDeg: +(Math.atan2(lab.forward.x, lab.forward.z) * DEG).toFixed(1),
        lookDeg: +(Math.atan2(look.x, look.z) * DEG).toFixed(1),
        state: lab.travelState,
      });
    }
  }
  lab.input.walk = 0; lab.input.dig = false;
  const round = (o) => Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, +v.toFixed(2)]),
  );
  return {
    hitWallFrame: hitWall,
    alongMm: +(lab.at.z * MM - start.z).toFixed(2),
    worst: round(worst),
    track,
  };
  }, digging);
  await p2.close();
  return r;
};

/*
 * The CONTROL, and it is the whole value of the rig: the same run without
 * biting. Walking into a wall and boring into one differ by exactly one thing,
 * so whatever the two have in common is not the digging.
 */
const walking = await run(false);
const out = await run(true);
await page.close();

console.log(JSON.stringify({ walking, drilling: out, errs }, null, 2));
console.log('');
console.log('                    walking in    drilling in');
for (const [label, key, unit] of [
  ['across the bore', 'acrossMm', 'mm'], ['height', 'heightMm', 'mm'],
  ['heading swing', 'headingDeg', '\u00b0'], ['body tilt', 'upDeg', '\u00b0'],
  ['view yaw off bore', 'lookDeg', '\u00b0'],
]) {
  console.log(`${label.padEnd(20)}${String(walking.worst[key]).padStart(9)} ${unit}`
    + `${String(out.worst[key]).padStart(11)} ${unit}`);
}
console.log('');
console.log(`bored ${out.alongMm} mm along, met the wall at frame ${out.hitWallFrame}`);
console.log('');
console.log('           BODY                          CAMERA');
console.log(`across   ${String(out.worst.acrossMm).padStart(7)} mm            `
  + `${String(out.worst.camAcrossMm).padStart(7)} mm`);
console.log(`height   ${String(out.worst.heightMm).padStart(7)} mm`);
console.log(`heading  ${String(out.worst.headingDeg).padStart(7)}°             `
  + `${String(out.worst.lookDeg).padStart(7)}°  (view yaw off the bore)`);
console.log(`up tilt  ${String(out.worst.upDeg).padStart(7)}°`);
console.log('');
console.log(`worst single frame: body up ${out.worst.frameUpDeg}° · `
  + `view ${out.worst.frameLookDeg}° · eye ${out.worst.frameEyeMm} mm`);
/*
 * Straight in means straight in. A millimetre of wander and a degree or two of
 * lean is the gait breathing; anything larger is the fault being looked for.
 */
const bodyOk = out.worst.acrossMm < 2 && out.worst.upDeg < 8 && out.worst.headingDeg < 8;
const camOk = out.worst.lookDeg < 8 && out.worst.frameLookDeg < 6;
console.log(bodyOk ? 'BODY_STRAIGHT' : 'BODY_WANDERS');
console.log(camOk ? 'CAMERA_STRAIGHT' : 'CAMERA_WANDERS');
await b.close();
