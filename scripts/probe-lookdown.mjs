/**
 * Drag the screen and watch her jaw. No angle conventions anywhere.
 *
 * "Up and down is reversed" was reported from the device, and two rounds of
 * reasoning about signs produced two different answers that both looked right
 * on paper. Angles need a convention; a HEIGHT does not, and neither does a
 * drag. So this drives the real pointer handler — a finger dragging up the
 * screen, and down — and reports what happens to the distance from her jaw to
 * the soil.
 *
 * Whichever direction the player drags to LOOK DOWN must be the one that
 * brings her jaw toward the ground. That is the whole test.
 */
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(process.env.SMOKE_URL ?? 'http://localhost:4471/Thronemound-Colony-Sim/?scene=block', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await p.waitForTimeout(2000);
const out = await p.evaluate(() => {
  const lab = window.blockScene, MM = 5;
  const V = Object.getPrototypeOf(lab.at).constructor;
  const canvas = document.querySelector('canvas');
  // The look pointer is the RIGHT half of the screen; the left half is the stick.
  const cx = Math.round(window.innerWidth * 0.75);
  const cy = Math.round(window.innerHeight * 0.5);
  const send = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, {
    pointerId: 91, clientX: x, clientY: y, bubbles: true,
  }));
  const jawHeight = () => {
    lab.stepForTest(1 / 60, 6);
    const j = new V();
    lab.queen.jawPosition(j);
    const g = lab.cast(j.clone().addScaledVector(lab.up, 4 / MM), lab.up.clone().negate(), 24 / MM);
    return g ? +(j.clone().sub(g).dot(lab.up) * MM).toFixed(3) : null;
  };
  const drag = (dy) => {
    send('pointerdown', cx, cy);
    for (let i = 1; i <= 10; i += 1) send('pointermove', cx, cy + (dy * i) / 10);
    send('pointerup', cx, cy + dy);
  };
  lab.setMode(1); // DIG
  lab.stepForTest(1 / 60, 30);
  const start = jawHeight();
  drag(120);            // finger DOWN the screen
  const afterDown = jawHeight();
  const camAfterDown = +(lab.follow.lookPitch * 180 / Math.PI).toFixed(1);
  drag(-240);           // and back UP past the start
  const afterUp = jawHeight();
  const camAfterUp = +(lab.follow.lookPitch * 180 / Math.PI).toFixed(1);
  return { start, afterDown, camAfterDown, afterUp, camAfterUp };
});
console.log(JSON.stringify({ errors: errs.slice(0, 2) }));
console.log(`start                       jaw ${out.start} mm above the soil`);
console.log(`after dragging DOWN 120px   jaw ${out.afterDown} mm   (view elevation ${out.camAfterDown}°)`);
console.log(`after dragging UP   240px   jaw ${out.afterUp} mm   (view elevation ${out.camAfterUp}°)`);
const downLooksDown = out.camAfterDown < 0;
const jawWentDown = out.afterDown < out.start;
console.log(`\ndragging down ${downLooksDown ? 'looks DOWN' : 'looks UP'}; her jaw went ${jawWentDown ? 'DOWN' : 'UP'}`);
console.log(downLooksDown === jawWentDown ? 'AGREE — her head follows the view' : 'REVERSED');
await b.close();
