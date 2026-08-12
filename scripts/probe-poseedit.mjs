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
 * THE MENU IS THE LOADING SCREEN, AND START IS PRESSABLE FROM THE FIRST
 * FRAME.
 *
 * It used to sit greyed until the island had finished, which was reported as
 * feeling broken — the one thing you came to press refusing, for no visible
 * reason. So the wait moved BEHIND the button: START is live immediately, and
 * pressing it early puts up the original loading curtain, which lifts by
 * itself when she is standing. Pressed late, the curtain never appears,
 * because the island has been building behind the menu the whole time.
 */
const booting = await page.evaluate(() => ({
  startLive: !document.querySelector('.main-menu__button[data-key="onStart"]')?.disabled,
  saveShut: !!document.querySelector('.main-menu__button[data-key="onSave"]')?.disabled,
  status: document.querySelector('.main-menu__status')?.textContent ?? '',
  devLive: !document.querySelector('.main-menu__button[data-key="onDev"]')?.disabled,
  ready: !!window.islandScene?.ready,
}));
console.log(`booting: START ${booting.startLive ? 'live' : 'SHUT'}, `
  + `SAVE ${booting.saveShut ? 'shut' : 'live'}, DEV ${booting.devLive ? 'live' : 'shut'}, `
  + `island ready ${booting.ready}, status "${booting.status}"`);
if (!booting.startLive) fail.push('START was not pressable while the island loaded');
if (!booting.status) fail.push('the menu showed no loading status while the island built');
if (!booting.devLive) fail.push('DEV was locked out while the island loaded');
/* SAVE is the one that genuinely cannot do anything yet — a live button that
 * silently does nothing is worse than a grey one. */
if (!booting.ready && !booting.saveShut) fail.push('SAVE was live before there was anything to save');

/*
 * PRESS IT WHILE IT IS STILL LOADING. The menu must go, the original curtain
 * must appear in its place, and it must lift on its own.
 */
if (!booting.ready) {
  await page.$eval('.main-menu__button[data-key="onStart"]', (el) => el.click());
  await page.waitForTimeout(300);
  const mid = await page.evaluate(() => ({
    menuGone: !document.querySelector('.main-menu'),
    curtain: !!document.querySelector('.tm-loading-root'),
    text: document.querySelector('.tm-loading-root')?.textContent ?? '',
  }));
  console.log(`pressed: menu gone ${mid.menuGone}, curtain up ${mid.curtain}`);
  if (!mid.menuGone) fail.push('START left the menu up while loading');
  if (!mid.curtain) fail.push('START while loading showed no loading screen — it just hangs');
  if (mid.curtain && !mid.text.trim()) fail.push('the loading screen says nothing');
} else {
  console.log('pressed: (the island had already finished — no curtain needed)');
}

/* PLAYER ready, not world ready — the queen settles after the world is
 * built, and the curtain is tied to the later of the two. */
await page.waitForFunction(
  () => window.islandScene?.loadingStateForTest?.().player === 1,
  null, { timeout: 200000 },
).catch(() => fail.push('the island never became playable'));
/* And the curtain lets go by itself. */
await page.waitForFunction(
  () => !document.querySelector('.tm-loading-root'), null, { timeout: 30000 },
).catch(() => fail.push('the loading screen never lifted after the island was ready'));

const loaded = await page.evaluate(() => ({
  islandReady: !!window.islandScene?.ready,
  player: window.islandScene?.loadingStateForTest?.().player ?? 0,
  menuGone: !document.querySelector('.main-menu'),
  curtainGone: !document.querySelector('.tm-loading-root'),
}));
console.log(`loaded : island ready ${loaded.islandReady}, player ${loaded.player}, `
  + `menu gone ${loaded.menuGone}, curtain gone ${loaded.curtainGone}`);
if (!loaded.islandReady) fail.push('the island never reported ready');
if (loaded.player !== 1) fail.push('the curtain lifted before the queen had settled');
if (!loaded.curtainGone) fail.push('the loading screen is still up');

/* If she had already finished before START was pressed, press it now. */
if (!loaded.menuGone) {
  await page.$eval('.main-menu__button[data-key="onStart"]', (el) => el.click());
  await page.waitForTimeout(300);
}
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

/*
 * WATCH THE BUTTON'S OWN CALL. Twice now the run has gone green on a RESUME
 * that did nothing, because the diagnostic below restored the nest itself and
 * the edit count then matched. Wrapping the method records whether the button
 * path ever called it and what it answered — so "the button works" is
 * something observed rather than inferred from a number anything could have
 * produced.
 */
