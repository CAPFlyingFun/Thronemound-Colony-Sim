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

// A fresh nest is exactly one piece: the Station.
const before = await page.evaluate(() => window.blockScene.nestForTest().nodes.length);
console.log(`\nSTARTING PLAN: ${before} piece(s)`);

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
 * Fly, and check the camera actually moved.
 *
 * The stick is held DOWN across real frames on purpose: movement is integrated
 * in update() per rendered frame, so a burst of synthetic pointermoves with no
 * time between them deflects the stick and releases it before a single frame
 * has integrated anything — the camera stays put and the probe reports a
 * broken control that works fine under a thumb.
 *
 * It also starts at the bottom-left, well away from the Station. The Station
 * spawns selected near screen centre, and a drag that begins on the selected
 * node MOVES THE NODE — by design. A probe that grabbed it by accident would
 * be measuring the drag feature and calling it the camera.
 */
const eye0 = await page.evaluate(() => window.blockScene.camera.position.toArray());
const canvas = page.locator('canvas').first();
await canvas.dispatchEvent('pointerdown', { pointerId: 1, clientX: 170, clientY: 330 });
for (let i = 1; i <= 6; i += 1) {
  await canvas.dispatchEvent('pointermove', { pointerId: 1, clientX: 170, clientY: 330 - i * 8 });
  await page.waitForTimeout(50);
}
await page.waitForTimeout(250);
await canvas.dispatchEvent('pointerup', { pointerId: 1, clientX: 170, clientY: 282 });
await page.waitForTimeout(150);
const eye1 = await page.evaluate(() => window.blockScene.camera.position.toArray());
const swung = Math.hypot(eye1[0] - eye0[0], eye1[1] - eye0[1], eye1[2] - eye0[2]);
console.log(`\nFLYING`);
console.log(`  camera moved           ${swung.toFixed(2)} world units`);

// And the LOOK drag on the right half must turn the view without moving her.
const look0 = await page.evaluate(() => {
  const V = Object.getPrototypeOf(window.blockScene.at).constructor;
  return window.blockScene.camera.getWorldDirection(new V()).toArray();
});
await canvas.dispatchEvent('pointerdown', { pointerId: 2, clientX: 700, clientY: 200 });
for (let i = 1; i <= 6; i += 1) {
  await canvas.dispatchEvent('pointermove', { pointerId: 2, clientX: 700 + i * 12, clientY: 200 });
  await page.waitForTimeout(25);
}
await canvas.dispatchEvent('pointerup', { pointerId: 2, clientX: 772, clientY: 200 });
await page.waitForTimeout(150);
const look1 = await page.evaluate(() => {
  const V = Object.getPrototypeOf(window.blockScene.at).constructor;
  return window.blockScene.camera.getWorldDirection(new V()).toArray();
});
const turned = Math.acos(Math.max(-1, Math.min(1,
  look0[0] * look1[0] + look0[1] * look1[1] + look0[2] * look1[2]))) * 180 / Math.PI;
console.log(`  view turned            ${turned.toFixed(1)}°`);

/*
 * The horizon must be LEVEL — camera.up pinned to world up. The follow rig
 * tilts camera.up onto whatever surface she is standing on, and a designer
 * that inherits that up rolls the view on every turn.
 */
const upNow = await page.evaluate(() => window.blockScene.camera.up.toArray());
const level = Math.abs(upNow[0]) < 1e-6 && Math.abs(upNow[1] - 1) < 1e-6 && Math.abs(upNow[2]) < 1e-6;
console.log(`  horizon level          ${level} (up = ${upNow.map(v => v.toFixed(2)).join(', ')})`);

