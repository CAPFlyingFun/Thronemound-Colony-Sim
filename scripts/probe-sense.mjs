/**
 * Does the underground view fade in by DEPTH, and reach full at 5 mm?
 *
 * Asked for as a ramp rather than a switch: nothing at the surface, full
 * wireframe five millimetres under. A switch would flip on the frame her head
 * crossed the soil line, which while digging is several times a second.
 *
 * So this walks the eye down through the soil and reports the shader's own
 * uniform at each depth, settled — 0 above ground, 1 at five millimetres, and
 * a smooth ramp in between with no step in it.
 */
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(process.env.SMOKE_URL ?? 'http://localhost:4540/Thronemound-Colony-Sim/?scene=block', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await p.waitForTimeout(2000);
const out = await p.evaluate(() => {
  const lab = window.blockScene, MM = 5;
  const V = Object.getPrototypeOf(lab.at).constructor;
  const rows = [];
  // Straight down through the top face, from above it to well under.
  const top = lab.at.clone();
  for (const mm of [2, 0, -1, -2, -3, -4, -5, -7, -10]) {
    const at = top.clone().addScaledVector(lab.up, mm / MM);
    // Park the camera there and let the ease settle.
    for (let i = 0; i < 120; i += 1) {
      lab.camera.position.copy(at);
      lab.stepForTest(1 / 60, 1);
      lab.camera.position.copy(at);
      lab.senseStepForTest(1 / 60);
    }
    rows.push({
      mm,
      depth: +(lab.buriedDepth(at) * MM).toFixed(2),
      sense: +lab.sense.uSense.value.toFixed(3),
    });
  }
  return rows;
});
console.log(JSON.stringify({ errors: errs.slice(0, 2) }));
console.log('  height vs surface   measured depth    sense');
for (const r of out) {
  console.log(`  ${String(r.mm).padStart(14)} mm ${r.depth.toFixed(2).padStart(13)} mm ${r.sense.toFixed(3).padStart(9)}`);
}
const monotone = out.every((r, i) => i === 0 || r.sense >= out[i - 1].sense - 1e-6);
console.log(`\n${monotone ? 'monotone: it only ever fades IN as she goes deeper' : 'NOT MONOTONE'}`);
await b.close();