await page.evaluate(() => {
  const s = window.islandScene;
  const orig = s.resumeFromStorage.bind(s);
  window.__resumeCalls = [];
  s.resumeFromStorage = (...a) => {
    const r = orig(...a);
    window.__resumeCalls.push(r);
    return r;
  };
});
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
  /*
   * READ FIRST, BEFORE THE DIAGNOSTIC CALLS ANYTHING. The previous cut took
   * this snapshot at the END of the block, by which point the diagnostic
   * below had made its own call and been recorded as if it were the button's
   * — the same contamination, one level up. What the button did has to be
   * captured before anything else is allowed to touch it.
   */
  const byButton = [...(window.__resumeCalls ?? [])];
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
    /* What the BUTTON's own path did, captured before the diagnostic ran. */
    byButton,
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
/* The BUTTON has to be the thing that did it. */
if (resumed.byButton.length === 0) {
  fail.push('the RESUME button never called the restore at all');
} else if (resumed.byButton[0] !== true) {
  fail.push(`the RESUME button's own call returned ${resumed.byButton[0]}`);
}
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
await page.waitForFunction(
  () => !!document.querySelector('.main-menu__button[data-key="onDev"]'),
  null, { timeout: 60000 },
);
await page.$eval('.main-menu__button[data-key="onDev"]', (el) => el.click());
/* `waitForSelector` on this one reported the pad visible and then timed out
 * anyway — the pad is plainly there, so ask the DOM directly. */
await page.waitForFunction(
  () => !!document.querySelector('.main-menu__pad'), null, { timeout: 10000 },
);
const dots = await page.evaluate(() => document.querySelectorAll('.main-menu__dot').length);
if (dots !== 4) fail.push(`the keypad drew ${dots} dots for a four-digit PIN`);

/* A wrong PIN must not open anything, and must clear itself. */
/*
 * Dispatched, not `page.click`ed. The last digit of a CORRECT PIN navigates,
 * and `click` then waits for that navigation to settle — which is the pose
 * editor booting a model, well past its timeout. The keypad is plain DOM;
 * pressing it is not what is under test here.
 */
const tap = (d) => page.evaluate((digit) => {
  const key = [...document.querySelectorAll('.main-menu__key')]
    .find((el) => el.textContent === digit);
  key?.click();
}, d);
for (const d of '1234') await tap(d);
const afterWrong = await page.evaluate(() => ({
  stillOnMenu: !!document.querySelector('.main-menu__pad'),
  lit: document.querySelectorAll('.main-menu__dot.is-on').length,
  note: document.querySelector('.main-menu__note')?.textContent ?? '',
}));
if (!afterWrong.stillOnMenu) fail.push('a WRONG PIN left the keypad');
if (afterWrong.lit !== 0) fail.push(`a wrong PIN left ${afterWrong.lit} digits typed`);
console.log(`wrong PIN: still gated, entry cleared, says "${afterWrong.note}"`);

/* And the right one goes through. */
for (const d of '2026') await tap(d);
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

/*
 * THE BONE HANDLES — "raw bone points you can press to select at joints that
 * aren't labeled, or we could label everything".
 *
 * Three separate claims, and a screenshot satisfies none of them: every bone
 * has a NAME, a tap on the dot in the viewport SELECTS that bone, and turning
 * one moves that bone WITHOUT moving its neighbours in the same chain. The
 * last is the one that says the per-bone layer is really per bone — a handle
 * that quietly spread down the chain would look identical in the panel.
 */
const bones = await page.evaluate(() => {
  const s = window.poseEditor;
  s.setBoneModeForTest(true);
  const handles = s.boneHandlesForTest();
  const rig = s.queen.rig;
  const leg = rig.legs[0];
  /* A joint in the MIDDLE of a chain: the one a group handle can never
   * isolate, and the reason the whole feature was asked for. */
  const target = leg.bones[2];
  const neighbour = leg.bones[3];
  const q = (name) => {
    const b = s.queen.root.getObjectByName(name);
    return b ? b.quaternion.clone() : null;
  };
  const deg = (a, b) => (a && b
    ? 2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * (180 / Math.PI) : -1);

  const beforeTarget = q(target);
  const beforeNeighbour = q(neighbour);
  s.setDialForTest(`bone:${target}`, 'pitch', 45);
  const movedTarget = deg(beforeTarget, q(target));
  const movedNeighbour = deg(beforeNeighbour, q(neighbour));
  s.setDialForTest(`bone:${target}`, 'pitch', 0);

  /* And the tap: aim at where the dot actually is, as a finger would. */
  const spot = s.markerScreenForTest(target);
  const tapped = spot ? s.tapForTest(spot.x, spot.y) : null;
  /* A tap on empty space must NOT steal the orbit drag. */
  const missed = s.tapForTest(2, 2);

  const named = handles.find((h) => h.bone === target);
  return {
    count: handles.length,
    sample: handles.slice(0, 4).map((h) => h.label),
    antenna: handles.filter((h) => h.label.startsWith('Antenna R')).map((h) => h.label),
    targetLabel: named?.label ?? null,
    movedTarget,
    movedNeighbour,
    tapped,
    wanted: `bone:${target}`,
    missed,
    picked: s.pickedForTest(),
    unnamed: handles.filter((h) => /^Bone_\d+$/.test(h.label)).length,
  };
});

console.log(`bones  : ${bones.count} per-bone handles, ${bones.unnamed} still unnamed`);
console.log(`         ${bones.antenna.join(' · ')}`);
console.log(`         turning "${bones.targetLabel}" moved it ${bones.movedTarget.toFixed(1)}°, `
  + `its neighbour ${bones.movedNeighbour.toFixed(1)}°`);
