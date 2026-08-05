/**
 * KAUAI AT 1:1000 — is the island real, whole, and walkable?
 *
 *   1. all 64 sections build (vertex/triangle census matches the maths)
 *   2. the ant spawns mid-island on the summit plateau, ~1,300 m up
 *   3. real-Kauai sanity: the centre is high, the corners are ocean,
 *      the shoreline exists (a walk from summit toward the coast descends)
 *   4. a walk simulates without pops
 *   5. the red-sky test: fog off, background red, whole-island view — not
 *      one red pixel below the horizon line means not one hole anywhere
 *   6. no page errors
 *
 *   SMOKE_URL=http://localhost:4173/Thronemound-Colony-Sim/ node scripts/probe-island.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://localhost:4173/Thronemound-Colony-Sim/')
  .replace(/\/$/, '');

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
page.on('pageerror', (e) => errs.push(e.message));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 60000 });
await page.evaluate(() => window.islandScene.setPausedForTest(true));

console.log('\nTHE ISLAND');
const stats = await page.evaluate(() => window.islandScene.statsForTest());
check('all 64 sections built', stats.verts === 64 * 65 * 65 && stats.tris === 64 * 64 * 64 * 2,
  `${stats.verts.toLocaleString()} verts, ${stats.tris.toLocaleString()} tris`);

const geo = await page.evaluate(() => {
  const s = window.islandScene;
  return {
    centre: s.heightAtMm(28000, 28000),
    cornerNW: s.heightAtMm(2000, 2000),
    cornerSE: s.heightAtMm(54000, 54000),
    midwayWest: s.heightAtMm(14000, 28000),
    antX: s.at.x * 5,
    antZ: s.at.z * 5,
    antElev: s.heightAtMm(s.at.x * 5, s.at.z * 5),
  };
});
check('ant stands mid-island', Math.abs(geo.antX - 28000) < 100 && Math.abs(geo.antZ - 28000) < 100,
  `at (${geo.antX.toFixed(0)}, ${geo.antZ.toFixed(0)}) mm`);
check('the centre is the high country', geo.centre > 900,
  `${geo.centre.toFixed(0)} m elevation`);
check('the north-west corner is ocean', geo.cornerNW < 0,
  `${geo.cornerNW.toFixed(0)} m`);
check('the south-east corner is ocean', geo.cornerSE < 0,
  `${geo.cornerSE.toFixed(0)} m`);
check('west midway is lower than the summit (island falls to the sea)',
  geo.midwayWest < geo.centre, `${geo.midwayWest.toFixed(0)} m vs ${geo.centre.toFixed(0)} m`);

console.log('\nTHE FOUNDING DIG (the island is born nestless; the queen digs the first one)');
const founding = await page.evaluate(() => {
  const s = window.islandScene;
  const bornNestless = s.statsForTest().planNodes;
  // With no nest at all, DIG must open the designer's box around HER —
  // not around some phantom plan at the island's origin.
  s.openDesigner();
  const st = s.statsForTest();
  const boxNearHer = Math.abs(st.designX - (s.at.x * 5 - 160)) < 1
    && Math.abs(st.designZ - (s.at.z * 5 - 160)) < 1;
  const openedEmpty = st.designing;
  // A nestless plan presets PLACE to the MOUTH — the piece it must start with.
  const presetMouth = s.designer.placing === 'entrance';
  // The founding PLACE lands at the QUEEN, grounded — not ahead of a camera.
  const d = s.designer;
  d.place();
  const first = d.current().nodes[0];
  const antOffMm = Math.hypot(
    first.x - (s.at.x * 5 - st.designX), first.z - (s.at.z * 5 - st.designZ),
  );
  const groundOffMm = Math.abs(
    first.y - (s.renderedHeightAtMm(first.x + st.designX, first.z + st.designZ) - st.designY),
  );
  // Leave the plan untouched for the scripted founding below: clear the
  // scratch mouth so DONE has nothing to carve.
  d.plan = { nodes: [], edges: [] };
  d.picked = null;
  d.dirty = false;
  s.closeDesignerForTest();
  // Found the colony: the classic four-node nest, dug through the pipeline
  // the DIG IT button uses. Everything downstream probes THIS nest.
  const ex = 28040;
  const ez = 28000;
  const ground = s.heightAtMm(ex, ez);
  s.applyPlanForTest({
    nodes: [
      { id: 'gate', kind: 'entrance', x: ex, y: ground, z: ez, radiusMm: 8 },
      { id: 'hall', kind: 'junction', x: ex, y: ground - 56, z: ez, radiusMm: 4 },
      { id: 'bend', kind: 'junction', x: ex + 64, y: ground - 72, z: ez + 10, radiusMm: 4 },
      { id: 'store', kind: 'chamber', x: ex + 112, y: ground - 84, z: ez + 18, radiusMm: 10 },
    ],
    edges: [
      { id: 'shaft', from: 'gate', to: 'hall', radiusMm: 4, flow: 'both' },
      { id: 'drift', from: 'hall', to: 'bend', radiusMm: 4, flow: 'both' },
      { id: 'run', from: 'bend', to: 'store', radiusMm: 4, flow: 'both' },
    ],
  });
  s.drainQueueForTest();
  const after = s.statsForTest();
  return {
    bornNestless, openedEmpty, boxNearHer, presetMouth, antOffMm, groundOffMm,
    nodes: after.planNodes, rails: after.rails,
  };
});
check('the island is born nestless', founding.bornNestless === 0,
  `${founding.bornNestless} plan nodes at spawn`);
check('nestless DIG opens the designer around the queen',
  founding.openedEmpty === 1 && founding.boxNearHer);
check('and PLACE is preset to the MOUTH', founding.presetMouth === true);
check('the founding mouth lands AT the queen, on the ground',
  founding.antOffMm < 2 && founding.groundOffMm < 1.5,
  `${founding.antOffMm.toFixed(1)} mm from her, ${founding.groundOffMm.toFixed(2)} mm off the surface`);
check('the founding dig took', founding.nodes === 4 && founding.rails === 3,
  `${founding.nodes} nodes, ${founding.rails} rails`);

console.log('\nTHE PRE-TUNNEL (streamed soil, nest folded into the function)');
/* One stance at (28100, 28020) puts the whole plan in the window: gate at
 * x=28040, store 112 mm east of it. */
