/**
 * WHICH WAY DOES EVERYTHING GO?
 *
 * Three signs that cannot be settled by reading the code — two of them have
 * already been wrong once each — so each is driven and measured against
 * something physical rather than against a convention.
 *
 *   head:   drag the view right, does her face end up right of her nose
 *   steer:  drag the view right and walk, does her NOSE come round to it
 *   strafe: press right without TURN, does she move to her own right
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/shot-steer.mjs
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

const r = await page.evaluate(() => {
  const s = window.islandScene;
  const MM = 5;
  /** Her own right, in the world. */
  const rightOf = () => ({
    x: s.up.y * s.fwd.z - s.up.z * s.fwd.y,
    y: s.up.z * s.fwd.x - s.up.x * s.fwd.z,
    z: s.up.x * s.fwd.y - s.up.y * s.fwd.x,
  });
  const settle = () => {
    s.input.walk = 0; s.input.yaw = 0; s.input.strafe = 0;
    s.camYaw = 0;
    s.stepForTest(1 / 60, 60);
  };

  /* HEAD. Swing the arm one way and see which side of her nose her face
   * ends up on. The head bone's own +Y is along the head. */
  const faceSide = (camYaw) => {
    settle();
    s.camYaw = camYaw;
    for (let i = 0; i < 30; i += 1) { s.camYaw = camYaw; s.stepForTest(1 / 60, 1); }
    const head = s.queen.bones.get(s.queen.rig.thorax[0]);
    head.updateWorldMatrix(true, false);
    const e = head.matrixWorld.elements;
    const rt = rightOf();
    return +(e[4] * rt.x + e[5] * rt.y + e[6] * rt.z).toFixed(3);
  };

  /* STEER. Hold the arm swung and walk; does her nose come round toward it? */
  const noseSwing = (camYaw) => {
    settle();
    const was = s.facing;
    s.input.walk = 1;
    let swept = 0;
    let prev = was;
    for (let i = 0; i < 90; i += 1) {
      s.camYaw = camYaw;
      s.stepForTest(1 / 60, 1);
      let d = s.facing - prev;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      swept += d; prev = s.facing;
    }
    s.input.walk = 0;
    return +(swept * 180 / Math.PI).toFixed(0);
  };

  /* STRAFE. Press right with the latch off and see where she went. */
  const sideStep = (strafe) => {
    settle();
    const rt = rightOf();
    const from = { x: s.at.x, y: s.at.y, z: s.at.z };
    const nose0 = s.facing;
    s.input.strafe = strafe;
    s.stepForTest(1 / 60, 90);
    s.input.strafe = 0;
    const dx = s.at.x - from.x;
    const dy = s.at.y - from.y;
    const dz = s.at.z - from.z;
    let turned = s.facing - nose0;
    while (turned > Math.PI) turned -= Math.PI * 2;
    while (turned < -Math.PI) turned += Math.PI * 2;
    return {
      alongRightMm: +((dx * rt.x + dy * rt.y + dz * rt.z) * MM).toFixed(2),
      alongNoseMm: +((dx * s.fwd.x + dy * s.fwd.y + dz * s.fwd.z) * MM).toFixed(2),
      noseTurnedDeg: +(turned * 180 / Math.PI).toFixed(1),
    };
  };

  s.precisionTurn = false;
  const out = {
    headRightDrag: faceSide(0.6),
    headLeftDrag: faceSide(-0.6),
    steerRightDrag: noseSwing(0.6),
    steerLeftDrag: noseSwing(-0.6),
    strafeRight: sideStep(1),
    strafeLeft: sideStep(-1),
  };
  /*
   * HER BODY'S OWN TWIST, not the compass.
   *
   * `facing` is a horizontal bearing, and on a slope her forward is
   * re-projected onto whatever she is standing on every frame — so the
   * bearing sweeps faster than she turns. Measured on this hillside the
   * compass read 174 deg/s against a commanded 89. The angle between
   * consecutive forwards, about her own up, is the number the stick
   * actually sets.
   */
  s.precisionTurn = true;
  settle();
  s.input.yaw = 1;
  let twist = 0;
  let prev = { x: s.fwd.x, y: s.fwd.y, z: s.fwd.z };
  let compass = 0;
  let prevFacing = s.facing;
  for (let i = 0; i < 60; i += 1) {
    s.stepForTest(1 / 60, 1);
    const dot = Math.max(-1, Math.min(1,
      prev.x * s.fwd.x + prev.y * s.fwd.y + prev.z * s.fwd.z));
    twist += Math.acos(dot);
    prev = { x: s.fwd.x, y: s.fwd.y, z: s.fwd.z };
    let d = s.facing - prevFacing;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    compass += d;
    prevFacing = s.facing;
  }
  s.input.yaw = 0;
  s.precisionTurn = false;
  out.turnRateDegS = +(twist * 180 / Math.PI).toFixed(0);
  out.compassDegS = +(Math.abs(compass) * 180 / Math.PI).toFixed(0);
  return out;
});

console.log('\nHER HEAD (dot of the head bone against her own right)');
console.log(`  view dragged right: ${r.headRightDrag}   left: ${r.headLeftDrag}`);
console.log(`  -> ${r.headRightDrag > 0 ? 'she looks RIGHT when the view goes right — correct'
  : 'BACKWARDS: she looks left when the view goes right'}`);

console.log('\nSTEERING WITH THE VIEW (nose swept while walking, 1.5 s)');
console.log(`  view held right: ${r.steerRightDrag}°   left: ${r.steerLeftDrag}°`);

console.log('\nSIDE STEP (TURN off)');
for (const [k, v] of [['right', r.strafeRight], ['left', r.strafeLeft]]) {
  console.log(`  press ${k.padEnd(5)} -> ${String(v.alongRightMm).padStart(6)} mm along her right, `
    + `${String(v.alongNoseMm).padStart(6)} mm along her nose, nose turned ${v.noseTurnedDeg}°`);
}

console.log(`\nROTATION (TURN on, full stick)`);
console.log(`  her body twists ${Math.abs(r.turnRateDegS)}°/s  (the compass reads `
  + `${r.compassDegS}°/s — a slope re-projects her forward, so the bearing runs faster)`);
console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
