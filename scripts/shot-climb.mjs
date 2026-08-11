/**
 * CAN SHE CLIMB IT?
 *
 * The tree is unioned into the same field the walker reads, so collision and
 * climbing should both fall out of the code that already carries her up a
 * shaft wall. This walks her at the trunk and reports what her body does:
 * whether she stops at the bark, whether her up turns onto it, and whether
 * she gains height going up the side.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/shot-climb.mjs
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
/* `Q='&support=0' node scripts/shot-climb.mjs` — extra query, so the same
 * climb runs against a switch and its control on one build. */
await page.goto(`${base}/?scene=island${process.env.Q ?? ''}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 90000 });
await page.waitForFunction(() => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 90000 });
await page.waitForFunction(() => window.islandScene.tree?.solid != null, null, { timeout: 60000 });
await page.waitForTimeout(1200);

const r = await page.evaluate(async () => {
  const s = window.islandScene, MM = 5;
  const sleep = (ms) => new Promise((k) => setTimeout(k, ms));
  const p = s.tree.root.position;
  const start = { y: s.at.y, d: Math.hypot(s.at.x - p.x, s.at.z - p.z) };
  // Point her at the trunk and hold the stick down.
  s.setFacingForTest(Math.atan2(p.x - s.at.x, p.z - s.at.z));
  s.input.walk = 1; s.input.sprint = true;
  const track = [];
  for (let i = 0; i < 40; i += 1) {
    await sleep(400);
    track.push({
      y: +(s.at.y * MM).toFixed(1),
      d: +(Math.hypot(s.at.x - p.x, s.at.z - p.z) * MM).toFixed(1),
      upY: +s.up.y.toFixed(2),
      inWood: s.tree.solid.solidAt(s.at.x, s.at.y, s.at.z),
    });
  }
  s.input.walk = 0; s.input.sprint = false;
  return {
    startYMm: start.y * MM, startDMm: start.d * MM,
    track,
    inWoodFrames: track.filter((t) => t.inWood).length,
    firstInWood: track.findIndex((t) => t.inWood),
    lastInWood: track.map((t,i)=>t.inWood?i:-1).reduce((a,b)=>Math.max(a,b),-1),
    minD: Math.min(...track.map((t) => t.d)),
    climbedMm: Math.max(...track.map((t) => t.y)) - start.y * MM,
    leastUpY: Math.min(...track.map((t) => t.upY)),
  };
});
console.log(`\nSHE WALKS AT THE TRUNK (started ${r.startDMm.toFixed(0)} mm out, `
  + `${r.startYMm.toFixed(0)} mm up)`);
console.log(`  closest she got to the axis: ${r.minD.toFixed(0)} mm (the trunk is ~500 mm in radius)`);
console.log(`  samples INSIDE the wood: ${r.inWoodFrames}/40 (first ${r.firstInWood}, last ${r.lastInWood})`);
console.log(`  climbed: ${r.climbedMm.toFixed(0)} mm`);
console.log(`  her up tipped to a minimum of ${r.leastUpY.toFixed(2)} (1 = level, 0 = on a wall)`);
console.log('  last samples:', JSON.stringify(r.track.slice(-4)));

await page.evaluate(() => { window.islandScene.aimPitchForTest(0.5); });
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/tree-climb.png', timeout: 90000 });
console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
