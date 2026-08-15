/*
 * HOW BIG A HOLE DOES A WORM ACTUALLY LEAVE?
 *
 * Asked directly — "I am curious, how big of a hole would the worm create?
 * Might be enough that would be like automatic tunnel starters" — and it is
 * the question that decides whether worms are a good idea or a way of
 * turning the island into a sponge. So it is measured in the running game
 * rather than derived from the constants.
 *
 * WHAT IT MEASURES. It lets the worms dig for a while, then walks the
 * density field along a ray across a burrow and reports how wide the air
 * is. That is the number a player cares about: not what we asked the brush
 * for, but what the mesher will draw and what she can walk down.
 *
 * The comparison that matters is her own bore. A burrow she can pass is a
 * tunnel starter; one she cannot is scenery.
 *
 *   node scripts/probe-worms.mjs
 */
import { chromium } from 'playwright';

const MM = 5;
const SECONDS = 90;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/?scene=island', {
  waitUntil: 'domcontentloaded',
});
await page.waitForFunction(() => window.islandScene?.ready === true, null, { timeout: 200000 });
await page.waitForFunction(() => !document.querySelector('.tm-loading-root'), null, { timeout: 200000 });
await page.waitForTimeout(900);

const out = await page.evaluate(async (seconds) => {
  const s = window.islandScene;
  const MM = 5;
  const before = s.wormsForTest();
  if (before.length === 0) return { error: 'no worms on the island' };

  /* Dig. Stepped rather than waited on, so the measurement does not depend
   * on how fast this machine renders. */
  for (let i = 0; i < seconds * 60; i += 1) s.stepForTest(1 / 60, 1);
  const after = s.wormsForTest();

  /*
   * THE BURROW, MEASURED ACROSS. From a point a worm has passed through,
   * step outward along an axis until the field says soil. Twice, both
   * ways, and the width is the sum — that is the air a body has to fit in.
   */
  const widthAt = (p, ax, ay, az) => {
    const STEP = 0.02;
    const reach = 40 / MM;
    let out = 0;
    for (const sign of [1, -1]) {
      let d = 0;
      while (d < reach) {
        d += STEP;
        const q = {
          x: p.x + ax * d * sign, y: p.y + ay * d * sign, z: p.z + az * d * sign,
        };
        /* Positive density is INSIDE soil. There is no `.solid` on this
         * report — a first cut read one, got undefined, and every ray ran
         * to the limit and reported the burrow as infinitely wide. */
        if (s.lensQueryForTest(q.x, q.y, q.z).finalMm > 0) break;
      }
      out += d;
    }
    return out * MM;
  };

  /*
   * INSIDE THE TUBE, NOT AT THE HEAD. The head sits at the working face,
   * where the hole ends — measuring there measures the face. Two bores
   * back is soil the worm has definitely eaten and left behind.
   *
   * And measured ACROSS the burrow, not along it: an axis parallel to the
   * heading runs down the tunnel and reports its length. Two perpendicular
   * axes are built off the heading for that reason.
   */
  const widths = [];
  let outOfWindow = 0;
  for (const w of after) {
    /*
     * AT THE LAST BITE, which is the one point its burrow is certainly at.
     * A first cut sampled twelve millimetres behind the HEAD and read zero
     * every time — not because the burrow was narrow but because a worm
     * that has travelled 130 mm has dug its way out of the 192 mm window,
     * so the field there is the coarse heightfield, which has never heard
     * of the burrow. That is a real constraint, not a bad measurement, and
     * it is counted below rather than hidden.
     */
    const back = { x: w.bx, y: w.by, z: w.bz };
    if (s.lensQueryForTest(back.x, back.y, back.z).fine === 'unavailable') {
      outOfWindow += 1;
      continue;
    }
    /* Any two axes across the heading. */
    let ax = { x: w.dy, y: w.dz, z: w.dx };
    const dot = ax.x * w.dx + ax.y * w.dy + ax.z * w.dz;
    ax = { x: ax.x - w.dx * dot, y: ax.y - w.dy * dot, z: ax.z - w.dz * dot };
    const len = Math.hypot(ax.x, ax.y, ax.z) || 1;
    ax = { x: ax.x / len, y: ax.y / len, z: ax.z / len };
    const bx = {
      x: w.dy * ax.z - w.dz * ax.y,
      y: w.dz * ax.x - w.dx * ax.z,
      z: w.dx * ax.y - w.dy * ax.x,
    };
    widths.push(widthAt(back, ax.x, ax.y, ax.z));
    widths.push(widthAt(back, bx.x, bx.y, bx.z));
  }

  const travelled = after.map((w, i) => Math.hypot(
    w.x - before[i].x, w.y - before[i].y, w.z - before[i].z,
  ) * MM);
  const bites = after.map((w) => w.bites);

  return {
    worms: after.length,
    seconds,
    bites,
    travelledMm: travelled.map((v) => +v.toFixed(1)),
    widthsMm: widths.map((v) => +v.toFixed(2)),
    outOfWindow,
    /* And how deep they are, which says whether they stayed underground. */
    depthMm: after.map((w) => +((s.walkGroundAtForTest(w.x, w.z) - w.y) * MM).toFixed(1)),
  };
}, SECONDS);

await browser.close();

if (out.error) { console.log(out.error); process.exit(1); }

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
/* Only a ray that ran the whole way is meaningless; a small reading is a
 * narrow burrow and must not be filtered away as noise. */
const kept = out.widthsMm.filter((w) => w < 39);
console.log(`\nTHE BURROW A WORM LEAVES — ${out.worms} worms, ${out.seconds} s of digging\n`);
console.log(`  bites taken        ${out.bites.join(', ')}`);
console.log(`  head travelled     ${out.travelledMm.join(', ')} mm`);
console.log(`  depth below grade  ${out.depthMm.join(', ')} mm`);
console.log(`\n  burrow width, measured across the field:`);
console.log(`    samples          ${kept.length} of ${out.widthsMm.length}`
  + ` (${out.outOfWindow} worm(s) had dug out of the streamed window)`);
if (kept.length) {
  console.log(`    narrowest        ${Math.min(...kept).toFixed(2)} mm`);
  console.log(`    mean             ${mean(kept).toFixed(2)} mm`);
  console.log(`    widest           ${Math.max(...kept).toFixed(2)} mm`);
}
console.log(`\n  for comparison     her own bore is about 7 mm across`);
console.log(`                     her body is 1.6 mm half-height`);
if (errs.length) console.log('\npage errors:', errs.slice(0, 2).join(' | '));

if (!out.bites.some((b) => b > 0)) {
  console.log('\nFAILED: no worm took a single bite');
  process.exit(1);
}
console.log('\nall green — the worms dug, and the hole is measured');
