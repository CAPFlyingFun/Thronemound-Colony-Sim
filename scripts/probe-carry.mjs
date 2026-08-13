/*
 * THE CARRY ROOM, judged — digging as picking things up.
 *
 * The soil is 48 x 128 x 48 blocks of 2 mm; the crosshair picks one; CARRY
 * takes it into her jaws and DROP sets it down against the face she is
 * looking at, or at her feet. A pit is exactly the blocks that left it, and
 * the spoil pile is exactly where they went. Every check sets the exit code.
 *
 * Run against the DEV server (`npm run dev`) like every other probe here —
 * `vite preview` resolves the config as `serve`, whose base is `/`, so a
 * build baked at `/Thronemound-Colony-Sim/` serves its assets as HTML
 * fallbacks under preview and no scene ever boots.
 *
 *   SMOKE_URL=http://localhost:4620/ node scripts/probe-carry.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://localhost:4620/')
  .replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

let failures = 0;
const check = (name, good, detail = '') => {
  console.log(`${good ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!good) failures += 1;
};

const errs = [];
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
page.on('pageerror', e => errs.push(e.message));
await page.goto(`${base}/?scene=carry`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.carryScene?.ready, null, { timeout: 60000 });
await page.evaluate(() => window.carryScene.setPausedForTest(true));

// THE UNDUG ROOM: 96 x 96 x 256 mm of soil in 2 mm blocks, and headroom.
const SOIL_BLOCKS = 48 * 128 * 48;
const boot = await page.evaluate(() => window.carryScene.statsForTest());
check('the soil is 294,912 blocks', boot.blocks === SOIL_BLOCKS,
  `blocks=${boot.blocks}`);
check('66 chunks carry the surface (buried and empty ones skipped)',
  boot.chunks === 66, `chunks=${boot.chunks}`);
check('she spawns standing on the top face',
  Math.abs(boot.antY - 1.2) < 0.5, `antY=${boot.antY.toFixed(2)}`);

// THE QUEEN herself, not the fallback cart.
await page.waitForFunction(
  () => window.carryScene.statsForTest().queen === 1, null, { timeout: 30000 },
).catch(() => {});
check('the queen model rides the room',
  (await page.evaluate(() => window.carryScene.statsForTest().queen)) === 1);

// FIRST PERSON: crosshair down at the soil ahead finds a reachable block.
const aimed = await page.evaluate(() => {
  const s = window.carryScene;
  s.setViewForTest(true);
  s.setAimForTest(0, -60);
  s.stepForTest(1 / 60, 5);
  return s.statsForTest();
});
check('her-eyes view engages', aimed.firstPerson === 1);
check('the crosshair finds a block', aimed.targetValid === 1);
check('...within her reach', aimed.targetReachable === 1);
check('...at the surface, not underground', aimed.targetY === 127,
  `targetY=${aimed.targetY}`);
const first = [aimed.targetX, aimed.targetY, aimed.targetZ];

// CARRY: the block leaves the ground and rides in her jaws.
const carried = await page.evaluate(() => {
  const s = window.carryScene;
  s.carryForTest();
  s.stepForTest(1 / 60, 2);
  const afterOne = s.statsForTest();
  s.carryForTest(); // jaws are full — a second CARRY must refuse
  return { afterOne, afterTwo: s.statsForTest() };
});
check('CARRY takes exactly one block',
  carried.afterOne.blocks === SOIL_BLOCKS - 1 && carried.afterOne.carrying === 1
  && carried.afterOne.removed === 1);
check('the carried cell is now air', !(await page.evaluate(
  ([x, y, z]) => window.carryScene.solidAtCell(x, y, z), first,
)));
check('full jaws refuse a second block',
  carried.afterTwo.blocks === SOIL_BLOCKS - 1 && carried.afterTwo.carrying === 1);

// DROP: against the face under the crosshair — it lands back in the hole.
const dropped = await page.evaluate(() => {
  const s = window.carryScene;
  s.stepForTest(1 / 60, 2); // retarget: the ray now hits the hole's floor
  const before = s.statsForTest();
  s.dropForTest();
  return { before, after: s.statsForTest() };
});
check('DROP fills the cell against the looked-at face',
  dropped.after.blocks === SOIL_BLOCKS && dropped.after.carrying === 0
  && dropped.after.removed === 0,
  `blocks=${dropped.after.blocks} carrying=${dropped.after.carrying}`);
check('...the very hole she dug', await page.evaluate(
  ([x, y, z]) => window.carryScene.solidAtCell(x, y, z), first,
));

// EXCAVATION: eight blocks out of the pit ahead, piled at her feet behind.
const pit = await page.evaluate(() => {
  const s = window.carryScene;
  for (let i = 0; i < 8; i += 1) {
    s.setAimForTest(0, -60);
    s.stepForTest(1 / 60, 2);
    s.carryForTest();
    s.setAimForTest(180, 60); // face away, look up: nothing targeted
    s.stepForTest(1 / 60, 2);
    s.dropForTest(); // ...so the block goes down at her feet
  }
  const stats = s.statsForTest();
  let pile = 0;
  for (let z = 0; z < 48; z += 1) {
    for (let x = 0; x < 48; x += 1) {
      if (s.solidAtCell(x, 128, z)) pile += 1;
    }
  }
  return { stats, pile };
});
check('eight round trips conserve every block',
  pit.stats.blocks === SOIL_BLOCKS && pit.stats.removed === 0
  && pit.stats.carrying === 0, `blocks=${pit.stats.blocks}`);
check('the spoil pile stands proud of the old surface', pit.pile > 0,
  `cells above y=0: ${pit.pile}`);

// SHE DESCENDS: standing over the pit means standing IN it.
const descent = await page.evaluate(([x, , z]) => {
  const s = window.carryScene;
  s.teleportMm((x + 0.5) * 2, (z + 0.5) * 2);
  s.stepForTest(1 / 60, 5);
  return s.statsForTest();
}, first);
check('the pit is real ground: she stands lower inside it',
  descent.antY < 0, `antY=${descent.antY.toFixed(2)}`);

// WALKING: hold forward, and she covers ground at walking pace.
const walked = await page.evaluate(() => {
  const s = window.carryScene;
  s.setAimForTest(90, 0);
  const before = s.statsForTest();
  s.setWalkForTest(1);
  s.stepForTest(1 / 60, 60);
  s.setWalkForTest(0);
  return { before, after: s.statsForTest() };
});
const strideMm = Math.hypot(
  walked.after.antX - walked.before.antX,
  walked.after.antZ - walked.before.antZ,
);
check('a held second of walking covers ~12 mm', strideMm > 6 && strideMm < 20,
  `${strideMm.toFixed(1)} mm`);

// OVER HER: the third-person camera hangs back and above.
const third = await page.evaluate(() => {
  const s = window.carryScene;
  s.setViewForTest(false);
  s.stepForTest(1 / 60, 3);
  return s.statsForTest();
});
const camBack = Math.hypot(
  third.camX - third.antX, third.camY - third.antY, third.camZ - third.antZ,
);
check('over-her view hangs the camera back', third.firstPerson === 0
  && camBack > 15, `dist=${camBack.toFixed(1)} mm`);

check('no page errors', errs.length === 0, errs.join(' | '));

await browser.close();
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
