/**
 * THE CAMERA, ACROSS THE SEAM THAT BROKE IT.
 *
 * Reported: stepping from the hill onto the trunk (and back) left the third-
 * person camera stuck under the ant, and the only way onto the tree was to
 * switch to first person. This walks that exact transition in third person
 * and watches the lens: how far off her it sits, whether it is ever inside
 * something, and whether it ever ends up BELOW her in her own frame — which
 * is what "stuck under the ant" measures as.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/shot-chase.mjs
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
await page.waitForFunction(() => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 90000 });
await page.waitForFunction(() => window.islandScene.tree?.solid != null, null, { timeout: 60000 });
await page.waitForTimeout(1200);

const r = await page.evaluate(async () => {
  const s = window.islandScene, MM = 5;
  const sleep = (ms) => new Promise((k) => setTimeout(k, ms));
  const p = s.tree.root.position;
  s.setFacingForTest(Math.atan2(p.x - s.at.x, p.z - s.at.z));
  s.input.walk = 1; s.input.sprint = true;
  const track = [];
  for (let i = 0; i < 50; i += 1) {
    await sleep(320);
    const c = s.camera.position;
    const off = { x: c.x - s.at.x, y: c.y - s.at.y, z: c.z - s.at.z };
    /* How far the lens sits along HER up: negative means it is under her. */
    const alongUp = off.x * s.up.x + off.y * s.up.y + off.z * s.up.z;
    track.push({
      dist: +(Math.hypot(off.x, off.y, off.z) * MM).toFixed(1),
      alongUp: +(alongUp * MM).toFixed(1),
      inSolid: s.soilSolidAt(c.x, c.y, c.z),
      upY: +s.up.y.toFixed(2),
      onTree: s.tree.solid.densityAt(s.at.x, s.at.y, s.at.z) > -2,
    });
  }
  s.input.walk = 0; s.input.sprint = false;
  return {
    track,
    minDist: Math.min(...track.map((t) => t.dist)),
    meanDist: track.reduce((a, t) => a + t.dist, 0) / track.length,
    underHer: track.filter((t) => t.alongUp < 0).length,
    inSolid: track.filter((t) => t.inSolid).length,
    gotOnTree: track.filter((t) => t.upY < 0.5).length,
  };
});
console.log('\nWALKING FROM THE HILL ONTO THE TRUNK, IN THIRD PERSON');
console.log(`  lens distance from her: mean ${r.meanDist.toFixed(0)} mm, closest ${r.minDist.toFixed(0)} mm`);
console.log(`  frames with the lens UNDER her: ${r.underHer}/50   <- the reported bug`);
console.log(`  frames with the lens inside something: ${r.inSolid}/50`);
console.log(`  frames she spent on a near-vertical surface: ${r.gotOnTree}/50`);

await page.evaluate(() => { window.islandScene.aimPitchForTest(0.35); });
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/chase-tree.png', timeout: 90000 });
console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
