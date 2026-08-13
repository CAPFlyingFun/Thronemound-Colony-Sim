/**
 * THE TREE, PHOTOGRAPHED AND COSTED.
 *
 * Twenty-six metres beside a nine-millimetre ant is a scale this engine has
 * never been asked for, so the questions are whether it draws, what it costs
 * a frame, and whether its foot stays buried as the ground under it resolves.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/shot-tree.mjs
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
await page.waitForFunction(() => window.islandScene.tree !== null, null, { timeout: 60000 });
await page.waitForTimeout(1500);

const t = await page.evaluate(() => {
  const s = window.islandScene, MM = 5;
  const tree = s.tree;
  const p = tree.root.position;
  return {
    bark: tree.bark,
    tris: tree.triangles,
    fromHerMm: Math.hypot(p.x - s.at.x, p.z - s.at.z) * MM,
    baseMm: p.y * MM,
    groundMm: s.walkGroundAt(p.x, p.z) * MM,
    topMm: (p.y + 5200) * MM,
    level: tree.root.getCurrentLevel(),
  };
});
console.log('\nTHE TREE');
console.log(`  bark ${t.bark}, triangles per level ${t.tris.join(' / ')}`);
console.log(`  ${t.fromHerMm.toFixed(0)} mm from her, base at ${t.baseMm.toFixed(0)} mm, `
  + `ground ${t.groundMm.toFixed(0)} mm -> buried ${(t.groundMm - t.baseMm).toFixed(0)} mm`);
console.log(`  crown at ${(t.topMm / 1000).toFixed(1)} m, showing detail level ${t.level}`);

// What does it cost? Same view, tree shown then hidden, off the scene's own
// frame counter — a delta of hand-timed frames measured the renderer's mood,
// not the tree.
const cost = await page.evaluate(async () => {
  const s = window.islandScene;
  const sleep = (ms) => new Promise((k) => setTimeout(k, ms));
  const p = s.tree.root.position;
  s.setFacingForTest(Math.atan2(p.x - s.at.x, p.z - s.at.z));
  s.aimPitchForTest(0.6);
  await sleep(3000);
  s.tree.root.visible = true;  await sleep(6000); const on = s.stats.fps;
  s.tree.root.visible = false; await sleep(6000); const off = s.stats.fps;
  s.tree.root.visible = true;
  return { on, off };
});
console.log(`\n  fps facing it: ${cost.on} with the tree, ${cost.off} without`);
console.log('  (software GL: a phone GPU will be far cheaper than this)');

await page.screenshot({ path: '/tmp/tree-ground.png', timeout: 90000 });
// Look up at it.
await page.evaluate(() => { window.islandScene.aimPitchForTest(1.2); });
await page.waitForTimeout(1200);
await page.screenshot({ path: '/tmp/tree-up.png', timeout: 90000 });
// And from a distance, to see the LOD swap.
await page.evaluate(() => { window.islandScene.camDistForTest?.(3000); });
await page.waitForTimeout(800);
console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
