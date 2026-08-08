/**
 * HOW MUCH DOES THE PICTURE SHAKE?
 *
 * Not "does the camera move" — it is supposed to follow her — but how much
 * of that movement is JITTER: reversals frame to frame that no amount of
 * following can explain. Measured on the thing the eye actually reads, the
 * look DIRECTION, because an arm's length of lever turns a millimetre of
 * wobble in her seat into a couple of degrees of view.
 *
 * The metric is the second difference of the aim: with a smooth pan it is
 * near zero, and with jitter it is the size of the jitter itself, twice.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/shot-shake.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 90000 });
await page.waitForFunction(
  () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 90000 },
);
await page.waitForFunction(() => window.islandScene.tree?.solid != null, null, { timeout: 60000 });
await page.waitForTimeout(1200);

const r = await page.evaluate(() => {
  const s = window.islandScene;
  const MM = 5;
  /* Simulated time, not wall clock: software GL renders at about one frame
   * a second here, and a filter with a 0.1 s time constant tested at 1 fps
   * measures nothing but the filter being skipped. */
  const run = (label, prep) => {
    prep();
    const aims = [];
    const seats = [];
    for (let i = 0; i < 240; i += 1) {
      s.stepForTest(1 / 60, 1);
      const d = new THREE_DIR(s.camera);
      aims.push(d);
      seats.push({ x: s.at.x, y: s.at.y, z: s.at.z });
    }
    /* Second difference of the aim direction, in degrees: how much the pan
     * REVERSES, which is what the eye reads as shake. */
    let sum = 0;
    let worst = 0;
    for (let i = 2; i < aims.length; i += 1) {
      const a = aims[i - 2];
      const b = aims[i - 1];
      const c = aims[i];
      const jx = (c.x - b.x) - (b.x - a.x);
      const jy = (c.y - b.y) - (b.y - a.y);
      const jz = (c.z - b.z) - (b.z - a.z);
      const deg = Math.hypot(jx, jy, jz) * (180 / Math.PI);
      sum += deg;
      if (deg > worst) worst = deg;
    }
    const n = aims.length - 2;
    /* Her own seat jitters too — that is the input the filter has to eat. */
    let seatSum = 0;
    for (let i = 2; i < seats.length; i += 1) {
      const a = seats[i - 2];
      const b = seats[i - 1];
      const c = seats[i];
      seatSum += Math.hypot(
        (c.x - b.x) - (b.x - a.x),
        (c.y - b.y) - (b.y - a.y),
        (c.z - b.z) - (b.z - a.z),
      ) * MM;
    }
    return {
      label, meanJitterDeg: sum / n, worstJitterDeg: worst, meanSeatJitterMm: seatSum / n,
    };
  };
  function THREE_DIR(cam) {
    const e = cam.matrixWorld.elements;
    return { x: -e[8], y: -e[9], z: -e[10] };
  }

  const p = s.tree.root.position;
  const out = [];
  out.push(run('standing still', () => { s.input.walk = 0; s.input.sprint = false; }));
  out.push(run('walking flat', () => {
    s.setFacingForTest(Math.atan2(p.x - s.at.x, p.z - s.at.z) + Math.PI);
    s.input.walk = 1;
  }));
  out.push(run('walking at the trunk', () => {
    s.setFacingForTest(Math.atan2(p.x - s.at.x, p.z - s.at.z));
    s.input.walk = 1; s.input.sprint = true;
  }));
  out.push(run('on the trunk', () => { s.input.walk = 1; s.input.sprint = true; }));
  s.input.walk = 0; s.input.sprint = false;
  return { out, upY: s.up.y, onWood: s.tree.solid.solidAt(s.at.x, s.at.y + 0.4, s.at.z) };
});

console.log('\nHOW MUCH THE PICTURE SHAKES (second difference of the aim, per frame)');
for (const row of r.out) {
  console.log(`  ${row.label.padEnd(22)} mean ${row.meanJitterDeg.toFixed(4)}°  `
    + `worst ${row.worstJitterDeg.toFixed(3)}°  (her seat jitters `
    + `${row.meanSeatJitterMm.toFixed(4)} mm)`);
}
console.log(`\n  her up at the end: ${r.upY.toFixed(2)} (1 = level, 0 = on a wall)`);
console.log(`page errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
