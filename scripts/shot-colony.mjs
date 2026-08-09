/**
 * DO THE COLONISTS ACTUALLY WALK?
 *
 * The worker they replace was a jig — a fixed circle at a fixed speed, with
 * its height read off the heightfield — so "she moves" was never the
 * question. What matters now is whether her LEGS are carrying her: that she
 * travels, that she turns toward somewhere rather than orbiting, that she
 * stays near where she hatched, and that her feet are on the island rather
 * than in it.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/shot-colony.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 90000 });
await page.waitForFunction(
  () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 90000 },
);
await page.waitForTimeout(2000);

/* They hatch off a quest. Call it directly — this is about the walk, not
 * about how she earns them. */
await page.evaluate(() => window.islandScene.spawnWorker());
await page.waitForFunction(
  () => window.islandScene.colony.every((c) => c.ready), null, { timeout: 60000 },
);

const r = await page.evaluate(() => {
  const s = window.islandScene;
  const MM = 5;
  const track = s.colony.map(() => ({
    path: 0, from: null, maxRoam: 0, headings: [], footLowMm: Infinity, still: 0,
  }));
  const prev = s.colony.map((c) => ({ x: c.at.x, y: c.at.y, z: c.at.z }));
  s.colony.forEach((c, i) => { track[i].from = { x: c.at.x, z: c.at.z }; });

  for (let step = 0; step < 60 * 25; step += 1) {
    s.stepForTest(1 / 60, 1);
    s.colony.forEach((c, i) => {
      const t = track[i];
      const d = Math.hypot(c.at.x - prev[i].x, c.at.z - prev[i].z);
      t.path += d;
      if (d * MM < 1e-4) t.still += 1;
      prev[i] = { x: c.at.x, y: c.at.y, z: c.at.z };
      t.maxRoam = Math.max(t.maxRoam, Math.hypot(
        c.at.x - s.workerAnchor.x, c.at.z - s.workerAnchor.z,
      ));
      if (step % 60 === 0) t.headings.push(Math.atan2(c.fwd.x, c.fwd.z));
      /* Lowest claw against the island under it — the seating check. */
      for (const leg of c.model.rig?.legs ?? []) {
        const name = c.model.limbTip.get(leg.slot) ?? leg.bones[leg.bones.length - 1];
        const bone = c.model.bones.get(name);
        if (!bone) continue;
        bone.updateWorldMatrix(true, false);
        const e = bone.matrixWorld.elements;
        const air = (e[13] - s.walkGroundAt(e[12], e[14])) * MM;
        if (air < t.footLowMm) t.footLowMm = air;
      }
    });
  }

  return s.colony.map((c, i) => {
    const t = track[i];
    /* How much of the circle her heading covered — a jig sweeps the lot
     * smoothly, a walker turns toward things and holds. */
    const spread = new Set(t.headings.map((h) => Math.round(h / (Math.PI / 4)))).size;
    return {
      caste: c.caste,
      pathMm: +(t.path * MM).toFixed(0),
      netMm: +(Math.hypot(c.at.x - t.from.x, c.at.z - t.from.z) * MM).toFixed(0),
      maxRoamMm: +(t.maxRoam * MM).toFixed(0),
      headingBuckets: spread,
      stillFrames: t.still,
      lowestFootMm: +t.footLowMm.toFixed(2),
    };
  });
});

console.log('\nTHE COLONY, 25 seconds of simulated walking');
for (const c of r) {
  console.log(`  ${c.caste.padEnd(6)} walked ${String(c.pathMm).padStart(5)} mm `
    + `(net ${String(c.netMm).padStart(4)} mm), stayed within ${c.maxRoamMm} mm of home`);
  console.log(`         ${c.headingBuckets}/8 heading octants used, `
    + `${c.stillFrames} frames stood still, lowest claw ${c.lowestFootMm} mm above the island`);
}
console.log(`\npage errors: ${errs.length ? errs.slice(0, 4).join(' | ') : 'none'}`);
await browser.close();
