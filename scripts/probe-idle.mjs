/**
 * Standing still, how much does she actually move?
 *
 * The report was that the idle read as the walking gait at half speed, which
 * it was: cadence had a floor, so the walk cycle never stopped, and the legs
 * kept a twelfth of their swing to prove they were alive.
 *
 * This measures the thing a player sees — the WORLD POSITION of the bones,
 * after the IK has had its say — with the stick untouched. Per leg, the
 * peak-to-peak travel of the knee and of the foot. Per antenna, the same.
 * A resting ant should have quiet legs and busy antennae; the numbers say
 * which way round it is.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4398/Thronemound-Colony-Sim/?scene=block';

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
  const q = lab.queen;
  const rig = q.rig;

  const watch = [];
  rig.legs.forEach((leg) => {
    watch.push({ tag: `${leg.slot} coxa`, bone: leg.bones[0] });
    watch.push({ tag: `${leg.slot} foot`, bone: q.limbTip.get(leg.slot) ?? leg.bones[leg.bones.length - 1] });
  });
  watch.push({ tag: 'antennaLeft tip', bone: rig.antennaLeft[rig.antennaLeft.length - 1] });
  watch.push({ tag: 'antennaRight tip', bone: rig.antennaRight[rig.antennaRight.length - 1] });

  // Let her settle first: any leftover stroke resolves into one step, then
  // nothing should be driving her at all.
  lab.input.walk = 0;
  lab.input.yaw = 0;
  lab.stepForTest(1 / 60, 120);

  const box = {};
  for (const w of watch) box[w.tag] = { lo: [1e9, 1e9, 1e9], hi: [-1e9, -1e9, -1e9] };
  const v = new (Object.getPrototypeOf(lab.at).constructor)();
  const frames = 4 * 60;
  for (let i = 0; i < frames; i += 1) {
    lab.stepForTest(1 / 60, 1);
    for (const w of watch) {
      const bone = q.bones.get(w.bone);
      if (!bone) continue;
      bone.getWorldPosition(v);
      const p = [v.x, v.y, v.z];
      for (let k = 0; k < 3; k += 1) {
        box[w.tag].lo[k] = Math.min(box[w.tag].lo[k], p[k]);
        box[w.tag].hi[k] = Math.max(box[w.tag].hi[k], p[k]);
      }
    }
  }
  return watch.map((w) => ({
    tag: w.tag,
    travelMm: +(Math.hypot(
      box[w.tag].hi[0] - box[w.tag].lo[0],
      box[w.tag].hi[1] - box[w.tag].lo[1],
      box[w.tag].hi[2] - box[w.tag].lo[2],
    ) * 5).toFixed(4),
  }));
});

console.log(JSON.stringify({ errors: errors.slice(0, 3) }));
console.log('idle bone travel over 4 seconds, stick untouched:');
let legWorst = 0;
let antenna = 0;
for (const r of out) {
  console.log('  ', r.tag.padEnd(20), `${r.travelMm.toFixed(4).padStart(9)} mm`);
  if (r.tag.includes('antenna')) antenna = Math.max(antenna, r.travelMm);
  else legWorst = Math.max(legWorst, r.travelMm);
}
console.log(`\nworst leg bone ${legWorst.toFixed(4)} mm | busiest antenna ${antenna.toFixed(4)} mm`);
console.log(antenna > legWorst
  ? 'the antennae are the busiest thing on her, which is what a resting ant looks like'
  : 'HER LEGS STILL OUTMOVE HER ANTENNAE AT REST');
await browser.close();
