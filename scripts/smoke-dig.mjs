/**
 * Headless smoke test for the dig prototype.
 *
 * Unit tests cover the voxel rules; this proves the parts they can't touch —
 * that WebGL initialises, that geometry actually reaches the screen, and that
 * the tap-to-dig loop survives a real round trip through the UI.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4173/Thronemound-Colony-Sim/?scene=dig&debug=1';
const OUT = process.env.SMOKE_OUT ?? '/tmp/dig-smoke';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 1600 }, deviceScaleFactor: 1 });

const errors = [];
const badResponses = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('response', (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas', { timeout: 20000 });
await page.waitForTimeout(2500);

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`  ok  ${msg}`);

// 1. The HUD rendered and is reporting a real world.
const readout = (await page.textContent('#dig-readout'))?.replace(/\s+/g, ' ').trim() ?? '';
if (!readout.includes('Depth')) fail(`HUD missing: "${readout}"`); else ok(`HUD: ${readout}`);

// 2. Something is actually drawn. gl.readPixels is useless here — three.js
// leaves preserveDrawingBuffer off, so the buffer reads back cleared even
// though the frame rendered fine. Compare compressed screenshots instead: a
// flat single-colour frame packs down to a couple of kB, detailed geometry
// does not.
const shot = async (name) => page.screenshot({ path: `${OUT}-${name}.png` });
const surfaceShot = await shot('1-surface');
if (surfaceShot.length < 8000) fail(`surface frame looks blank (${surfaceShot.length} B PNG)`);
else ok(`surface frame has detail (${(surfaceShot.length / 1024).toFixed(0)} KB PNG)`);

// Drive the TOUCH path throughout — that is the one that ships to a phone,
// and desktop now uses pointer lock which Playwright can't drive meaningfully.
const swipeLook = (fromY, toY) => page.evaluate(([y0, y1]) => {
  const canvas = document.querySelector('canvas');
  const send = (type, y) => canvas.dispatchEvent(new PointerEvent(type, {
    pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true,
    clientX: 700, clientY: y,
  }));
  send('pointerdown', y0);
  const steps = 12;
  for (let i = 1; i <= steps; i++) send('pointermove', y0 + ((y1 - y0) * i) / steps);
  send('pointerup', y1);
}, [fromY, toY]);

/** A press that goes nowhere and ends immediately — the dig gesture. */
const tap = (x, y) => page.evaluate(([cx, cy]) => {
  const canvas = document.querySelector('canvas');
  const send = (type) => canvas.dispatchEvent(new PointerEvent(type, {
    pointerId: 9, pointerType: 'touch', isPrimary: true, bubbles: true, clientX: cx, clientY: cy,
  }));
  send('pointerdown');
  send('pointerup');
}, [x, y]);

const hud = async () => {
  const t = (await page.textContent('#dig-readout'))?.replace(/\s+/g, ' ') ?? '';
  return {
    text: t.trim(),
    dug: Number(/Dug (\d+)/.exec(t)?.[1] ?? '0'),
    scoops: Number(/Carrying (\d+)\// .exec(t)?.[1] ?? '0'),
    pieces: Number(/pieces (\d+)/.exec(t)?.[1] ?? '0'),
    loose: Number(/Loose (\d+)/.exec(t)?.[1] ?? '0'),
    seconds: Number(/([\d.]+)s\/cube/.exec(t)?.[1] ?? '0'),
    speed: Number(/spd ([\d.]+)/.exec(t)?.[1] ?? '0'),
    target: /Target: ([^ ·]+)/.exec(t)?.[1] ?? '',
    chip: Number(/chip (\d+)\/\d+/.exec(t)?.[1] ?? 'NaN'),
    chipTotal: Number(/chip \d+\/(\d+)/.exec(t)?.[1] ?? 'NaN'),
    spill: Number(/spill (\d+)/.exec(t)?.[1] ?? 'NaN'),
    chips: Number(/chips (\d+)/.exec(t)?.[1] ?? '0'),
    box: Number(/box ([\d.]+)/.exec(t)?.[1] ?? '1'),
  };
};
/**
 * Poll the action button's label. Single-sampling it races the HUD, which only
 * repaints every 6th frame — about 770 ms under software rendering.
 */
const untilLabel = async (want, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const label = (await page.textContent('.dig-action')) ?? '';
    if (label.includes(want)) return true;
    if (Date.now() > deadline) return false;
    await page.waitForTimeout(250);
  }
};
/**
 * Poll until a predicate holds; the HUD only repaints every 6th frame.
 *
 * `watch` sees every sample, which is how a value that moves DURING the wait
 * can be asserted on — the state that finally satisfies `check` has usually
 * moved on from whatever the interesting moment was.
 */