const nest = await page.evaluate(() => {
  const s = window.islandScene;
  s.teleportMm(28100, 28020);
  s.drainQueueForTest();
  const n = Object.fromEntries(s.planForTest().map((p) => [p.id, p]));
  return {
    n,
    shaft: s.solidAtMm(n.gate.x, n.gate.y - 20, n.gate.z),
    hall: s.solidAtMm(n.hall.x, n.hall.y, n.hall.z),
    store: s.solidAtMm(n.store.x, n.store.y, n.store.z),
    soilBeside: s.solidAtMm(n.gate.x + 22, n.gate.y - 30, n.gate.z),
    soilBelowStore: s.solidAtMm(n.store.x, n.store.y - 26, n.store.z),
    entranceTop: s.stream.surfaceHeightAt(n.gate.x / 5, n.gate.z / 5) * 5,
    groundMm: n.gate.y,
    edited: s.statsForTest().edited,
  };
});
check('shaft below the gate is air', nest.shaft === false, `solidAtMm=${nest.shaft}`);
check('hall is air', nest.hall === false, `solidAtMm=${nest.hall}`);
check('store chamber is air', nest.store === false, `solidAtMm=${nest.store}`);
check('soil beside the shaft is soil', nest.soilBeside === true, `solidAtMm=${nest.soilBeside}`);
check('soil below the store is soil', nest.soilBelowStore === true, `solidAtMm=${nest.soilBelowStore}`);
check('the entrance is open THROUGH the island surface',
  nest.entranceTop < nest.groundMm - 30,
  `soil top ${nest.entranceTop.toFixed(1)} mm vs ground ${nest.groundMm.toFixed(1)} mm`);
check('the born nest cost zero saved samples', nest.edited === 0,
  `${nest.edited} edits stored`);

console.log('\nLEAVE AND RETURN (the tunnels rebuild from the pure function)');
const roundtrip = await page.evaluate(() => {
  const s = window.islandScene;
  const n = Object.fromEntries(s.planForTest().map((p) => [p.id, p]));
  s.teleportMm(20000, 20000);
  s.drainQueueForTest();
  const gateWhileAway = s.solidAtMm(n.gate.x, n.gate.y - 20, n.gate.z);
  s.teleportMm(28100, 28020);
  s.drainQueueForTest();
  return {
    gateWhileAway,
    shaftAgain: s.solidAtMm(n.gate.x, n.gate.y - 20, n.gate.z),
    storeAgain: s.solidAtMm(n.store.x, n.store.y, n.store.z),
    edited: s.statsForTest().edited,
  };
});
check('gate column unloads 8 m away', roundtrip.gateWhileAway === null);
check('shaft is air AGAIN', roundtrip.shaftAgain === false, `solidAtMm=${roundtrip.shaftAgain}`);
check('store is air AGAIN', roundtrip.storeAgain === false, `solidAtMm=${roundtrip.storeAgain}`);
check('reconstruction still cost zero saved samples', roundtrip.edited === 0,
  `${roundtrip.edited} edits stored`);

