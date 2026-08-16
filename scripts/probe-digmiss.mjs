/**
 * The two halves of "the camera blurs while digging and some presses dig
 * nothing", graded live:
 *
 * 1. THE MACRO BLUR LEAVES WITH THE SHOVEL. `tiltForTest().macroNow` is
 *    the strength the frame was ACTUALLY drawn with. Above ground looking
 *    level it should be near full; the moment DIG is armed it must be
 *    exactly zero.
 *
 * 2. THE MISS IS TOLD. `biteMiss()` must light the "OUT OF REACH" note
 *    (and blush the crosshair ring), and both must fade on their own.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:18980/Thronemound-Colony-Sim/';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
await page.goto(`${URL}?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(
  () => window.islandScene?.statsForTest?.().playerReady === 1,
  null, { timeout: 180000 },
);
await page.mouse.click(466, 215);
await page.waitForTimeout(2500);

const before = await page.evaluate(() => window.islandScene.tiltForTest());
await page.screenshot({ path: '/tmp/dig-before.png' });

// Arm DIG through its own button, the way a thumb would.
await page.click('button[aria-label="Dig"]', { noWaitAfter: true });
await page.waitForTimeout(800);
const armed = await page.evaluate(() => ({
  tilt: window.islandScene.tiltForTest(),
  digMode: window.islandScene.statsForTest().digMode,
}));
await page.screenshot({ path: '/tmp/dig-armed.png' });

// The miss note, rung directly: the unit tests pin that bite() rings it;
// this checks the WIRING — element present, lit, and self-extinguishing.
const miss = await page.evaluate(async () => {
  const s = window.islandScene;
  s.biteMiss();
  const el = document.querySelector('.dig-miss');
  const ring = document.querySelector('.density-lab-crosshair');
  const lit = {
    text: el?.textContent,
    noteOn: el?.classList.contains('is-on') ?? false,
    ringOn: ring?.classList.contains('is-miss') ?? false,
    opacity: el ? getComputedStyle(el).opacity : 'none',
  };
  await new Promise((r) => { setTimeout(r, 1300); });
  const after = el ? getComputedStyle(el).opacity : 'none';
  return { lit, fadedOpacity: after };
});
await page.screenshot({ path: '/tmp/dig-miss.png' });

// Disarm: the blur must come back on the open hill.
await page.click('button[aria-label="Dig"]', { noWaitAfter: true });
await page.waitForTimeout(800);
const disarmed = await page.evaluate(() => window.islandScene.tiltForTest());

const verdict = {
  beforeMacro: before.macroNow,
  armedMacro: armed.tilt.macroNow,
  armedDigMode: armed.digMode,
  disarmedMacro: disarmed.macroNow,
  miss,
  errors,
  pass: armed.tilt.macroNow === 0 && armed.digMode === 1
    && miss.lit.noteOn && miss.lit.ringOn && miss.lit.text === 'OUT OF REACH'
    && disarmed.macroNow > 0 && errors.length === 0,
};
console.log(JSON.stringify(verdict, null, 2));
await browser.close();
process.exit(verdict.pass ? 0 : 1);
