/*
 * THE MONORAIL ROOM, judged — the ant-and-branches edition.
 *
 * Tap-placed pieces keep their exact angles; a held DIG grows the tube
 * along the first-person aim; the queen rides the working line; rooms are
 * 6-exit hubs that branch; the soil carves around all of it; both cameras
 * hold their posts. Every check sets the exit code.
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
});

// TAP PLACEMENT still speaks exact angles (the editor's grammar).
const tapped = await page.evaluate(() => {
  const s = window.railScene;
  for (const kind of ['straight', 'up', 'left']) s.addPieceForTest(kind);
  return { stats: s.statsForTest(), pieces: s.piecesForTest() };
});
check('tap-placed pieces land', tapped.stats.pieces === 3);
check('exact steps hold: 0, +15, +15 L15',
  tapped.pieces[1].pitch === 15 && tapped.pieces[2].turn === 15);
check('auto-bank leans the LEFT piece left', tapped.pieces[2].roll > 0);

// HOLD TO GROW: aim down-right, hold DIG, step three seconds of sim.
const grown = await page.evaluate(() => {
  const s = window.railScene;
  s.setAimForTest(60, -50);
  s.setDigForTest(true);
  s.stepForTest(1 / 30, 90); // 3 s at GROW_RATE 5 mm/s = 15 mm = 2 pieces
  s.setDigForTest(false);
  return { stats: s.statsForTest(), pieces: s.piecesForTest(), ant: s.antForTest() };
});
check('a held DIG grows the tube', grown.stats.pieces === 5,
  `${grown.stats.pieces} pieces`);
check('aim snaps the pitch to 15° steps',
  grown.pieces[4].pitch === -45, `pitch ${grown.pieces[4].pitch}`);
check('aim turns toward the look, snapped',
  grown.pieces[3].turn === 45, `turn ${grown.pieces[3].turn}`);
check('the ant rides to the face she dug',
  Math.abs(grown.ant.s - grown.stats.lengthMm) < 0.05,
  `ant at ${grown.ant.s.toFixed(1)} of ${grown.stats.lengthMm.toFixed(1)} mm`);

// RELEASED means released: no growth without the button.
const idle = await page.evaluate(() => {
  const s = window.railScene;
  const before = s.statsForTest().pieces;
  s.stepForTest(1 / 30, 60);
  return { before, after: s.statsForTest().pieces };
});
check('no digging with DIG released', idle.before === idle.after);

// EVERY piece wears a tag, tap-placed and dug alike.
const labels = await page.evaluate(() => window.railScene.labelsForTest());
check('every piece wears a tag', labels.length === 5, `${labels.length} tags`);

// ROOMS ARE HUBS: room the line, branch DOWN off it, dig the branch.
const branched = await page.evaluate(() => {
  const s = window.railScene;
  s.setRoomForTest(11);
  s.branchOutForTest('down');
  s.setDigForTest(true);
  s.stepForTest(1 / 30, 60); // one 6 mm piece of branch
  s.setDigForTest(false);
  return {
    stats: s.statsForTest(),
    branches: s.branchesForTest(),
    pieces: s.piecesForTest(),
  };
});
check('the branch exists and is active',
  branched.stats.branches === 2 && branched.stats.activeBranch === 1);
check('the branch hangs off the DOWN exit',
  branched.branches[1].parent?.exit === 'down');
check('a DOWN branch digs downward from the seed',
  branched.pieces[0].pitch <= -60, `pitch ${branched.pieces[0].pitch}`);
check('the tree compiles clean', branched.stats.planFaults === 0,
  `${branched.stats.planFaults} faults, ${branched.stats.planChambers} chamber`);

// THE SOIL: air in the dug bore, soil beside it, the mound at the station.
const dig = await page.evaluate(() => {
  const s = window.railScene;
  s.activateBranchForTest(0);
  const stats = s.statsForTest();
  const mid = { x: stats.endX / 2, y: stats.endY / 2, z: (stats.endZ + 12) / 2 };
  return {
    inBore: s.solidAtMm(mid.x, mid.y, mid.z),
    // A far corner of the block no track goes near — including the queen
    // room, whose 15 mm half-width swallowed the first "beside" point.
    besideBore: s.solidAtMm(-40, -30, 70),
    mound: s.solidAtMm(11, 1.5, 0),
    carveMs: stats.carveMs,
  };
});
check('the bore is open air', dig.inBore === false);
check('the soil beside the bore holds', dig.besideBore === true);
check('the entrance mound is heaped over the station', dig.mound === true);
check('a carve is a moment, not a hang', dig.carveMs < 2500,
  `${dig.carveMs.toFixed(0)} ms`);

// THE ANT: her model loads, she rides with the walk input, cameras hold post.
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
  s.stepForTest(1 / 30, 5);
  const third = s.antForTest();
  const eye = Math.hypot(first.camX - first.x, first.camY - first.y, first.camZ - first.z);
  const shoulder = Math.hypot(third.camX - third.x, third.camY - third.y, third.camZ - third.z);
  return { queen: start.queen, sBefore: start.s, sAfter: walked.s, eye, shoulder };
});
check('the queen model is riding, not the cart', ant.queen === 1);
check('the walk input rides her along the tube', ant.sBefore - ant.sAfter > 8,
  `${ant.sBefore.toFixed(1)} → ${ant.sAfter.toFixed(1)} mm`);
check('first person sits in her eyes', ant.eye < 8, `${ant.eye.toFixed(1)} mm off`);
check('third person stands back from her', ant.shoulder > 15,
  `${ant.shoulder.toFixed(1)} mm back`);

// RIDING THROUGH HUBS: back off the branch onto the parent line, then
// forward through the room again by LOOKING down the branch's exit.
const through = await page.evaluate(() => {
  const s = window.railScene;
  s.activateBranchForTest(1); // the DOWN branch; she stands at its face
  const parentLen = (() => {
    s.activateBranchForTest(0);
    const l = s.statsForTest().lengthMm;
    s.activateBranchForTest(1);
    return l;
  })();
  s.setWalkForTest(-1); // ride back: branch → room → parent line
  s.stepForTest(1 / 30, 45); // 1.5 s = 18 mm against a 6 mm branch
  s.setWalkForTest(0);
  const back = { branch: s.antForTest().activeBranch, s: s.antForTest().s };
  // Now forward again: look down the DOWN exit and walk through the hub.
  s.setAimForTest(0, -75);
  s.setWalkForTest(1);
  s.stepForTest(1 / 30, 60); // 2 s = 24 mm, enough to re-enter the branch
  s.setWalkForTest(0);
  const fwd = { branch: s.antForTest().activeBranch, s: s.antForTest().s };
  return { parentLen, back, fwd };
});
check('riding back through the room lands her on the parent line',
  through.back.branch === 0, `on branch ${through.back.branch}`);
check('and she keeps going toward the station without a seam',
  through.back.s < through.parentLen - 8,
  `${through.back.s.toFixed(1)} of ${through.parentLen.toFixed(1)} mm`);
check('looking down the DOWN exit rides her forward into that branch',
  through.fwd.branch === 1, `on branch ${through.fwd.branch}`);
check('with the spill carried into the branch, not dropped at the door',
  through.fwd.s > 0.5, `${through.fwd.s.toFixed(1)} mm in`);

// FEET ON THE WALL: riding the line, the solver's pre-solve penetration
// stays small — the gait is finding the tube, not a phantom flat floor.
const feet = await page.evaluate(() => {
  const s = window.railScene;
  s.setWalkForTest(-1);
  s.stepForTest(1 / 30, 30);
  s.setWalkForTest(0);
  return s.antForTest();
});
check('the foot solver runs against the tunnel wall',
  Number.isFinite(feet.footPenMm) && feet.footPenMm < 2.5,
  `worst pre-solve penetration ${feet.footPenMm.toFixed(2)} mm`);

// GHOST AND WHEEL: arm a piece, tune it, place what the ghost shows.
const ghost = await page.evaluate(() => {
  const s = window.railScene;
  s.armForTest('straight');
  s.wheelTapForTest('pitch', -1);
  const tuned = s.ghostPieceForTest();
  const before = s.statsForTest().pieces;
  s.placeGhostForTest();
  const after = s.piecesForTest();
  s.cancelArmForTest();
  return { tuned, before, placed: after[after.length - 1], count: after.length };
});
check('the wheel tunes the ghost', ghost.tuned.pitch === -60,
  `ghost pitch ${ghost.tuned.pitch}`);
check('placing commits what the ghost shows',
  ghost.count === ghost.before + 1 && ghost.placed.pitch === -60);

// UNDO still undoes; smoothing still changes only the view.
const tidy = await page.evaluate(() => {
  const s = window.railScene;
  const before = s.statsForTest();
  s.undoForTest();
  const undone = s.statsForTest();
  s.setSmoothForTest(true);
  const smoothed = s.statsForTest();
  s.setSmoothForTest(false);
  return { before, undone, smoothed };
});
check('undo removes exactly the last piece',
  tidy.undone.pieces === tidy.before.pieces - 1);
check('smoothing leaves the pieces and the plan alone',
  tidy.smoothed.pieces === tidy.undone.pieces && tidy.smoothed.planFaults === 0);

check('no page errors', errs.length === 0, errs.join(' | '));

await browser.close();
console.log(failures === 0 ? 'RAIL RIG SOUND' : `RAIL RIG BROKEN — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
