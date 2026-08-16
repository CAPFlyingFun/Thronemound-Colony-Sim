/**
 * THE THROWN CHARGE, GRADED LIVE — the wiring the unit tests cannot see:
 *
 * 1. A lob at the SKY flies, runs out of throw, and FIZZLES out loud —
 *    the "OUT OF REACH" note lights when the bead gives up, not before.
 * 2. A lob at the GROUND flies, lands, and carves — no note, and the
 *    spoil pop (grit) confirms soil actually came out at the landing.
 *
 * Flight is driven through `stepForTest`, which runs the same simulate()
 * the frame loop does, so what passes here is what the thumb gets.
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

// Arm DIG through its own button, the way a thumb would.
await page.click('button[aria-label="Dig"]', { noWaitAfter: true });
await page.waitForTimeout(600);

// A lob at the sky: it must fly, then fizzle into the miss note.
const sky = await page.evaluate(() => {
  const s = window.islandScene;
  s.aimPitchForTest(0.9);
  // The look CHASES the written pitch; let it arrive before the throw.
  s.stepForTest(1 / 60, 40);
  s.lobForTest();
  const flying = s.chargesForTest();
  let steps = 0;
  while (s.chargesForTest() > 0 && steps < 600) { s.stepForTest(1 / 60, 1); steps += 1; }
  const el = document.querySelector('.dig-miss');
  return {
    flying,
    landedAll: s.chargesForTest() === 0,
    steps,
    noteOn: el?.classList.contains('is-on') ?? false,
  };
});
await page.screenshot({ path: '/tmp/charge-sky.png' });
// Let the note fade before the second act, so its light is its own.
await page.waitForTimeout(900);

// A lob into the hill: it must land, carve (spoil pops), and say nothing.
const dirt = await page.evaluate(() => {
  const s = window.islandScene;
  s.aimPitchForTest(-0.7);
  s.stepForTest(1 / 60, 40);
  s.lobForTest();
  const flying = s.chargesForTest();
  let steps = 0;
  while (s.chargesForTest() > 0 && steps < 600) { s.stepForTest(1 / 60, 1); steps += 1; }
  const el = document.querySelector('.dig-miss');
  return {
    flying,
    landedAll: s.chargesForTest() === 0,
    steps,
    noteOn: el?.classList.contains('is-on') ?? false,
  };
});
/* The spoil pop is COUNTED by the render loop's grit.step, not by the
 * synchronous sim steps above — let a real frame draw, then read it
 * inside the chips' 0.42 s lifetime. */
await page.waitForTimeout(150);
dirt.grit = await page.evaluate(() => window.islandScene.gritLiveForTest());
await page.screenshot({ path: '/tmp/charge-dirt.png' });

const verdict = {
  sky, dirt, errors,
  pass: sky.flying === 1 && sky.landedAll && sky.noteOn
    && dirt.flying === 1 && dirt.landedAll && dirt.grit > 0 && !dirt.noteOn
    && errors.length === 0,
};
console.log(JSON.stringify(verdict, null, 2));
await browser.close();
process.exit(verdict.pass ? 0 : 1);
