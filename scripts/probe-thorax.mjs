/**
 * WHERE THE THORAX IS, per caste — the dig origin's anatomical anchor.
 *
 * Read-only. Its output is transcribed into `src/sim/density/casteDig.ts` as
 * DATA, because the dig origin must be a stable declared number rather than a
 * skinned-vertex sweep run every frame. This probe exists so that number can
 * be re-derived and checked rather than trusted.
 *
 *   npx vite --port 5177 &
 *   SMOKE_URL=http://127.0.0.1:5177/?scene=habitat node scripts/probe-thorax.mjs
 */
import { chromium } from 'playwright';
import { pressPlay } from './lib/pressPlay.mjs';

/*
 * THE BARE URL, because the default no-scene route is the game.
 *
 * This used to default to `?scene=habitat`. That route falls through to the
 * same branch, so it was not measuring a different program by accident — but
 * it was naming one, and a probe that names a route nobody plays is one
 * refactor away from measuring it. Standing rule (Joshua, 2026-08-21): no
 * scenes; all work and all measurement on the default URL.
 */
const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const ctx = await browser.newContext({
  viewport: { width: 932, height: 430 }, serviceWorkers: 'block',
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERR', e.message));
await page.goto(`${URL}${URL.includes('?') ? '&' : '?'}probe=${Date.now()}`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.habitatScene?.ready === true, null, { timeout: 200000 });
/* Through the front door, as a player must — `reveal()` is on the far side. */
await pressPlay(page);

const rows = await page.evaluate(async () => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const { QueenModel } = await import('/src/anim/QueenModel.ts');
  const MM = 5;                        // one world unit = one voxel = 5 mm
  const out = [];
  for (const caste of ['queen', 'worker', 'major']) {
    const m = new QueenModel(caste);
    if (!await m.load()) { out.push({ caste, error: 'load failed' }); continue; }
    m.root.updateMatrixWorld(true);

    /* THORAX CENTRE: the mean of the thorax chain's bone positions, which is
     * the middle of the segment rather than either of its ends. */
    const p = new THREE.Vector3();
    const centre = new THREE.Vector3();
    let n = 0;
    for (const name of m.rig.thorax) {
      const bone = m.root.getObjectByName(name);
      if (!bone) continue;
      bone.getWorldPosition(p);
      centre.add(p); n += 1;
    }
    if (n === 0) { out.push({ caste, error: 'no thorax bones' }); continue; }
    centre.multiplyScalar(1 / n);

    const jaw = new THREE.Vector3();
    const hasJaw = m.jawPosition(jaw);
    /* Her rig faces +z in its own frame, so a forward offset is a z delta. */
    out.push({
      caste,
      thoraxCentre_x: +(centre.x * MM).toFixed(3),
      thoraxCentre_y: +(centre.y * MM).toFixed(3),
      thoraxCentre_z: +(centre.z * MM).toFixed(3),
      thoraxBones: n,
      thoraxToJawMm: hasJaw ? +(centre.distanceTo(jaw) * MM).toFixed(2) : null,
      jawFwdOfCentreMm: hasJaw ? +((jaw.z - centre.z) * MM).toFixed(2) : null,
      jawAboveCentreMm: hasJaw ? +((jaw.y - centre.y) * MM).toFixed(2) : null,
    });
  }
  return out;
});
console.table(rows);

/* And what that leaves beyond her jaws for each caste's planned bore. */
const LENGTH_MM = { queen: 9, worker: 6, major: 7 };
console.log('\n  planned bore length is measured from the THORAX CENTRE:');
for (const r of rows) {
  if (r.error) { console.log(`  ${r.caste}: ${r.error}`); continue; }
  const beyond = LENGTH_MM[r.caste] - r.jawFwdOfCentreMm;
  console.log(`  ${r.caste.padEnd(7)} length ${LENGTH_MM[r.caste]} mm`
    + ` - jaw ${r.jawFwdOfCentreMm} mm forward = ${beyond.toFixed(2)} mm beyond her jaws`);
}
await browser.close();