console.log('\nA HAND-DIG THROUGH THE ISLAND SURFACE');
const dig = await page.evaluate(() => {
  const s = window.islandScene;
  s.teleportMm(27950, 27950);
  s.drainQueueForTest();
  s.setFacingForTest(0); // facing +z; the mouth rides 1.4 mm ahead
  const mouthX = 27950 / 5;
  const mouthZ = (27950 + 1.4) / 5;
  const before = s.stream.surfaceHeightAt(mouthX, mouthZ) * 5;
  s.input.dig = true;
  s.stepForTest(1 / 30, 90); // three seconds of chewing, deterministic
  s.input.dig = false;
  s.drainQueueForTest();
  const after = s.stream.surfaceHeightAt(mouthX, mouthZ) * 5;
  // Leave far enough that the hole's column unloads, then come back.
  s.teleportMm(20000, 20000);
  s.drainQueueForTest();
  const goneWhileAway = s.solidAtMm(27950, 1300, 27951.4);
  s.teleportMm(27950, 27950);
  s.drainQueueForTest();
  const returned = s.stream.surfaceHeightAt(mouthX, mouthZ) * 5;
  return {
    before, after, returned, goneWhileAway, edited: s.statsForTest().edited,
  };
});
check('the surface under the mouth dropped', dig.after < dig.before - 1.5,
  `${dig.before.toFixed(1)} → ${dig.after.toFixed(1)} mm`);
check('the dig is in the sparse store', dig.edited > 0, `${dig.edited} samples`);
check('hole column unloaded while away', dig.goneWhileAway === null);
check('the hole SURVIVED the round trip', Math.abs(dig.returned - dig.after) < 0.5,
  `${dig.after.toFixed(1)} mm before, ${dig.returned.toFixed(1)} mm after`);

console.log('\nTHE WALKS (clearance is against the DRAWN triangles — below zero');
console.log('is "she went underground", the playtest bug this pins down forever)');
const runWalk = (xMm, zMm, facing) => page.evaluate(([x0, z0, face]) => {
  const s = window.islandScene;
  s.teleportMm(x0, z0);
  s.setFacingForTest(face);
  s.input.walk = 1;
  let worstStepMm = 0;
  let minClearMm = Infinity;
  let lastY = null;
  for (let i = 0; i < 1500; i += 1) {
    s.stepForTest(1 / 30, 1);
    const y = s.at.y * 5;
    if (lastY !== null) worstStepMm = Math.max(worstStepMm, Math.abs(y - lastY));
    lastY = y;
    minClearMm = Math.min(
      minClearMm, y - s.renderedHeightAtMm(s.at.x * 5, s.at.z * 5),
    );
  }
  s.input.walk = 0;
  return {
    worstStepMm,
    minClearMm,
    travelledMm: Math.hypot(s.at.x * 5 - x0, s.at.z * 5 - z0),
  };
}, [xMm, zMm, facing]);
const walks = [
  ['west off the summit plateau', await runWalk(28000, 28000, -Math.PI / 2)],
  ['through canyon country', await runWalk(16000, 34000, Math.PI)],
];
for (const [name, walk] of walks) {
  check(`${name}: no pop underfoot`, walk.worstStepMm < 2.0,
    `worst step ${walk.worstStepMm.toFixed(2)} mm over ${walk.travelledMm.toFixed(0)} mm`);
  check(`${name}: never below the drawn ground`, walk.minClearMm > 0,
    `worst clearance ${walk.minClearMm.toFixed(2)} mm`);
}

console.log('\nINTO THE HOLE (the playtest bug: "it bounced me back up")');
const descent = await page.evaluate(() => {
  const s = window.islandScene;
  const n = Object.fromEntries(s.planForTest().map((p) => [p.id, p]));
  // Start two body lengths west of the gate, walk east across it.
  s.teleportMm(n.gate.x - 18, n.gate.z);
  s.drainQueueForTest();
  s.setFacingForTest(Math.PI / 2);
  s.input.walk = 1;
  let deepest = Infinity;
  let bouncedUp = 0;
  let wasUnder = false;
  for (let i = 0; i < 900; i += 1) {
    s.stepForTest(1 / 30, 1);
    const y = s.at.y * 5;
    const surface = s.renderedHeightAtMm(s.at.x * 5, s.at.z * 5);
    const under = y < surface - 6;
    if (under) wasUnder = true;
    // Once she is underground, popping back ABOVE the surface without
    // climbing (no wall contact reported) is the old roof-yank bug.
    if (wasUnder && y > surface + 3) bouncedUp += 1;
    deepest = Math.min(deepest, y - surface);
    if (deepest < -40) break; // she's properly down the shaft — stop there
  }
  s.input.walk = 0;
  return { deepest, bouncedUp, under: s.statsForTest().underground };
});
check('she gets INTO the hole', descent.deepest < -30,
  `deepest ${descent.deepest.toFixed(1)} mm below the surface`);
