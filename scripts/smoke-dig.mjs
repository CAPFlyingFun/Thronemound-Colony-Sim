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
    carrying: Number(/Carrying (\d+)/.exec(t)?.[1] ?? '0'),
    mound: Number(/Mound (\d+)/.exec(t)?.[1] ?? '0'),
    seconds: Number(/([\d.]+)s\/cube/.exec(t)?.[1] ?? '0'),
    speed: Number(/spd ([\d.]+)/.exec(t)?.[1] ?? '0'),
    target: /Target: ([^ ·]+)/.exec(t)?.[1] ?? '',
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
/** Poll until a predicate holds; the HUD only repaints every 6th frame. */
const until = async (label, check, timeoutMs = 150000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await hud();
    if (check(state)) return state;
    if (Date.now() > deadline) { fail(`timed out waiting for ${label} — "${state.text}"`); return state; }
    await page.waitForTimeout(400);
  }
};

// 3. Look down so the ground ahead is within the one-cube reach, then TAP it.
await swipeLook(700, 1180);
await page.waitForTimeout(400);

const start = await hud();
if (start.seconds < 4.9) fail(`first cube should cost the full 5s, HUD says ${start.seconds}`);
else ok(`unpractised queen digs at ${start.seconds}s/cube`);

// Screen centre is where the crosshair points, so tapping there targets the
// same cube — which is the point: tap and crosshair are one mechanic.
await tap(450, 800);
if (!await untilLabel('CANCEL')) fail('tapping soil did not start a dig');
else ok('tap starts a dig and the button offers CANCEL');

// 4. Tapping the same cube again cancels it, discarding progress.
await tap(450, 800);
if (!await untilLabel('DIG')) fail('tapping the cube again did not cancel');
else ok('tapping the same cube again cancels');
const afterCancel = await hud();
if (afterCancel.dug !== 0) fail(`a cancelled dig still removed soil: dug ${afterCancel.dug}`);
else ok('a cancelled dig removes nothing');
if (afterCancel.seconds < 4.9) fail('a cancelled dig credited practice — tap-cancel would be an exploit');
else ok('a cancelled dig credits no practice');

// 5. Tap and let it run to completion. Five seconds of SIM time is a long
// wall-clock wait: dt is clamped to 50 ms and software rendering manages ~3 fps
// once the sky is drawn, so the sim advances at roughly 0.15x real time.
await tap(450, 800);
const dug = await until('the first cube to pop', (s) => s.dug >= 1);
if (dug.dug < 1) fail(`nothing was excavated — "${dug.text}"`);
else ok(`excavated ${dug.dug}, carrying ${dug.carrying}`);
if (dug.carrying !== dug.dug) fail(`spoil not conserved: dug ${dug.dug}, carrying ${dug.carrying}`);
else ok('soil conserved: everything dug is being carried');
if (dug.seconds > 4.9) fail(`practice did not advance after a completed dig (${dug.seconds}s)`);
else ok(`practice advanced: now ${dug.seconds}s/cube`);

const dugShot = await shot('2-dug');
if (Buffer.compare(surfaceShot, dugShot) === 0) fail('frame did not change after digging');
else ok('rendered frame changed after digging');

// 6. Climb out, then DROP puts it back.
//
// She is standing IN the hole she just dug, and a one-cube pit has nowhere to
// backfill from the inside — the placement cell would be her own body, which is
// refused on purpose. Walking out is the real loop, and step-up clears a
// one-voxel rise without a jump. (This step used to be unnecessary only because
// a hover bug left her eye above the rim.)
await page.keyboard.down('KeyW');
await page.waitForTimeout(2000);
await page.keyboard.up('KeyW');
// Wait for her to actually come to rest. Deceleration is 22 voxels/s^2 but the
// sim runs at ~0.15x wall clock here, so a fixed pause is a coin flip — aiming
// while still walking is what made this step flaky.
await until('the ant to stop walking', (s) => s.speed < 0.2, 40000);

// Deliberately do NOT fuss over the aim. DROP prefers the cell the crosshair
// faces but falls back to the best neighbouring one, precisely so a player
// doesn't have to thread the narrow window that one-cube reach leaves on flat
// ground. If this needs a perfect pitch to pass, the fallback has regressed.
await page.click('.dig-drop');
const placed = await until('the load to reach the mound', (s) => s.mound >= 1, 25000);
if (placed.mound < 1) fail(`DROP placed nothing — "${placed.text}"`);
else ok(`dropped ${placed.mound} voxel(s), now carrying ${placed.carrying}`);
if (placed.dug !== placed.carrying + placed.mound) {
  fail(`soil not conserved: dug ${placed.dug} != carried ${placed.carrying} + mound ${placed.mound}`);
} else ok(`soil conserved end to end: dug ${placed.dug} = carried ${placed.carrying} + mound ${placed.mound}`);

await shot('3-placed');

// 7. No console errors or failed requests at any point.
if (badResponses.length) fail(`failed requests:\n    ${badResponses.join('\n    ')}`);
else ok('no failed requests');
if (errors.length) fail(`console errors:\n    ${errors.join('\n    ')}`);
else ok('no console errors');

writeFileSync(`${OUT}-report.txt`, [readout, dug.text, placed.text].join('\n'));
await browser.close();
console.log(process.exitCode ? '\nSMOKE FAILED' : '\nSMOKE PASSED');
