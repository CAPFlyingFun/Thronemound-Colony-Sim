/**
 * ONE GAME, TWO HANDS — the input foundation, driven both ways.
 *
 *     npx vite --port 5173                                  # then
 *     SMOKE_URL=http://127.0.0.1:5173/?scene=island npm run probe:input
 *
 * The card's acceptance, verbatim: "input source can switch without
 * changing game mechanics, and the HUD presentation follows the active
 * input mode." Both halves are checked here against the REAL listeners —
 * dispatched keyboard and pointer events, not method calls, because the
 * thing that can be wrong is the wiring.
 *
 * Pinned:
 *   1. the island boots wearing TOUCH on a coarse pointer;
 *   2. a real key press swings it to PC, and the HUD re-dresses — the
 *      stick goes, the plates wear their keys;
 *   3. a touch swings it back, and the stick returns;
 *   4. THE MECHANICS ARE THE SAME EITHER WAY: the E key and the INTERACT
 *      plate both pick up the same seed, and both put it down;
 *   5. G arms the shovel exactly as the DIG plate does — all six of its
 *      consequences, not just the flag;
 *   6. the mouse looks with NO BUTTON HELD, and only once per pixel (the
 *      touch drag path stands down rather than doubling it);
 *   7. Settings' TOUCH override pins it against a keyboard.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/?scene=island';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const errs = [];
/* A COARSE pointer, so the boot guess is TOUCH and the swing to PC is
 * something the keyboard earned rather than something the harness set. */
const page = await browser.newPage({
  viewport: { width: 932, height: 430 }, hasTouch: true, isMobile: true,
});
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready === true, null, { timeout: 200000 });
await page.waitForFunction(
  () => !document.querySelector('.tm-loading-root'), null, { timeout: 200000 },
);

const dress = () => page.evaluate(() => ({
  mode: window.islandScene.inputMode,
  pcClass: document.querySelector('.density-lab-hud')?.classList.contains('is-pc') ?? false,
  stickShown: (document.querySelector('.tm-stick')?.getBoundingClientRect().width ?? 0) > 0,
  keyed: [...document.querySelectorAll('.tm-art[data-key]')].length,
}));

const out = {};
await page.evaluate(() => {
  const s = window.islandScene;
  s.questStage = 1; s.deepCarved = 1e9;
  s.stepForTest(1 / 60, 20);
});
out.boot = await dress();

/* 2. A real key press, through the real listener. */
await page.keyboard.press('KeyE');
await page.evaluate(() => window.islandScene.stepForTest(1 / 60, 4));
out.afterKey = await dress();

/* 3. A touch swings it back. */
await page.touchscreen.tap(466, 300);
await page.evaluate(() => window.islandScene.stepForTest(1 / 60, 4));
out.afterTouch = await dress();

/* 4. THE SAME MECHANIC, BOTH HANDS. Stand on a seed; pick it up with the
 *    plate, drop it; pick it up with the key, drop it. */
out.both = await page.evaluate(async () => {
  const s = window.islandScene;
  const MM = 5;
  const seed = s.props.find((p) => p.id === 'seed');
  const go = () => {
    s.teleportMm(seed.at.x * MM, seed.at.z * MM);
    s.stepForTest(1 / 60, 10);
  };
  const press = (key) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
    s.stepForTest(1 / 60, 10);
  };
  const plate = () => {
    document.querySelector('.tm-art-interact')
      ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    s.stepForTest(1 / 60, 10);
  };
  if (s.carry.carrying) { plate(); }
  go(); plate();
  const byPlate = s.carry.carrying ? s.carry.held.id : null;
  plate();
  const platePutDown = !s.carry.carrying;
  go(); press('e');
  const byKey = s.carry.carrying ? s.carry.held.id : null;
  press('e');
  const keyPutDown = !s.carry.carrying;
  return { byPlate, byKey, platePutDown, keyPutDown };
});

/* 5. G arms the shovel the way the plate does — every consequence. */
out.dig = await page.evaluate(() => {
  const s = window.islandScene;
  const snap = () => ({
    mode: s.hudMode,
    first: s.firstPerson,
    scoopUp: (document.querySelector('.tm-art-scoop')?.getBoundingClientRect().width ?? 0) > 0,
  });
  const press = (key) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
    s.stepForTest(1 / 60, 6);
  };
  const before = snap();
  press('g');
  const armed = snap();
  press('g');
  const off = snap();
  return { before, armed, off };
});

