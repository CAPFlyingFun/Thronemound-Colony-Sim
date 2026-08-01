/**
 * How far can a leg actually reach?
 *
 * The vertical search band for a foot — how far above and below its normal
 * height it may hunt for something to grab, which is what carries her over
 * an edge — should come from her anatomy rather than from a guess. So this
 * measures, per leg, on the loaded model at its real scale:
 *
 *   rest      hip joint to foot tip, in the pose she stands in
 *   stretched the sum of every bone in the chain: the most she could ever
 *             reach if the leg were pulled straight
 *   spare     what stretching buys over standing — the honest budget for
 *             reaching down over a lip, since reaching UP is bounded the
 *             same way by folding the leg instead.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4351/Thronemound-Colony-Sim/?scene=block';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.ready === true, null, { timeout: 90000 });
await page.waitForTimeout(1500);

const out = await page.evaluate(() => {
  const lab = window.blockScene;
  const queen = lab.queen;
  const V = lab.at.constructor;
  const rig = queen.rig;
  const bones = queen.bones;
  /*
   * THE FOOT IS `limbTip`, NOT THE LAST BONE IN THE CHAIN.
   *
   * Every leg on this rig ends in two auto-rig terminals carrying no
   * geometry, and on the queen they point back UP, about a millimetre above
   * the foot they trail — QueenModel says so in the comment beside
   * `limbTip`, and it says it because planting one of those markers is the
   * old "feet up in the air" bug. Measuring hip-to-LAST-BONE is measuring
   * to a marker floating above her claw, which is what the first version of
   * this probe did. The model already publishes the honest answer:
   * `legPlan()` gives the neutral foot position and the hip-to-foot reach,
   * both taken to the tip that actually has geometry on it.
   */
  const plan = queen.legPlan();
  const rows = [];
  for (const leg of rig.legs) {
    const entry = plan.find((p) => p.slot === leg.slot);
    if (!entry) continue;
    const chain = leg.bones.map((n) => bones.get(n)).filter(Boolean);
    const world = chain.map((b) => b.getWorldPosition(new V()));
    // Stretched: every bone up to and including the one that IS the foot.
    const tipName = queen.limbTipName ? queen.limbTipName(leg.slot) : null;
    const cut = tipName ? leg.bones.indexOf(tipName) : leg.bones.length - 3;
    const last = cut >= 1 ? cut : leg.bones.length - 3;
    let stretched = 0;
    for (let i = 1; i <= last && i < world.length; i += 1) {
      stretched += world[i].distanceTo(world[i - 1]);
    }
    rows.push({
      slot: leg.slot,
      segments: last + 1,
      restMm: +(entry.reach * 5).toFixed(2),
      stretchedMm: +(stretched * 5).toFixed(2),
    });
  }
  return { rows };
});

const w = (s, n) => String(s).padEnd(n);
console.log(w('leg', 12), w('bones', 6), w('rest', 8), w('stretched', 11), 'spare');
for (const r of out.rows) {
  console.log(
    w(r.slot, 12), w(r.segments, 6), w(`${r.restMm} mm`, 8),
    w(`${r.stretchedMm} mm`, 11), `${(r.stretchedMm - r.restMm).toFixed(2)} mm`,
  );
}
await browser.close();
