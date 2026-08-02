/**
 * How far does the TOP JOINT of each leg actually move, per second?
 *
 * Asked for directly, and it is the right question: the coxa is the joint the
 * whole leg hangs off, so a wiggle you can see from outside has to show up
 * here. Everything below it is the IK chasing a foot target and will move
 * whatever the coxa does.
 *
 * It reports two different things per leg, because they have different causes
 * and only one of them is the gait's fault:
 *
 *   GAIT     how far the coxa turns because `gaitPose` wrote a rotation into
 *            it -- measured off the pose the animation lays down, before the
 *            foot solver has run.
 *   FINAL    how far it turns after `solveFeet` has had its say. In the block
 *            room the feet are pinned to world anchors, so this is mostly the
 *            IK reacting to the BODY moving underneath them.
 *
 * If FINAL is large while GAIT is near zero, the legs are not animating -- the
 * body is moving and the legs are holding still, which looks identical from
 * the outside and needs the opposite fix.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4420/Thronemound-Colony-Sim/?scene=block';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.drive, null, { timeout: 45000 });
await page.waitForTimeout(1500);

const out = await page.evaluate(() => {
  const lab = window.blockScene;
  const q = lab.queen;
  const rig = q.rig;
  const DEG = 180 / Math.PI;

  const start = { at: lab.at.clone(), up: lab.up.clone(), forward: lab.forward.clone() };
  const reset = () => {
    lab.at.copy(start.at); lab.up.copy(start.up); lab.forward.copy(start.forward);
    lab.gripping = true;
    lab.drive.plantAll({ at: lab.at, up: lab.up, forward: lab.forward }, lab.groundForLegs);
    lab.input.walk = 0; lab.input.yaw = 0;
    lab.stepForTest(1 / 60, 120);
  };

  /** Angle between two quaternions, in degrees. */
  const between = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(
    a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w,
  ))) * DEG;

  const run = (walk, yaw, secs) => {
    reset();
    lab.input.walk = walk; lab.input.yaw = yaw;
    const legs = rig.legs.map((l) => ({ slot: l.slot, bone: l.bones[0] }));
    const acc = {};
    for (const l of legs) acc[l.slot] = { gait: 0, final: 0, speed: 0 };
    let prevGait = {};
    let prevFinal = {};
    const frames = Math.round(secs * 60);
    for (let i = 0; i < frames; i += 1) {
      lab.stepForTest(1 / 60, 1);
      for (const l of legs) {
        const bone = q.bones.get(l.bone);
        const base = q.poseBase.get(l.bone);
        if (!bone) continue;
        if (prevFinal[l.slot]) {
          acc[l.slot].final += between(prevFinal[l.slot], bone.quaternion);
          if (base && prevGait[l.slot]) acc[l.slot].gait += between(prevGait[l.slot], base);
        }
        prevFinal[l.slot] = bone.quaternion.clone();
        if (base) prevGait[l.slot] = base.clone();
      }
      acc[legs[0].slot].speed = Math.max(acc[legs[0].slot].speed, lab.walkSpeed);
    }
    lab.input.walk = 0; lab.input.yaw = 0;
    return {
      speedMm: +(acc[legs[0].slot].speed * 5).toFixed(3),
      rows: legs.map((l) => ({
        slot: l.slot,
        gait: +(acc[l.slot].gait / secs).toFixed(3),
        final: +(acc[l.slot].final / secs).toFixed(3),
      })),
    };
  };

  return { idle: run(0, 0, 3), walk: run(1, 0, 3), turn: run(0, 1, 3) };
});

console.log(JSON.stringify({ errors: errors.slice(0, 3) }));
for (const [tag, r] of Object.entries(out)) {
  console.log(`\n${tag}  (peak body speed ${r.speedMm} mm/s) - degrees of coxa rotation PER SECOND`);
  console.log('  leg            from the gait      after the foot solver');
  for (const row of r.rows) {
    console.log('  ', row.slot.padEnd(12), `${row.gait.toFixed(3).padStart(12)}`, `${row.final.toFixed(3).padStart(23)}`);
  }
}
await browser.close();
