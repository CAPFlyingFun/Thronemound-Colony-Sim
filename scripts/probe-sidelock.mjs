/**
 * The glue trap: hold forward, round the corner, and KEEP HOLDING.
 *
 * The report was "as soon as I get to the side of the dirt block, I get
 * locked, like I stepped into a glue trap", with the HUD reading six feet
 * planted, nothing reaching, nothing held back, and a stroke of -29%. So the
 * thing to measure is not whether she reaches the side — probe-block already
 * proves that — but whether she is still MOVING a second and five seconds
 * after she gets there, and whether the gait is still swapping tripods.
 *
 * A locked ant and a walking ant look identical in a still frame. They do
 * not look identical in a per-second distance travelled.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4393/Thronemound-Colony-Sim/?scene=block';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.drive, null, { timeout: 45000 });
await page.waitForTimeout(1500);

const out = await page.evaluate(() => {
  const lab = window.blockScene;
  const rows = [];
  lab.input.walk = 1;
  let prev = lab.at.clone();
  for (let s = 0; s < 18; s += 1) {
    let steps = 0;
    let planted = 6;
    let clipped = 0;
    let strainMax = -99;
    for (let i = 0; i < 60; i += 1) {
      lab.stepForTest(1 / 60, 1);
      const r = lab.report;
      if (!r) continue;
      if (r.planted < planted) steps += 1;
      planted = r.planted;
      if (r.allowed < 0.999) clipped += 1;
      strainMax = Math.max(strainMax, r.strain);
    }
    const now = lab.at.clone();
    rows.push({
      s: s + 1,
      mm: +(prev.distanceTo(now) * 5).toFixed(2),
      up: [lab.up.x, lab.up.y, lab.up.z].map((n) => +n.toFixed(2)),
      steps,
      clipped,
      strainMax: +strainMax.toFixed(2),
      grip: lab.gripping,
    });
    prev = now;
  }
  lab.input.walk = 0;
  return rows;
});

console.log(JSON.stringify({ errors: errors.slice(0, 3) }));
console.log(' s   travelled  face              steps clipped strokeMax');
for (const r of out) {
  const face = r.up[1] > 0.5 ? 'TOP' : (r.up[1] < -0.5 ? 'UNDERSIDE' : 'SIDE');
  console.log(
    String(r.s).padStart(2),
    `${r.mm.toFixed(2).padStart(7)} mm`,
    face.padEnd(10), JSON.stringify(r.up).padEnd(18),
    String(r.steps).padStart(4),
    String(r.clipped).padStart(6),
    r.strainMax.toFixed(2).padStart(8),
    r.grip ? '' : 'FALLING',
  );
}
const sides = out.filter((r) => Math.abs(r.up[1]) <= 0.5);
const stalled = sides.filter((r) => r.mm < 1);
console.log(`\non a side face for ${sides.length} s; stalled (<1 mm in a second) for ${stalled.length} s`);
await browser.close();
