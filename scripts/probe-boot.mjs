/**
 * DOES IT STILL BOOT? — menu, then START, then the island.
 *
 * A split that typechecks proves the pieces still fit together; it proves
 * nothing about module INITIALISATION ORDER, which is the way this kind of
 * refactor actually breaks. Constants pulled into their own module are
 * evaluated when that module is first imported, and a circular import — the
 * scene needing the tuning, the tuning needing something that needs the
 * scene — yields `undefined` at the moment a constant is read rather than an
 * error anyone can see. The symptom is a black screen and a NaN somewhere
 * far away.
 *
 * So this drives the real front door of the real build: wait for the menu,
 * press START, and wait for the island to say it is ready with the queen on
 * her feet.
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4700/Thronemound-Colony-Sim/')
  .replace(/\/$/, '');
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const p = await b.newPage({ viewport: { width: 900, height: 500 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

await p.goto(`${base}/?scene=menu`, { waitUntil: 'domcontentloaded' });

/* 1. The front door. */
await p.waitForSelector('.main-menu__button[data-key="onStart"]', { timeout: 90000 });
const menu = await p.evaluate(() => ({
  title: document.querySelector('.main-menu__title')?.textContent,
  version: document.querySelector('.main-menu__version')?.textContent,
  buttons: [...document.querySelectorAll('.main-menu__button')].map((b) => b.textContent),
}));
console.log(`menu title    : ${menu.title}`);
console.log(`menu version  : ${menu.version}`);
console.log(`menu buttons  : ${menu.buttons.join(', ')}`);

/* 2. START only lights once the world is built behind the menu. */
await p.waitForFunction(
  () => !document.querySelector('.main-menu__button[data-key="onStart"]')?.disabled,
  null, { timeout: 180000 },
);
console.log('START enabled : yes');
/* Dispatched rather than clicked: the island meshes behind the menu, so on
 * a software renderer the main thread is busy enough that Playwright's
 * actionability wait can expire on a button that is perfectly fine. */
await p.evaluate(() => document.querySelector(
  '.main-menu__button[data-key="onStart"]',
).click());

/* 3. And into the game. */
await p.waitForFunction(() => window.islandScene?.ready === true, null, { timeout: 180000 });
await p.waitForFunction(
  () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 180000 },
);
await p.waitForTimeout(1500);

const game = await p.evaluate(() => {
  const s = window.islandScene;
  const st = s.statsForTest();
  return {
    ready: s.ready,
    verts: st.verts,
    meshed: st.meshed,
    antAt: [Math.round(s.at.x * 5), Math.round(s.at.y * 5), Math.round(s.at.z * 5)],
    /* The tuning module's numbers, read back through live behaviour: a
     * constant that came across as undefined shows up as NaN here. */
    finite: Number.isFinite(s.at.x) && Number.isFinite(s.at.y) && Number.isFinite(s.at.z),
    hudButtons: document.querySelectorAll('.density-lab-button').length,
  };
});
console.log(`island ready  : ${game.ready}`);
console.log(`terrain built : ${game.verts.toLocaleString()} verts, ${game.meshed} chunks meshed`);
console.log(`queen at      : (${game.antAt.join(', ')}) mm`);
console.log(`position sane : ${game.finite}`);
console.log(`HUD buttons   : ${game.hudButtons}`);

/* 4. And it must still SIMULATE, not merely load. */
const moved = await p.evaluate(async () => {
  const s = window.islandScene;
  const from = s.at.clone();
  s.input.walk = 1;
  s.stepForTest(1 / 60, 120);
  s.input.walk = 0;
  return s.at.distanceTo(from) * 5;
});
console.log(`walked 2 s    : ${moved.toFixed(2)} mm`);

console.log(`\npage errors: ${errs.length ? errs.slice(0, 4).join(' | ') : 'none'}`);
const fail = [];
if (!game.ready) fail.push('island never readied');
if (!game.finite) fail.push('her position is not a number');
if (game.verts === 0) fail.push('no terrain built');
if (moved < 1) fail.push('she does not move');
if (errs.length) fail.push(`${errs.length} page errors`);
console.log(fail.length ? `\nFAILED: ${fail.join('; ')}` : '\nall green — menu, START, island, and she walks');
await b.close();
