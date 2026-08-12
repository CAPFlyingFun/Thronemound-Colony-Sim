/**
 * DOES THE FRONT DOOR OPEN, AND DOES THE POSE EDITOR POSE HER?
 *
 * Two new routes, neither of which any test can reach: `?scene=menu` is DOM
 * and `?scene=poseedit` needs a GLB, a WebGL context and a skeleton. The unit
 * tests cover the parts that are pure — the PIN gate, the pose maths, the
 * store — and this covers the parts that only exist in a browser.
 *
 * What it pins:
 *
 *   1. the menu draws all six entries, and the ones with nothing behind them
 *      are DISABLED rather than missing — a menu that changes shape as
 *      features land is one nobody learns;
 *   2. DEV opens a keypad rather than the tools, and a wrong PIN does not;
 *   3. the right PIN does, and leaves nothing typed behind it;
 *   4. the editor finds her bones and offers a handle per body group,
 *      including all six legs;
 *   5. turning a handle actually moves the skeleton — measured on the BONE,
 *      not on the slider, because a slider that updates a number nothing
 *      reads is exactly the bug this is here to catch;
 *   6. and a pose carries no position, which is the one thing the request
 *      was explicit about.
 *
 *   npm run probe:poseedit      # needs `vite preview` already running
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const fail = [];
const page = await browser.newPage({
  viewport: { width: 900, height: 600 },
  serviceWorkers: 'block',
});
page.on('pageerror', (e) => errs.push(e.message));

/* ------------------------------------------------------------- the menu */

await page.goto(`${base}/?scene=menu`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.main-menu__button', { timeout: 60000 });

const menu = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('.main-menu__button')];
  return {
    labels: buttons.map((b) => b.textContent),
    disabled: buttons.filter((b) => b.disabled).map((b) => b.textContent),
    padOpen: !!document.querySelector('.main-menu__pad'),
  };
});
console.log(`menu: ${menu.labels.join(' / ')}`);
console.log(`      not wired yet: ${menu.disabled.join(', ') || 'none'}`);

for (const want of ['START', 'RESUME', 'SAVE', 'SETTINGS', 'INFO', 'DEV']) {
  if (!menu.labels.includes(want)) fail.push(`the menu has no ${want}`);
}
if (menu.padOpen) fail.push('the PIN pad was showing before DEV was pressed');

/* DEV opens the keypad rather than the tools. */
await page.click('.main-menu__button[data-key="onDev"]');
await page.waitForSelector('.main-menu__pad', { timeout: 5000 });
const dots = await page.evaluate(() => document.querySelectorAll('.main-menu__dot').length);
if (dots !== 4) fail.push(`the keypad drew ${dots} dots for a four-digit PIN`);

/* A wrong PIN must not open anything, and must clear itself. */
for (const d of '1234') await page.click(`.main-menu__key >> text="${d}"`);
const afterWrong = await page.evaluate(() => ({
  stillOnMenu: !!document.querySelector('.main-menu__pad'),
  lit: document.querySelectorAll('.main-menu__dot.is-on').length,
  note: document.querySelector('.main-menu__note')?.textContent ?? '',
}));
if (!afterWrong.stillOnMenu) fail.push('a WRONG PIN left the keypad');
if (afterWrong.lit !== 0) fail.push(`a wrong PIN left ${afterWrong.lit} digits typed`);
console.log(`wrong PIN: still gated, entry cleared, says "${afterWrong.note}"`);

/* And the right one goes through. */
for (const d of '2026') await page.click(`.main-menu__key >> text="${d}"`);
await page.waitForFunction(
  () => window.location.search.includes('poseedit'), null, { timeout: 10000 },
).catch(() => fail.push('the right PIN did not open the dev tools'));
console.log(`right PIN: ${page.url().split('?')[1] ?? '(did not navigate)'}`);

/* --------------------------------------------------------- the editor */

await page.goto(`${base}/?scene=poseedit`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.poseEditor?.ready, null, { timeout: 120000 })
  .catch(() => fail.push('the pose editor never became ready'));

const edit = await page.evaluate(() => {
  const s = window.poseEditor;
  const handles = [...document.querySelectorAll('#pose-groups .pose-button')]
    .map((b) => b.textContent.replace(' •', ''));

  /* Turn a leg, and read the BONE rather than the slider. */
  const rig = s.queen.rig;
  const legBone = rig.legs[0].bones[0];
  const before = s.queen.root.getObjectByName(legBone).quaternion.clone();
  s.setDialForTest(rig.legs[0].slot, 'pitch', 60);
  const after = s.queen.root.getObjectByName(legBone).quaternion.clone();
  const movedDeg = 2 * Math.acos(Math.min(1, Math.abs(before.dot(after)))) * (180 / Math.PI);

  /* And the gaster, which is the sting-arch chain. */
  s.setDialForTest('gaster', 'pitch', -40);
  const pose = s.poseForTest();

  return {
    handles,
    legs: rig.legs.length,
    movedDeg,
    bonesWritten: Object.keys(pose.rotations).length,
    keys: Object.keys(pose),
    gasterWritten: rig.gaster.every((b) => b in pose.rotations),
  };
});

console.log(`editor: ${edit.handles.length} handles — ${edit.handles.join(', ')}`);
console.log(`        turning a leg 60° moved its coxa ${edit.movedDeg.toFixed(1)}°, `
  + `${edit.bonesWritten} bones written`);

if (edit.handles.length < 8) fail.push(`only ${edit.handles.length} handles — groups are missing`);
for (const want of ['Body', 'Thorax', 'Head', 'Gaster', 'Front L', 'Rear R']) {
  if (!edit.handles.includes(want)) fail.push(`no "${want}" handle`);
}
/* The whole point: the slider has to reach the skeleton. A dial that updates
 * a number nothing reads looks identical in a screenshot. */
if (edit.movedDeg < 1) {
  fail.push(`turning a leg moved its bone ${edit.movedDeg.toFixed(2)}° — the dial is not wired`);
}
if (!edit.gasterWritten) fail.push('the gaster chain was not written by its own handle');
/* "doesn't save the x/y/z, only body bones" — enforced by the type, checked
 * here on the real thing. */
if (edit.keys.sort().join(',') !== 'name,rotations') {
  fail.push(`a pose carries ${edit.keys.join(', ')} — it must be name and rotations only`);
}

console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
if (errs.length) fail.push(`${errs.length} page error(s)`);
await browser.close();
if (fail.length) {
  console.log(`\nFAILED: ${fail.join('; ')}`);
  process.exit(1);
}
console.log('\nall green — the door opens, the PIN gates, and the handles reach her bones');
