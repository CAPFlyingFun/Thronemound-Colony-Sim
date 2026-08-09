/**
 * WHICH NUMBER IS SHAKING?
 *
 * The first-person lens is the sum of a chain — her seat, her surface
 * normal, the gait's body lift, the ground guard's rigid correction, the
 * head bone, then the eye filter — and "it shakes" does not say which link.
 * This walks her and reports the per-frame SECOND DIFFERENCE of each link
 * separately: a value that moves smoothly has one near zero, a value that
 * reverses every frame has one the size of the reversal, twice.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/shot-shake-fp.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 90000 });
await page.waitForFunction(
  () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 90000 },
);
await page.waitForTimeout(1500);

const run = (label, walk) => page.evaluate(({ w }) => {
  const s = window.islandScene;
  const MM = 5;
  s.firstPerson = true;
  s.input.walk = w; s.input.yaw = 0; s.input.strafe = 0;
  s.stepForTest(1 / 60, 30);

  const head = () => {
    const name = s.queen.rig.thorax[s.queen.rig.thorax.length - 1];
    const b = s.queen.bones.get(name);
    if (!b) return 0;
    b.updateWorldMatrix(true, false);
    return b.matrixWorld.elements[13];
  };

  const series = {
    seatY: [], upY: [], rootY: [], guard: [], headY: [], camY: [], camPitch: [],
  };
  for (let i = 0; i < 200; i += 1) {
    s.stepForTest(1 / 60, 1);
    series.seatY.push(s.at.y);
    series.upY.push(s.up.y);
    series.rootY.push(s.queen.root.position.y);
    series.guard.push(s.guardLift);
    series.headY.push(head());
    series.camY.push(s.camera.position.y);
    const e = s.camera.matrixWorld.elements;
    series.camPitch.push(Math.asin(Math.max(-1, Math.min(1, -e[9]))));
  }
  s.input.walk = 0;
  s.firstPerson = false;

  /* Mean |second difference| — smooth motion is near zero, a value that
   * reverses each frame reports the reversal twice. */
  const jitter = (a) => {
    let sum = 0;
    for (let i = 2; i < a.length; i += 1) {
      sum += Math.abs((a[i] - a[i - 1]) - (a[i - 1] - a[i - 2]));
    }
    return sum / Math.max(1, a.length - 2);
  };
  return {
    seatMm: jitter(series.seatY) * MM,
    upY: jitter(series.upY),
    rootMm: jitter(series.rootY) * MM,
    guardMm: jitter(series.guard) * MM,
    guardMaxMm: Math.max(...series.guard) * MM,
    guardOnFrames: series.guard.filter((g) => g > 0).length,
    headMm: jitter(series.headY) * MM,
    camMm: jitter(series.camY) * MM,
    camPitchDeg: jitter(series.camPitch) * 180 / Math.PI,
  };
}, { w: walk });

for (const [label, walk] of [['standing still', 0], ['walking', 1]]) {
  const r = await run(label, walk);
  console.log(`\n${label.toUpperCase()} — mean |second difference| per frame`);
  console.log(`  her seat        ${r.seatMm.toFixed(4)} mm`);
  console.log(`  her up.y        ${r.upY.toFixed(5)}`);
  console.log(`  model root      ${r.rootMm.toFixed(4)} mm`);
  console.log(`  ground guard    ${r.guardMm.toFixed(4)} mm  (max ${r.guardMaxMm.toFixed(3)} mm, `
    + `fired on ${r.guardOnFrames}/200 frames)`);
  console.log(`  head bone       ${r.headMm.toFixed(4)} mm`);
  console.log(`  CAMERA          ${r.camMm.toFixed(4)} mm, pitch ${r.camPitchDeg.toFixed(4)}°`);
}
console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
