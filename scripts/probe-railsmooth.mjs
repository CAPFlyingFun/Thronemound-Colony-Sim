/**
 * How wide does the track's smoothing window have to be?
 *
 * Not guessable, and two guesses in a row made things worse. Her sleepers go
 * down every 0.4 mm while her body swings about four degrees a FRAME, so the
 * recorded path is noise at short range and a real tunnel at long range. The
 * window is the line between those two readings of the same data, so sweep it
 * and look.
 */
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 932, height: 430 } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(process.env.SMOKE_URL, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await p.evaluate(() => window.blockScene.setPausedForTest(true));
await p.waitForTimeout(400);
const out = await p.evaluate(() => {
  const lab = window.blockScene, DEG = 180 / Math.PI;
  const V = Object.getPrototypeOf(lab.at).constructor;
  lab.setPausedForTest(true);
  lab.stepForTest(1 / 60, 120);
  lab.setMode(1);
  lab.setAimPitchForTest(-Math.PI / 2.4);
  let dug = 0;
  while (!lab.underground && dug < 400) {
    lab.input.dig = true; lab.input.walk = 1; lab.digCooldown = 0;
    lab.stepForTest(1 / 60, 3); dug += 1;
  }
  for (let i = 0; i < 700; i += 1) {
    lab.input.dig = true; lab.input.walk = 1; lab.digCooldown = 0;
    lab.stepForTest(1 / 60, 1);
  }
  lab.input.dig = false;
  const trackMm = +lab.rail.lengthMm.toFixed(1);
  // The SAME track, read at each window — so this is the window's doing and
  // nothing else's.
  const rows = [];
  for (const window of [1, 2, 4, 6, 9, 14, 20]) {
    let up = 0; let upPeak = 0; let look = 0; let lookPeak = 0; let n = 0;
    lab.railSmoothMm = window;
    lab.railS = trackMm - 5;
    lab.input.walk = -1;
    lab.stepForTest(1 / 60, 10);
    let lastUp = lab.up.clone();
    let lastLook = lab.camera.getWorldDirection(new V());
    for (let i = 0; i < 300; i += 1) {
      lab.stepForTest(1 / 60, 1);
      const a = Math.acos(Math.max(-1, Math.min(1, lab.up.dot(lastUp)))) * DEG;
      up += a; upPeak = Math.max(upPeak, a); lastUp = lab.up.clone();
      const dir = lab.camera.getWorldDirection(new V());
      const c = Math.acos(Math.max(-1, Math.min(1, dir.dot(lastLook)))) * DEG;
      look += c; lookPeak = Math.max(lookPeak, c); lastLook = dir.clone();
      n += 1;
    }
    lab.input.walk = 0;
    rows.push({ window, upPerFrame: +(up / n).toFixed(3), upWorst: +upPeak.toFixed(2),
      lookPerFrame: +(look / n).toFixed(3), lookWorst: +lookPeak.toFixed(2),
      onRails: lab.onRails });
  }
  return { trackMm, rows };
});
console.log(`track ${out.trackMm} mm\n`);
console.log('window   up/frame  up worst  look/frame  look worst  on rails');
for (const r of out.rows) {
  console.log(`${String(r.window).padStart(5)}mm ${String(r.upPerFrame).padStart(9)}° `
    + `${String(r.upWorst).padStart(9)}° ${String(r.lookPerFrame).padStart(11)}° `
    + `${String(r.lookWorst).padStart(11)}°  ${r.onRails}`);
}
console.log(errs.length ? `ERRORS ${errs.join('; ')}` : 'no errors');
await b.close();
