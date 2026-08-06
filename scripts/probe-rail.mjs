/*
 * THE MONORAIL ROOM, judged: pieces append with exact angles, the rail's
 * arithmetic holds end to end, auto-bank leans into turns, the plan compiles
 * clean, and the cart actually rides.
 *
 * Self-judging on purpose — every check sets the exit code, so a CI wrapper
 * or a bare `npm run probe:rail` sees red on failure instead of a table of
 * numbers a human has to read.
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
  window.railScene.setPausedForTest(true);
  window.railScene.clearForTest();
  window.railScene.setAutoBankForTest(true);
});

// Build S, U, U, L, R, D — six 6 mm pieces exercising every button.
const stats = await page.evaluate(() => {
  const s = window.railScene;
  for (const kind of ['straight', 'up', 'up', 'left', 'right', 'down']) {
    s.addPieceForTest(kind);
  }
  return s.statsForTest();
});

check('six pieces on the track', stats.pieces === 6, `pieces ${stats.pieces}`);
check('track length is the sum of the pieces', Math.abs(stats.lengthMm - 36) < 0.05,
  `${stats.lengthMm.toFixed(2)} mm`);
check('turns cancel: end heading back on the start bearing',
  Math.abs(stats.endHeadingDeg) < 1, `${stats.endHeadingDeg.toFixed(2)} deg`);
check('grade ends one DOWN below two UPs', Math.abs(stats.endPitchDeg - 15) < 1,
  `${stats.endPitchDeg.toFixed(2)} deg`);
check('the climb went somewhere: track ends above the station', stats.endY > 3,
  `${stats.endY.toFixed(2)} mm up`);
check('plan compiles with no faults', stats.planFaults === 0,
  `${stats.planFaults} faults over ${stats.planNodes} nodes / ${stats.planEdges} edges`);
check('curved pieces subdivide in the plan', stats.planEdges > stats.pieces,
  `${stats.planEdges} edges for ${stats.pieces} pieces`);

const pieces = await page.evaluate(() => window.railScene.piecesForTest());
check('exact angles: pitches walk 0,15,30,30,30,15',
  JSON.stringify(pieces.map(p => p.pitch)) === JSON.stringify([0, 15, 30, 30, 30, 15]),
  pieces.map(p => p.pitch).join(','));
check('auto-bank leans the LEFT piece left', pieces[3].roll > 0,
  `roll ${pieces[3].roll} deg`);
check('auto-bank leans the RIGHT piece right', pieces[4].roll < 0,
  `roll ${pieces[4].roll} deg`);
check('straight pieces carry no bank', pieces[0].roll === 0 && pieces[5].roll === 0);

// The ride: step deterministically and require the cart to have travelled.
const ride = await page.evaluate(() => {
  const s = window.railScene;
  s.setRidingForTest(true);
  s.stepForTest(1 / 30, 60);
  return s.statsForTest();
});
check('the cart rides', ride.cartS > 5, `cart at ${ride.cartS.toFixed(1)} mm after 2 s`);

// Undo is an undo: one piece gone, length shorter by that piece.
const undone = await page.evaluate(() => {
  window.railScene.undoForTest();
  return window.railScene.statsForTest();
});
check('undo removes exactly the last piece',
  undone.pieces === 5 && Math.abs(undone.lengthMm - 30) < 0.05,
  `${undone.pieces} pieces, ${undone.lengthMm.toFixed(1)} mm`);

// Smoothing changes the view, not the track: same pieces, same plan.
const smoothed = await page.evaluate(() => {
  window.railScene.setSmoothForTest(true);
  return window.railScene.statsForTest();
});
check('smoothing leaves the pieces and the plan alone',
  smoothed.pieces === 5 && smoothed.planFaults === 0 && smoothed.smooth === 1);

// The tags: one label per piece, wearing the exact angles.
const labels = await page.evaluate(() => window.railScene.labelsForTest());
check('one tag per piece', labels.length === 5, labels.join(' | '));
check('tags carry pitch and yaw', labels[0] === '+0°' && labels[3] === '+30° L15°',
  `${labels[0]} … ${labels[3]}`);
check('tag sprites are in the scene',
  await page.evaluate(() => window.railScene.labelSpritesForTest()) === 5);

// THE DIRT COMES OUT: dive a fresh track underground and ask the field.
const dig = await page.evaluate(() => {
  const s = window.railScene;
  s.clearForTest();
  for (const kind of ['down', 'down', 'down', 'straight', 'straight', 'straight']) {
    s.addPieceForTest(kind);
  }
  const stats = s.statsForTest();
  // The last straight runs at -45 deg from roughly (0, -17, 24) onward; ask
  // three spots: inside the bore, beside it, and the mound over the station.
  const end = { x: stats.endX, y: stats.endY, z: stats.endZ };
  const mid = { x: end.x / 2, y: end.y / 2, z: (end.z + 12) / 2 };
  return {
    carveMs: stats.carveMs,
    endY: stats.endY,
    inBore: s.solidAtMm(mid.x, mid.y, mid.z),
    besideBore: s.solidAtMm(mid.x + 15, mid.y, mid.z),
    // Outside the 8 mm vent, inside the mound's 25 mm spread.
    mound: s.solidAtMm(11, 1.5, 0),
  };
});
check('the dive went underground', dig.endY < -15, `end ${dig.endY.toFixed(1)} mm`);
check('the bore is open air', dig.inBore === false, `solidAtMm ${dig.inBore}`);
check('the soil beside the bore holds', dig.besideBore === true);
check('the entrance mound is heaped over the station', dig.mound === true);
check('a carve is a moment, not a hang', dig.carveMs < 2500, `${dig.carveMs.toFixed(0)} ms`);

// PRESETS AND THE ROOM: whole nest moves in one tap, ended in a chamber.
const nest = await page.evaluate(() => {
  const s = window.railScene;
  s.clearForTest();
  s.addPresetForTest('shaft');
  s.addPresetForTest('spiralLeft');
  s.setRoomForTest(2); // the queen room
  const stats = s.statsForTest();
  return {
    pieces: stats.pieces,
    endY: stats.endY,
    heading: stats.endHeadingDeg,
    chambers: stats.planChambers,
    faults: stats.planFaults,
    roomAir: s.solidAtMm(stats.endX + 9, stats.endY, stats.endZ),
    labels: s.labelsForTest().length,
  };
});
check('presets append whole moves', nest.pieces === 8, `${nest.pieces} pieces`);
check('shaft + spiral dig deep', nest.endY < -35, `${nest.endY.toFixed(1)} mm`);
check('the spiral came half round',
  Math.abs(Math.abs(nest.heading) - 180) < 2, `${nest.heading.toFixed(0)} deg`);
check('the tunnel ends in exactly one chamber, plan clean',
  nest.chambers === 1 && nest.faults === 0,
  `${nest.chambers} chambers, ${nest.faults} faults`);
check('the queen room is carved wider than the bore', nest.roomAir === false);
check('preset pieces wear tags too', nest.labels === 8, `${nest.labels} tags`);

check('no page errors', errs.length === 0, errs.join(' | '));

await browser.close();
console.log(failures === 0 ? 'RAIL RIG SOUND' : `RAIL RIG BROKEN — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
