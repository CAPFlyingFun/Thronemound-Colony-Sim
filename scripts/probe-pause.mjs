/**
 * THE DOOR THAT NO LONGER BURNS THE HOUSE DOWN.
 *
 *     npx vite --port 5173                                 # then
 *     SMOKE_URL=http://127.0.0.1:5173/ npm run probe:pause
 *
 * The MENU plate ran `window.location.href = BASE_URL`. Nothing in the unit
 * suite could see that, because nothing in the unit suite has a `window` to
 * lose — and the bug WAS the losing. A full reload throws away the streamed
 * window, the colony and the founding, with no confirmation and nowhere to
 * save first, since SAVE lived only on the front menu you could not reach
 * except by pressing it.
 *
 * So the first and most important measurement here is a NEGATIVE one: a
 * sentinel written onto `window` before the press, still there after it. A
 * reload would wipe it. Everything else — the freeze, the lossless resume,
 * the save, the two-press exit — is only worth checking once that holds.
 *
 * It drives the FRONT DOOR, not `?scene=island`: the pause menu belongs to
 * whoever owns the page, and on the bare island route there is no front menu
 * to return to, so that route keeps the old reload deliberately.
 */
import { chromium } from 'playwright';

/*
 * THE FRONT DOOR MOVED to `?scene=menu` — Thronemound's default route is the
 * colony simulator now. This probe is about the island's pause/menu/save
 * flow, so it asks for that door by name.
 */
const BASE = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const URL = BASE.includes('?') ? BASE : `${BASE.replace(/\/$/, '')}/?scene=menu`;
const SAVE_KEY = 'thronemound.island.v1';

const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const p = await b.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

const log = [];
const ok = (what, cond) => log.push([what, cond === true]);

await p.goto(URL, { waitUntil: 'domcontentloaded' });

/* --- into the game through the front door, exactly as a player does --- */
await p.waitForSelector('.main-menu__button[data-key="onStart"]', { timeout: 90000 });
await p.waitForFunction(
  () => !document.querySelector('.main-menu__button[data-key="onStart"]')?.disabled,
  null, { timeout: 240000 },
);
/* Dispatched rather than clicked, for probe-boot's reason: the island is
 * meshing behind the menu and actionability can expire on a fine button. */
await p.evaluate(() => document.querySelector(
  '.main-menu__button[data-key="onStart"]',
).click());
await p.waitForFunction(
  () => window.islandScene?.playerReady === true, null, { timeout: 240000 },
);
await p.waitForFunction(
  () => document.querySelector('.tm-loading-root') === null, null, { timeout: 240000 },
);
await p.waitForTimeout(600);

/*
 * THE SENTINEL. Written on the live page; a reload takes it with it. Also
 * stamped onto the scene object, so "same island" is checked by identity
 * rather than by the name `window.islandScene` merely being bound to
 * something again.
 */
await p.evaluate(() => {
  window.__tmAlive = 'before-menu';
  window.islandScene.__tmMark = 'before-menu';
  window.localStorage.removeItem('thronemound.island.v1');
});

/* --- 1. the press, and what it did NOT do --- */
await p.evaluate(() => document.querySelector('.tm-art-menu')
  .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })));
await p.waitForTimeout(400);

const pressed = await p.evaluate(() => ({
  sentinel: window.__tmAlive ?? null,
  mark: window.islandScene?.__tmMark ?? null,
  up: !!document.querySelector('.tm-pause'),
  paused: window.islandScene?.isPaused === true,
  frontMenu: !!document.querySelector('.main-menu'),
  labels: [...document.querySelectorAll('.tm-pause button')].map((x) => x.textContent),
  settingsLive: [...document.querySelectorAll('.tm-pause button')]
    .find((x) => x.textContent === 'SETTINGS')?.disabled === false,
  build: document.querySelector('.tm-pause-build')?.textContent ?? '',
}));
ok('the page did not reload', pressed.sentinel === 'before-menu');
ok('and it is the SAME island, not a rebuilt one', pressed.mark === 'before-menu');
ok('the pause menu is up', pressed.up);
ok('the sim is paused', pressed.paused);
ok('the front menu is NOT what came up', pressed.frontMenu === false);
ok('it offers resume, save, settings, dev tools and a way out',
  pressed.labels.join('|')
    === 'RESUME|SAVE GAME|SETTINGS|DEV TOOLS|MAIN MENU');