console.log(`         a tap on its dot selected ${bones.tapped ?? 'nothing'}`);

if (bones.count < 40) fail.push(`only ${bones.count} per-bone handles — the rig has far more`);
if (bones.unnamed > 0) {
  fail.push(`${bones.unnamed} bone handles fell back to a raw Bone_ number`);
}
if (bones.movedTarget < 1) {
  fail.push(`turning a single bone moved it ${bones.movedTarget.toFixed(2)}° — not wired`);
}
/* The claim that makes it per-BONE rather than another group. */
if (bones.movedNeighbour > 0.5) {
  fail.push(`turning one bone also moved its neighbour ${bones.movedNeighbour.toFixed(2)}°`);
}
if (bones.tapped !== bones.wanted) {
  fail.push(`a tap on the dot selected ${bones.tapped ?? 'nothing'}, wanted ${bones.wanted}`);
}
if (bones.missed !== null) fail.push('a tap on empty space selected a bone anyway');

/*
 * THE TIMELINE: key, play, and load it back.
 *
 * Measured on the BONE at several moments, because "it plays" is exactly the
 * kind of claim a button can appear to satisfy while nothing moves. A clip
 * with two different keys must put the skeleton somewhere DIFFERENT at three
 * different times, come back to the same place at the same time, and survive
 * a save and a reload.
 */
const anim = await page.evaluate(async () => {
  const s = window.poseEditor;
  const rig = s.queen.rig;
  const bone = rig.gaster[0];
  const read = () => {
    const b2 = s.queen.root.getObjectByName(bone);
    return b2 ? b2.quaternion.clone() : null;
  };
  const angle = (a, b2) => (a && b2
    ? 2 * Math.acos(Math.min(1, Math.abs(a.dot(b2)))) * (180 / Math.PI) : 0);

  /* Key a neutral gaster at 0, a bent one at 1. */
  s.setDialForTest('gaster', 'pitch', 0);
  s.clip = { name: 'Sting', duration: 2, loop: true, keys: [] };
  s.head = 0;
  document.querySelectorAll('.pose-line .pose-button').forEach((el) => {
    if (el.textContent === 'KEY') el.click();
  });
  s.setDialForTest('gaster', 'pitch', -70);
  s.head = 1;
  document.querySelectorAll('.pose-line .pose-button').forEach((el) => {
    if (el.textContent === 'KEY') el.click();
  });
  const keys = s.clip.keys.length;

  /* Scrub to three moments and read the skeleton at each. */
  const at = {};
  for (const t of [0, 0.5, 1]) { s.head = t; s.showAt(t); at[t] = read(); }
  const spread = [angle(at[0], at[0.5]), angle(at[0.5], at[1]), angle(at[0], at[1])];

  /* Play, and see the playhead actually advance. */
  s.head = 0;
  s.playing = true;
  const t0 = s.head;
  await new Promise((r) => setTimeout(r, 500));
  const moved = s.head - t0;
  s.playing = false;

  /* Save it, then load it back from the list. */
  s.nameBox.value = 'Sting';
  document.querySelectorAll('.pose-row .pose-button').forEach((el) => {
    if (el.textContent === 'SAVE') el.click();
  });
  const inList = [...s.list.options].map((o) => o.value).includes('Sting');
  s.clip = { name: 'x', duration: 2, loop: true, keys: [] };
  const back = s.clipStore.get('Sting');
  if (back) s.loadClip(back);
  return {
    keys, spread, moved, inList, reloadedKeys: s.clip.keys.length, saved: !!back,
  };
});

console.log(`clip   : ${anim.keys} keys, bone moved ${anim.spread.map((v) => v.toFixed(1)).join('° / ')}° `
  + `between 0, 0.5 and 1s`);
console.log(`play   : the playhead advanced ${anim.moved.toFixed(2)}s in half a second`);
console.log(`store  : saved ${anim.saved}, in the list ${anim.inList}, `
  + `reloaded with ${anim.reloadedKeys} keys`);

if (anim.keys !== 2) fail.push(`KEY dropped ${anim.keys} keys instead of 2`);
/* Different at each moment, and travelling BETWEEN them rather than snapping
 * — a mid-point identical to an end is a clip that is not interpolating. */
if (anim.spread[2] < 5) fail.push('the two keys put the bone in the same place — nothing is keyed');
if (anim.spread[0] < 1 || anim.spread[1] < 1) {
  fail.push(`the half-way pose is not between the keys (${anim.spread.join(', ')})`);
}
if (anim.moved < 0.2 || anim.moved > 1.2) {
  fail.push(`PLAY advanced the playhead ${anim.moved.toFixed(2)}s in half a second`);
}
if (!anim.saved || !anim.inList) fail.push('the clip did not save into the list');
if (anim.reloadedKeys !== 2) fail.push(`loading the clip back gave ${anim.reloadedKeys} keys`);

console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
if (errs.length) fail.push(`${errs.length} page error(s)`);
await browser.close();
if (fail.length) {
  console.log(`\nFAILED: ${fail.join('; ')}`);
  process.exit(1);
}
console.log('\nall green — the door opens, the PIN gates, and the handles reach her bones');
