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
 *   turn:   push the stick right, does her nose swing screen-right
 *   strafe: pan the view right, does she SLIDE screen-right without turning
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

/**
 * THE TWO CONTROLS, AFTER THE SWAP.
 *
 * The stick's left and right TURN her; a pan of the view SIDE-STEPS her.
 *
 * The turn is measured as the SIGNED ROTATION OF HER FORWARD ABOUT HER OWN
 * UP, accumulated per frame. Two earlier metrics failed here and both failed
 * quietly: the dot of her forward against a fixed axis is a cosine, so it
 * stops being monotonic past a right angle AND its value depends on which
 * way she happened to be pointing — the same build read "correct" in one run
 * and "backwards" in the next.
 *
 * The sign is fixed once from geometry already settled against the screen: a
 * positive rotation about `up` carries a vector toward `up x forward`, and
 * that axis is measured above to be SCREEN-LEFT. So a nose going to the
 * right of the screen is a NEGATIVE rotation about her up, whatever her
 * heading and whatever the slope.
 */
const stickTurn = async (px) => {
  await reset();
  await page.mouse.move(220, 400);
  await page.mouse.down();
  await page.mouse.move(220 + px, 400, { steps: 6 });
  const out = await page.evaluate(() => {
    const s = window.islandScene;
    let turned = 0;
    let prev = { x: s.fwd.x, y: s.fwd.y, z: s.fwd.z };
    for (let i = 0; i < 40; i += 1) {
      s.stepForTest(1 / 60, 1);
      const cx = prev.y * s.fwd.z - prev.z * s.fwd.y;
      const cy = prev.z * s.fwd.x - prev.x * s.fwd.z;
      const cz = prev.x * s.fwd.y - prev.y * s.fwd.x;
      turned += Math.atan2(
        cx * s.up.x + cy * s.up.y + cz * s.up.z,
        prev.x * s.fwd.x + prev.y * s.fwd.y + prev.z * s.fwd.z,
      );
      prev = { x: s.fwd.x, y: s.fwd.y, z: s.fwd.z };
    }
    return { screenRightDeg: +(-turned * 180 / Math.PI).toFixed(1) };
  });
  await page.mouse.up();
  return out;
};

/** Hold the view dragged and see whether she SLIDES, without turning. */
const panSlide = async (px) => {
  await reset();
  await page.mouse.move(700, 320);
  await page.mouse.down();
  for (let i = 0; i < 10; i += 1) await page.mouse.move(700 + ((i + 1) * px) / 10, 320);
  const out = await page.evaluate(() => {
    const s = window.islandScene;
    s.camera.updateMatrixWorld();
    const c = s.camera.matrixWorld.elements;
    const screenRight = { x: c[0], y: c[1], z: c[2] };
    const held = s.camYaw;
    const from = { x: s.at.x, y: s.at.y, z: s.at.z };
    let turned = 0;
    let prev = { x: s.fwd.x, y: s.fwd.y, z: s.fwd.z };
    for (let i = 0; i < 60; i += 1) {
      s.camYaw = held;
      s.stepForTest(1 / 60, 1);
      const cx = prev.y * s.fwd.z - prev.z * s.fwd.y;
      const cy = prev.z * s.fwd.x - prev.x * s.fwd.z;
      const cz = prev.x * s.fwd.y - prev.y * s.fwd.x;
      turned += Math.atan2(
        cx * s.up.x + cy * s.up.y + cz * s.up.z,
        prev.x * s.fwd.x + prev.y * s.fwd.y + prev.z * s.fwd.z,
      );
      prev = { x: s.fwd.x, y: s.fwd.y, z: s.fwd.z };
    }
    const dx = s.at.x - from.x;
    const dy = s.at.y - from.y;
    const dz = s.at.z - from.z;
    return {
      strafe: +s.input.strafe.toFixed(2),
      slidScreenRightMm: +((dx * screenRight.x + dy * screenRight.y
        + dz * screenRight.z) * 5).toFixed(2),
      noseTurnedDeg: +(-turned * 180 / Math.PI).toFixed(1),
    };
  });
  await page.mouse.up();
  return out;
};

const tr = await stickTurn(40);
const tl = await stickTurn(-40);
console.log('\nTHE STICK TURNS HER — degrees her nose swung toward SCREEN-RIGHT');
console.log(`  stick right -> ${tr.screenRightDeg}°   left -> ${tl.screenRightDeg}°`);
console.log(`  -> ${tr.screenRightDeg > 0 && tl.screenRightDeg < 0
  ? 'she turns the way you push — CORRECT'
  : 'BACKWARDS: she turns against the push'}`);

const pr = await panSlide(140);
const pl = await panSlide(-140);
console.log('\nA PAN OF THE VIEW SIDE-STEPS HER');
console.log(`  drag right -> strafe ${pr.strafe}, slid ${pr.slidScreenRightMm} mm `
  + `screen-right, nose turned ${pr.noseTurnedDeg}°`);
console.log(`  drag left  -> strafe ${pl.strafe}, slid ${pl.slidScreenRightMm} mm `
  + `screen-right, nose turned ${pl.noseTurnedDeg}°`);
console.log(`  -> ${pr.slidScreenRightMm > 0 && pl.slidScreenRightMm < 0
  ? 'she slides the way you pan — CORRECT'
  : 'BACKWARDS: she slides against the pan'}`);

console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
