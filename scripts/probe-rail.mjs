/*
 * THE MONORAIL ROOM, judged — the you-are-the-ant edition.
 *
 * Hold DIG and the tube grows along the aim in exact steps; the ant rides
 * to the face; rooms toggle at the end; the soil carves around all of it;
 * both cameras hold their posts. Every check sets the exit code.
 *
 * Run against the DEV server (`npm run dev`) like every other probe here —
 * `vite preview` resolves the config as `serve`, whose base is `/`, so a
 * build baked at `/Thronemound-Colony-Sim/` serves its assets as HTML
 * fallbacks under preview and no scene ever boots.
 *
 *   SMOKE_URL=http://localhost:4620/ node scripts/probe-rail.mjs
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
await page.goto(`${base}/?scene=rail`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.railScene?.ready, null, { timeout: 60000 });

// A saved track from an earlier session would make every count below wrong.
await page.evaluate(() => {
  const s = window.railScene;
  s.setPausedForTest(true);
  s.clearForTest();
  s.setAutoBankForTest(true);
  s.setModeForTest('tubes');
});

// HOLD TO GROW: aim level, hold DIG, step three seconds of sim.
const grown = await page.evaluate(() => {
  const s = window.railScene;
  s.setAimForTest(0, 0);
  s.setDigForTest(true);
  s.stepForTest(1 / 30, 90); // 3 s at GROW_RATE 5 mm/s = 15 mm = 2 full pieces
  s.setDigForTest(false);
  const stats = s.statsForTest();
  return { ...stats, antS: s.antForTest().s };
});
check('a held DIG grows the tube', grown.pieces === 2, `${grown.pieces} pieces`);
check('growth is piece-quantised', Math.abs(grown.lengthMm - 12) < 0.05,
  `${grown.lengthMm.toFixed(1)} mm`);
check('the ant rides to the face she dug', Math.abs(grown.antS - grown.lengthMm) < 0.05,
  `ant at ${grown.antS.toFixed(1)} mm`);
check('level aim digs level', Math.abs(grown.endPitchDeg) < 1,
  `${grown.endPitchDeg.toFixed(1)} deg`);

// AIM STEERS: look down-right and keep digging — exact snapped angles.
const steered = await page.evaluate(() => {
  const s = window.railScene;
  s.setAimForTest(40, -50);
  s.setDigForTest(true);
  s.stepForTest(1 / 30, 90);
  s.setDigForTest(false);
  return { pieces: s.piecesForTest(), labels: s.labelsForTest() };
});
check('aim snaps the pitch to 15° steps',
  steered.pieces[steered.pieces.length - 1].pitch === -45,
  `pitch ${steered.pieces[steered.pieces.length - 1].pitch}`);
check('aim turns toward the look, snapped',
  steered.pieces[2].turn === 45, `turn ${steered.pieces[2].turn}`);
check('later pieces run straight once aligned',
  steered.pieces[steered.pieces.length - 1].turn === 0);
check('every piece wears a tag', steered.labels.length === steered.pieces.length,
  `${steered.labels.length} tags for ${steered.pieces.length} pieces`);

// RELEASED means released: no growth without the button.
const idle = await page.evaluate(() => {
  const s = window.railScene;
  const before = s.statsForTest().pieces;
  s.stepForTest(1 / 30, 60);
  return { before, after: s.statsForTest().pieces };
});
check('no digging with DIG released', idle.before === idle.after);

// ROOMS MODE: a tap puts the chamber at the end; the plan stays clean.
const room = await page.evaluate(() => {
  const s = window.railScene;
  s.setModeForTest('rooms');
  s.toggleRoomForTest();
  const stats = s.statsForTest();
  return {
    chambers: stats.planChambers,
    faults: stats.planFaults,
    roomMm: stats.roomMm,
    roomAir: s.solidAtMm(stats.endX + 9, stats.endY, stats.endZ),
  };
});
check('the tunnel ends in one chamber, plan clean',
  room.chambers === 1 && room.faults === 0,
  `${room.chambers} chambers, ${room.faults} faults`);
check('the default room is the queen chamber', room.roomMm === 11);
check('the room is carved wider than the bore', room.roomAir === false);

// THE SOIL: air in the bore, soil beside it, the mound over the station.
const dig = await page.evaluate(() => {
  const s = window.railScene;
  const stats = s.statsForTest();
  const mid = { x: stats.endX / 2, y: stats.endY / 2, z: (stats.endZ + 12) / 2 };
  return {
    inBore: s.solidAtMm(mid.x, mid.y, mid.z),
    besideBore: s.solidAtMm(mid.x + 15, mid.y, mid.z),
    mound: s.solidAtMm(11, 1.5, 0),
    carveMs: stats.carveMs,
  };
});
check('the bore is open air', dig.inBore === false);
check('the soil beside the bore holds', dig.besideBore === true);
check('the entrance mound is heaped over the station', dig.mound === true);
check('a carve is a moment, not a hang', dig.carveMs < 2500,
  `${dig.carveMs.toFixed(0)} ms`);

// THE ANT: her model loads, she rides with W/S, both cameras hold post.
await page.waitForFunction(
  () => window.railScene.antForTest().queen === 1, null, { timeout: 60000 },
).catch(() => { /* judged below */ });
const ant = await page.evaluate(() => {
  const s = window.railScene;
  const start = s.antForTest();
  s.setWalkForTest(-1);
  s.stepForTest(1 / 30, 30); // one second back down the tube
  s.setWalkForTest(0);
  const walked = s.antForTest();
  s.setViewForTest(true);
  s.stepForTest(1 / 30, 5);
  const first = s.antForTest();
  s.setViewForTest(false);
  s.stepForTest(1 / 30, 120);
  const third = s.antForTest();
  const eye = Math.hypot(first.camX - first.x, first.camY - first.y, first.camZ - first.z);
  const shoulder = Math.hypot(third.camX - third.x, third.camY - third.y, third.camZ - third.z);
  return {
    queen: start.queen, sBefore: start.s, sAfter: walked.s, eye, shoulder,
  };
});
check('the queen model is riding, not the cart', ant.queen === 1);
check('W/S rides her along the tube', ant.sBefore - ant.sAfter > 8,
  `${ant.sBefore.toFixed(1)} → ${ant.sAfter.toFixed(1)} mm`);
check('first person sits in her eyes', ant.eye < 8, `${ant.eye.toFixed(1)} mm off`);
check('third person stands back from her', ant.shoulder > 15,
  `${ant.shoulder.toFixed(1)} mm back`);

// UNDO still undoes a piece; smoothing still changes only the view.
const tidy = await page.evaluate(() => {
  const s = window.railScene;
  const before = s.statsForTest();
  s.undoForTest();
  const undone = s.statsForTest();
  s.setSmoothForTest(true);
  const smoothed = s.statsForTest();
  return { before, undone, smoothed };
});
check('undo removes exactly the last piece',
  tidy.undone.pieces === tidy.before.pieces - 1
  && Math.abs(tidy.undone.lengthMm - (tidy.before.lengthMm - 6)) < 0.05);
check('smoothing leaves the pieces and the plan alone',
  tidy.smoothed.pieces === tidy.undone.pieces
  && tidy.smoothed.planFaults === 0 && tidy.smoothed.smooth === 1);

check('no page errors', errs.length === 0, errs.join(' | '));

await browser.close();
console.log(failures === 0 ? 'RAIL RIG SOUND' : `RAIL RIG BROKEN — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
