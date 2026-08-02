/**
 * WHERE DOES THE SHAKE COME FROM?
 *
 * Reported as the camera being all over the place and the whole thing feeling
 * unstable to move around in. That is a symptom with at least four plausible
 * causes stacked on top of each other, so this measures each layer separately
 * and lets the numbers say which one is the problem:
 *
 *   NORMAL  the raw surface normal under her, straight out of the field. A
 *           finite-difference gradient on a voxel grid is noisy by nature.
 *   UP      her body's up, which eases toward that normal. If the easing is
 *           not doing its job the noise arrives at the body intact.
 *   SEAT    where `hold()` decides she should sit. A cast that flips between
 *           two surfaces jumps the whole body.
 *   CAMERA  what you actually see: how far the view direction swings and how
 *           far the eye jumps, per frame.
 *
 * Everything is per-frame, because per-frame is what reads as shake. A steady
 * turn of ninety degrees over two seconds is 0.75 degrees a frame and looks
 * fine; the same ninety degrees delivered in six frames is the complaint.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL
  ?? 'http://localhost:4543/Thronemound-Colony-Sim/?scene=block';
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];

const measure = async (label, setup) => {
  const page = await b.newPage({ viewport: { width: 932, height: 430 } });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
  await page.evaluate(() => window.blockScene.setPausedForTest(true));
  await page.waitForTimeout(400);
  const row = await page.evaluate((how) => {
    const lab = window.blockScene;
    const DEG = 180 / Math.PI;
    const V = Object.getPrototypeOf(lab.at).constructor;
    lab.setPausedForTest(true);
    lab.stepForTest(1 / 60, 120);

    if (how === 'walk') lab.input.walk = 1;
    if (how === 'dig') { lab.setMode(1); lab.input.walk = 1; lab.input.dig = true; }
    if (how === 'plan') {
      lab.setMode(1);
      lab.planPieces = [{ pitch: -20, turn: 30, roll: 0, length: 8 }];
      lab.startPlan();
    }

    const ang = (a, b2) => Math.acos(Math.max(-1, Math.min(1, a.dot(b2)))) * DEG;
    const stat = () => ({ sum: 0, peak: 0, n: 0 });
    const add = (s, v) => { s.sum += v; s.peak = Math.max(s.peak, v); s.n += 1; };
    const done = (s) => ({
      perFrame: +(s.sum / Math.max(1, s.n)).toFixed(3),
      worstFrame: +s.peak.toFixed(3),
    });

    const normal = stat();
    const up = stat();
    const seat = stat();
    const look = stat();
    const eye = stat();
    const fwd = stat();
    // How far the eye is from HER, in mm. Third person is tens; on her head is
    // about one. Flipping between them is a mode flap, not a wobble.
    const ranges = [];
    let flips = 0;
    let wasNear = null;
    const reasons = [];
    let lastWhy = null;

    let lastUp = lab.up.clone();
    let lastNormal = null;
    let lastAt = lab.at.clone();
    let lastForward = lab.forward.clone();
    let lastLook = lab.camera.getWorldDirection(new V());
    let lastEye = lab.camera.position.clone();

    for (let i = 0; i < 600; i += 1) {
      lab.stepForTest(1 / 60, 1);
      /*
       * The raw normal is read the same way `hold()` reads it — the field's
       * own gradient at the contact under her — so a difference between this
       * and her body's up is the easing doing work, not two different
       * questions being asked.
       */
      const n = new V();
      const hit = lab.castForTest(
        lab.at.clone().addScaledVector(lab.up, 0.05),
        lab.up.clone().negate(), 2.5,
      );
      if (hit) {
        lab.normalAt(hit, n);
        if (lastNormal) add(normal, ang(n, lastNormal));
        lastNormal = n.clone();
      }
      add(up, ang(lab.up, lastUp));
      lastUp = lab.up.clone();
      add(fwd, ang(lab.forward, lastForward));
      lastForward = lab.forward.clone();
      add(seat, lab.at.distanceTo(lastAt) * 5);
      lastAt = lab.at.clone();
      const dir = lab.camera.getWorldDirection(new V());
      add(look, ang(dir, lastLook));
      lastLook = dir.clone();
      const w = lab.follow.why;
      if (w) {
        if (lastWhy && w.onboard !== lastWhy.onboard) {
          reasons.push({ frame: i, to: w.onboard ? 'ONBOARD' : 'third',
            noRoom: w.noRoom, submerged: w.submerged, mode: w.mode,
            clearMm: +(w.clear * 5).toFixed(2), minMm: +(w.minDistance * 5).toFixed(2) });
        }
        lastWhy = { onboard: w.onboard };
      }
      const range = lab.camera.position.distanceTo(lab.at) * 5;
      ranges.push(+range.toFixed(2));
      const near = range < 8;
      if (wasNear !== null && near !== wasNear) flips += 1;
      wasNear = near;
      add(eye, lab.camera.position.distanceTo(lastEye) * 5);
      lastEye = lab.camera.position.clone();
    }
    return {
      normalDeg: done(normal),
      upDeg: done(up),
      forwardDeg: done(fwd),
      seatMm: done(seat),
      lookDeg: done(look),
      eyeMm: done(eye),
      gripping: lab.gripping,
      rangeMinMm: Math.min(...ranges),
      rangeMaxMm: Math.max(...ranges),
      modeFlips: flips,
      reasons,
    };
  }, setup);
  await page.close();
  return { label, ...row };
};

const rows = [
  await measure('standing still', 'idle'),
  await measure('walking, top face', 'walk'),
  await measure('walking and digging', 'dig'),
  await measure('flying a plan', 'plan'),
];
console.log(JSON.stringify({ rows, errs }, null, 2));
console.log('');
console.log('                        normal/f    up/f    seat/f    LOOK/f    eye/f   (worst)');
for (const r of rows) {
  console.log(`${r.label.padEnd(22)} worst: up ${r.upDeg.worstFrame}° fwd ${r.forwardDeg.worstFrame}° look ${r.lookDeg.worstFrame}° seat ${r.seatMm.worstFrame}mm`);
  console.log(`${r.label.padEnd(22)} `
    + `${String(r.normalDeg.perFrame).padStart(7)}° `
    + `${String(r.upDeg.perFrame).padStart(7)}° `
    + `${String(r.seatMm.perFrame).padStart(7)}mm `
    + `${String(r.lookDeg.perFrame).padStart(7)}° `
    + `${String(r.eyeMm.perFrame).padStart(6)}mm  `
    + `look worst ${r.lookDeg.worstFrame}°`);
}
/*
 * A degree a frame is sixty a second and reads as a smooth pan. Three a frame
 * is a hundred and eighty a second, which is the complaint.
 */
const ok = rows.every((r) => r.lookDeg.perFrame < 1 && r.lookDeg.worstFrame < 6);
console.log(ok && errs.length === 0 ? 'STEADY' : 'SHAKY');
await b.close();
