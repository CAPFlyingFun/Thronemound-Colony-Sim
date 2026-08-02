/**
 * Do the legs actually drive her?
 *
 * The last version of the tank reported `heldBack` 0.000 on every frame and
 * a displacement of exactly speed × dt — the constraint never bound, so the
 * feet were decoration and the body was being flown. This asks three things
 * that a decorative leg cannot fake:
 *
 * 1. STROKE. Each stance foot should sweep its circle and the tripod should
 *    swap when it runs out — so the stroke reading must actually reach 1
 *    and reset, over and over, and never run away past the leg's limit.
 * 2. WHEELS. Half throttle should take half as many steps over the same
 *    time, because steps are triggered by ground covered, not by a clock.
 * 3. TURNING IS NOT A MODE. On a spin in place, the left and right feet
 *    must travel in OPPOSITE world directions — that is `v + ω × r` with
 *    v = 0, and no branch anywhere computes it.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4390/Thronemound-Colony-Sim/?scene=block';

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

  /** Run for `secs` at a given stick, reporting the stroke and the steps. */
  const run = (walk, yaw, secs) => {
    lab.input.walk = walk;
    lab.input.yaw = yaw;
    const frames = Math.round(secs * 60);
    const strokes = [];
    let steps = 0;
    let planted = 6;
    let moved = 0;
    let held = 0;
    let clipped = 0;
    const feet = {};
    const slots = ['frontLeft', 'frontRight', 'midLeft', 'midRight', 'rearLeft', 'rearRight'];
    const first = {};
    for (const s of slots) {
      const a = lab.drive.anchorFor(s);
      if (a) first[s] = [...a];
    }
    for (let i = 0; i < frames; i += 1) {
      lab.stepForTest(1 / 60, 1);
      const r = lab.report;
      if (!r) continue;
      strokes.push(r.strain);
      moved += r.movedMm;
      held += r.heldBackMm;
      if (r.allowed < 0.999) clipped += 1;
      if (r.planted < planted) steps += 1;
      planted = r.planted;
    }
    for (const s of slots) {
      const a = lab.drive.anchorFor(s);
      if (a && first[s]) {
        feet[s] = [a[0] - first[s][0], a[1] - first[s][1], a[2] - first[s][2]]
          .map((n) => +(n * 5).toFixed(2));
      }
    }
    lab.input.walk = 0;
    lab.input.yaw = 0;
    return {
      steps,
      movedMm: +moved.toFixed(2),
      heldMm: +held.toFixed(2),
      clippedFrames: clipped,
      strokeMax: +Math.max(...strokes).toFixed(2),
      strokeMin: +Math.min(...strokes).toFixed(2),
      feet,
      at: [lab.at.x, lab.at.y, lab.at.z].map((n) => +(n * 5).toFixed(1)),
      up: [lab.up.x, lab.up.y, lab.up.z].map((n) => +n.toFixed(2)),
      state: lab.drive.legs.map((l) => `${l.slot}:${l.planted ? 'down' : (l.groping ? 'GROPE' : 'swing')}`),
    };
  };

  const full = run(1, 0, 3);
  const half = run(0.5, 0, 3);
  const spin = run(0, 1, 2);
  // What the legs will physically tolerate, for scale.
  const spread = lab.drive.legs
    ? lab.drive.legs.map((l) => +(l.spread * 5).toFixed(2))
    : null;
  return { full, half, spin, spread };
});

console.log(JSON.stringify({ errors: errors.slice(0, 3) }));
const show = (tag, r) => console.log(
  tag.padEnd(12),
  `steps ${String(r.steps).padStart(3)}`,
  `moved ${r.movedMm.toFixed(2).padStart(7)} mm`,
  `held ${r.heldMm.toFixed(2).padStart(6)} mm`,
  `clipped ${String(r.clippedFrames).padStart(3)} fr`,
  `stroke ${r.strokeMin.toFixed(2)}..${r.strokeMax.toFixed(2)}`,
  `at ${JSON.stringify(r.at)} up ${JSON.stringify(r.up)}`,
  `\n             ${r.state.join(' ')}`,
);
show('walk 100%', out.full);
show('walk  50%', out.half);
show('spin', out.spin);
console.log('spread limits mm', JSON.stringify(out.spread));
console.log('\nfoot travel over the spin (mm, world):');
for (const [slot, d] of Object.entries(out.spin.feet)) console.log(' ', slot.padEnd(11), JSON.stringify(d));
await browser.close();
