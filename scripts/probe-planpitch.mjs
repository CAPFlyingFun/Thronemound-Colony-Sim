/**
 * Two reports off one screenshot: a piece asking for -30 degrees went the
 * other way, and her head is stuck hard over.
 *
 * Both are measured here rather than read off the picture, because "which way
 * is she pointing" in a photograph of an ant at an angle is exactly the kind
 * of judgement that has been wrong before in this scene.
 *
 *   PITCH   run the piece from the screenshot, -30 / 0 / 0 / 10 mm, and watch
 *           the grade her nose actually holds and whether she ends up higher
 *           or lower than she started. A sign error shows up in both.
 *   HEAD    orbit the camera past what her neck can do and see whether the
 *           head comes back. The neck clamps at 60 degrees; the question is
 *           what happens to the 61st and whether anything ever returns it.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL
  ?? 'http://localhost:4561/Thronemound-Colony-Sim/?scene=block';
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const fresh = async () => {
  const page = await b.newPage({ viewport: { width: 932, height: 430 } });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
  await page.evaluate(() => window.blockScene.setPausedForTest(true));
  await page.waitForTimeout(400);
  return page;
};

const pitchCase = async (pitch) => {
  const page = await fresh();
  const row = await page.evaluate((deg) => {
    const lab = window.blockScene;
    const MM = 5;
    lab.setPausedForTest(true);
    lab.stepForTest(1 / 60, 120);
    lab.setMode(1);
    const y0 = lab.at.y * MM;
    lab.planPieces = [{ pitch: deg, turn: 0, roll: 0, length: 10 }];
    lab.startPlan();
    const grades = [];
    for (let i = 0; i < 60 * 40 && lab.plan; i += 1) {
      lab.stepForTest(1 / 60, 1);
      grades.push(lab.gradeDeg());
    }
    const mid = grades.slice(Math.floor(grades.length * 0.3), Math.floor(grades.length * 0.9));
    const mean = mid.reduce((a, x) => a + x, 0) / Math.max(1, mid.length);
    return {
      asked: deg,
      flew: +mean.toFixed(1),
      sankMm: +(y0 - lab.at.y * MM).toFixed(2),
      frames: grades.length,
      finished: lab.plan === null,
    };
  }, pitch);
  await page.close();
  return row;
};

const headCase = async () => {
  const page = await fresh();
  const row = await page.evaluate(() => {
    const lab = window.blockScene;
    const DEG = 180 / Math.PI;
    const V = Object.getPrototypeOf(lab.at).constructor;
    lab.setPausedForTest(true);
    lab.stepForTest(1 / 60, 120);
    /**
     * Where her FACE actually points, against her body — the thing that looks
     * stuck. Measured off the model rather than off the number fed into it.
     */
    const faceYaw = () => {
      const head = new V();
      const jaw = new V();
      if (!lab.queen.headJointPosition(head) || !lab.queen.jawPosition(jaw)) return null;
      const d = jaw.sub(head).normalize();
      const right = new V().crossVectors(lab.up, lab.forward).normalize();
      const flatF = lab.forward.clone();
      return +(Math.atan2(d.dot(right), d.dot(flatF)) * DEG).toFixed(1);
    };
    const rows = [];
    for (const orbitDeg of [0, 30, 60, 90, 150, 220, 300, 359]) {
      lab.follow.yawOffset = (orbitDeg * Math.PI) / 180;
      lab.stepForTest(1 / 60, 45);
      rows.push({ orbitDeg, lookYawDeg: +(lab.follow.lookYaw * DEG).toFixed(1), face: faceYaw() });
    }
    // And back to straight ahead: does it RETURN?
    lab.follow.yawOffset = 0;
    lab.stepForTest(1 / 60, 60);
    return { rows, backHome: faceYaw() };
  });
  await page.close();
  return row;
};

const out = {
  down: await pitchCase(-30),
  up: await pitchCase(30),
  head: await headCase(),
};
console.log(JSON.stringify({ ...out, errs }, null, 2));
console.log('');
for (const k of ['down', 'up']) {
  const r = out[k];
  console.log(`asked ${String(r.asked).padStart(3)}°  flew ${String(r.flew).padStart(6)}°  `
    + `sank ${String(r.sankMm).padStart(6)} mm  ${r.finished ? 'finished' : 'RAN OUT'} `
    + `in ${(r.frames / 60).toFixed(1)} s`);
}
console.log('');
console.log('orbit   lookYaw   her face (vs her own body)');
for (const r of out.head.rows) {
  console.log(`${String(r.orbitDeg).padStart(4)}° ${String(r.lookYawDeg).padStart(9)}° `
    + `${String(r.face).padStart(10)}°`);
}
console.log(`back to 0: face ${out.head.backHome}°`);

// Down must fly down and end lower; up must fly up. And the face must come home.
const signOk = out.down.flew < -10 && out.up.flew > 10 && out.down.sankMm > 0;
const headOk = Math.abs(out.head.backHome) < 12
  && Math.abs(out.head.rows[out.head.rows.length - 1].face) < 65;
console.log(signOk ? 'PITCH_SIGN_OK' : 'PITCH_SIGN_WRONG');
console.log(headOk ? 'HEAD_FREE' : 'HEAD_STUCK');
await b.close();
