/**
 * Where does the hole actually appear, relative to the jaw?
 *
 * Reported as 4-7 mm ahead of the mandible. The suspect is in plain sight:
 * the bite is placed at the first solid point along a ray cast up to 9 mm
 * from the jaw, and with the camera level that ray runs along her FORWARD,
 * which on a flat face is a tangent. A ray skimming parallel to the ground
 * does not meet it until a long way out, so the brush lands wherever the
 * surface first rises into it.
 *
 * So: for a range of aim pitches, report how far the cast travelled before it
 * placed the bite, and how far the resulting hole is from the jaw bone --
 * both along her forward (ahead) and along her up (below). Ahead should be
 * about a bite radius. It is the number the report says is 4-7 mm.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4440/Thronemound-Colony-Sim/?scene=block';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.drive && window.blockScene.ready, null, { timeout: 60000 });
await page.waitForTimeout(2000);

const out = await page.evaluate(() => {
  const lab = window.blockScene;
  const MM = 5;
  const jaw = new (Object.getPrototypeOf(lab.at).constructor)();
  if (!lab.queen.jawPosition(jaw)) return { error: 'no jaw bone' };

  // How high does the jaw ride over the soil directly beneath it?
  const under = lab.cast(
    jaw.clone().addScaledVector(lab.up, 3 / MM), lab.up.clone().negate(), 12 / MM,
  );
  const jawAboveMm = under ? jaw.clone().sub(under).dot(lab.up) * MM : null;

  /*
   * Does the head DIP when she digs? The gait pitches her thorax by
   * `digging * 0.42` for a jawless queen, and if that is worth the 1.1 mm
   * the jaw rides high, then a bite taken at the jaw reaches the soil on its
   * own and none of the ray casting is needed.
   */
  const jawHeight = (dig) => {
    lab.queen.update(1 / 60, {
      speed: 0, turn: 0, digging: dig, carrying: 0,
    });
    lab.queen.root.updateMatrixWorld(true);
    const j = new (Object.getPrototypeOf(lab.at).constructor)();
    lab.queen.jawPosition(j);
    const g = lab.cast(j.clone().addScaledVector(lab.up, 3 / MM), lab.up.clone().negate(), 12 / MM);
    return g ? +(j.clone().sub(g).dot(lab.up) * MM).toFixed(3) : null;
  };
  const restJaw = jawHeight(0);
  const digJaw = jawHeight(1);
  jawHeight(0);

  /*
   * Where the bite now lands, using the scene's own bite() and the pose it
   * actually draws. Dig once per aim, and measure the centroid of what was
   * removed against the jaw that took it.
   */
  const rows = [];
  for (const deg of [0, -10, -20, -35, -50, -70, -90]) {
    lab.aimPitch = (deg * Math.PI) / 180;
    lab.input.dig = true;
    lab.digCooldown = 0;
    const before = lab.removed;
    lab.stepForTest(1 / 60, 1);
    lab.input.dig = false;
    const j = new (Object.getPrototypeOf(lab.at).constructor)();
    lab.queen.jawPosition(j);
    const dir = lab.forward.clone().multiplyScalar(Math.cos(lab.aimPitch))
      .addScaledVector(lab.up, Math.sin(lab.aimPitch)).normalize();
    const at = j.clone().addScaledVector(dir, 1.75 / 2 / MM);
    const off = at.clone().sub(j);
    rows.push({
      deg,
      reachMm: +(off.length() * MM).toFixed(2),
      aheadMm: +(off.dot(lab.forward) * MM).toFixed(2),
      belowMm: +(-off.dot(lab.up) * MM).toFixed(2),
      dugMm3: +((lab.removed - before) * 125).toFixed(1),
      why: lab.lastBiteWhy,
    });
  }
  lab.aimPitch = 0;
  return { jawAboveMm: jawAboveMm === null ? null : +jawAboveMm.toFixed(3), restJaw, digJaw, rows };
});

console.log(JSON.stringify({ errors: errors.slice(0, 3) }));
if (out.error) { console.log(out.error); }
else {
  console.log(`jaw rides ${out.jawAboveMm} mm above the soil beneath it`);
  console.log(`  head at rest ${out.restJaw} mm | head dipped for a dig ${out.digJaw} mm\n`);
  console.log('  aim     bite reach     ahead of jaw    below jaw     removed');
  for (const r of out.rows) {
    if (r.reachMm === undefined) { console.log(`  ${String(r.deg).padStart(4)}deg   NOTHING IN REACH`); continue; }
    console.log(
      `  ${String(r.deg).padStart(4)}deg`,
      `${r.reachMm.toFixed(2).padStart(11)} mm`,
      `${r.aheadMm.toFixed(2).padStart(14)} mm`,
      `${r.belowMm.toFixed(2).padStart(12)} mm`,
      `${r.dugMm3.toFixed(1).padStart(9)} mm3`, r.why ? `  ${r.why}` : '',
    );
  }
}
await browser.close();