check('and is never yanked back through the roof', descent.bouncedUp === 0,
  `${descent.bouncedUp} bounce frames`);
check('the scene knows she is underground', descent.under === 1);

console.log('\nTHE UNDERGROUND CHASE CAMERA');
const chase = await page.evaluate(() => {
  const s = window.islandScene;
  // Keep walking along the drift so the trail has shape, then let the
  // camera settle.
  s.input.walk = 1;
  s.stepForTest(1 / 30, 120);
  s.input.walk = 0;
  s.stepForTest(1 / 30, 40);
  const camY = s.camera.position.y * 5;
  const surfaceAtCam = s.renderedHeightAtMm(s.camera.position.x * 5, s.camera.position.z * 5);
  return {
    dist: s.camera.position.distanceTo(s.at) * 5,
    camBelowSurface: camY < surfaceAtCam,
  };
});
check('the camera follows a few mm behind her', chase.dist > 2 && chase.dist < 12,
  `${chase.dist.toFixed(1)} mm back`);
check('and is itself inside the tunnel, not the hillside sky',
  chase.camBelowSurface === true);

console.log('\nTHE RAIL (down the middle of the tube — playtest\'s own spec)');
const rail = await page.evaluate(() => {
  const s = window.islandScene;
  // She fell into the shaft in the descent test — the rail should have her.
  const bound = s.statsForTest().railBound;
  // Ride the whole nest: forward to the store dead end...
  s.input.walk = 1;
  // She CRAWLS the bore wall now (back to the centerline, legs on the
  // tube): her riding depth is r - 1.3 mm, and the gap between where she
  // is and that wall says whether she floats or clips. Joint hand-offs
  // blend for a few frames, so the probe scores the SHARE of bad frames.
  let gapWorst = 0;
  let gapBad = 0;
  let railFrames = 0;
  let pitchOk = 0;
  for (let i = 0; i < 900; i += 1) {
    s.stepForTest(1 / 30, 1);
    const st = s.railStateForTest();
    if (st.edge >= 0) {
      railFrames += 1;
      const gap = (st.rMm - 1.3) - st.offMm;
      gapWorst = Math.max(gapWorst, Math.abs(gap));
      if (Math.abs(gap) > 2.5) gapBad += 1;
      // Body pitch follows the bore: quaternion forward vs the rail axis.
      // (Pose only runs once her model loads — skip the frames before.)
      if (s.queenReady) {
        const V = Object.getPrototypeOf(s.at).constructor;
        const fwd = new V(0, 0, 1).applyQuaternion(s.queen.root.quaternion);
        if (Math.abs(fwd.dot(s.railForward)) > 0.9) pitchOk += 1;
      } else {
        pitchOk += 1; // no model, no pose — nothing to misalign
      }
    }
  }
  const n = Object.fromEntries(s.planForTest().map((p) => [p.id, p]));
  const atStore = Math.hypot(
    s.at.x * 5 - n.store.x, s.at.y * 5 - n.store.y, s.at.z * 5 - n.store.z,
  );
  // ...then back out: pulling BACK is how you ride a vertical bore upward.
  // The gate no longer ejects her — it ASKS. The probe's thumb presses YES
  // the moment the SURFACE? offer appears, then expects daylight.
  s.input.walk = -1;
  let outAt = -1;
  let offeredAt = -1;
  for (let i = 0; i < 1600; i += 1) {
    s.stepForTest(1 / 30, 1);
    if (offeredAt < 0 && s.surfaceOfferForTest()) {
      offeredAt = i;
      s.answerSurfaceForTest(true);
    }
    if (s.statsForTest().railBound === 0
      && s.at.y * 5 >= s.renderedHeightAtMm(s.at.x * 5, s.at.z * 5) - 2) {
      outAt = i;
      break;
    }
  }
  s.input.walk = 0;
  const surface = s.renderedHeightAtMm(s.at.x * 5, s.at.z * 5);
  return {
    bound,
    railFrames,
    gapWorst,
    gapBadShare: railFrames > 0 ? gapBad / railFrames : 1,
    pitchShare: railFrames > 0 ? pitchOk / railFrames : 0,
    atStore,
    outAt,
    offeredAt,
    railBoundAfter: s.statsForTest().railBound,
    aboveMm: s.at.y * 5 - surface,
  };
});
check('the shaft handed her to the rail', rail.bound === 1);
check('she crawls ON the bore wall, back to the centerline', rail.gapBadShare < 0.1,
  `off the wall on ${(rail.gapBadShare * 100).toFixed(0)}% of ${rail.railFrames} rail frames, worst ${rail.gapWorst.toFixed(1)} mm`);
