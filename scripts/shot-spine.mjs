/**
 * IS THE PROXIMITY BIAS FIRING ON FLAT GROUND?
 *
 * `readSpine` feeds `posture()` a `headGap` of `max(0, -aheadRise)`. That is
 * a terrain DIFFERENCE, not a clearance, and `posture()` treats anything
 * under `SPINE_CLEARANCE` as "about to hit something" and adds the full
 * head limit. So the suspicion is: any uphill rise at all, however small,
 * makes the pseudo-gap exactly zero, which is maximally "close", which
 * slams the head target to its 30-degree clamp — and on rough ground the
 * sign flips frame to frame, which would be a nod at frame rate.
 *
 * This logs every input and both outputs so that can be proved or dropped.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/shot-spine.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
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
await page.waitForTimeout(1500);

const run = (walk, sprint) => page.evaluate(({ w, sp }) => {
  const s = window.islandScene;
  const MM = 5;
  const DEG = 180 / Math.PI;
  s.input.walk = w; s.input.sprint = sp; s.input.yaw = 0;
  s.stepForTest(1 / 60, 30);
  const rows = [];
  for (let i = 0; i < 240; i += 1) {
    s.stepForTest(1 / 60, 1);
    const r = s.spineRead;
    const t = s.spineWant;
    if (!r || !t) continue;
    rows.push({
      aheadMm: r.aheadRise * MM,
      behindMm: r.behindRise * MM,
      headClearMm: Number.isFinite(r.headClear) ? r.headClear * MM : 999,
      gasterClearMm: Number.isFinite(r.gasterClear) ? r.gasterClear * MM : 999,
      wantHead: t.head * DEG,
      poseHead: s.spine.pose.head * DEG,
    });
  }
  s.input.walk = 0; s.input.sprint = false;

  const jitter = (a) => {
    let sum = 0;
    for (let i = 2; i < a.length; i += 1) {
      sum += Math.abs((a[i] - a[i - 1]) - (a[i - 1] - a[i - 2]));
    }
    return sum / Math.max(1, a.length - 2);
  };
  const col = (k) => rows.map((r) => r[k]);
  /* How often the pseudo-gap is pinned at exactly zero — which is what
   * "maximally close to solid" means to `posture()`. */
  const pinned = rows.filter((r) => r.headClearMm <= 0.1).length;
  /* And how often the raw head target is sitting on its 30-degree clamp. */
  const clamped = rows.filter((r) => Math.abs(r.wantHead) > 29.5).length;
  return {
    n: rows.length,
    pinnedPct: (100 * pinned) / rows.length,
    clampedPct: (100 * clamped) / rows.length,
    aheadMm: { min: Math.min(...col('aheadMm')), max: Math.max(...col('aheadMm')) },
    headClear: { min: Math.min(...col('headClearMm')), max: Math.max(...col('headClearMm')) },
    gasterClear: {
      min: Math.min(...col('gasterClearMm')), max: Math.max(...col('gasterClearMm')),
    },
    wantHead: { min: Math.min(...col('wantHead')), max: Math.max(...col('wantHead')) },
    wantHeadJitterDeg: jitter(col('wantHead')),
    poseHeadJitterDeg: jitter(col('poseHead')),
    poseHead: { min: Math.min(...col('poseHead')), max: Math.max(...col('poseHead')) },
  };
}, { w: walk, sp: sprint });

for (const [label, walk, sprint] of [
  ['standing still', 0, false], ['walking', 1, false], ['running', 1, true],
]) {
  const r = await run(walk, sprint);
  console.log(`\n${label.toUpperCase()}  (${r.n} frames)`);
  console.log(`  ahead rise        ${r.aheadMm.min.toFixed(3)} .. ${r.aheadMm.max.toFixed(3)} mm`);
  console.log(`  head clearance    ${r.headClear.min.toFixed(2)} .. ${r.headClear.max.toFixed(2)} mm`
    + `   (999 = nothing within reach)`);
  console.log(`  gaster clearance  ${r.gasterClear.min.toFixed(2)} .. ${r.gasterClear.max.toFixed(2)} mm`);
  console.log(`  head at/inside the 0.1 mm shell on ${r.pinnedPct.toFixed(0)}% of frames`);
  console.log(`  raw head target on its 30 deg clamp on ${r.clampedPct.toFixed(0)}% of frames`);
  console.log(`  raw head target   ${r.wantHead.min.toFixed(1)} .. ${r.wantHead.max.toFixed(1)} deg`
    + `   jitter ${r.wantHeadJitterDeg.toFixed(2)} deg/frame`);
  console.log(`  FILTERED head     ${r.poseHead.min.toFixed(1)} .. ${r.poseHead.max.toFixed(1)} deg`
    + `   jitter ${r.poseHeadJitterDeg.toFixed(3)} deg/frame`);
}
console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
