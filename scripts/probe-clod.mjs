/*
 * DOES A BITE THROW A CLOD, AND IS IT THE SIZE OF THE HOLE?
 *
 * The clod's whole job is to be the soil that just came out, so the thing to
 * check is not "is there a lump" but "does the lump track the volume". A clod
 * sized off the brush radius would be identical whether the bite hit packed
 * soil or clipped a tunnel she had already dug.
 *
 *   SMOKE_URL=http://localhost:4281/ node scripts/probe-clod.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://localhost:4281/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
page.on('pageerror', e => errs.push(e.message));
await page.goto(`${base}/?scene=block`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await page.evaluate(() => window.blockScene.setPausedForTest(true));
await page.waitForTimeout(300);

const out = await page.evaluate(() => {
  const lab = window.blockScene;
  lab.setPausedForTest(true);
  lab.stepForTest(1 / 60, 120);

  const seen = [];
  /*
   * Bite, and compare the clod against the volume the FIELD said it removed.
   *
   * The first version of this probe assumed repeated bites at one spot would
   * shrink as the hole deepened. They do not: she re-aims her mandible between
   * bites, so each one lands on fresh soil, and the sizes came back flat. That
   * measured her aim, not the clod.
   *
   * The invariant the clod actually claims is narrower and checkable: whatever
   * `subtractSphere` reported removing, the lump is that volume's sphere at
   * 72%. `lab.removed` accumulates, so its delta is this bite's volume.
   */
  const expected = (v) => Math.min(0.32, Math.max(0.08,
    Math.cbrt((v * 3) / (4 * Math.PI)) * 0.72));
  for (let i = 0; i < 8; i += 1) {
    const had = lab.clodsForTest().length;
    const before = lab.removed;
    lab.input.dig = true;
    lab.stepForTest(1 / 60, 1);
    lab.input.dig = false;
    const clods = lab.clodsForTest();
    const fresh = clods[clods.length - 1];
    const volume = lab.removed - before;
    if (clods.length > had && fresh) {
      seen.push({
        bite: i,
        volume: +volume.toFixed(5),
        radius: +fresh.radius.toFixed(5),
        want: +expected(volume).toFixed(5),
        mass: +fresh.mass.toFixed(4),
      });
    }
    lab.stepForTest(1 / 60, 20);
  }

  // Let them fall, and check none finish inside the soil.
  let buried = 0;
  const V = Object.getPrototypeOf(lab.at).constructor;
  for (let i = 0; i < 240; i += 1) {
    lab.stepForTest(1 / 60, 1);
    for (const c of lab.clodsForTest()) {
      if (lab.solidAt(new V(c.at.x, c.at.y, c.at.z))) buried += 1;
    }
  }
  const settled = lab.clodsForTest();
  return {
    seen,
    buried,
    alive: settled.length,
    resting: settled.filter(c => c.resting).length,
    removedTotal: +lab.removed.toFixed(4),
  };
});

console.log('\nA BITE AND ITS CLOD');
console.log('  bite   removed vol   clod r   wanted r');
for (const s of out.seen) {
  console.log(`   ${String(s.bite).padStart(2)}    ${String(s.volume).padStart(9)}   `
    + `${String(s.radius).padStart(6)}   ${String(s.want).padStart(6)}`);
}
const tracks = out.seen.length > 0
  && out.seen.every(s => Math.abs(s.radius - s.want) < 1e-4);
console.log(`\n  clods thrown           ${out.seen.length} of 8 bites`);
console.log(`  matches removed volume ${tracks}`);
console.log(`  frames ending buried   ${out.buried}`);
console.log(`  still alive / at rest  ${out.alive} / ${out.resting}`);

const pass = out.seen.length >= 2 && tracks && out.buried === 0 && out.resting > 0;
console.log(`\n  ${pass ? 'PASS' : 'FAIL'}\n`);
if (errs.length) console.log('  page errors:', errs.slice(0, 4));
await browser.close();
process.exit(pass && !errs.length ? 0 : 1);