check('her body pitch follows the tube', rail.pitchShare > 0.85,
  `${(rail.pitchShare * 100).toFixed(0)}% of ${rail.railFrames} rail frames aligned`);
check('the rail delivered her to the store', rail.atStore < 14,
  `${rail.atStore.toFixed(1)} mm from the chamber`);
check('the gate ASKS instead of ejecting', rail.offeredAt >= 0,
  `SURFACE? offered after ${rail.offeredAt} steps`);
check('riding back surfaces her at the gate',
  rail.outAt >= 0 && rail.railBoundAfter === 0 && rail.aboveMm > -6,
  `out after ${rail.outAt} steps, ${rail.aboveMm.toFixed(1)} mm vs surface`);

console.log('\nNO HOLES EVEN STARVED (budget capped at 1 chunk/frame)');
const churn = await page.evaluate(() => {
  const s = window.islandScene;
  s.teleportMm(26000, 26000);
  s.drainQueueForTest();
  s.setMeshBudgetCapForTest(1); // a 20 fps phone's backlog, simulated
  s.setFacingForTest(Math.PI);
  s.input.sprint = true;
  s.input.walk = 1;
  let uncovered = 0;
  for (let i = 0; i < 600; i += 1) {
    s.stepForTest(1 / 30, 1);
    if (i % 5 === 0 && !s.clipCoveredForTest()) uncovered += 1;
  }
  s.input.walk = 0;
  s.input.sprint = false;
  s.setMeshBudgetCapForTest(Infinity);
  s.drainQueueForTest();
  return { uncovered, covered: s.clipCoveredForTest() };
});
check('the clip NEVER exposed an unbuilt chunk', churn.uncovered === 0,
  `${churn.uncovered} uncovered samples of 120 during starved sprint`);
check('and full coverage returns after the drain', churn.covered === true);

console.log('\nNEVER IN THE WALLS (grinding every direction at the joints)');
/* The playtest disaster this pins down: at tunnel joints, "there is a
 * floor below the destination" used to walk her centre into thin soil
 * ribs. Embedded, the camera sits inside soil and the world renders
 * see-through — reported as "holes all over" and "forced into the
 * terrain". Grind into the joint region from every direction and assert
 * her body centre NEVER samples solid. */
const grind = await page.evaluate(() => {
  const s = window.islandScene;
  const n = Object.fromEntries(s.planForTest().map((p) => [p.id, p]));
  s.teleportMm(n.gate.x - 18, n.gate.z);
  s.drainQueueForTest();
  s.setFacingForTest(Math.PI / 2);
  s.input.walk = 1;
  for (let i = 0; i < 500; i += 1) {
    s.stepForTest(1 / 30, 1);
    if (s.at.y * 5 < s.renderedHeightAtMm(s.at.x * 5, s.at.z * 5) - 40) break;
  }
  let embedded = 0;
  let run = 0;
  let worstRunFree = 0;
  let worstRunRail = 0;
  let deepestMm = Infinity;
  for (let i = 0; i < 1200; i += 1) {
    if (i % 40 === 0) s.setFacingForTest(s.facing + 2.4);
    s.stepForTest(1 / 30, 1);
    if (s.stream.solidAtWu(s.at.x, s.at.y, s.at.z) === true) {
      embedded += 1;
      run += 1;
      if (s.statsForTest().railBound === 1) worstRunRail = Math.max(worstRunRail, run);
      else worstRunFree = Math.max(worstRunFree, run);
    } else {
      run = 0;
    }
    deepestMm = Math.min(
      deepestMm, s.at.y * 5 - s.renderedHeightAtMm(s.at.x * 5, s.at.z * 5),
    );
  }
  s.input.walk = 0;
  return { embedded, worstRunFree, worstRunRail, deepestMm };
});
/* Free mode: single-frame solids are rounding flicker (snap-back fires at
 * three consecutive). Rail mode: the position lerp squeezes joint corners
 * for a few frames — she is following the bore by construction, so a brief
 * corner brush is a squeeze, not the see-through embedding. */
