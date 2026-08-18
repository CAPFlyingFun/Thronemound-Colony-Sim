/**
 * THE SETTINGS PANEL, DRIVEN THROUGH BOTH DOORS.
 *
 *     npx vite --port 5173                                  # then
 *     SMOKE_URL=http://127.0.0.1:5173/ npm run probe:settings
 *
 * Foundation Pass rule (ChatGPT's plan, Joshua's go): "the same
 * SettingsPanel should open from MAIN MENU and PAUSE. One component. No
 * duplicate settings logic." Pinned here end to end, on the DEFAULT
 * route — the real game's front door, not a ?scene shortcut:
 *
 *   1. the front menu's SETTINGS entry is LIVE (it shipped greyed);
 *   2. changes persist to storage and APPLY LIVE to the island;
 *   3. first- and third-person FOVs are separate dials, and the dig's
 *      wide working lens still outranks both while DIG is armed;
 *   4. look speed and invert Y actually change what a drag does;
 *   5. resolution scale actually changes what the renderer is asked for;
 *   6. the PAUSE menu opens the same panel over itself;
 *   7. a reload comes back wearing every saved value.
 */
import { chromium } from 'playwright';

const URL = (process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const errs = [];
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${URL}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.main-menu', { timeout: 120000 });

const out = {};

/* 1. The front door's SETTINGS is live. */
const settingsBtn = page.locator('.main-menu button', { hasText: 'SETTINGS' });
out.frontEnabled = !(await settingsBtn.isDisabled());
await settingsBtn.click();
await page.waitForSelector('.tm-settings', { timeout: 10000 });

/* 2. Set every dial to a non-default through the real inputs. */
const setSlider = async (label, value) => {
  await page.evaluate(([name, v]) => {
    const rows = [...document.querySelectorAll('.tm-settings-row')];
    const row = rows.find((r) => r.querySelector('.tm-set-name')?.textContent === name);
    const input = row.querySelector('input[type="range"]');
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, [label, value]);
};
await setSlider('FOV — 1st person', 84);
await setSlider('FOV — 3rd person', 72);
await setSlider('Look speed', 2);
await setSlider('Resolution', 0.75);
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.tm-settings-row')];
  rows.find((r) => r.querySelector('.tm-set-name')?.textContent === 'Invert Y')
    ?.querySelector('button')?.click();
});
out.stored = await page.evaluate(
  () => JSON.parse(window.localStorage.getItem('thronemound.prefs.v1') ?? 'null'),
);
await page.locator('.tm-settings button', { hasText: 'BACK' }).click();

/* 3. Into the game, and the lens obeys per view. */
await page.locator('.main-menu button', { hasText: 'START' }).click();
await page.waitForFunction(() => window.islandScene?.ready === true, null, { timeout: 200000 });
await page.waitForFunction(
  () => !document.querySelector('.tm-loading-root'), null, { timeout: 200000 },
);
out.game = await page.evaluate(() => {
  const s = window.islandScene;
  s.stepForTest(1 / 60, 10);
  const report = { thirdFov: 0, firstFov: 0, digFov: 0, backFov: 0 };
  report.thirdFov = s.camera.fov;
  s.firstPerson = true;
  s.stepForTest(1 / 60, 4);
  report.firstFov = s.camera.fov;
  document.querySelector('.tm-art-dig')
    .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  s.stepForTest(1 / 60, 4);
  report.digFov = s.camera.fov;
  document.querySelector('.tm-art-dig')
    .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  s.firstPerson = false;
  s.stepForTest(1 / 60, 4);
  report.backFov = s.camera.fov;
  /* 4. A synthetic look-drag, measured against the settings' own claim:
   * double speed and inverted, the same movementY must move lookPitch
   * UP by twice what defaults would. Simulated via the real handler. */
  report.pitchBefore = s.lookPitch;
  const canvas = s.renderer.domElement;
  canvas.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, pointerId: 7, clientX: 466, clientY: 215,
  }));
  const move = new PointerEvent('pointermove', {
    bubbles: true, pointerId: 7, clientX: 466, clientY: 235,
  });
  Object.defineProperty(move, 'movementY', { value: 20 });
  Object.defineProperty(move, 'movementX', { value: 0 });
  canvas.dispatchEvent(move);
  canvas.dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true, pointerId: 7, clientX: 466, clientY: 235,
  }));
  report.pitchAfter = s.lookPitch;
  report.pixelRatio = +s.renderer.getPixelRatio().toFixed(3);
  report.devicePixelRatio = window.devicePixelRatio;
  return report;
});

