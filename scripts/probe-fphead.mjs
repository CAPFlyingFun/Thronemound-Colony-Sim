/**
 * In FIRST PERSON, does the bone equal the camera?
 *
 * "Bone should = camera's pitch, not the other way around." The eye rides her
 * head, so if the neck stops at its anatomical forty degrees while the view
 * carries on to ninety, the head reads as welded down — which is what a full
 * downward deflection looked like.
 *
 * So: sweep the aim across its whole range in first person and report the
 * camera's pitch beside the bone's, measured from geometry (neck joint to jaw
 * tip) rather than from a bone axis. They should track. Then the same sweep in
 * third person, where the anatomical limit SHOULD still bite.
 */
import { chromium } from 'playwright';
const DEG = 180 / Math.PI;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(process.env.SMOKE_URL ?? 'http://localhost:4490/Thronemound-Colony-Sim/?scene=block', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await p.waitForTimeout(2000);
const out = await p.evaluate(() => {
  const lab = window.blockScene, DEG = 180 / Math.PI;
  const V = Object.getPrototypeOf(lab.at).constructor;
  const rig = lab.queen.rig;
  /*
   * The face direction itself, not its elevation. An elevation is an asin and
   * saturates at ninety degrees — her face already rests about 27 degrees
   * down, so a 90 degree look tips it past vertical and the number folds back
   * and reads as a clamp that is not there. The unsigned angle between two
   * directions has no such ceiling until 180.
   */
  const faceDir = () => {
    const h = new V(); lab.queen.bones.get(rig.thorax[0]).getWorldPosition(h);
    const j = new V(); lab.queen.jawPosition(j);
    return j.sub(h).normalize();
  };
  const sweep = (first) => {
    lab.setFirstPerson(first);
    lab.setMode(1);
    const rows = [];
    let base = null;
    for (const deg of [15, 5, 0, -20, -40, -60, -90]) {
      // Through the same clamp the player's drag goes through, so a limit
      // the probe cannot reach is a limit the player cannot reach either.
      if (first) {
        lab.aimPitch = 0;
        for (let i = 0; i < 400; i += 1) {
          const step = Math.sign(deg) * 0.005;
          if (Math.abs(lab.aimPitch) >= Math.abs((deg * Math.PI) / 180)) break;
          lab.setAimPitchForTest(lab.aimPitch + step);
        }
      }
      else lab.follow.orbit(0, lab.follow.lookPitch - (deg * Math.PI) / 180);
      lab.stepForTest(1 / 60, 8);
      const face = faceDir();
      if (base === null) base = face.clone();
      rows.push({
        cam: +(lab.follow.lookPitch * DEG).toFixed(1),
        bone: +(Math.acos(Math.max(-1, Math.min(1, face.dot(base)))) * DEG).toFixed(1),
      });
    }
    return rows;
  };
  return { first: sweep(true), third: sweep(false) };
});
console.log(JSON.stringify({ errors: errs.slice(0, 2) }));
for (const [tag, rows] of Object.entries(out)) {
  console.log(`\n${tag} person — camera pitch vs how far the BONE actually moved`);
  console.log('   camera      bone swung');
  for (const r of rows) {
    console.log(`  ${r.cam.toFixed(1).padStart(7)}° ${r.bone.toFixed(1).padStart(13)}°`);
  }
}
await b.close();