/* LIVE now — the shared SettingsPanel exists (Foundation Pass) and both
 * doors open the same one. The button shipped dimmed waiting for exactly
 * this; probe:settings drives the panel itself end to end. */
ok('SETTINGS is live, no longer dimmed', pressed.settingsLive === true);
/* The build, where a screenshot of a paused game still dates itself. It
 * came off the STATS chip on the playing screen in v0.1.35. */
ok(`the build is on it (${pressed.build})`, /^v\d+\.\d+\.\d+$/.test(pressed.build));

/*
 * --- 1b. DEV TOOLS, which is the reason it is here rather than on the HUD ---
 *
 * The handle was the last child of a bottom-anchored rail, so it sat UNDER
 * the ten action plates and pushed every one of them 38px up the screen.
 * Moving it has to keep it WORKING, or the drawer is simply gone.
 */
const dev = await p.evaluate(async () => {
  const btn = [...document.querySelectorAll('.tm-pause button')]
    .find((x) => x.textContent === 'DEV TOOLS');
  const shown = () => {
    const el = document.querySelector('.tm-dev-panel');
    return !!el && el.style.display !== 'none';
  };
  const before = shown();
  btn.click();
  await new Promise((r) => setTimeout(r, 80));
  const opened = shown();
  btn.click();
  await new Promise((r) => setTimeout(r, 80));
  return { before, opened, closed: shown() };
});
ok('the drawer starts closed', dev.before === false);
ok('DEV TOOLS opens it', dev.opened === true);
ok('and closes it again', dev.closed === false);
/* And it is NOT on the playing screen any more — the whole point. */
ok('no DEV handle is left on the HUD', await p.evaluate(
  () => ![...document.querySelectorAll('.density-lab-actions button')]
    .some((b) => b.textContent === 'DEV'),
));

/*
 * --- 2. IS IT ACTUALLY FROZEN? ---
 *
 * Not `isPaused === true` — that is the flag agreeing with itself. Hold the
 * stick down through real animation frames and measure whether she moved.
 * `setPaused` lets go of the stick for her, so the walk is written AFTER the
 * pause, which is the harder case: input arriving while stopped.
 *
 * Under SwiftShader this is about a frame a second and `animate` clamps `dt`
 * to 0.05, so a few wall seconds buy a fraction of a game one — plenty to
 * move a queen who is walking and nothing at all for one who is not.
 */
const froze = await p.evaluate(async () => {
  const s = window.islandScene;
  const from = s.at.clone();
  s.input.walk = 1;
  await new Promise((r) => setTimeout(r, 2500));
  const moved = s.at.distanceTo(from) * 5;
  return { movedMm: +moved.toFixed(4), stage: s.questStage };
});
ok(`she did not move while paused (${froze.movedMm} mm)`, froze.movedMm < 0.01);

/* --- 3. SAVE, from inside the game, which was the thing you could not do --- */
const saved = await p.evaluate(async () => {
  const say = () => document.querySelector('.tm-pause-say')?.textContent ?? '';
  [...document.querySelectorAll('.tm-pause button')]
    .find((x) => x.textContent === 'SAVE GAME').click();
  /*
   * THE PAYLOAD LIVES IN INDEXEDDB NOW — a dug nest outgrew localStorage,
   * see `islandStore` — and only the MARK stays behind as a key. This
   * check read the OLD key and waited a flat 120 ms for an asynchronous
   * write, so it failed on a save that was working; polled against the
   * menu's own 'Saved' and the real mark instead.
   */
  for (let waited = 0; waited < 8000 && say() !== 'Saved'; waited += 200) {
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    said: say(),
    stored: !!window.localStorage.getItem('thronemound.island.mark.v1'),
  };
});
ok('SAVE wrote a save (the mark is down)', saved.stored);
ok('and said so', saved.said === 'Saved');
ok('without leaving the pause menu', await p.evaluate(
  () => !!document.querySelector('.tm-pause'),
));

