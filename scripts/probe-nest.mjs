/*
 * DOES THE SOIL AGREE WITH THE PLAN?
 *
 * The carve is tested as arithmetic elsewhere. This asks the question that
 * arithmetic cannot answer: once the field has been sampled onto half-
 * millimetre cells and meshed, is the tunnel the plan describes still there,
 * still open, and still the width it claims?
 *
 * Everything it measures it reads off the scene — the plan from `nestForTest`,
 * the soil from `solidAtMm`. It keeps no second copy of where the nest is,
 * because measuring a dig against a second description of it is the bug this
 * whole module exists to make impossible.
 *
 *   SMOKE_URL=http://localhost:4231/ node scripts/probe-nest.mjs
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
page.on('console', m => { if (m.type() === 'warning') console.log('  page:', m.text()); });

const base = (process.env.SMOKE_URL ?? 'http://localhost:4231/').replace(/\/$/, '');
await page.goto(`${base}/?scene=block&shape=nest`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await page.evaluate(() => window.blockScene.setPausedForTest(true));

const audit = await page.evaluate(() => window.blockScene.auditNest());

console.log('\nTHE NEST, as carved');
console.log(`  centreline samples   ${audit.samples}`);
console.log(`  blocked (solid)      ${audit.blocked}`);
console.log(`  pinched (too narrow) ${audit.pinched}`);
if (audit.worstAtMm) {
  const w = audit.worstAtMm;
  console.log(`  first fault at       ${w.x.toFixed(1)}, ${w.y.toFixed(1)}, ${w.z.toFixed(1)} mm`);
}

/*
 * The mouth has to break the surface, and it has to break it WIDE. Measured,
 * she walks straight over a ten-millimetre hole — 2942 frames of 3000 spent on
 * top of it — so an entrance cut to the width of the shaft below it is a door
 * she never finds. Read the opening across the real soil, a shade below the
 * surface, rather than trusting the plan's number for it.
 */
const mouths = await page.evaluate(() => {
  const scene = window.blockScene;
  const plan = scene.nestForTest();
  return plan.nodes.filter(n => n.kind === 'entrance').map(node => {
    let open = 0;
    for (let d = -20; d <= 20; d += 0.25) {
      if (!scene.solidAtMm(node.x + d, node.y - 0.5, node.z)) open += 0.25;
    }
    // How far down it stays open, which is what makes it a shaft and not a dish.
    let depth = 0;
    while (depth < 64 && !scene.solidAtMm(node.x, node.y - depth, node.z)) depth += 0.5;
    return { id: node.id, radiusMm: node.radiusMm, open, depth };
  });
});

console.log('\nTHE WAY IN');
for (const m of mouths) {
  console.log(`  ${m.id}: r=${m.radiusMm} mm  opening ${m.open.toFixed(2)} mm  `
    + `clear to ${m.depth.toFixed(1)} mm down`);
}
console.log('  (she strides over a 10 mm hole — the opening has to beat it comfortably)');

const openEnough = mouths.length > 0 && mouths.every(m => m.open > 14 && m.depth > 12);
const verdict = audit.blocked === 0 && audit.pinched === 0 && openEnough;
console.log(`\n  ${verdict ? 'PASS' : 'FAIL'} — the soil ${verdict ? 'matches' : 'does not match'} the plan\n`);

await browser.close();
process.exit(verdict ? 0 : 1);
