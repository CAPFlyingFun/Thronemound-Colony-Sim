/**
 * Regression probe: does she still walk all the way round the block?
 *
 * Holds walk = 1 for 14 s, stepping ONE frame at a time so planted-foot slip
 * can be measured frame to frame. Reports .up once a second, the exact frame
 * of each face transition, worst planted-foot slip, planted-leg counts, and
 * whether .gripping ever went false.
 *
 * Read-only: touches nothing but .input.
 */
import { chromium } from 'playwright';

const URL = 'http://localhost:4380/Thronemound-Colony-Sim/?scene=block';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.drive, null, { timeout: 90000 });
await page.waitForTimeout(800);

const out = await page.evaluate(() => {
  const lab = window.blockScene;
  const FPS = 60;
  const SECONDS = 14;
  const v3 = (v) => [v.x, v.y, v.z];

  const legCount = lab.drive.legs.length;
  const snapFeet = () => lab.drive.legs.map((l) => ({
    slot: l.slot,
    planted: !!l.planted,
    at: v3(l.at),
  }));

  const perSecond = [];
  const upTrace = [];          // per-frame up.y
  let worstSlip = { mm: -1, frame: -1, slot: null };
  let slipSamples = 0;      // how many planted->planted pairs we actually compared
  let slipNonZero = 0;      // how many of those moved at all
  let slipSum = 0;
  let swingMaxMm = 0;       // sanity: an UNPLANTED foot must move, else .at is stale
  let minPlanted = Infinity;
  let maxPlanted = -Infinity;
  let minPlantedFrame = -1;
  let plantedHist = {};
  let grippingFalseFrames = 0;
  let firstGripFalseFrame = -1;

  const start = {
    up: v3(lab.up),
    at: v3(lab.at),
    gripping: lab.gripping,
    planted: snapFeet().filter((f) => f.planted).length,
  };

  lab.input.walk = 1;
  lab.input.yaw = 0;
  lab.input.dig = false;

  let prev = snapFeet();

  for (let f = 0; f < SECONDS * FPS; f += 1) {
    lab.stepForTest(1 / 60, 1);
    const now = snapFeet();

    // planted-foot slip: same slot planted on both frames -> foot should not move
    for (let i = 0; i < legCount; i += 1) {
      const a = prev[i];
      const b = now[i];
      const dx = b.at[0] - a.at[0];
      const dy = b.at[1] - a.at[1];
      const dz = b.at[2] - a.at[2];
      const mm = Math.sqrt(dx * dx + dy * dy + dz * dz) * 5;
      if (a.planted && b.planted && a.slot === b.slot) {
        slipSamples += 1;
        slipSum += mm;
        if (mm > 1e-9) slipNonZero += 1;
        if (mm > worstSlip.mm) worstSlip = { mm, frame: f + 1, slot: b.slot };
      } else if (!b.planted) {
        if (mm > swingMaxMm) swingMaxMm = mm;
      }
    }

    const nPlanted = now.filter((x) => x.planted).length;
    if (nPlanted < minPlanted) { minPlanted = nPlanted; minPlantedFrame = f + 1; }
    if (nPlanted > maxPlanted) maxPlanted = nPlanted;
    plantedHist[nPlanted] = (plantedHist[nPlanted] ?? 0) + 1;

    if (lab.gripping === false) {
      grippingFalseFrames += 1;
      if (firstGripFalseFrame < 0) firstGripFalseFrame = f + 1;
    }

    upTrace.push(+lab.up.y.toFixed(4));

    if ((f + 1) % FPS === 0) {
      perSecond.push({
        s: (f + 1) / FPS,
        up: v3(lab.up).map((n) => +n.toFixed(3)),
        atMm: v3(lab.at).map((n) => +(n * 5).toFixed(1)),
        gripping: lab.gripping,
        planted: nPlanted,
        report: lab.report ? {
          movedMm: +(lab.report.movedMm ?? 0).toFixed(3),
          heldBackMm: +(lab.report.heldBackMm ?? 0).toFixed(3),
          clearanceMm: +(lab.report.clearanceMm ?? 0).toFixed(3),
          groping: lab.report.groping,
        } : null,
      });
    }

    prev = now;
  }

  lab.input.walk = 0;

  // exact transition frames from the per-frame up.y trace
  const leftTop = upTrace.findIndex((y) => y < 0.5);        // top -> side
  const onSide = upTrace.findIndex((y) => Math.abs(y) < 0.1);
  const onUnder = upTrace.findIndex((y) => y < -0.5);       // side -> underside
  const fullUnder = upTrace.findIndex((y) => y < -0.99);

  return {
    legCount,
    start,
    perSecond,
    worstSlip: { mm: +worstSlip.mm.toFixed(4), frame: worstSlip.frame, slot: worstSlip.slot },
    slipSamples,
    slipNonZero,
    slipMeanMm: slipSamples ? +(slipSum / slipSamples).toFixed(5) : null,
    swingMaxMm: +swingMaxMm.toFixed(3),
    minPlanted,
    minPlantedFrame,
    maxPlanted,
    plantedHist,
    grippingFalseFrames,
    firstGripFalseFrame,
    totalFrames: SECONDS * FPS,
    transitions: {
      leftTopFrame: leftTop, onSideFrame: onSide, onUnderFrame: onUnder, fullUnderFrame: fullUnder,
    },
    finalUp: v3(lab.up).map((n) => +n.toFixed(3)),
    ride: lab.ride,
  };
});

console.log(JSON.stringify({ pageErrors: errors.slice(0, 5) }));
console.log('legs', out.legCount, 'ride', out.ride);
console.log('start  up', JSON.stringify(out.start.up.map((n) => +n.toFixed(3))),
  'planted', out.start.planted, 'gripping', out.start.gripping);
for (const r of out.perSecond) {
  console.log(
    String(r.s).padStart(3) + 's',
    'up', JSON.stringify(r.up).padEnd(26),
    'atMm', JSON.stringify(r.atMm).padEnd(28),
    'planted', r.planted,
    'grip', r.gripping,
    r.report ? `moved ${r.report.movedMm}mm held ${r.report.heldBackMm}mm clr ${r.report.clearanceMm}mm grope ${r.report.groping}` : '',
  );
}
console.log('---');
console.log('worstSlip', JSON.stringify(out.worstSlip));
console.log('slipSamples', out.slipSamples, 'nonZero', out.slipNonZero, 'meanMm', out.slipMeanMm);
console.log('swingMaxMm (unplanted foot, sanity: must be > 0)', out.swingMaxMm);
console.log('plantedRange', out.minPlanted, '(frame', out.minPlantedFrame + ') -', out.maxPlanted);
console.log('plantedHist', JSON.stringify(out.plantedHist));
console.log('grippingFalseFrames', out.grippingFalseFrames, 'firstAt', out.firstGripFalseFrame, 'of', out.totalFrames);
console.log('transitions(frames)', JSON.stringify(out.transitions));
console.log('finalUp', JSON.stringify(out.finalUp));

await browser.close();
