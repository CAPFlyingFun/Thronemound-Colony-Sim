/**
 * CAN THE CAMERA ALWAYS BE MOVED? — the one that locked the game up.
 *
 *     npx vite --port 5173                                     # then
 *     SMOKE_URL=http://127.0.0.1:5173/?scene=island npm run probe:lookstuck
 *
 * Reported from the device: "after digging down and working my way back up,
 * the camera ended up locking up and I was no longer able to pan or pitch in
 * 1st or 3rd person view."
 *
 * The digging was a red herring — it is simply where a phone is most likely
 * to interrupt a touch. `lookPointer` holds the id of the finger driving the
 * camera and a new stroke is only accepted while it is null; it was cleared
 * in exactly one place, a `pointerup` whose id matched. Every other way a
 * finger can stop existing left it set to an id that would never be seen
 * again, and the camera was dead for the rest of the session.
 *
 * So this walks every one of those ways out. A unit test cannot: the whole
 * bug lives in listener wiring on a real canvas, and the state it corrupts
 * is only reachable through events.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/?scene=island';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready === true, null, { timeout: 200000 });
await page.waitForFunction(
  () => !document.querySelector('.tm-loading-root'), null, { timeout: 200000 },
);
await page.waitForTimeout(600);

const out = await page.evaluate(() => {
  const s = window.islandScene;
  const canvas = s.renderer.domElement;
  const log = [];
  let id = 100;

  /** A complete look-drag, and how far it turned the view. */
  const pans = () => {
    id += 1;
    const before = s.lookYaw;
    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: id, clientX: 600, clientY: 200,
    }));
    for (let i = 1; i <= 8; i += 1) {
      canvas.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, pointerId: id, clientX: 600 + i * 8, clientY: 200, movementX: 8, movementY: 0,
      }));
    }
    canvas.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, pointerId: id, clientX: 664, clientY: 200,
    }));
    s.stepForTest(1 / 60, 3);
    return Math.abs(s.lookYaw - before) > 1e-6;
  };

  /** Start a stroke and then end it the way the phone is about to. */
  const interrupt = (how) => {
    id += 1;
    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: id, clientX: 600, clientY: 200,
    }));
    canvas.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerId: id, clientX: 620, clientY: 200, movementX: 20, movementY: 0,
    }));
    how(id);
    s.stepForTest(1 / 60, 3);
  };

  log.push(['a plain drag pans the view', pans()]);

  /* 1. THE BROWSER TAKES THE GESTURE OVER. */
  interrupt((i) => window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: i })));
  log.push(['pans again after a cancelled stroke', pans()]);

  /* 2. CAPTURE IS REVOKED — no up, no cancel. */
  interrupt((i) => canvas.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: i })));
  log.push(['pans again after capture is taken away', pans()]);

  /* 3. THE WINDOW LOSES FOCUS mid-drag. */
  interrupt(() => window.dispatchEvent(new Event('blur')));
  log.push(['pans again after the window loses focus', pans()]);

  /* 4. AND IN FIRST PERSON, where the drag turns HER rather than the view —
   *    a different branch, the same pointer bookkeeping. */
  s.firstPerson = true;
  s.stepForTest(1 / 60, 3);
  const beforeQ = s.queen.root.quaternion.clone();
  interrupt((i) => window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: i })));
  id += 1;
  canvas.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, cancelable: true, pointerId: id, clientX: 600, clientY: 200,
  }));
  for (let i = 1; i <= 8; i += 1) {
    canvas.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerId: id, clientX: 600 + i * 8, clientY: 200, movementX: 8, movementY: 0,
    }));
  }
  canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: id, clientX: 664, clientY: 200 }));
  s.stepForTest(1 / 60, 3);
  log.push(['first person turns her after a cancelled stroke',
    s.queen.root.quaternion.angleTo(beforeQ) > 1e-4]);
  s.firstPerson = false;

  /* 5. AND THE STICK IS NOT COLLATERAL — the same handlers drop both. */
  s.stepForTest(1 / 60, 3);
  log.push(['the stick is free too', s.stickPointer === null]);
  log.push(['and the look pointer is clear', s.lookPointer === null]);
  return log;
});
await browser.close();

let bad = 0;
console.log('\nTHE CAMERA CANNOT BE LOCKED OUT\n');
for (const [what, ok] of out) {
  if (!ok) bad += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`);
}
if (errs.length) console.log(`\npage errors: ${errs.slice(0, 3).join(' | ')}`);
if (bad || errs.length) { console.log(`\n${bad} check(s) failed`); process.exit(1); }
console.log('\nall green — every way a finger can vanish gives the camera back');
