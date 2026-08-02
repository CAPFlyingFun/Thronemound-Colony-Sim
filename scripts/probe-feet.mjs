/**
 * "The back feet wiggle a little too much and look like it's dancing."
 *
 * Two things could make a foot read as fidgety: it steps more often than its
 * neighbours, or it JUMPS — moves a long way in a single frame. Both are
 * measurable per leg, and both were suspected here:
 *
 * - The gait circle used to be sized PER LEG from that leg's own ratio of
 *   rotation to travel. The rear feet sit furthest from her turn axis, so on
 *   any yaw at all they scored the most "turning" and got the SHORTEST
 *   circle — short circle, frequent steps, only at the back.
 * - The swing locked at 90% of its arc, at which point the foot was still a
 *   tenth short of its target and a third of the arc off the ground, so it
 *   teleported the rest.
 *
 * A thumb on a stick is never at exactly zero yaw, so the interesting case is
 * walking with a LITTLE steering in it, not the laboratory-clean straight
 * line. This reports both.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4393/Thronemound-Colony-Sim/?scene=block';
const SLOTS = ['frontLeft', 'frontRight', 'midLeft', 'midRight', 'rearLeft', 'rearRight'];

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

const out = await page.evaluate((slots) => {
  const lab = window.blockScene;

  /*
   * Every run starts from the same spot on the TOP face. The first version
   * chained them, so by the third she had walked to an edge and the
   * up-vector flip reprojected all six anchors at once — which shows up as
   * an 8 mm "single-frame jump" that is a corner, not a foot.
   */
  const start = {
    at: lab.at.clone(), up: lab.up.clone(), forward: lab.forward.clone(),
  };
  const reset = () => {
    lab.at.copy(start.at);
    lab.up.copy(start.up);
    lab.forward.copy(start.forward);
    lab.gripping = true;
    lab.drive.plantAll(
      { at: lab.at, up: lab.up, forward: lab.forward }, lab.groundForLegs,
    );
    lab.stepForTest(1 / 60, 30);
  };

  const run = (walk, yaw, secs) => {
    reset();
    lab.input.walk = walk;
    lab.input.yaw = yaw;
    const per = {};
    for (const s of slots) per[s] = { lifts: 0, maxJump: 0, sumMove: 0, frames: 0, wasDown: true };
    const last = {};
    for (const s of slots) {
      const a = lab.drive.anchorFor(s);
      last[s] = a ? [...a] : null;
    }
    const frames = Math.round(secs * 60);
    for (let i = 0; i < frames; i += 1) {
      lab.stepForTest(1 / 60, 1);
      for (const leg of lab.drive.legs) {
        const p = per[leg.slot];
        if (!p) continue;
        const a = lab.drive.anchorFor(leg.slot);
        if (a && last[leg.slot]) {
          const d = Math.hypot(
            a[0] - last[leg.slot][0], a[1] - last[leg.slot][1], a[2] - last[leg.slot][2],
          ) * 5;
          p.maxJump = Math.max(p.maxJump, d);
          p.sumMove += d;
          p.frames += 1;
        }
        if (a) last[leg.slot] = [...a];
        if (p.wasDown && !leg.planted) p.lifts += 1;
        p.wasDown = leg.planted;
      }
    }
    lab.input.walk = 0;
    lab.input.yaw = 0;
    const rows = slots.map((s) => ({
      slot: s,
      stepsPerSec: +(per[s].lifts / secs).toFixed(2),
      maxJumpMm: +per[s].maxJump.toFixed(4),
      meanPerFrameMm: +(per[s].sumMove / Math.max(1, per[s].frames)).toFixed(4),
    }));
    const front = (rows[0].stepsPerSec + rows[1].stepsPerSec) / 2;
    const rear = (rows[4].stepsPerSec + rows[5].stepsPerSec) / 2;
    return { rows, rearOverFront: +(rear / Math.max(0.01, front)).toFixed(3) };
  };

  // Short runs, so she stays on the top face and the numbers are like-for-like.
  return {
    straight: run(1, 0, 2),
    nudged: run(1, 0.15, 2),
    steering: run(1, 0.4, 2),
    spin: run(0, 1, 2),
  };
}, SLOTS);

console.log(JSON.stringify({ errors: errors.slice(0, 3) }));
for (const [tag, r] of Object.entries(out)) {
  console.log(`\n${tag}  (rear steps / front steps = ${r.rearOverFront})`);
  console.log('  leg          steps/s   max single-frame jump   mean per frame');
  for (const row of r.rows) {
    console.log(
      '  ', row.slot.padEnd(11),
      row.stepsPerSec.toFixed(2).padStart(6),
      `${row.maxJumpMm.toFixed(4).padStart(18)} mm`,
      `${row.meanPerFrameMm.toFixed(4).padStart(14)} mm`,
    );
  }
}
await browser.close();
