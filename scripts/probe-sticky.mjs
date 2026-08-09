/**
 * STICKY FEET, AND NOT KNOWING WHAT TO DO — the two halves of the report.
 *
 * "Sticky" is a foot that stays put while she is trying to move, which in
 * this drive means the clip refused the twist: `allowed` near zero. "Doesn't
 * know what to do" is the corner scheduler changing its mind — arming and
 * giving up, or rewinding its own queue.
 *
 * So this counts both, in two places: at the trunk, where a transition is
 * SUPPOSED to happen, and out on open soil a long way from any wood, where
 * one is supposed to be impossible. A scheduler that arms on a bump in the
 * ground would look exactly like an ant dithering at the tree line.
 *
 *   SMOKE_URL=http://127.0.0.1:4176/ node scripts/probe-sticky.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 90000 });
await page.waitForFunction(
  () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 90000 },
);
await page.waitForFunction(() => window.islandScene.tree?.solid != null, null, { timeout: 60000 });
await page.waitForTimeout(1200);

/** Walk `frames` and report what the drive and the scheduler did. */
const march = (frames, sprint) => page.evaluate(([n, run]) => {
  const s = window.islandScene;
  s.input.walk = 1; s.input.sprint = run;
  let stuck = 0;
  let arms = 0;
  let aborts = 0;
  let settles = 0;
  let rewinds = 0;
  let armed = 0;
  let was = 'normal';
  let wasRow = -1;
  const ROWS = { acquireFront: 0, transferMiddle: 1, transferRear: 2 };
  let moved = 0;
  let longestStill = 0;
  let still = 0;
  for (let f = 0; f < n; f += 1) {
    s.stepForTest(1 / 60, 1);
    const r = s.driveReport;
    if (!r) continue;
    const c = r.corner;
    if (r.allowed < 0.05) { stuck += 1; still += 1; longestStill = Math.max(longestStill, still); }
    else still = 0;
    moved += r.movedMm;
    if (was === 'normal' && c.phase !== 'normal') arms += 1;
    if (was !== 'normal' && was !== 'settle' && c.phase === 'normal') aborts += 1;
    if (c.phase === 'settle') settles += 1;
    if (c.phase !== 'normal') {
      armed += 1;
      const row = ROWS[c.phase];
      if (row !== undefined && wasRow >= 0 && row < wasRow) rewinds += 1;
      if (row !== undefined) wasRow = row;
    } else wasRow = -1;
    was = c.phase;
  }
  s.input.walk = 0; s.input.sprint = false;
  return {
    frames: n,
    armedFrames: armed,
    arms,
    abortsWithoutFinishing: aborts,
    settles,
    queueRewinds: rewinds,
    clippedFrames: stuck,
    longestClippedRun: longestStill,
    mmPerSecond: +(moved / (n / 60)).toFixed(2),
  };
}, [frames, sprint]);

/** Park her `gapMm` clear of the bark, facing it. */
const atTree = (gapMm) => page.evaluate((gap) => {
  const s = window.islandScene;
  const t = s.tree.root.position;
  const dx = s.at.x - t.x;
  const dz = s.at.z - t.z;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len;
  const uz = dz / len;
  let bark = -1;
  for (let r = 0; r < 240; r += 0.02) {
    if (!s.tree.solid.solidAt(t.x + ux * r, s.at.y, t.z + uz * r)) { bark = r; break; }
  }
  if (bark < 0) throw new Error('no bark');
  const stand = (bark * 5 + gap) / 5;
  s.teleportMm((t.x + ux * stand) * 5, (t.z + uz * stand) * 5);
  s.setFacingForTest(Math.atan2(t.x - s.at.x, t.z - s.at.z));
  s.input.walk = 0; s.stepForTest(1 / 60, 40);
}, gapMm);

/** Put her on open soil, well away from the landmark, on a given heading. */
const onOpenGround = (bearing) => page.evaluate((deg) => {
  const s = window.islandScene;
  const t = s.tree.root.position;
  const a = (deg * Math.PI) / 180;
  /* Four hundred millimetres from the trunk's axis is a long way outside a
   * 650 mm bark radius... so go the OTHER way: 1600 mm out, which is well
   * clear of the wood and still on the hill. */
  const away = 1600 / 5;
  s.teleportMm((t.x + Math.sin(a) * away) * 5, (t.z + Math.cos(a) * away) * 5);
  s.setFacingForTest(a + Math.PI / 2);
  s.input.walk = 0; s.stepForTest(1 / 60, 40);
  const dx = s.at.x - t.x;
  const dz = s.at.z - t.z;
  return { fromAxisMm: +(Math.hypot(dx, dz) * 5).toFixed(0) };
}, bearing);

const show = (tag, r) => {
  console.log(`  ${tag}`);
  console.log(`    armed ${r.arms}x over ${r.armedFrames}/${r.frames} frames · `
    + `settled ${r.settles} · gave up ${r.abortsWithoutFinishing} · queue rewound ${r.queueRewinds}x`);
  console.log(`    clipped (allowed<0.05) on ${r.clippedFrames}/${r.frames} frames, `
    + `longest run ${r.longestClippedRun} · travelled ${r.mmPerSecond} mm/s`);
};

console.log('\nAT THE TRUNK — a transition is supposed to happen here');
await atTree(13);
show('walk, 600 frames', await march(600, false));

console.log('\nON OPEN SOIL — no wood within reach; nothing should ever arm');
for (const bearing of [0, 90, 180, 270]) {
  const where = await onOpenGround(bearing);
  show(`bearing ${bearing}deg, ${where.fromAxisMm} mm from the trunk axis`,
    await march(360, false));
}

console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