/* --- 4. RESUME is lossless: the same queen, the same stage, and moving --- */
const resumed = await p.evaluate(async () => {
  const s = window.islandScene;
  /* LET GO OF THE STICK FIRST. Step 2 left `walk` held down to prove input
   * arriving while paused does nothing, and it does — but leaving it held
   * across the resume measures her first honest step and calls it drift.
   * Measured that way once: 0.74 mm "lost", which was exactly the 0.73 mm
   * the next assertion then wanted her to walk. */
  s.input.walk = 0;
  const was = s.at.clone();
  const stage = s.questStage;
  [...document.querySelectorAll('.tm-pause button')]
    .find((x) => x.textContent === 'RESUME').click();
  await new Promise((r) => setTimeout(r, 60));
  const here = s.at.clone();
  s.input.walk = 1;
  await new Promise((r) => setTimeout(r, 2500));
  s.input.walk = 0;
  return {
    up: !!document.querySelector('.tm-pause'),
    paused: s.isPaused,
    /* Nothing jumped on the way back in. A resume that teleported her a
     * millimetre would still be a resume that lost something. */
    keptMm: +(here.distanceTo(was) * 5).toFixed(4),
    keptStage: s.questStage === stage,
    walkedMm: +(s.at.distanceTo(here) * 5).toFixed(3),
    mark: s.__tmMark,
  };
});
ok('RESUME closes the menu', resumed.up === false);
ok('and unpauses', resumed.paused === false);
ok(`she is where she was (${resumed.keptMm} mm drift)`, resumed.keptMm < 0.01);
ok('the founding is where it was', resumed.keptStage);
ok(`and she walks again (${resumed.walkedMm} mm)`, resumed.walkedMm > 0.05);
ok('still the same island', resumed.mark === 'before-menu');

/* --- 5. ESCAPE opens it, and ESCAPE closes it --- */
await p.keyboard.press('Escape');
await p.waitForTimeout(200);
ok('Escape pauses', await p.evaluate(
  () => !!document.querySelector('.tm-pause') && window.islandScene.isPaused === true,
));
await p.keyboard.press('Escape');
await p.waitForTimeout(200);
ok('Escape unpauses', await p.evaluate(
  () => !document.querySelector('.tm-pause') && window.islandScene.isPaused === false,
));

/*
 * --- 6. LEAVING ASKS TWICE ---
 *
 * The only button here that can lose anything. One press must not do it,
 * and the second press must be a different WORD — a confirmation you can
 * clear by double-tapping is not a confirmation.
 */
await p.keyboard.press('Escape');
await p.waitForTimeout(200);
const armed = await p.evaluate(async () => {
  const leave = () => [...document.querySelectorAll('.tm-pause button')]
    .find((x) => x.textContent.startsWith('MAIN MENU') || x.textContent.startsWith('LEAVE'));
  leave().click();
  await new Promise((r) => setTimeout(r, 80));
  return {
    label: leave().textContent,
    gone: !document.querySelector('.tm-pause'),
    front: !!document.querySelector('.main-menu'),
  };
});
ok('one press does not leave', armed.gone === false && armed.front === false);
ok('it changes the wording instead', armed.label.startsWith('LEAVE'));

const left = await p.evaluate(async () => {
  [...document.querySelectorAll('.tm-pause button')]
    .find((x) => x.textContent.startsWith('LEAVE')).click();
  await new Promise((r) => setTimeout(r, 200));
  return {
    front: !!document.querySelector('.main-menu'),
    pause: !!document.querySelector('.tm-pause'),
    paused: window.islandScene?.isPaused,
    mark: window.islandScene?.__tmMark ?? null,
    sentinel: window.__tmAlive ?? null,
    resumeLive: !document.querySelector(
      '.main-menu__button[data-key="onResume"]',
    )?.disabled,
  };
});
ok('the second press reaches the front menu', left.front);
ok('the pause menu is gone', left.pause === false);
ok('the island is left RUNNING for whatever comes next', left.paused === false);
ok('and it was never reloaded, start to finish',
  left.sentinel === 'before-menu' && left.mark === 'before-menu');
/* The save made from inside the game is the one the front menu offers back.
 * That is the whole loop the reload used to break. */
ok('RESUME on the front menu is live, from the save made in-game', left.resumeLive);

let bad = 0;
for (const [what, good] of log) {
  if (!good) bad += 1;
  console.log(`  ${good ? 'ok  ' : 'FAIL'}  ${what}`);
}
console.log(`\npage errors: ${errs.length ? errs.slice(0, 3).join(' | ') : 'none'}`);
console.log(bad === 0 && errs.length === 0
  ? '\nall green — MENU pauses, saves, resumes losslessly, and asks before leaving'
  : `\n${bad} step(s) failed`);
await b.close();
process.exit(bad === 0 && errs.length === 0 ? 0 : 1);
