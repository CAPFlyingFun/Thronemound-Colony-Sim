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
 * And THE DIG: one movement law — her legs, above ground and below — and a
 * shovel that takes a mouthful 10 mm wide, 5 mm tall and 3 mm deep. There
 * is no rail, no body capsule and no threshold prompt any more; a tunnel is
 * a hole wide enough to walk into, and walking into it is all there is.
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

console.log('\nTHE LOADING SCREEN (a dark curtain until the island AND the queen settle)');
const loadWorld = await page.evaluate(() => window.islandScene.loadingStateForTest());
check('the world readies behind the curtain', loadWorld.world === 1);
await page.waitForFunction(
  () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 60000 },
);
await page.waitForFunction(
  () => document.querySelector('.tm-loading-root') === null, null, { timeout: 15000 },
);
const loadDone = await page.evaluate(() => window.islandScene.loadingStateForTest());
check('playerReady waited for the queen to settle',
  loadDone.player === 1 && loadDone.queenSettled === 1);
check('the curtain faded out and left the DOM', loadDone.overlayGone === 1);

console.log('\nTHE STATS CHIP (telemetry folded away by default)');
const statsChip = await page.evaluate(() => {
  const chip = document.querySelector('.tm-stats-chip');
  const body = document.querySelector('.density-lab-status');
  const collapsed = body !== null && body.style.display === 'none';
  chip?.click();
  return {
    hasChip: chip !== null,
    collapsed,
    openNow: body !== null && body.style.display !== 'none',
  };
});
await page.waitForTimeout(1300); // one telemetry tick lands in the open body
const statsBody = await page.evaluate(() => {
  const body = document.querySelector('.density-lab-status');
  const text = body?.textContent ?? '';
  document.querySelector('.tm-stats-chip')?.click();
  return {
    hasTelemetry: text.includes('kauai island'),
    closedAgain: body !== null && body.style.display === 'none',
  };
});
check('a STATS chip exists and starts collapsed', statsChip.hasChip && statsChip.collapsed);
check('tap expands it and telemetry flows in', statsChip.openNow && statsBody.hasTelemetry);
check('tap again folds it away', statsBody.closedAgain);

/*
 * Getting UNDERGROUND is now just walking there: the mouth is a hole in the
 * ground and her own legs carry her into it, so the knock that used to
 * answer an ENTER? prompt is a plain walk.
 */
await page.evaluate(() => {
  window.__goIn = (fromXMm, fromZMm, facing, steps = 700) => {
    const s = window.islandScene;
    s.teleportMm(fromXMm, fromZMm);
    s.drainQueueForTest();
    s.setFacingForTest(facing);
    s.input.walk = 1;
    for (let i = 0; i < steps; i += 1) {
      s.stepForTest(1 / 30, 1);
      if (s.statsForTest().underground === 1) { s.input.walk = 0; return true; }
    }
    s.input.walk = 0;
    return false;
  };
});

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
  // With no nest at all, DIG SEEDS the founding mouth at the queen and
  // opens the tools around HER — no premade tunnel, and no guessing that
  // PLACE is the first move.
  s.openDesigner();
  const st = s.statsForTest();
  const boxNearHer = Math.abs(st.designX - (s.at.x * 5 - 160)) < 1
    && Math.abs(st.designZ - (s.at.z * 5 - 160)) < 1;
  const opened = st.designing;
  const d = s.designer;
  const seed = d.current();
  const first = seed.nodes[0];
  const seededMouth = seed.nodes.length === 1 && !!first && first.kind === 'entrance';
  const seedSelected = !!d.picked && d.picked.kind === 'node' && !!first
    && d.picked.id === first.id;
  const antOffMm = first ? Math.hypot(
    first.x - (s.at.x * 5 - st.designX), first.z - (s.at.z * 5 - st.designZ),
  ) : 99;
  const groundOffMm = first ? Math.abs(
    first.y - (s.renderedHeightAtMm(first.x + st.designX, first.z + st.designZ) - st.designY),
  ) : 99;
  // The seed is an EDIT: DONE with nothing else touched must still carve it.
  const carvesOnDone = d.hasUnbuilt === true;
  // Leave the plan untouched for the scripted founding below: clear the
  // seed so DONE has nothing to carve.
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
    bornNestless, opened, boxNearHer, seededMouth, seedSelected, antOffMm,
    groundOffMm, carvesOnDone, nodes: after.planNodes, rails: after.rails,
  };
});
check('the island is born nestless', founding.bornNestless === 0,
  `${founding.bornNestless} plan nodes at spawn`);
check('nestless DIG opens the nest tools around the queen',
  founding.opened === 1 && founding.boxNearHer);
check('and SEEDS the founding mouth, selected',
  founding.seededMouth === true && founding.seedSelected === true);
check('the seeded mouth sits AT the queen, on the ground',
  founding.antOffMm < 2 && founding.groundOffMm < 1.5,
  `${founding.antOffMm.toFixed(1)} mm from her, ${founding.groundOffMm.toFixed(2)} mm off the surface`);
check('and DONE would carve it untouched', founding.carvesOnDone === true);
check('the founding dig took', founding.nodes === 4,
  `${founding.nodes} nodes`);

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