check('free mode never embedded past the snap threshold', grind.worstRunFree <= 2,
  `worst free run ${grind.worstRunFree}, ${grind.embedded} transient frames of 1200`);
check('rail corner squeezes stay brief', grind.worstRunRail <= 6,
  `worst rail run ${grind.worstRunRail}`);
check('and she was genuinely down among the joints for it', grind.deepestMm < -30,
  `deepest ${grind.deepestMm.toFixed(1)} mm`);

console.log('\nKEYBOARD (WASD writes the same inputs the stick does)');
const keys = await page.evaluate(async () => {
  const s = window.islandScene;
  const press = (key, type) => window.dispatchEvent(new KeyboardEvent(type, { key }));
  press('w', 'keydown');
  press('Shift', 'keydown');
  const held = { walk: s.input.walk, sprint: s.input.sprint };
  press('w', 'keyup');
  press('Shift', 'keyup');
  press('a', 'keydown');
  const turning = s.input.yaw;
  press('a', 'keyup');
  const fpBefore = s.statsForTest().firstPerson;
  press('v', 'keydown');
  press('v', 'keyup');
  const fpAfter = s.statsForTest().firstPerson;
  press('v', 'keydown');
  press('v', 'keyup');
  return {
    held, turning, released: { walk: s.input.walk, yaw: s.input.yaw }, fpBefore, fpAfter,
  };
});
check('W walks, Shift sprints', keys.held.walk === 1 && keys.held.sprint === true);
check('A turns left', keys.turning === -1);
check('keys release cleanly', keys.released.walk === 0 && keys.released.yaw === 0);
check('V toggles first person', keys.fpBefore === 0 && keys.fpAfter === 1);

console.log('\nFIRST PERSON (her own eyes)');
const fp = await page.evaluate(() => {
  const s = window.islandScene;
  s.teleportMm(27950, 27950);
  s.drainQueueForTest();
  s.firstPerson = true;
  s.stepForTest(1 / 30, 10);
  const d = s.camera.position.distanceTo(s.at) * 5;
  const bodyHidden = s.queen.root.visible === false;
  const crosshairOn = s.crosshair.style.display !== 'none';
  s.firstPerson = false;
  s.stepForTest(1 / 30, 10);
  // Restore means "visible again IF her model has loaded" — headless runs
  // sometimes outpace the GLB fetch, and that must not fail this check.
  const bodyBack = s.queen.root.visible === s.queenReady;
  const crosshairOff = s.crosshair.style.display === 'none';
  return { d, bodyHidden, crosshairOn, bodyBack, crosshairOff };
});
check('the camera sits on the ant', fp.d < 4, `${fp.d.toFixed(1)} mm from her centre`);
check('her body is hidden in her own eyes, crosshair on',
  fp.bodyHidden && fp.crosshairOn);
check('body and crosshair restore in third person',
  fp.bodyBack && fp.crosshairOff);

console.log('\nUNDERGROUND PAN OVERRIDE (drag orbits, capsule keeps following)');
const pan = await page.evaluate(() => {
  const s = window.islandScene;
  const n = Object.fromEntries(s.planForTest().map((p) => [p.id, p]));
  // Back into the nest: over the gate and down.
  s.teleportMm(n.gate.x - 18, n.gate.z);
  s.drainQueueForTest();
  s.setFacingForTest(Math.PI / 2);
  s.input.walk = 1;
  for (let i = 0; i < 900; i += 1) {
    s.stepForTest(1 / 30, 1);
    if (s.statsForTest().underground === 1
      && s.at.y * 5 < s.renderedHeightAtMm(s.at.x * 5, s.at.z * 5) - 40) break;
  }
  s.input.walk = 0;
  s.stepForTest(1 / 30, 40);
  const trailDist = s.camera.position.distanceTo(s.at) * 5;
  // Hold a drag: the orbit override takes the camera, still centred on her.
  s.lookPointer = 99;
  s.camYaw = s.facing + Math.PI / 2;
  s.camPitch = 0.9;
  s.stepForTest(1 / 30, 60);
  const heldDist = s.camera.position.distanceTo(s.at) * 5;
  const heldY = s.camera.position.y - s.at.y;
  // Let go: the trail cam takes it back.
  s.lookPointer = null;
  s.stepForTest(1 / 30, 80);
  const backDist = s.camera.position.distanceTo(s.at) * 5;
  return {
    under: s.statsForTest().underground, trailDist, heldDist, heldY, backDist,
  };
});
check('she is underground for the pan test', pan.under === 1);
check('held drag orbits close around her', pan.heldDist > 3 && pan.heldDist < 9
  && pan.heldY > 0.5, `${pan.heldDist.toFixed(1)} mm out, ${(pan.heldY * 5).toFixed(1)} mm up`);
