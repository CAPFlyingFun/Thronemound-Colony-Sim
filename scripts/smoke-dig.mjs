/**
 * Headless smoke test for the dig prototype.
 *
 * Unit tests cover the voxel rules; this proves the parts they can't touch —
 * that WebGL initialises, that geometry actually reaches the screen, and that
 * digging changes what is rendered.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4173/Thronemound-Colony-Sim/?scene=dig';
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
const shot = async (name) => {
  const buffer = await page.screenshot({ path: `${OUT}-${name}.png` });
  return buffer;
};
const surfaceShot = await shot('1-surface');
if (surfaceShot.length < 8000) fail(`surface frame looks blank (${surfaceShot.length} B PNG)`);
else ok(`surface frame has detail (${(surfaceShot.length / 1024).toFixed(0)} KB PNG)`);

// Drive the TOUCH path throughout — that is the one that ships to a phone,
// and desktop now uses pointer lock which Playwright can't drive meaningfully.
const swipeLook = (fromY, toY) => page.evaluate(([y0, y1]) => {
  const canvas = document.querySelector('canvas');
  const send = (type, y, extra = {}) => canvas.dispatchEvent(new PointerEvent(type, {
    pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true,
    clientX: 700, clientY: y, ...extra,
  }));
  send('pointerdown', y0);
  const steps = 12;
  for (let i = 1; i <= steps; i++) send('pointermove', y0 + ((y1 - y0) * i) / steps);
  send('pointerup', y1);
}, [fromY, toY]);

// 3. Look down, then hold the action button: the ground should be excavated.
// Straight down. With reach clamped to the cubes immediately around the ant,
// a shallow angle aims at ground two cubes out, which is now out of range.
await swipeLook(700, 1180);
await page.waitForTimeout(300);

const action = await page.$('.dig-action');
if (!action) fail('action button missing');
const box = await action.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.waitForTimeout(3000);
await page.mouse.up();
await page.waitForTimeout(400);

const after = (await page.textContent('#dig-readout'))?.replace(/\s+/g, ' ').trim() ?? '';
const dug = Number(/Dug (\d+)/.exec(after)?.[1] ?? '0');
const carrying = Number(/Carrying (\d+)/.exec(after)?.[1] ?? '0');
if (dug < 1) fail(`nothing was excavated after 3s of digging — "${after}"`);
else ok(`excavated ${dug} voxels, carrying ${carrying}`);
if (carrying !== dug) fail(`spoil not conserved: dug ${dug}, carrying ${carrying}`);
else ok('soil conserved: everything dug is being carried');

const dugShot = await shot('2-dug');
if (Buffer.compare(surfaceShot, dugShot) === 0) fail('frame did not change after digging');
else ok('rendered frame changed after digging');

// 4. Switch to ADD and deposit. Pitch back up so the placement cell is the
// face of an adjacent cube rather than the ant's own — aiming straight down
// targets the cell it is standing in, which the scene refuses on purpose.
await swipeLook(1180, 960);
await page.waitForTimeout(400);

await page.click('.dig-mode');
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.waitForTimeout(250);
await page.mouse.up();
await page.waitForTimeout(400);
// The HUD only repaints every 6th frame, so comparing readings taken at
// different moments races it. Assert the conservation invariant on one settled
// snapshot instead: everything dug is either still carried or now in the mound.
await page.waitForTimeout(900);
const placed = (await page.textContent('#dig-readout'))?.replace(/\s+/g, ' ').trim() ?? '';
const mound = Number(/Mound (\d+)/.exec(placed)?.[1] ?? '0');
const carryAfter = Number(/Carrying (\d+)/.exec(placed)?.[1] ?? '0');
const dugFinal = Number(/Dug (\d+)/.exec(placed)?.[1] ?? '0');
if (mound < 1) fail(`ADD mode placed nothing — "${placed}"`);
else ok(`placed ${mound} voxel(s) back, now carrying ${carryAfter}`);
if (dugFinal !== carryAfter + mound) {
  fail(`soil not conserved: dug ${dugFinal} != carried ${carryAfter} + mound ${mound}`);
} else ok(`soil conserved end to end: dug ${dugFinal} = carried ${carryAfter} + mound ${mound}`);

await shot('3-placed');

// 5. No console errors or failed requests at any point.
if (badResponses.length) fail(`failed requests:\n    ${badResponses.join('\n    ')}`);
else ok('no failed requests');
if (errors.length) fail(`console errors:\n    ${errors.join('\n    ')}`);
else ok('no console errors');

writeFileSync(`${OUT}-report.txt`, [readout, after, placed].join('\n'));
await browser.close();
console.log(process.exitCode ? '\nSMOKE FAILED' : '\nSMOKE PASSED');
