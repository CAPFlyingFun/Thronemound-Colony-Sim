/**
 * Does her head go where you are looking, and only where the mode allows?
 *
 * Three claims to check, and each has a number:
 *
 *   YAW, EVERY MODE. Swing the camera off her heading and her face should
 *   follow it, up to a neck's limit. Measured as the angle between her head's
 *   own forward and her body's, against the camera offset that caused it.
 *
 *   PITCH, DIGGING ONLY. The same drag downward should tip her face in DIG
 *   and leave it alone in WALK. If walking pitches at all, she noses at the
 *   floor every time you glance down.
 *
 *   THE GASTER COUNTERS. Her abdomen swings against the head at about 30%,
 *   which is what keeps a turned face from reading as a broken neck.
 *
 * And the one that closes the loop this room was built for: in DIG mode the
 * angle between where her JAWS point and where the BITE lands should be zero.
 * It was the full aim angle before, because the gait held her head up while
 * the bite obeyed the camera.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4450/Thronemound-Colony-Sim/?scene=block';
const DEG = 180 / Math.PI;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.drive && window.blockScene.ready, null, { timeout: 60000 });
await page.waitForTimeout(2000);

const out = await page.evaluate(() => {
  const lab = window.blockScene;
  const DEG = 180 / Math.PI;
  const V = Object.getPrototypeOf(lab.at).constructor;

  /**
   * Which way her FACE points, taken from geometry rather than from a bone
   * axis: the vector from the head joint to the tip of her mouthparts.
   *
   * The first version of this probe assumed the head bone's local +Z was its
   * forward and read 159.5 degrees off her body at a zero camera. Auto-rig
   * bone axes mean nothing; two points on the model mean exactly what they
   * look like.
   */
  const headFrame = () => {
    const rig = lab.queen.rig;
    const head = lab.queen.bones.get(rig.thorax[rig.thorax.length - 1]);
    const pos = new V();
    head.getWorldPosition(pos);
    const jaw = new V();
    lab.queen.jawPosition(jaw);
    return { pos, fwd: jaw.clone().sub(pos).normalize() };
  };

  /**
   * How far her gaster has swung, in her frame — from the root of the abdomen
   * to its tip, which is geometry and not a bone axis. Measured the lazy way
   * first (a local-Y component off the quaternion) it read 4.2 degrees where
   * 18 was intended, for exactly the reason the head did: local Y is not her
   * up on this rig either.
   */
  const gasterRest = { yaw: null };
  const gasterYaw = () => {
    const rig = lab.queen.rig;
    const a = new V();
    const b = new V();
    lab.queen.bones.get(rig.gaster[0]).getWorldPosition(a);
    lab.queen.bones.get(rig.gaster[rig.gaster.length - 1]).getWorldPosition(b);
    const dir = b.sub(a).normalize();
    const right = new V().crossVectors(lab.up, lab.forward).normalize();
    const flat = dir.addScaledVector(lab.up, -dir.dot(lab.up));
    const yaw = Math.atan2(flat.dot(right), flat.dot(lab.forward)) * DEG;
    if (gasterRest.yaw === null) gasterRest.yaw = yaw;
    // Unwrap: a swing the other way came out as 342 rather than -18.
    let d = yaw - gasterRest.yaw;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
  };

  /** Set the look, settle a frame, and report the head. */
  const look = (yawDeg, pitchDeg, modeIndex) => {
    lab.setMode(modeIndex);
    lab.follow.yawOffset = (yawDeg * Math.PI) / 180;
    lab.aimPitch = (pitchDeg * Math.PI) / 180;
    lab.stepForTest(1 / 60, 4);
    const { fwd } = headFrame();
    // Head yaw and pitch measured in HER frame.
    const right = new V().crossVectors(lab.up, lab.forward).normalize();
    const flat = fwd.clone().addScaledVector(lab.up, -fwd.dot(lab.up));
    const headYaw = Math.atan2(flat.dot(right), flat.dot(lab.forward)) * DEG;
    const headPitch = Math.asin(Math.max(-1, Math.min(1, fwd.dot(lab.up)))) * DEG;
    return {
      headYaw: +headYaw.toFixed(1),
      headPitch: +headPitch.toFixed(1),
      gaster: +gasterYaw().toFixed(1),
    };
  };

  const yawRows = [];
  for (const y of [0, 15, 30, 45, 60, 90]) {
    yawRows.push({ camYaw: y, walk: look(y, 0, 0), dig: look(y, 0, 1) });
  }
  const pitchRows = [];
  for (const p of [0, -15, -30, -45, -60]) {
    pitchRows.push({ camPitch: p, walk: look(0, p, 0), dig: look(0, p, 1) });
  }

  /*
   * And the loop-closer: in DIG mode, the angle between where her JAWS point
   * and the direction the bite is taken along.
   */
  const jawVsBite = [];
  for (const p of [0, -20, -45, -70]) {
    look(0, p, 1);
    const { fwd } = headFrame();
    const aim = lab.aimPitch;
    const bite = lab.forward.clone().multiplyScalar(Math.cos(aim))
      .addScaledVector(lab.up, Math.sin(aim)).normalize();
    jawVsBite.push({
      camPitch: p,
      offDeg: +(Math.acos(Math.max(-1, Math.min(1, fwd.dot(bite)))) * DEG).toFixed(1),
    });
  }
  lab.setMode(0);
  lab.follow.yawOffset = 0;
  lab.aimPitch = 0;
  return { yawRows, pitchRows, jawVsBite };
});

console.log(JSON.stringify({ errors: errors.slice(0, 3) }));
console.log('\nYAW — she should turn her face in EVERY mode, gaster against it');
console.log('  camera off    WALK head   gaster      DIG head   gaster');
for (const r of out.yawRows) {
  console.log(
    `  ${String(r.camYaw).padStart(8)}째`,
    `${r.walk.headYaw.toFixed(1).padStart(11)}째`, `${r.walk.gaster.toFixed(1).padStart(8)}째`,
    `${r.dig.headYaw.toFixed(1).padStart(13)}째`, `${r.dig.gaster.toFixed(1).padStart(8)}째`,
  );
}
console.log('\nPITCH — DIG only. WALK must stay put whatever the camera does');
console.log('  camera pitch    WALK head pitch    DIG head pitch');
for (const r of out.pitchRows) {
  console.log(
    `  ${String(r.camPitch).padStart(10)}째`,
    `${r.walk.headPitch.toFixed(1).padStart(16)}째`,
    `${r.dig.headPitch.toFixed(1).padStart(17)}째`,
  );
}
console.log('\nJAWS vs BITE in DIG mode — the angle that used to be the whole aim');
for (const r of out.jawVsBite) {
  console.log(`  aim ${String(r.camPitch).padStart(4)}째   jaws are ${r.offDeg.toFixed(1)}째 off the bite`);
}
await browser.close();
