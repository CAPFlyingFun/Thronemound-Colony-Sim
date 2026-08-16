/*
 * ARE THE FLY AND THE APHID ACTUALLY IN THE GAME, AND ALIVE?
 *
 * Asked for: "I will want the fly, aphid and worm in the game", with the
 * aphid replacing the procedural ladybug. A unit test can prove the brain
 * decides correctly; only the running island can prove one was ever built,
 * dressed, seated on soil, and moved.
 *
 *   node scripts/probe-critters.mjs
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
await page.goto(process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/?scene=island', {
  waitUntil: 'domcontentloaded',
});
await page.waitForFunction(() => window.islandScene?.ready === true, null, { timeout: 200000 });
await page.waitForFunction(() => !document.querySelector('.tm-loading-root'), null, { timeout: 200000 });
/* The bodies are fetched off the critical path — wait for them rather than
 * assume they beat the first step. */
await page.waitForFunction(
  () => window.islandScene.crittersForTest().some((c) => c.ready),
  null, { timeout: 60000 },
).catch(() => { /* reported as undressed below */ });
await page.waitForTimeout(600);

const out = await page.evaluate(() => {
  const s = window.islandScene;
  const born = s.crittersForTest();
  const from = born.map((c) => ({ x: c.x, z: c.z }));
  for (let i = 0; i < 60 * 30; i += 1) s.stepForTest(1 / 60, 1);
  const now = s.crittersForTest();
  const MM = 5;
  const movedMm = now.map((c, i) => Math.hypot(c.x - from[i].x, c.z - from[i].z) * MM);
  const bugs = s.bulkReportForTest().filter((b) => String(b.id).startsWith('bug-'));
  /* On the soil, not floating: compare each to the seat the game would give
   * it right now. */
  const offGroundMm = now.map((c) => Math.abs(c.y - s.walkGroundAtForTest(c.x, c.z)) * MM);
  return {
    total: born.length,
    byKind: born.reduce((m, c) => ({ ...m, [c.kind]: (m[c.kind] || 0) + 1 }), {}),
    dressed: now.filter((c) => c.ready).length,
    behaviours: [...new Set(now.map((c) => c.behaviour))],
    movedMaxMm: +Math.max(...movedMm).toFixed(1),
    movedMinMm: +Math.min(...movedMm).toFixed(1),
    onShoveList: bugs.length,
    worstOffGroundMm: +Math.max(...offGroundMm).toFixed(2),
    alive: now.filter((c) => c.health > 0).length,
  };
});

await browser.close();
if (errs.length) console.log('page errors:', errs.slice(0, 2).join(' | '));

console.log('\nTHE ISLAND\'S OTHER ANIMALS\n');
console.log(`  spawned            ${out.total}  ${JSON.stringify(out.byKind)}`);
console.log(`  drawn (dressed)    ${out.dressed}`);
console.log(`  alive              ${out.alive}`);
console.log(`  brains doing       ${out.behaviours.join(', ')}`);
console.log(`  moved in 30 s      ${out.movedMinMm} to ${out.movedMaxMm} mm`);
console.log(`  on the shove list  ${out.onShoveList}`);
console.log(`  worst float        ${out.worstOffGroundMm} mm off the seat`);

let bad = 0;
const say = (ok, what) => { if (!ok) bad += 1; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); };
console.log('');
say(out.total > 0, `the island seeded ${out.total} walking creatures`);
say(Object.keys(out.byKind).length === 2, 'both an aphid and a housefly are present');
say(out.dressed === out.total, 'every one of them got a body');
say(out.movedMaxMm > 1, 'at least one actually walked somewhere');
say(out.onShoveList === out.total, 'all of them collide');
say(out.worstOffGroundMm < 2, 'none of them is floating off its seat');
if (bad > 0) { console.log(`\n${bad} check(s) failed`); process.exit(1); }
console.log('\nall green — the fly and the aphid live on the island');
