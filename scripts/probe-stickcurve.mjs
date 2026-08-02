/**
 * Rolling the thumb round the pad: does it curve, or does it snap?
 *
 * "Between movement and turns we need to lerp as it tends to snap... if you
 * smoothly go all around the joystick, the curve and transitions should be
 * really smooth."
 *
 * Two runs. The first SNAPS the stick from full forward to full left in one
 * frame, which is the worst case and the easiest to measure. The second rolls
 * it right round the circle over two seconds, which is what a thumb actually
 * does and is the case that has to feel natural.
 *
 * What is reported is the largest single-frame CHANGE in her motion — how much
 * her heading rate jumps, and how far a foot target moves in one frame. A snap
 * is a spike in those; a curve is not. Peak values, because the eye catches
 * the one bad frame and not the average.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4423/Thronemound-Colony-Sim/?scene=block';

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
  const SLOTS = ['frontLeft', 'frontRight', 'midLeft', 'midRight', 'rearLeft', 'rearRight'];
  const DEG = 180 / Math.PI;

  const start = { at: lab.at.clone(), up: lab.up.clone(), forward: lab.forward.clone() };
  const reset = () => {
    lab.at.copy(start.at); lab.up.copy(start.up); lab.forward.copy(start.forward);
    lab.gripping = true;
    lab.drive.plantAll({ at: lab.at, up: lab.up, forward: lab.forward }, lab.groundForLegs);
    lab.input.walk = 0; lab.input.yaw = 0;
    lab.stepForTest(1 / 60, 120);
  };

  /**
   * Run a stick programme. `stick(t)` returns [walk, yaw] for time t.
   * Reports the worst single-frame change in heading rate and in foot target.
   */
  const run = (stick, secs) => {
    reset();
    const frames = Math.round(secs * 60);
    let prevFwd = lab.forward.clone();
    let prevRate = 0;
    let worstRateJump = 0;
    let worstFootJump = 0;
    let prevFeet = {};
    for (const s of SLOTS) {
      const a = lab.drive.anchorFor(s);
      prevFeet[s] = a ? [...a] : null;
    }
    for (let i = 0; i < frames; i += 1) {
      const [walk, yaw] = stick(i / 60);
      lab.input.walk = walk; lab.input.yaw = yaw;
      lab.stepForTest(1 / 60, 1);
      // Heading rate this frame, in degrees per second.
      const dot = Math.max(-1, Math.min(1, prevFwd.dot(lab.forward)));
      const rate = Math.acos(dot) * DEG * 60;
      // Ignore the first few frames: prevRate has no history yet.
      if (i > 2) worstRateJump = Math.max(worstRateJump, Math.abs(rate - prevRate));
      prevRate = rate;
      prevFwd = lab.forward.clone();
      for (const s of SLOTS) {
        const a = lab.drive.anchorFor(s);
        if (a && prevFeet[s]) {
          worstFootJump = Math.max(worstFootJump, Math.hypot(
            a[0] - prevFeet[s][0], a[1] - prevFeet[s][1], a[2] - prevFeet[s][2],
          ) * 5);
        }
        if (a) prevFeet[s] = [...a];
      }
    }
    lab.input.walk = 0; lab.input.yaw = 0;
    return {
      worstRateJumpDegPerSec2: +worstRateJump.toFixed(2),
      worstFootJumpMm: +worstFootJump.toFixed(4),
    };
  };

  /**
   * Can she walk and turn AT THE SAME TIME?
   *
   * Driven through the REAL pointer handler with synthetic events, because
   * the question is about the stick's mapping and setting `input` directly
   * would answer a question nobody asked. A thumb is dragged round the pad in
   * sixteen steps and what the scene received is read back at each.
   *
   * Both columns non-zero on a diagonal is a curved walk. One column zero is
   * the old square wave, where whichever axis was larger took the whole
   * throw and the other got nothing.
   */
  const mix = () => {
    reset();
    const canvas = document.querySelector('canvas');
    const cx = Math.round(window.innerWidth * 0.25);
    const cy = Math.round(window.innerHeight * 0.6);
    const send = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, {
      pointerId: 77, clientX: x, clientY: y, bubbles: true,
    }));
    send('pointerdown', cx, cy);
    const rows = [];
    for (let i = 0; i < 16; i += 1) {
      const a = (i / 16) * Math.PI * 2;
      // Screen y grows downward, so "up the screen" is -sin here.
      send('pointermove', cx + Math.sin(a) * 70, cy - Math.cos(a) * 70);
      rows.push({
        deg: Math.round((a * 180) / Math.PI),
        walk: +lab.input.walk.toFixed(3),
        yaw: +lab.input.yaw.toFixed(3),
      });
    }
    send('pointerup', cx, cy);
    return rows;
  };

  return {
    // Full forward for a second, then hard left in a single frame.
    snap: run((t) => (t < 1 ? [1, 0] : [0, 1]), 2.5),
    // A thumb rolling right round the pad, once, over two seconds.
    circle: run((t) => {
      const a = (t / 2) * Math.PI * 2;
      return [Math.cos(a), Math.sin(a)];
    }, 2),
    mix: mix(),
  };
});

console.log(JSON.stringify({ errors: errors.slice(0, 3) }));
console.log('\nthumb dragged round the pad, what the scene received:');
console.log('  bearing    walk      yaw    both?');
for (const r of out.mix) {
  const both = Math.abs(r.walk) > 0.05 && Math.abs(r.yaw) > 0.05;
  console.log(
    `  ${String(r.deg).padStart(5)}deg`,
    r.walk.toFixed(3).padStart(8), r.yaw.toFixed(3).padStart(8),
    both ? '   yes' : '',
  );
}
const diagonals = out.mix.filter((r) => r.deg % 90 !== 0);
const curved = diagonals.filter((r) => Math.abs(r.walk) > 0.05 && Math.abs(r.yaw) > 0.05);
console.log(`\n${curved.length} of ${diagonals.length} off-axis bearings give a curve rather than a square-wave switch\n`);
delete out.mix;
for (const [tag, r] of Object.entries(out)) {
  console.log(
    tag.padEnd(8),
    `worst heading-rate jump ${r.worstRateJumpDegPerSec2.toFixed(2).padStart(8)} deg/s per frame`,
    `| worst foot jump ${r.worstFootJumpMm.toFixed(4).padStart(8)} mm`,
  );
}
await browser.close();
