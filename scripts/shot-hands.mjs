/**
 * LEFT AND RIGHT, SETTLED AGAINST THE SCREEN.
 *
 * Twice now a sign here has been "verified" and shipped backwards, both
 * times because the check used the code's own idea of her right — the
 * `up x forward` axis — which is self-consistent whichever way the MODEL
 * faces, and so can confirm anything.
 *
 * The screen cannot be argued with. The camera's own +X column IS
 * screen-right, so:
 *
 *   head:   drag right on the view, does her face swing screen-right
 *   strafe: push the stick right, does she travel screen-right
 *
 * and both are driven through the real pointer handlers, because the drag's
 * own sign (`camYaw -= movementX`) is one of the things under test.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/shot-hands.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 90000 });
await page.waitForFunction(
  () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 90000 },
);
await page.waitForTimeout(2000);

const reset = () => page.evaluate(() => {
  const s = window.islandScene;
  s.input.walk = 0; s.input.yaw = 0; s.input.strafe = 0;
  s.camYaw = 0;
  s.stepForTest(1 / 60, 60);
});

/** Drag the LOOK pointer (right half of the screen) by `px`, then report. */
const lookDrag = async (px) => {
  await reset();
  await page.mouse.move(700, 320);
  await page.mouse.down();
  const steps = 10;
  for (let i = 0; i < steps; i += 1) {
    await page.mouse.move(700 + ((i + 1) * px) / steps, 320);
  }
  await page.mouse.up();
  return page.evaluate(() => {
    const s = window.islandScene;
    /* Hold the swing while the pose catches up — the drag's own decay would
     * otherwise unwind it before the head has finished turning. */
    const held = s.camYaw;
    for (let i = 0; i < 30; i += 1) { s.camYaw = held; s.stepForTest(1 / 60, 1); }
    s.camera.updateMatrixWorld();
    const c = s.camera.matrixWorld.elements;
    const screenRight = { x: c[0], y: c[1], z: c[2] };
    const head = s.queen.bones.get(s.queen.rig.thorax[0]);
    head.updateWorldMatrix(true, false);
    const e = head.matrixWorld.elements;
    /*
     * WHICH AXIS OF THE HEAD BONE IS ITS FACE? Guessing +Y gave dots of
     * 0.008 against 0.026 — a verdict resting on two hundredths, which is
     * no verdict. Take whichever of the bone's three axes lies closest to
     * her BODY forward and use that; it is the face by construction.
     */
    const axes = [
      { x: e[0], y: e[1], z: e[2] }, { x: e[4], y: e[5], z: e[6] },
      { x: e[8], y: e[9], z: e[10] },
    ];
    let face = axes[0];
    let best = -Infinity;
    for (const a of axes) {
      for (const sign of [1, -1]) {
        const d = sign * (a.x * s.fwd.x + a.y * s.fwd.y + a.z * s.fwd.z);
        if (d > best) { best = d; face = { x: a.x * sign, y: a.y * sign, z: a.z * sign }; }
      }
    }
    const len = Math.hypot(face.x, face.y, face.z) || 1;
    return {
      camYaw: +held.toFixed(3),
      alongNose: +(best / len).toFixed(3),
      faceScreenRight: +((face.x * screenRight.x + face.y * screenRight.y
        + face.z * screenRight.z) / len).toFixed(3),
    };
  });
};

/** Push the STICK (left half) by `px` across, then report where she went. */
const stickPush = async (px) => {
  await reset();
  await page.mouse.move(220, 400);
  await page.mouse.down();
  await page.mouse.move(220 + px, 400, { steps: 6 });
  const out = await page.evaluate(() => {
    const s = window.islandScene;
    s.camera.updateMatrixWorld();
    const c = s.camera.matrixWorld.elements;
    const screenRight = { x: c[0], y: c[1], z: c[2] };
    const from = { x: s.at.x, y: s.at.y, z: s.at.z };
    s.stepForTest(1 / 60, 90);
    const dx = s.at.x - from.x;
    const dy = s.at.y - from.y;
    const dz = s.at.z - from.z;
    return {
      strafe: +s.input.strafe.toFixed(3),
      screenRightMm: +((dx * screenRight.x + dy * screenRight.y
        + dz * screenRight.z) * 5).toFixed(2),
    };
  });
  await page.mouse.up();
  return out;
};

const right = await lookDrag(140);
const left = await lookDrag(-140);
console.log('\nHER HEAD, against the camera\'s own screen-right');
console.log(`  drag right 140 px -> camYaw ${right.camYaw}, face ${right.faceScreenRight}`);
console.log(`  drag left  140 px -> camYaw ${left.camYaw}, face ${left.faceScreenRight}`);
console.log(`  -> ${right.faceScreenRight > left.faceScreenRight
  ? 'she looks toward the side you dragged — CORRECT'
  : 'BACKWARDS: she looks away from the side you dragged'}`);

const sr = await stickPush(40);
const sl = await stickPush(-40);
console.log('\nHER SIDE STEP, against the camera\'s own screen-right');
console.log(`  stick right -> strafe ${sr.strafe}, travelled ${sr.screenRightMm} mm screen-right`);
console.log(`  stick left  -> strafe ${sl.strafe}, travelled ${sl.screenRightMm} mm screen-right`);
console.log(`  -> ${sr.screenRightMm > 0 && sl.screenRightMm < 0
  ? 'she goes the way you push — CORRECT'
  : 'BACKWARDS: she goes opposite the push'}`);

console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
