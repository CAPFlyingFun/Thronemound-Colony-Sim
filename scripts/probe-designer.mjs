/*
 * DRAW A NEST AND DIG IT.
 *
 * Drives the designer the way a finger does — press DIG, orbit, tap a node,
 * place another, join them, press DIG IT — and then asks the SOIL whether the
 * new room is there. The plan editing is tested as arithmetic elsewhere; what
 * this checks is the part arithmetic cannot: that the buttons are wired to the
 * operations, that the pointer events reach the designer instead of the
 * joystick, and that a re-carve at runtime actually moves dirt.
 *
 *   SMOKE_URL=http://localhost:4271/ node scripts/probe-designer.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://localhost:4271/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto(`${base}/?scene=block&shape=nest`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await page.waitForTimeout(600);

const chip = (label) => page.locator('.nest-designer-chip', { hasText: new RegExp(`^${label}$`) }).first();
const press = async (label) => { await chip(label).dispatchEvent('pointerdown'); await page.waitForTimeout(120); };

const before = await page.evaluate(() => window.blockScene.nestForTest().nodes.length);

// DIG opens the designer.
await page.locator('.density-lab-dig').first().dispatchEvent('pointerdown');
await page.waitForTimeout(400);
const opened = await page.evaluate(() => ({
  designing: document.querySelector('.density-lab-hud').classList.contains('is-designing'),
  panel: !!document.querySelector('.nest-designer'),
  playControlsVisible: !!document.querySelector('.density-lab-actions')?.offsetParent,
}));
console.log('\nOPENING');
console.log(`  designer up            ${opened.designing && opened.panel}`);
console.log(`  play controls hidden   ${!opened.playControlsVisible}`);

/*
 * Orbit, and check the camera actually moved. A drag that silently does
 * nothing is the failure mode that looks like a working designer right up
 * until you try to see round the back of the nest.
 */
const eye0 = await page.evaluate(() => window.blockScene.camera.position.toArray());
const canvas = page.locator('canvas').first();
await canvas.dispatchEvent('pointerdown', { pointerId: 1, clientX: 400, clientY: 200 });
for (let i = 1; i <= 8; i += 1) {
  await canvas.dispatchEvent('pointermove', { pointerId: 1, clientX: 400 + i * 14, clientY: 200 });
}
await canvas.dispatchEvent('pointerup', { pointerId: 1, clientX: 512, clientY: 200 });
await page.waitForTimeout(200);
const eye1 = await page.evaluate(() => window.blockScene.camera.position.toArray());
const swung = Math.hypot(eye1[0] - eye0[0], eye1[1] - eye0[1], eye1[2] - eye0[2]);
console.log(`\nORBIT`);
console.log(`  camera moved           ${swung.toFixed(2)} world units`);

// A drag on empty space must NOT have driven her or spawned a joystick.
const drove = await page.evaluate(() => ({
  walk: window.blockScene.input.walk,
  yaw: window.blockScene.input.yaw,
  stick: !!document.querySelector('.density-lab-stick.is-live'),
}));
console.log(`  joystick stayed away   ${!drove.stick && drove.walk === 0 && drove.yaw === 0}`);

/*
 * Place a room and join it to the deepest chamber, then dig it. Placing goes
 * through the panel, and the selection is set directly — tapping a node
 * on-screen needs it to be under a known pixel, and where that is depends on
 * the orbit, which is not what this probe is about.
 */
await page.evaluate(() => {
  const d = window.blockScene.designerForTest();
  d.selectForTest('node', 'royal');
});
await press('ROOM');
await press('\\+ PLACE');
await page.evaluate(() => window.blockScene.designerForTest().linkForTest('royal'));
await page.waitForTimeout(150);

const drawn = await page.evaluate(() => {
  const p = window.blockScene.designerForTest().current();
  return { nodes: p.nodes.length, edges: p.edges.length, last: p.nodes[p.nodes.length - 1] };
});
console.log('\nDRAWING');
console.log(`  nodes ${before} → ${drawn.nodes}, edges now ${drawn.edges}`);
console.log(`  new room at ${drawn.last.x.toFixed(0)}, ${drawn.last.y.toFixed(0)}, `
  + `${drawn.last.z.toFixed(0)} mm, r=${drawn.last.radiusMm}`);

const soilBefore = await page.evaluate((n) => window.blockScene.solidAtMm(n.x, n.y, n.z), drawn.last);
await press('DIG IT');
await page.waitForTimeout(1500);
const soilAfter = await page.evaluate((n) => window.blockScene.solidAtMm(n.x, n.y, n.z), drawn.last);

console.log('\nDIGGING');
console.log(`  soil at the new room   before=${soilBefore}  after=${soilAfter}`);

// UNDO must put the plan back.
await press('UNDO');
const undone = await page.evaluate(() => window.blockScene.designerForTest().current().edges.length);
console.log(`  undo dropped the link  ${undone === drawn.edges - 1} (${drawn.edges} → ${undone})`);

// DONE goes back to walking her about.
await press('DONE');
await page.waitForTimeout(1200);
const closed = await page.evaluate(() => ({
  designing: document.querySelector('.density-lab-hud').classList.contains('is-designing'),
  playControlsVisible: !!document.querySelector('.density-lab-actions')?.offsetParent,
  onGround: !window.blockScene.solidAtMm(
    window.blockScene.at.x * 5 - 3 * 0.5, 0, 0) || true,
}));
console.log('\nCLOSING');
console.log(`  back to playing        ${!closed.designing && closed.playControlsVisible}`);

const pass = opened.designing && opened.panel && !opened.playControlsVisible
  && swung > 1 && !drove.stick
  && drawn.nodes === before + 1 && soilBefore === true && soilAfter === false
  && undone === drawn.edges - 1
  && !closed.designing && closed.playControlsVisible;
console.log(`\n  ${pass ? 'PASS' : 'FAIL'}\n`);
if (errs.length) console.log('  page errors:', errs.slice(0, 5));

await browser.close();
process.exit(pass && !errs.length ? 0 : 1);
