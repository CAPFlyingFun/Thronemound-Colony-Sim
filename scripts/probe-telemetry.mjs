/**
 * THE FLIGHT RECORDER, END TO END.
 *
 * Walks her into the landmark tree on the real island with the real animation
 * loop, then prints exactly what the COPY button would put on the clipboard.
 * Proves the wiring — that the scene feeds the recorder, that it arms itself
 * on movement and stops on demand — and produces the first real ground->tree
 * timeline in one run.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/probe-telemetry.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const seconds = Number(process.env.SECONDS ?? 18);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 90000 });
await page.waitForFunction(
  () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 90000 },
);
await page.waitForFunction(() => window.islandScene.tree?.solid != null, null, { timeout: 60000 });
await page.waitForTimeout(1200);

const out = await page.evaluate(async (secs) => {
  const s = window.islandScene;
  const sleep = (ms) => new Promise((k) => setTimeout(k, ms));
  const p = s.tree.root.position;

  /* Point her at the trunk and hold the stick down — the same approach the
   * climb probe uses, so the two are comparable. */
  s.setFacingForTest(Math.atan2(p.x - s.at.x, p.z - s.at.z));
  s.input.walk = 1;
  await sleep(secs * 1000);
  s.input.walk = 0;

  /* Let her settle, then freeze the buffer the way the COPY button does. */
  await sleep(600);
  const report = s.telemetryReport();
  return {
    report,
    upY: s.up.y,
    inWood: s.tree.solid.solidAt(s.at.x, s.at.y, s.at.z),
  };
}, seconds);

console.log(out.report);
console.log(`\nfinal up.y=${out.upY.toFixed(3)} inWood=${out.inWood}`);
console.log(`page errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
