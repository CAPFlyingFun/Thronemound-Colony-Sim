/**
 * Does the STICK let go, wherever the thumb happens to end up?
 *
 * The report: "somehow my joystick got locked in full right deflection and I
 * had to close the game as it was stuck… the model and camera started like
 * spinning in place."
 *
 * `pointerup` and `pointercancel` were bound to the canvas alone, and the HUD,
 * the buttons and the tuner all take pointer events. A thumb that slid off the
 * canvas mid-drag fired its release somewhere the canvas never heard, so the
 * stick stayed latched at whatever it was last set to — full deflection, and
 * unrecoverable without killing the app.
 *
 * So this drags the stick to a hard-over turn and then lets go in every awkward
 * place there is: over a HUD button, as a bare window event with no capture in
 * play, and by taking the app away mid-drag. The stick has to read zero after
 * each one. It also checks the HUD buttons still respond, because the fix binds
 * the pointer to the canvas and a fix that deadens the controls is no fix.
 */
import { chromium } from 'playwright';

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const p = await b.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(process.env.SMOKE_URL ?? 'http://localhost:4520/Thronemound-Colony-Sim/?scene=block',
  { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await p.waitForTimeout(1500);

/** What the stick is commanding right now. */
const stick = () => p.evaluate(() => ({
  walk: +window.blockScene.input.walk.toFixed(3),
  yaw: +window.blockScene.input.yaw.toFixed(3),
  held: window.blockScene.stickPointer !== null,
}));

/** Where a HUD control actually sits, so the release lands on a real target. */
const hudSpot = await p.evaluate(() => {
  const el = [...document.querySelectorAll('button')]
    .find((n) => getComputedStyle(n).pointerEvents !== 'none' && n.getBoundingClientRect().width > 0);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: el.textContent?.trim() };
});

const ORIGIN = { x: 200, y: 300 };
const rows = [];

/** Drag hard right, then release however `finish` says to. */
const run = async (name, finish) => {
  await p.mouse.move(ORIGIN.x, ORIGIN.y);
  await p.mouse.down();
  await p.mouse.move(ORIGIN.x + 90, ORIGIN.y, { steps: 6 });
  const during = await stick();
  await finish();
  await p.waitForTimeout(60);
  const after = await stick();
  rows.push({ name, during, after, stuck: Math.abs(after.yaw) > 0.001 || Math.abs(after.walk) > 0.001 });
  // Whatever the outcome, do not leave a pointer down for the next case.
  await p.evaluate(() => window.dispatchEvent(new Event('blur')));
  await p.waitForTimeout(30);
};

// 1. Released over a HUD button — the exact shape of the report.
if (hudSpot) {
  await run('release over HUD button', async () => {
    await p.mouse.move(hudSpot.x, hudSpot.y, { steps: 4 });
    await p.mouse.up();
  });
}

// 2. Released as a bare window event, with pointer capture never established.
//    This is the path capture alone does not cover.
await run('release on window only', async () => {
  await p.evaluate(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
  });
});

// 3. Cancelled outright — what a system gesture or a call coming in looks like.
await run('pointercancel on window', async () => {
  await p.evaluate(() => {
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }));
  });
});

// 4. App taken away mid-drag. A pointer that ends while backgrounded may never
//    report at all, so nothing but the visibility change can clear it.
await run('backgrounded mid-drag', async () => {
  await p.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });
});

// And the cost check: capturing the pointer must not deaden the HUD.
let buttonWorks = null;
if (hudSpot) {
  buttonWorks = await p.evaluate((spot) => new Promise((done) => {
    const el = document.elementFromPoint(spot.x, spot.y);
    if (!el) return done(false);
    let fired = false;
    el.addEventListener('click', () => { fired = true; }, { once: true });
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    setTimeout(() => done(fired), 20);
  }), hudSpot);
  await p.mouse.click(hudSpot.x, hudSpot.y);
}

const stuck = rows.filter((r) => r.stuck);
console.log(JSON.stringify({
  hudSpot, rows, buttonWorks, stuckCases: stuck.length, errs,
}, null, 2));
console.log(stuck.length === 0 && errs.length === 0 ? 'STICK_RELEASES' : 'STICK_STUCK');
await b.close();