const until = async (label, check, timeoutMs = 300000, watch = null) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await hud();
    if (watch) watch(state);
    if (check(state)) return state;
    if (Date.now() > deadline) { fail(`timed out waiting for ${label} — "${state.text}"`); return state; }
    await page.waitForTimeout(400);
  }
};

// 3. Look down so the ground ahead is within the one-cube reach, then TAP it.
await swipeLook(700, 1180);
await page.waitForTimeout(400);

const start = await hud();
if (start.seconds < 12.4) fail(`first cube should cost the full 12.5s, HUD says ${start.seconds}`);
else ok(`unpractised queen digs at ${start.seconds}s/cube`);

// Screen centre is where the crosshair points, so tapping there targets the
// same cube — which is the point: tap and crosshair are one mechanic.
await tap(450, 800);
if (!await untilLabel('CANCEL')) fail('tapping soil did not start a dig');
else ok('tap starts a dig and the button offers CANCEL');

/*
 * The voxel is replaced by a chipped lattice while she works, not left perfect
 * until it vanishes. `chips N` counts the part-dug cubes being drawn in place
 * of solid ones.
 *
 * This used to wait for a CRUMB to disappear, which is now a race: pieces only
 * leave in the last tenth of a sheet, so "visibly chipping" and "the sheet
 * finished" are the same instant, and the cancel below would land on a
 * finished sheet instead of a running one.
 */
const chipping = await until('the chipped lattice to appear', (s) => s.chips >= 1, 90000);
if (chipping.chips < 1) fail(`target never got a chipped visual — "${chipping.text}"`);
else ok('the target is drawn as a chipped lattice while she works');

// 4. Tapping the same cube again cancels it, discarding progress.
await tap(450, 800);
if (!await untilLabel('DIG')) fail('tapping the cube again did not cancel');
else ok('tapping the same cube again cancels');
// Cancelling must take the temporary crumb mesh away and put the intact voxel
// back — no `chip` readout means no active visual.
// Cancelling an UNTOUCHED cube has nothing left to show, so the visual goes
// and the terrain draws it whole again.
const cleared = await until('the chipped visual to be torn down', (s) => s.chips === 0, 20000);
if (cleared.chips !== 0) fail(`cancel left a chipped visual behind — "${cleared.text}"`);
else ok('cancelling an untouched cube removes the temporary visual');
const afterCancel = await hud();
if (afterCancel.dug !== 0) fail(`a cancelled dig still removed soil: dug ${afterCancel.dug}`);
else ok('a cancelled dig removes nothing');
if (afterCancel.seconds < 12.4) fail('a cancelled dig credited practice — tap-cancel would be an exploit');
else ok('a cancelled dig credits no practice');

/*
 * 5. ONE press takes the whole cell.
 *
 * It used to be four, a sheet of sixteen at a time, with the spoil hauled out
 * between them. The cell is the unit now: one press, one pellet, and nothing
 * is part-dug in between — so the things this used to check (a shrinking
 * outline, a hole that survives between presses, a face buried in its own
 * spoil) describe a stage that no longer exists. Sim time runs at roughly
 * 0.15x wall here (dt clamped to 50 ms, ~3 fps under software rendering), so a
 * 12.5 second cell is a long wait.
 */
