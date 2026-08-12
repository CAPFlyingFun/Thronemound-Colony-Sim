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

/*
 * THE DEFAULT ROUTE, which is now the menu with the island building behind
 * it. Loaded bare — no `?scene=` — because that is what a player opens and
 * what a home-screen PWA launches.
 */
await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
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

/*
 * THE MENU IS THE LOADING SCREEN. START must be shut until she is standing,
 * the status line must actually say what the boot is doing, and pressing
 * START must reveal an island that is ALREADY there rather than starting one.
 */
const booting = await page.evaluate(() => ({
  startShut: !!document.querySelector('.main-menu__button[data-key="onStart"]')?.disabled,
  status: document.querySelector('.main-menu__status')?.textContent ?? '',
  devLive: !document.querySelector('.main-menu__button[data-key="onDev"]')?.disabled,
}));
console.log(`booting: START ${booting.startShut ? 'shut' : 'OPEN'}, `
  + `DEV ${booting.devLive ? 'live' : 'shut'}, status "${booting.status}"`);
if (!booting.startShut) fail.push('START was pressable before the island had loaded');
if (!booting.status) fail.push('the menu showed no loading status while the island built');
/* Everything that does not need terrain stays reachable during the wait —
 * that is the whole point of spending the boot on a menu. */
if (!booting.devLive) fail.push('DEV was locked out while the island loaded');

await page.waitForFunction(
  () => {
    const b = document.querySelector('.main-menu__button[data-key="onStart"]');
    return !!b && !b.disabled;
  },
  null, { timeout: 200000 },
).catch(() => fail.push('START never opened — the island never reported ready'));

const loaded = await page.evaluate(() => ({
  islandReady: !!window.islandScene?.ready,
  player: window.islandScene?.loadingStateForTest?.().player ?? 0,
  status: document.querySelector('.main-menu__status')?.textContent ?? '',
}));
console.log(`loaded : island ready ${loaded.islandReady}, player ${loaded.player}, `
  + `status "${loaded.status}"`);
if (!loaded.islandReady) fail.push('START opened while the island was not ready');
if (loaded.player !== 1) fail.push('START opened before the queen had settled');

/* Pressing START must simply take the menu down. */
await page.click('.main-menu__button[data-key="onStart"]');
await page.waitForTimeout(400);
const started = await page.evaluate(() => ({
  menuGone: !document.querySelector('.main-menu'),
  stillIsland: !!window.islandScene?.ready,
  navigated: window.location.search,
}));
console.log(`start  : menu gone ${started.menuGone}, island alive ${started.stillIsland}, `
  + `url "${started.navigated || '(unchanged)'}"`);
if (!started.menuGone) fail.push('START left the menu on screen');
if (!started.stillIsland) fail.push('START lost the island it had already built');
if (started.navigated) fail.push(`START navigated to "${started.navigated}" — it should not reload`);

/*
 * SAVE AND RESUME, which is the thing that made digging feel provisional:
 * a tunnel was an hour's work and it evaporated with the tab.
 *
 * Measured on the SOIL, not on the button. She digs, the edit count goes up,
 * a save is written; then the page is RELOADED — a real one, not a re-render
 * — and RESUME has to bring the same count back. Anything less and the save
 * is a button that lights up.
 */
const dug = await page.evaluate(async () => {
  const s = window.islandScene;
  s.setPausedForTest(true);
  s.aimPitchForTest(-1.0);
  s.input.dig = true;
  s.stepForTest(0.023, 90);
  s.input.dig = false;
  /* How big the save actually is, because localStorage is about five
   * megabytes and a nest is eight bytes a sample — the number matters. */
  const bytes = s.stream?.serializeEdits().length ?? 0;
  return {
    edits: s.stream?.editedSamples ?? 0,
    bytes,
    saved: s.saveToStorage(),
    stored: (window.localStorage.getItem('thronemound.island.v1') ?? '').length,
    at: [s.at.x, s.at.y, s.at.z],
  };
});
console.log(`save   : dug ${dug.edits} samples = ${(dug.bytes / 1024).toFixed(0)} KiB raw, `
  + `${(dug.stored / 1024).toFixed(0)} KiB stored, saved ${dug.saved}`);
if (!dug.edits) fail.push('the probe dug nothing, so the save proves nothing');
if (!dug.saved) fail.push('saving the island failed');

await page.reload({ waitUntil: 'domcontentloaded' });
/*
 * EXISTENCE FIRST, THEN ENABLED — and the order is not pedantry.
 *
 * The check here was `!document.querySelector(sel)?.disabled`, which for a
 * MISSING element is `!undefined`, which is true. So straight after a reload,
 * before the menu's module had even imported, the wait passed instantly and
 * every measurement after it was taken against a page with no menu on it:
 * the click hit nothing, the restore never ran from the button, and three
 * runs were spent reading that as a broken feature.
 */
/*
 * The key is passed as an ARGUMENT, not closed over. Playwright serialises
 * this function into the page, where the surrounding scope does not exist —
 * a closed-over `key` throws "key is not defined" inside the browser, the
 * wait rejects, and the `.catch` below turns a broken predicate into a
 * confident report that the button never lit up.
 */
