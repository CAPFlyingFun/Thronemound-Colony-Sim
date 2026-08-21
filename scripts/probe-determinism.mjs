/**
 * THE SAME SEED TWICE — does the Queen do the same thing?
 *
 * She did not, and for two separate reasons, both of which had gone unnoticed
 * because nothing had ever asked:
 *
 *   1. `reveal()` started the live loop, so between the PLAY click and a
 *      probe taking the clock the world ran however many frames the software
 *      renderer managed. Measured: 0.15 to 0.25 s of unaccounted simulation.
 *   2. `DigBrain`'s `rand` parameter defaults to `Math.random`, and the scene
 *      passed two arguments. The stroller was seeded. The brain that decides
 *      where the nest goes was not.
 *
 * The second was the big one, and it is why `probe:dig` reported excavation
 * depths of 8.6, 12.6, 24.2 and 45.8 mm on runs of "the same seed" — a spread
 * that was blamed on SwiftShader's timing and was nothing of the kind.
 *
 * This probe exists so neither can come back quietly. It compares two runs
 * frame for frame and reports the FIRST divergence, because the first one is
 * the cause and everything after it is weather.
 */
import { chromium } from 'playwright';
import { pressPlay } from './lib/pressPlay.mjs';

const PORT = process.env.PORT ?? '5177';
const FRAMES = Number(process.env.FRAMES ?? 1800);
const SAMPLE = 10;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

async function run(frames) {
  const ctx = await browser.newContext({
    viewport: { width: 932, height: 430 }, serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/?cb=${Date.now()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.habitatScene?.ready === true, null, { timeout: 240000 });
  /* The clock is taken BEFORE the door opens. See `reveal`. */
  await page.evaluate(() => window.habitatScene.setPausedForTest(true));
  await pressPlay(page);
  const out = await page.evaluate(({ frames: n, sample }) => {
    const lab = window.habitatScene;
    lab.setPausedForTest(true);
    lab.setDiggingForTest(true);
    const trace = [];
    for (let f = 0; f < n; f += 1) {
      lab.tick(1 / 60);
      if (f % sample) continue;
      const a = lab.ant.at;
      const d = lab.digReportForTest();
      const s = lab.digSiteForTest();
      trace.push([
        f,
        `${a.x.toFixed(6)},${a.y.toFixed(6)},${a.z.toFixed(6)}`,
        d.phase, d.arms, d.bites,
        s ? `${s.stand.x.toFixed(6)},${s.stand.z.toFixed(6)}` : 'null',
      ].join('|'));
    }
    return trace;
  }, { frames, sample: SAMPLE });
  await ctx.close();
  return out;
}

console.log(`  two runs, ${FRAMES} frames each, same seed`);
const a = await run(FRAMES);
const b = await run(FRAMES);
await browser.close();

let firstDiff = -1;
for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
  if (a[i] !== b[i]) { firstDiff = i; break; }
}

const ok = firstDiff < 0;
if (ok) {
  console.log(`  PASS  the same seed gives the same run — ${a.length} samples over ${FRAMES} frames identical`);
} else {
  console.log(`  FAIL  diverges at frame ${firstDiff * SAMPLE}`);
  console.log(`          A  ${a[firstDiff] ?? '(ended)'}`);
  console.log(`          B  ${b[firstDiff] ?? '(ended)'}`);
}
console.log(`\n  ${ok ? 1 : 0}/1 checks passed`);
process.exit(ok ? 0 : 1);