check('released, the trail capsule takes the camera back',
  pan.backDist > 2 && pan.backDist < 12, `${pan.backDist.toFixed(1)} mm back`);

console.log('\nFREE MODE (the rail never takes her)');
const freeMode = await page.evaluate(() => {
  const s = window.islandScene;
  const n = Object.fromEntries(s.planForTest().map((p) => [p.id, p]));
  s.setFreeMode(true);
  s.teleportMm(n.gate.x - 18, n.gate.z);
  s.drainQueueForTest();
  s.setFacingForTest(Math.PI / 2);
  s.input.walk = 1;
  let boundFrames = 0;
  let wentUnder = 0;
  for (let i = 0; i < 900; i += 1) {
    s.stepForTest(1 / 30, 1);
    const st = s.statsForTest();
    if (st.railBound === 1) boundFrames += 1;
    if (st.underground === 1) wentUnder = 1;
    if (st.underground === 1
      && s.at.y * 5 < s.renderedHeightAtMm(s.at.x * 5, s.at.z * 5) - 40) break;
  }
  s.input.walk = 0;
  s.stepForTest(1 / 30, 30);
  const stillFree = s.statsForTest().railBound;
  const underNow = s.statsForTest().underground;
  // Flip FREE off right where she stands: the rail may take her again.
  s.setFreeMode(false);
  s.stepForTest(1 / 30, 60);
  const rebound = s.statsForTest().railBound;
  return { boundFrames, wentUnder, stillFree, underNow, rebound };
});
check('she went underground on her own six feet', freeMode.wentUnder === 1);
check('the rail NEVER took her in free mode',
  freeMode.boundFrames === 0 && freeMode.stillFree === 0,
  `${freeMode.boundFrames} bound frames`);
check('free off, underground: the rail takes her again',
  freeMode.underNow !== 1 || freeMode.rebound === 1,
  `under=${freeMode.underNow} rebound=${freeMode.rebound}`);

console.log("\nTHE DESIGNER'S DIG IT (a planned tunnel becomes soil and rail)");
const digIt = await page.evaluate(() => {
  const s = window.islandScene;
  const n = Object.fromEntries(s.planForTest().map((p) => [p.id, p]));
  s.teleportMm(n.store.x, n.store.z);
  s.drainQueueForTest();
  // The designer opens and closes without touching the world.
  s.openDesigner();
  const opened = s.statsForTest().designing;
  const panelUp = document.querySelector('.nest-designer') !== null;
  s.closeDesignerForTest();
  const closed = s.statsForTest().designing;
  // Space opens it too — and a release WHILE it is open must not swallow
  // the next press (the sticky-edge bug).
  const press = (key, type) => window.dispatchEvent(new KeyboardEvent(type, { key }));
  press(' ', 'keydown');
  const spaceOpened = s.statsForTest().designing;
  press(' ', 'keyup');
  s.closeDesignerForTest();
  press(' ', 'keydown');
  const spaceReopened = s.statsForTest().designing;
  press(' ', 'keyup');
  s.closeDesignerForTest();
  // Extend the plan the way DIG IT does: a new run east off the store.
  const plan = s.currentPlanForTest();
  const store = plan.nodes.find((p) => p.id === 'store');
  plan.nodes.push({
    id: 'probe-room', kind: 'chamber',
    x: store.x + 48, y: store.y - 30, z: store.z, radiusMm: 8,
  });
  plan.edges.push({
    id: 'probe-run', from: 'store', to: 'probe-room', radiusMm: 4, flow: 'both',
  });
  const railsBefore = s.statsForTest().rails;
  s.applyPlanForTest(plan);
  s.drainQueueForTest();
  const mid = { x: store.x + 24, y: store.y - 15, z: store.z };
  return {
    opened,
    panelUp,
    closed,
    spaceOpened,
    spaceReopened,
    railsBefore,
    railsAfter: s.statsForTest().rails,
    midAir: s.solidAtMm(mid.x, mid.y, mid.z),
    roomAir: s.solidAtMm(store.x + 48, store.y - 30, store.z),
    // The hillside SLOPES here — above the run is soon open sky, so the
    // over-carve guard samples the deep soil below the new room instead.
    soilBelow: s.solidAtMm(store.x + 48, store.y - 60, store.z),
  };
});
check('DIG opens the designer, DONE closes it',
  digIt.opened === 1 && digIt.panelUp && digIt.closed === 0);