const waitEnabled = (key) => page.waitForFunction(
  (k) => {
    const el = document.querySelector(`.main-menu__button[data-key="${k}"]`);
    return !!el && !el.disabled;
  },
  key,
  { timeout: 200000 },
);
await waitEnabled('onResume')
  .catch(() => fail.push('RESUME never lit up after a save'));

const beforeResume = await page.evaluate(() => window.islandScene?.stream?.editedSamples ?? 0);
/*
 * Dispatched rather than `page.click`ed. RESUME rebuilds every chunk in the
 * window synchronously, so the main thread is blocked for the whole restore
 * and Playwright's post-click stability wait times out on a page that is
 * merely busy. The button is real and enabled — the log above proves it —
 * so what is being tested is the restore, not the actuality of the click.
 */
/* One place, one report: how many menus are on the page, whether the button
 * is really enabled, and what changed the instant it is clicked. Three runs
 * were spent inferring this from the outside. */
const clicked = await page.evaluate(() => {
  const all = [...document.querySelectorAll('.main-menu__button[data-key="onResume"]')];
  const btn = all[0];
  const before = {
    menus: document.querySelectorAll('.main-menu').length,
    buttons: all.length,
    disabled: all.map((b) => b.disabled),
  };
  btn?.click();
  return {
    ...before,
    status: document.querySelector('.main-menu__status')?.textContent ?? '',
    menusNow: document.querySelectorAll('.main-menu').length,
  };
});
console.log(`click  : ${clicked.menus} menu(s), ${clicked.buttons} RESUME button(s) `
  + `disabled=${JSON.stringify(clicked.disabled)} -> ${clicked.menusNow} menu(s), `
  + `status "${clicked.status}"`);
/*
 * WAITED FOR, not slept through. Restoring rebuilds every chunk in the
 * window synchronously — seventy thousand edits is seconds of work on a
 * software renderer — so a fixed pause measures the machine rather than the
 * feature. Twice this probe reported a working restore as broken because it
 * looked before the main thread came back.
 */
await page.waitForFunction(
  () => !document.querySelector('.main-menu'), null, { timeout: 120000 },
).catch(() => { /* reported below, with the reason */ });
const resumed = await page.evaluate(() => {
  const s = window.islandScene;
  /* If the button's restore did not take, call it directly and report what
   * it says — a probe that only knows "it did not work" cannot be acted on. */
  let why = document.querySelector('.main-menu__status')?.textContent ?? '';
  /*
   * DIAGNOSTIC ONLY, and only when the BUTTON failed to restore.
   *
   * It used to run unconditionally, which quietly made the probe unable to
   * fail: a button that did nothing would still end with the right number of
   * edits, because this call put them back. A check that repairs the thing
   * it is checking is not a check. So it runs only when there is already a
   * failure to explain, and says so.
   */
  if ((s?.stream?.editedSamples ?? 0) === 0) {
    why += ' | the BUTTON restored nothing;';
    try {
      why += ` a direct call returned ${s.resumeFromStorage()}`;
    } catch (e) {
      why += ` a direct call THREW: ${e && e.message ? e.message : String(e)}`;
    }
  }
  return {
    edits: s?.stream?.editedSamples ?? 0,
    at: [s.at.x, s.at.y, s.at.z],
    menuGone: !document.querySelector('.main-menu'),
    why,
  };
});
const moved = Math.hypot(
  resumed.at[0] - dug.at[0], resumed.at[1] - dug.at[1], resumed.at[2] - dug.at[2],
) * 5;
console.log(`resume : fresh island had ${beforeResume} edits, after RESUME ${resumed.edits}`
  + ` (saved ${dug.edits}); she came back within ${moved.toFixed(2)} mm`);
console.log(`         menu gone ${resumed.menuGone} — ${resumed.why}`);
if (beforeResume >= dug.edits) {
  fail.push('the reloaded island already had the digs — nothing was proved');
}
if (resumed.edits !== dug.edits) {
  fail.push(`RESUME restored ${resumed.edits} of ${dug.edits} dug samples`
    + ` (it said: "${resumed.why}")`);
}
if (!resumed.menuGone) fail.push('RESUME left the menu up');
/* Where she stood is part of the save; centimetres out means it was ignored. */
if (moved > 5) fail.push(`RESUME put her ${moved.toFixed(1)} mm from where she saved`);

/* And the old direct route is untouched, because forty probes use it. */
await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
const direct = await page.evaluate(() => !!document.querySelector('.main-menu'));
if (direct) fail.push('?scene=island now shows the menu — the direct route changed');
console.log(`direct : ?scene=island still goes straight in (${direct ? 'NO' : 'yes'})`);

/* Back to the menu for the PIN checks. */
await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.main-menu__button', { timeout: 60000 });

/* DEV opens the keypad rather than the tools. */
await page.click('.main-menu__button[data-key="onDev"]');
/* `waitForSelector` on this one reported the pad visible and then timed out
 * anyway — the pad is plainly there, so ask the DOM directly. */
await page.waitForFunction(
  () => !!document.querySelector('.main-menu__pad'), null, { timeout: 10000 },
);
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