// Two fingers slide the view: the camera TRANSLATES and does not turn.
const pan0 = await page.evaluate(() => {
  const V = Object.getPrototypeOf(window.blockScene.at).constructor;
  return {
    at: window.blockScene.camera.position.toArray(),
    look: window.blockScene.camera.getWorldDirection(new V()).toArray(),
  };
});
await canvas.dispatchEvent('pointerdown', { pointerId: 3, clientX: 640, clientY: 180 });
await canvas.dispatchEvent('pointerdown', { pointerId: 4, clientX: 760, clientY: 200 });
for (let i = 1; i <= 6; i += 1) {
  await canvas.dispatchEvent('pointermove', { pointerId: 3, clientX: 640 + i * 10, clientY: 180 + i * 6 });
  await canvas.dispatchEvent('pointermove', { pointerId: 4, clientX: 760 + i * 10, clientY: 200 + i * 6 });
  await page.waitForTimeout(20);
}
await canvas.dispatchEvent('pointerup', { pointerId: 3, clientX: 700, clientY: 216 });
await canvas.dispatchEvent('pointerup', { pointerId: 4, clientX: 820, clientY: 236 });
await page.waitForTimeout(150);
const pan1 = await page.evaluate(() => {
  const V = Object.getPrototypeOf(window.blockScene.at).constructor;
  return {
    at: window.blockScene.camera.position.toArray(),
    look: window.blockScene.camera.getWorldDirection(new V()).toArray(),
  };
});
const slid = Math.hypot(pan1.at[0] - pan0.at[0], pan1.at[1] - pan0.at[1], pan1.at[2] - pan0.at[2]);
const panTurn = Math.acos(Math.max(-1, Math.min(1,
  pan0.look[0] * pan1.look[0] + pan0.look[1] * pan1.look[1] + pan0.look[2] * pan1.look[2]))) * 180 / Math.PI;
console.log(`  two-finger slide       ${slid.toFixed(2)} units, view turned ${panTurn.toFixed(2)}°`);

// A drag on empty space must NOT have driven her or spawned a joystick.
const drove = await page.evaluate(() => ({
  walk: window.blockScene.input.walk,
  yaw: window.blockScene.input.yaw,
  stick: !!document.querySelector('.density-lab-stick.is-live'),
}));
console.log(`  joystick stayed away   ${!drove.stick && drove.walk === 0 && drove.yaw === 0}`);

/*
 * PRESS PLACE THREE TIMES AND SEE WHETHER A TUNNEL APPEARS.
 *
 * This is the whole of the rework. A fresh nest is one entrance — the Station
 * — already selected, and PLACE hangs a new piece off whatever is selected and
 * JOINS it. So three presses should give four nodes and three edges, in a
 * chain, each one lower than the last.
 *
 * The previous version of this probe selected a node from the worked example
 * by name and no longer had one to select, so PLACE fell back to dropping a
 * loose node at the camera and the run reported zero edges. That was the probe
 * being stale, but the failure it printed is exactly what a player saw before
 * the rework: press the button, nothing joins up, nothing carves.
 */
await press('ROOM');
await press('\\+ PLACE');
await press('\\+ PLACE');
await press('\\+ PLACE');

const drawn = await page.evaluate(() => {
  const p = window.blockScene.designerForTest().current();
  return {
    nodes: p.nodes.length,
    edges: p.edges.length,
    last: p.nodes[p.nodes.length - 1],
    depths: p.nodes.map(n => Math.round(n.y)),
    chained: p.edges.length === p.nodes.length - 1,
  };
});
console.log('\nBUILDING');
console.log(`  nodes ${before} → ${drawn.nodes}, edges ${drawn.edges}`);
console.log(`  one chain, no loose pieces  ${drawn.chained}`);
console.log(`  depths (mm up)             ${drawn.depths.join(' → ')}`);
console.log(`  newest piece at ${drawn.last.x.toFixed(0)}, ${drawn.last.y.toFixed(0)}, `
  + `${drawn.last.z.toFixed(0)} mm, r=${drawn.last.radiusMm}`);

const descends = drawn.depths.every((d, i) => i === 0 || d < drawn.depths[i - 1]);
console.log(`  each piece below the last  ${descends}`);

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
  && swung > 1 && turned > 5 && level && slid > 0.5 && panTurn < 1 && !drove.stick
  && before === 1 && drawn.nodes === 4 && drawn.edges === 3 && drawn.chained && descends
  && soilBefore === true && soilAfter === false
  && undone === drawn.edges - 1
  && !closed.designing && closed.playControlsVisible;
console.log(`\n  ${pass ? 'PASS' : 'FAIL'}\n`);
if (errs.length) console.log('  page errors:', errs.slice(0, 5));

await browser.close();
process.exit(pass && !errs.length ? 0 : 1);