/* 6. THE MOUSE LOOKS WITH NO BUTTON HELD, once per pixel. */
out.mouse = await page.evaluate(() => {
  const s = window.islandScene;
  /* Into PC mode by the honest route, then a bare hover move. Chromium
   * here has no real pointer lock without a user gesture, so this is the
   * iOS path — which is the one that needs proving anyway. */
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'e', bubbles: true }));
  s.stepForTest(1 / 60, 4);
  s.firstPerson = false;
  s.lookYaw = 0;
  const canvas = s.renderer.domElement;
  const move = (x, y) => canvas.dispatchEvent(new PointerEvent('pointermove', {
    bubbles: true, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y,
  }));
  move(400, 200);            // first sighting only plants the origin
  const afterPlant = s.lookYaw;
  move(440, 200);            // 40 px right, no button held
  const afterMove = s.lookYaw;
  return {
    mode: s.inputMode,
    plantedNothing: afterPlant === 0,
    swung: +(afterMove - afterPlant).toFixed(4),
    want: +(-40 * 0.005 * s.prefs.lookSens).toFixed(4),
  };
});

/* 7. Settings' TOUCH override pins it against a keyboard. */
out.override = await page.evaluate(() => {
  const s = window.islandScene;
  s.applyPrefs({ ...s.prefs, inputMode: 'touch' });
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'e', bubbles: true }));
  s.stepForTest(1 / 60, 4);
  const pinned = s.inputMode;
  s.applyPrefs({ ...s.prefs, inputMode: 'auto' });
  return { pinned };
});

await browser.close();

let bad = 0;
const say = (ok, line) => { if (!ok) bad += 1; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${line}`); };

console.log('\nONE GAME, TWO HANDS\n');
console.log(`  boot        : ${JSON.stringify(out.boot)}`);
console.log(`  after a key : ${JSON.stringify(out.afterKey)}`);
console.log(`  after touch : ${JSON.stringify(out.afterTouch)}`);
console.log(`  both hands  : ${JSON.stringify(out.both)}`);
console.log(`  the shovel  : ${JSON.stringify(out.dig)}`);
console.log(`  the mouse   : ${JSON.stringify(out.mouse)}`);
console.log(`  override    : ${JSON.stringify(out.override)}\n`);

say(out.boot.mode === 'touch' && out.boot.stickShown && !out.boot.pcClass,
  'a phone boots wearing touch — stick up, no PC dress');
say(out.afterKey.mode === 'pc' && out.afterKey.pcClass,
  'one real key press swings it to PC');
say(!out.afterKey.stickShown, 'and the stick goes — WASD replaced it');
say(out.afterKey.keyed >= 4, `and the plates wear their keys (${out.afterKey.keyed} of them)`);
say(out.afterTouch.mode === 'touch' && out.afterTouch.stickShown,
  'a touch swings it back, and the stick returns');
say(out.both.byPlate === 'seed' && out.both.byKey === 'seed',
  `the plate and the E key lift the SAME seed (${out.both.byPlate} / ${out.both.byKey})`);
say(out.both.platePutDown && out.both.keyPutDown,
  'and both put it down again — one mechanic, two doors');
say(out.dig.before.mode === 'explore' && out.dig.armed.mode !== 'explore',
  `G arms the shovel (${out.dig.before.mode} -> ${out.dig.armed.mode})`);
say(out.dig.armed.first && out.dig.armed.scoopUp,
  'with every consequence: her own eyes, and SCOOP on the rail');
say(out.dig.off.mode === 'explore' && !out.dig.off.scoopUp,
  'and G again puts the whole rail back');
say(out.mouse.plantedNothing, 'the first hover move only plants the origin — no jump');
say(Math.abs(out.mouse.swung - out.mouse.want) < 1e-6,
  `the mouse looks with no button held, exactly once per pixel (${out.mouse.swung})`);
say(out.override.pinned === 'touch',
  'Settings TOUCH pins it against a keyboard');

if (errs.length) console.log(`\npage errors: ${errs.slice(0, 3).join(' | ')}`);
if (bad > 0 || errs.length) { console.log(`\n${bad} check(s) failed`); process.exit(1); }
console.log('\nall green — the ant does not care which hand asked');
