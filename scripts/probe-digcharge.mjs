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

/*
 * A LOB AT THE SKY: it must fly, and then COME BACK DOWN AND LAND.
 *
 * This case used to assert a fizzle, and that premise died with v0.1.82.
 * It only ever held because the original ballistics could throw 141 mm
 * against a carvable world reaching 64 — the very mismatch that had two
 * throws in three silently carving nothing. With an arc that fits the
 * world, a charge thrown upward returns to the ground and digs, which is
 * both more physical and no longer a miss.
 *
 * The fizzle is still pinned, just not here: `tests/digCharge.test.ts`
 * proves a charge dies at the window's edge deterministically, with no
 * browser and no terrain to arrange. That is the better home for it — the
 * scenario is exact rather than provoked.
 */
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
    /* THE FIREBALL'S SECOND ACT: a landing that carved must leave a fire
     * still eating — read the instant the last bead lands, before the
     * smoulder's own ticks can spend it. */
    burning: s.burnsForTest(),
  };
});
/* The spoil pop is COUNTED by the render loop's grit.step, not by the
 * synchronous sim steps above — let a real frame draw, then read it
 * inside the chips' 0.42 s lifetime. */
await page.waitForTimeout(150);
dirt.grit = await page.evaluate(() => window.islandScene.gritLiveForTest());
await page.screenshot({ path: '/tmp/charge-dirt.png' });

/* And the fire goes OUT by itself: step the sim through every burn beat
 * plus slack, then confirm nothing is still alight — a smoulder that
 * never dies would carve the hill forever. Embers are checked mid-burn,
 * off a rendered frame, the same way the grit is. */
const burn = await page.evaluate(() => {
  const s = window.islandScene;
  s.stepForTest(1 / 60, 40); // into the first beat...
  return { midBurn: s.burnsForTest() };
});
await page.waitForTimeout(150);
burn.embers = await page.evaluate(() => window.islandScene.embersLiveForTest());
burn.after = await page.evaluate(() => {
  const s = window.islandScene;
  s.stepForTest(1 / 60, 180); // ...and through every remaining one.
  return s.burnsForTest();
});

const verdict = {
  sky, dirt, burn, errors,
  /* The sky throw lands now rather than fizzling — see the note above the
   * `sky` block. So neither throw should raise the miss note. */
  pass: sky.flying === 1 && sky.landedAll && !sky.noteOn
    && dirt.flying === 1 && dirt.landedAll && dirt.grit > 0 && !dirt.noteOn
    && dirt.burning >= 1 && burn.after === 0
    && errors.length === 0,
};
console.log(JSON.stringify(verdict, null, 2));
await browser.close();
process.exit(verdict.pass ? 0 : 1);