/*
 * THE EYE MUST NOT ROLL. Handing `lookAt` a fixed world up and a look
 * parallel to it leaves the roll undefined, and straight down a shaft is
 * exactly that — the opening aims her at exactly -90°, so it was hit every
 * time. Measured before the fix: camera right ran (-1,0,0) to -89° and
 * snapped to (+1,0,0) at -90°, reported as the view sitting ninety degrees
 * off the ant. Both poles are swept, at two headings, because a singularity
 * that only shows at one bearing is still a singularity.
 */
const eyeRoll = await page.evaluate(() => {
  const s = window.islandScene;
  s.teleportMm(27950, 27950);
  s.drainQueueForTest();
  s.firstPerson = true;
  const worst = [];
  for (const facing of [0, Math.PI / 3]) {
    s.setFacingForTest(facing);
    // Her right hand, on the flat: the axis the camera's right must track.
    const rx = -Math.cos(facing);
    const rz = Math.sin(facing);
    let least = 1;
    for (let deg = 0; deg >= -90; deg -= 5) {
      s.aimPitch = (deg * Math.PI) / 180;
      s.fpPitch = s.aimPitch;
      s.stepForTest(1 / 30, 2);
      const m = s.camera.matrixWorld.elements;
      least = Math.min(least, m[0] * rx + m[2] * rz);
    }
    for (let deg = 0; deg <= 80; deg += 5) {
      s.aimPitch = (deg * Math.PI) / 180;
      s.fpPitch = s.aimPitch;
      s.stepForTest(1 / 30, 2);
      const m = s.camera.matrixWorld.elements;
      least = Math.min(least, m[0] * rx + m[2] * rz);
    }
    worst.push(least);
  }
  s.aimPitch = 0; s.fpPitch = 0; s.firstPerson = false;
  s.stepForTest(1 / 30, 4);
  return worst;
});
check('the eye never rolls, not even straight down a shaft',
  eyeRoll.every((d) => d > 0.99),
  `worst right-axis agreement ${eyeRoll.map((d) => d.toFixed(3)).join(', ')}`);
check('her body is hidden in her own eyes, crosshair on',
  fp.bodyHidden && fp.crosshairOn);
check('body and crosshair restore in third person',
  fp.bodyBack && fp.crosshairOff);

console.log('\nUNDERGROUND PAN OVERRIDE (drag orbits, capsule keeps following)');
const pan = await page.evaluate(() => {
  const s = window.islandScene;
  const n = Object.fromEntries(s.planForTest().map((p) => [p.id, p]));
  // Back into the nest: over the gate and down.
  window.__goIn(n.gate.x - 18, n.gate.z, Math.PI / 2);
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
/* Closer than it used to sit, and deliberately: a burrow is barely wider
 * than she is, so a camera that refuses to be inside the wall has to give
 * up its distance. The orbit still has to be BEHIND her and above, just
 * not out in the soil. */
check('held drag orbits close around her', pan.heldDist > 1.5 && pan.heldDist < 9
  && pan.heldY > 0.2, `${pan.heldDist.toFixed(1)} mm out, ${(pan.heldY * 5).toFixed(1)} mm up`);
check('released, the trail capsule takes the camera back',
  pan.backDist > 2 && pan.backDist < 12, `${pan.backDist.toFixed(1)} mm back`);

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

/*
 * The reported symptom was "empty space underground when the camera dips" —
 * unlit soil is black soil, and black soil reads as a hole in the world. The
 * density lab already solved it by sensing rather than lighting the dirt, so
 * what is checked here is the crossover: dark below, lit above, and the ramp
 * between the two rather than a switch.
 */
console.log('\nTHE UNDERGROUND SENSE (soil is sensed down there, lit up here)');
const sensed = await page.evaluate(() => {
  const s = window.islandScene;
  const n = Object.fromEntries(s.planForTest().map((p) => [p.id, p]));
  s.stepForTest(1 / 30, 30);
  const above = s.sense ? s.sense.uSense.value : -1;
  window.__goIn(n.gate.x - 18, n.gate.z, Math.PI / 2);
  s.input.walk = 1;
  for (let i = 0; i < 400; i += 1) s.stepForTest(1 / 30, 1);
  s.input.walk = 0;
  const under = s.sense ? s.sense.uSense.value : -1;
  const wasUnder = s.statsForTest().underground;
  // And back to daylight: a sense that never lets go would tint the island.
  s.teleportMm(28000, 28000);
  s.drainQueueForTest();
  const half = (() => {
    s.stepForTest(1 / 30, 3);
    return s.sense ? s.sense.uSense.value : -1;
  })();
  s.stepForTest(1 / 30, 60);
  return {
    wired: !!s.sense,
    soilOnly: s.islandMaterial !== s.soilMaterial,
    above,
    under,
    wasUnder,
    half,
    back: s.sense ? s.sense.uSense.value : -1,
  };
});
check('the soil knows how to be sensed', sensed.wired && sensed.soilOnly,
  'uniforms on the soil, not on the island sheet');
check('above ground the dirt is simply lit', sensed.above < 0.02,
  `uSense ${sensed.above.toFixed(3)}`);
check('in a bore it is sensed instead', sensed.wasUnder === 1 && sensed.under > 0.95,
  `uSense ${sensed.under.toFixed(3)} underground`);
check('and surfacing eases back rather than snapping', sensed.half > 0.1 && sensed.back < 0.05,
  `${sensed.half.toFixed(2)} three frames out, ${sensed.back.toFixed(3)} settled`);

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