/* 6. The pause menu opens the same panel. */
await page.keyboard.press('Escape');
await page.waitForSelector('.tm-pause', { timeout: 10000 });
const pauseSettings = page.locator('.tm-pause button', { hasText: 'SETTINGS' });
out.pauseEnabled = !(await pauseSettings.isDisabled());
await pauseSettings.click();
await page.waitForSelector('.tm-settings', { timeout: 10000 });
out.overPause = await page.evaluate(() => ({
  settingsUp: !!document.querySelector('.tm-settings'),
  pauseStillUp: !!document.querySelector('.tm-pause'),
}));
/* Escape closes ONE layer — the panel, not the pause under it. */
await page.keyboard.press('Escape');
out.escapeOneLayer = await page.evaluate(() => ({
  settingsGone: !document.querySelector('.tm-settings'),
  pauseStillUp: !!document.querySelector('.tm-pause'),
}));

/* 7. A reload comes back wearing everything. */
await page.goto(`${URL}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.main-menu', { timeout: 120000 });
out.reload = await page.evaluate(
  () => JSON.parse(window.localStorage.getItem('thronemound.prefs.v1') ?? 'null'),
);

await browser.close();

let bad = 0;
const say = (ok, line) => { if (!ok) bad += 1; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${line}`); };

console.log('\nTHE SETTINGS PANEL, BOTH DOORS\n');
console.log(`  stored : ${JSON.stringify(out.stored)}`);
console.log(`  game   : ${JSON.stringify(out.game)}`);
console.log(`  pause  : enabled=${out.pauseEnabled} ${JSON.stringify(out.overPause)}`
  + ` escape=${JSON.stringify(out.escapeOneLayer)}\n`);

say(out.frontEnabled, 'the front menu SETTINGS entry is live (it shipped greyed)');
say(out.stored?.fov1 === 84 && out.stored?.fov3 === 72 && out.stored?.lookSens === 2
  && out.stored?.invertY === true && out.stored?.resScale === 0.75,
'every dial wrote through to storage');
say(out.game.thirdFov === 72, `third person wears the 3rd-person FOV (${out.game.thirdFov})`);
say(out.game.firstFov === 84, `first person wears the 1st-person FOV (${out.game.firstFov})`);
say(out.game.digFov === 100, `DIG armed keeps its wide working lens (${out.game.digFov})`);
say(out.game.backFov === 72, `disarmed and third person again, the preference returns (${out.game.backFov})`);
say(out.game.pitchAfter > out.game.pitchBefore,
  `inverted Y: dragging down looks UP (${out.game.pitchBefore.toFixed(3)} -> ${out.game.pitchAfter.toFixed(3)})`);
say(Math.abs(out.game.pitchAfter - out.game.pitchBefore - 20 * 0.004 * 2) < 1e-6,
  'and at exactly double speed — the look-speed dial is real');
say(Math.abs(out.game.pixelRatio - Math.min(out.game.devicePixelRatio, 2) * 0.75) < 0.02,
  `the renderer is asked for 75% of the adaptive rung (${out.game.pixelRatio})`);
say(out.pauseEnabled, 'the pause menu SETTINGS button is live too');
say(out.overPause.settingsUp && out.overPause.pauseStillUp,
  'the panel stacks over the pause menu rather than replacing it');
say(out.escapeOneLayer.settingsGone && out.escapeOneLayer.pauseStillUp,
  'Escape closes one layer — the panel first, the pause survives');
say(out.reload?.fov1 === 84 && out.reload?.invertY === true,
  'a reload comes back wearing the saved values');

if (errs.length) console.log(`\npage errors: ${errs.slice(0, 3).join(' | ')}`);
if (bad > 0 || errs.length) { console.log(`\n${bad} check(s) failed`); process.exit(1); }
console.log('\nall green — one panel, both doors, every dial real');
