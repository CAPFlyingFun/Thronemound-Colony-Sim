/*
 * THE WORKER'S FEET, MEASURED — the founding's handover, walked and judged.
 *
 * The report, verbatim: "once going from queen to worker, the legs don't
 * hold to the ground and the legs feel stiff and a few are floating in the
 * air and sometimes the worker ant doesn't move." The cause was queen
 * millimetres fed to a worker's LegDrive — see the `scale` note in
 * `legDrive.ts` — and this probe is the number on the fix: it walks the
 * QUEEN first for a baseline, hands over to the worker the way the founding
 * does, walks HER, and compares the two on the three things the report
 * names.
 *
 *   - MOVES: distance covered over the same walk input. A worker that
 *     "sometimes doesn't move" shows up as a fraction of the queen's run.
 *   - HOLDS: planted feet, on average, out of six. Stiff floating legs are
 *     legs that never plant.
 *   - FLOATS: the worst planted-foot height above its own footing, in mm.
 *     A planted foot belongs ON the ground, caste regardless.
 *
 *   SMOKE_URL='http://localhost:18980/Thronemound-Colony-Sim/' \
 *     node scripts/probe-workerlegs.mjs
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/?scene=island';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready === true, null, { timeout: 200000 });
await page.waitForFunction(() => window.islandScene?.playerReady === true, null, { timeout: 200000 })
  .catch(() => { /* older builds: fall through, the walk below still answers */ });
await page.waitForTimeout(600);

/*
 * One walk, one verdict — run for whoever the player currently is. The
 * drive's fields are TS-private, which is a compile-time promise, not a
 * runtime wall; a probe reading them is the point of a probe.
 */
const walk = async () => page.evaluate(() => {
  const s = window.islandScene;
  const from = { x: s.at.x, z: s.at.z };
  let plantedSum = 0;
  let frames = 0;
  let worstFloat = 0;
  s.input.walk = 1;
  for (let i = 0; i < 260; i += 1) {
    s.stepForTest(0.023, 1);
    if (i < 40) continue; /* let the gait settle before judging it */
    frames += 1;
    for (const leg of s.drive.legs) {
      if (leg.planted && !leg.groping) {
        plantedSum += 1 / 6;
        const ground = s.footingFrom(leg.at.x, leg.at.z, leg.at.y);
        worstFloat = Math.max(worstFloat, (leg.at.y - ground) * 5);
      }
    }
  }
  s.input.walk = 0;
  const movedMm = Math.hypot(s.at.x - from.x, s.at.z - from.z) * 5;
  return {
    caste: s.playerCaste,
    movedMm: Number(movedMm.toFixed(2)),
    plantedOfSix: Number(((plantedSum / frames) * 6).toFixed(2)),
    worstPlantedFloatMm: Number(worstFloat.toFixed(3)),
  };
});

/*
 * THE FEET THE PLAYER SEES, not the feet the drive believes in.
 *
 * The drive's ledger said "planted" before AND after the founding bug —
 * because the bug lived a layer down, in the IK band `solveFeet` was given:
 * queen-sized, so a worker's skeleton was asked to hold feet on ground her
 * legs cannot deliver, and the MODEL's toes hung in the air while the
 * ledger read planted. So the verdict is measured at the skinned tip bone,
 * after a real render (matrixWorld is only honest after one), against the
 * ANCHOR the drive planted — which is on the surface by construction, and
 * which stays honest when she walks up the trunk, where "height above the
 * ground below" reads fifty of float on a foot pressed flat to the bark.
 */
const feet = async () => page.evaluate(() => {
  const s = window.islandScene;
  const out = [];
  for (const leg of s.drive.legs) {
    if (!leg.planted || leg.groping) continue;
    const tipName = s.queen.limbTipName(leg.slot);
    const tip = tipName ? s.queen.bones.get(tipName) : null;
    if (!tip) continue;
    const e = tip.matrixWorld.elements;
    const a = leg.anchor;
    const gap = Math.hypot(e[12] - a.x, e[13] - a.y, e[14] - a.z);
    out.push(Number((gap * 5).toFixed(3)));
  }
  return out.sort((a, b) => b - a);
});

const queen = await walk();
await page.waitForTimeout(200); /* a real frame, so matrixWorld is honest */
queen.tipFloatsMm = await feet();

/* The founding's handover, without the founding. */
await page.evaluate(() => window.islandScene.spawnWorker());
await page.waitForFunction(
  () => window.islandScene.playerCaste === 'fire-worker', null, { timeout: 200000 },
);
await page.waitForTimeout(300);
const worker = await walk();
await page.waitForTimeout(200);
worker.tipFloatsMm = await feet();

await page.screenshot({ path: '/tmp/worker-walk.png' });
await browser.close();

/*
 * The verdict. The worker is 4 mm to the queen's 9, so her honest travel is
 * whatever the pace system gives her — the bug was ZERO. She must cover
 * real ground, keep a working majority of feet planted, and no planted
 * foot may hover more than a whisker above its own footing.
 */
/*
 * The gates. Travel: the pace system holds a 4 mm animal to less ground
 * than a 9 mm one — right and proper — so the bar is "clearly walking",
 * not "keeping up with mother". Feet: the VISIBLE tips are the ones the
 * report was about; a worker's worst planted toe may stray no further from
 * its own anchor than the queen's worst does from hers, scaled the same
 * way she is (she is 4 mm to the queen's 9, so her honest wobble is
 * smaller too) — with a small absolute floor so the queen's good day does
 * not set an impossible bar.
 */
const worstTip = (r) => (r.tipFloatsMm?.[0] ?? Infinity);
const pass = worker.movedMm > 10
  && worker.plantedOfSix >= 3
  && worstTip(worker) < Math.max(worstTip(queen) * (4 / 9) * 1.5, 0.6)
  && errors.length === 0;

console.log(JSON.stringify({ queen, worker, errors, pass }, null, 2));
process.exit(pass ? 0 : 1);