const label = async () => (await page.textContent('.dig-action')) ?? '';

// Aim back down at the cube after any detour.
const aimDown = async () => {
  await swipeLook(700, 1180);
  await page.waitForTimeout(800);
};

await aimDown();
// POLLED, not sampled once: the HUD and the button repaint every 6th frame, so
// reading immediately after aiming catches the previous label.
if (!await untilLabel('DIG', 15000)) {
  fail(`expected the button to offer DIG, got "${(await label()).trim()}"`);
} else ok('the button offers DIG, with no sheet count to be part-way through');

const beforeDig = await hud();
await page.click('.dig-action');

/*
 * Nothing comes away until the cell does.
 *
 * The old model handed out a scoop of soil per sheet while the cube was still
 * standing, which is the state every conservation bug lived in. Sampled
 * part-way through: the world must be exactly as it was.
 */
await page.waitForTimeout(6000);
const midway = await hud();
if (midway.dug !== beforeDig.dug || midway.loose + midway.pieces !== beforeDig.loose + beforeDig.pieces) {
  fail(`soil moved mid-press: dug ${midway.dug}, ${midway.loose + midway.pieces} pieces`);
} else ok('a press in progress has issued no soil at all');

const cut = await until('the cell to come away', (s) => s.dug >= 1, 300000);
if (cut.dug < 1) fail('the cell never came away');
else ok('one press took the whole cell');

const dug = await hud();
if (dug.seconds > 12.4) fail(`practice did not advance after a completed dig (${dug.seconds}s)`);
else ok(`practice advanced: now ${dug.seconds}s/cube`);

// One cell is one pellet, so the whole cube is accounted for by a single piece.
const settled = await until('the spoil to settle', (s) => s.speed < 0.2, 30000);
if (settled.pieces + settled.loose < 1) {
  fail(`soil went missing: ${settled.pieces} held + ${settled.loose} loose`);
} else ok(`the cell's soil is accounted for (${settled.pieces} held + ${settled.loose} loose)`);

// Completing must tear the chip down, leaving the normal terrain path to draw
// the (now removed) voxel. A leftover crumb would float in the hole.
const afterDig = await until('the chipped visual to be torn down on completion',
  (s) => s.chips === 0, 20000);
if (afterDig.chips !== 0) fail(`completion left a chipped visual behind — "${afterDig.text}"`);
else ok('completing a cell removes the temporary visual');

const dugShot = await shot('2-dug');
if (Buffer.compare(surfaceShot, dugShot) === 0) fail('frame did not change after digging');
else ok('rendered frame changed after digging');

/*
 * 6. Soil conservation, end to end, in PIECES.
 *
 * The cube is gone and every piece of it is either in her jaws or lying on the
 * ground. Counted in pellets, and a cell is exactly one — which is the point of
 * the rework: cell, pellet and grab are one object, so there is no second unit
 * for the count to drift between. It used to be 64 pieces and a scoop of 16 —
 * the cube figure alone cannot see a sheet going missing.
 */
const placed = await hud();
if (placed.dug !== placed.pieces + placed.loose) {
  fail(`soil not conserved: dug ${placed.dug} != held ${placed.pieces} + loose ${placed.loose}`);
} else ok(`soil conserved end to end: ${placed.dug} cell = ${placed.pieces} held + ${placed.loose} loose`);

await shot('3-placed');

// 7. No console errors or failed requests at any point.
if (badResponses.length) fail(`failed requests:\n    ${badResponses.join('\n    ')}`);
else ok('no failed requests');
if (errors.length) fail(`console errors:\n    ${errors.join('\n    ')}`);
else ok('no console errors');

writeFileSync(`${OUT}-report.txt`, [readout, dug.text, placed.text].join('\n'));
await browser.close();
console.log(process.exitCode ? '\nSMOKE FAILED' : '\nSMOKE PASSED');