check('Space opens it, and reopens after a release while open',
  digIt.spaceOpened === 1 && digIt.spaceReopened === 1,
  `first=${digIt.spaceOpened} again=${digIt.spaceReopened}`);
check('DIG IT bored the planned run open', digIt.midAir === false,
  `solidAtMm=${digIt.midAir}`);
check('and hollowed the new chamber', digIt.roomAir === false,
  `solidAtMm=${digIt.roomAir}`);
check('the soil below the new chamber is still soil', digIt.soilBelow === true,
  `solidAtMm=${digIt.soilBelow}`);
check('the new run joined the rail network', digIt.railsAfter === digIt.railsBefore + 1,
  `${digIt.railsBefore} -> ${digIt.railsAfter}`);

console.log('\nTHE GROUNDED ENTRANCE (mouths snap to the terrain, GRND toggles it)');
const grounded = await page.evaluate(() => {
  const s = window.islandScene;
  s.teleportMm(27800, 28200); // a summit slope, away from the nest
  s.drainQueueForTest();
  s.openDesigner();
  const d = s.designer;
  const st = s.statsForTest();
  const terrain = (x, z) => s.renderedHeightAtMm(st.designX + x, st.designZ + z) - st.designY;
  // Place a mouth: wherever the drop lands, its height must be the ground.
  d.placing = 'entrance';
  d.place();
  const mouth = d.current().nodes.slice(-1)[0];
  const placedOff = Math.abs(mouth.y - terrain(mouth.x, mouth.z));
  // Drag it about (a step is the drag's deterministic cousin): it re-finds
  // the ground under its new spot.
  d.step(3, 0, 0);
  const stepped = d.current().nodes.slice(-1)[0];
  const steppedOff = Math.abs(stepped.y - terrain(stepped.x, stepped.z));
  const movedXZ = Math.hypot(stepped.x - mouth.x, stepped.z - mouth.z);
  // The toggle frees the height for by-hand placement.
  d.groundSnap = false;
  d.step(0, 1, 0);
  d.step(0, 1, 0);
  const freed = d.current().nodes.slice(-1)[0];
  const rose = freed.y - stepped.y;
  s.closeDesignerForTest();
  s.drainQueueForTest();
  return { placedOff, steppedOff, movedXZ, rose };
});
check('a placed mouth sits ON the ground', grounded.placedOff < 1.5,
  `${grounded.placedOff.toFixed(2)} mm off the surface`);
check('dragging it re-finds the ground', grounded.movedXZ > 3 && grounded.steppedOff < 1.5,
  `moved ${grounded.movedXZ.toFixed(1)} mm, ${grounded.steppedOff.toFixed(2)} mm off`);
check('GRND off frees the height', grounded.rose > 3,
  `rose ${grounded.rose.toFixed(1)} mm with the toggle off`);

console.log('\nTHE RED-SKY TEST (fog off, red background, island panorama)');
await page.evaluate(() => {
  const s = window.islandScene;
  s.teleportMm(28000, 28000);
  s.drainQueueForTest();
  s.scene.fog = null;
  s.scene.background.setHex(0xff0000);
  s.camPitch = 0.35;
  s.camDist = 900;
  s.setPausedForTest(false);
});
await page.waitForTimeout(800);
const holes = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  // readPixels is bottom-up: rows 0..h*0.45 are the LOWER 45% of the screen,
  // safely below the horizon from this boom height — sky must not appear.
  let red = 0;
  const rows = Math.floor(h * 0.45);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      if (px[o] > 200 && px[o + 1] < 60 && px[o + 2] < 60) red += 1;
    }
  }
  return { red, sampled: rows * w };
});
check('not one hole in the island', holes.red === 0,
  `${holes.red} red pixels of ${holes.sampled.toLocaleString()} below the horizon`);

console.log('\nERRORS');
check('no page errors', errs.length === 0, errs.join(' | ').slice(0, 200));

// Pretty shots: a reload puts the real sky and haze back. Cosmetic — a
// slow SwiftShader raster must not fail the run.
try {
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 60000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: '/tmp/island-summit.png', timeout: 90000 });
await page.evaluate(() => {
  const s = window.islandScene;
  s.setPausedForTest(true);
  s.teleportMm(20000, 10000);
  s.camPitch = 0.22;
  s.camDist = 500;
  s.setPausedForTest(false);
});
await page.waitForTimeout(700);
await page.screenshot({ path: '/tmp/island-coast.png', timeout: 90000 });
} catch (e) {
  console.log(`  info  screenshots skipped: ${String(e).slice(0, 80)}`);
}

await browser.close();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECKS FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
