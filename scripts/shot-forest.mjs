/**
 * HOW MANY PLANTS, AND WHAT THEY COST.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/shot-forest.mjs
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
await page.waitForFunction(() => window.islandScene.stands.size > 0, null, { timeout: 90000 });
await page.waitForTimeout(2000);

const f = await page.evaluate(() => {
  const s = window.islandScene;
  const rows = [];
  let tris = 0;
  for (const [name, mesh] of s.stands) {
    const per = mesh.geometry.getAttribute('position').count / 3;
    rows.push({ name, count: mesh.count, per: Math.round(per) });
    tris += per * mesh.count;
  }
  return { rows, tris: Math.round(tris), draws: s.stands.size };
});
console.log('\nWHAT IS GROWING');
for (const r of f.rows) {
  console.log(`  ${r.name.padEnd(9)} ${String(r.count).padStart(5)} plants  `
    + `${String(r.per).padStart(4)} tris each  = ${(r.count * r.per).toLocaleString()}`);
}
console.log(`  ${'total'.padEnd(9)} ${f.tris.toLocaleString()} triangles in ${f.draws} draw calls`);

const cost = await page.evaluate(async () => {
  const s = window.islandScene;
  const sleep = (ms) => new Promise((k) => setTimeout(k, ms));
  const show = (on) => { for (const m of s.stands.values()) m.visible = on; };
  show(true); await sleep(6000); const on = s.stats.fps;
  show(false); await sleep(6000); const off = s.stats.fps;
  show(true);
  return { on, off };
});
console.log(`\n  fps with the forest ${cost.on}, without ${cost.off} (software GL)`);

await page.evaluate(() => { window.islandScene.aimPitchForTest(0.2); });
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/forest-ground.png', timeout: 90000 });
console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
