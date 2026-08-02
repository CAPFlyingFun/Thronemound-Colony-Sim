/**
 * Does a level camera now leave her head at the agreed resting posture, and
 * does the bone still track the camera one-for-one from there?
 *
 * The contract: BONE = rest + camera, with rest at -43.26. So camera 0 must
 * read -43.26, and every step of camera after that must move the bone by the
 * same step. A posture that got folded into the look clamp instead would show
 * up as the bottom of the range arriving early.
 */
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(process.env.SMOKE_URL ?? 'http://localhost:4495/Thronemound-Colony-Sim/?scene=block', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await p.waitForTimeout(2000);
const out = await p.evaluate(() => {
  const lab = window.blockScene, DEG = 180 / Math.PI;
  const V = Object.getPrototypeOf(lab.at).constructor;
  const rig = lab.queen.rig;
  const bone = () => {
    const h = new V(); lab.queen.headJointPosition(h);
    const j = new V(); lab.queen.jawPosition(j);
    const d = j.sub(h).normalize();
    /*
     * atan2 in her forward/up plane, not asin. An asin is capped at +-90, and
     * her face goes past vertical the moment a steep look is added to a rest
     * that is already 43 degrees down — where it folds back and reads as the
     * head coming UP again. That fold is what made this probe report the
     * posture working when it was being applied twice.
     */
    return +(Math.atan2(d.dot(lab.up), d.dot(lab.forward)) * DEG).toFixed(2);
  };
  lab.setFirstPerson(true);
  lab.setMode(1);
  const rows = [];
  for (const deg of [60, 30, 15, 0, -45, -90]) {
    lab.setAimPitchForTest((deg * Math.PI) / 180);
    lab.stepForTest(1 / 60, 12);
    rows.push({
      asked: deg,
      view: +(lab.follow.lookPitch * DEG).toFixed(1),
      bone: bone(),
    });
  }
  return rows;
});
console.log(JSON.stringify({ errors: errs.slice(0, 2) }));
console.log('  player      view       BONE     bone - player (must be a constant -43.26)');
for (const r of out) {
  console.log(
    `  ${String(r.asked).padStart(6)}° ${r.view.toFixed(1).padStart(9)}° ${r.bone.toFixed(2).padStart(10)}°`,
    `${(r.bone - r.asked).toFixed(2).padStart(15)}°`,
  );
}
await b.close();
