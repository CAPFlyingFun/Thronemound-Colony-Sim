/**
 * ONE BARK, ON THE TREE, FROM THE TRUNK.
 *
 * Judging a new bark by loading the island and hoping is hopeless: which bark
 * a tree wears is a hash of where it stands. `?bark=<name>` forces one, and
 * this walks her up the landmark so the texture is seen the way she sees it —
 * at a grazing angle with her face against it, which is the only view that
 * matters and the one a flat thumbnail never shows.
 *
 * Sim time, not wall time: the software renderer manages about a frame a
 * second, so `stepForTest` walks her the 700 mm instead of waiting.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/Thronemound-Colony-Sim/ \
 *   BARK=bark-ridged SHOT=/tmp/bark.png node scripts/shot-bark.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const bark = process.env.BARK ?? 'bark-ridged';
const shot = process.env.SHOT ?? `/tmp/${bark}.png`;
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?scene=island&bark=${bark}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 90000 });
await page.waitForFunction(() => window.islandScene.tree?.solid != null, null, { timeout: 90000 });
await page.waitForTimeout(2500);

const info = await page.evaluate(async () => {
  const s = window.islandScene;
  const sleep = (ms) => new Promise((k) => setTimeout(k, ms));
  const t = s.tree.root.position;
  s.setFacingForTest(Math.atan2(t.x - s.at.x, t.z - s.at.z));
  s.input.walk = 1; s.input.sprint = true;
  for (let i = 0; i < 30; i += 1) { s.stepForTest(0.016, 100); await sleep(16); }
  s.input.walk = 0; s.input.sprint = false;
  for (let i = 0; i < 5; i += 1) { s.stepForTest(0.016, 20); await sleep(16); }
  await sleep(600);
  const mesh = s.tree.root.children?.[0];
  const mat = mesh?.children?.[0]?.material ?? mesh?.material;
  return {
    distMm: +(Math.hypot(s.at.x - t.x, s.at.z - t.z) * 5).toFixed(1),
    upY: +s.up.y.toFixed(2),
    normalMap: !!mat?.normalMap,
    roughnessMap: !!mat?.roughnessMap,
    repeat: mat?.map ? [mat.map.repeat.x, mat.map.repeat.y] : null,
  };
});

console.log(`${bark}: ${JSON.stringify(info)}`);
await page.screenshot({ path: shot });
console.log(`shot -> ${shot}`);
console.log(`page errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
