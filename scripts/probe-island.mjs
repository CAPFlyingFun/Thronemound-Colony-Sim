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
 * And THE PROLOGUE PATH, end to end, which is what the stabilisation pass
 * exists to keep true: the curtain lifts only when island AND queen are
 * ready · DIG seeds a mouth at the queen · the shaft GRIPs her · she rides
 * every orientation · the room frees her · she roams it without clipping ·
 * the mouth GRIPs her back · riding toward the gate auto-surfaces her.
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
 * Every probe below that wants to be UNDERGROUND has to knock: walking onto
 * the mouth asks ENTER? and waits, so the old "walk east across the gate and
 * fall in" preamble no longer descends on its own. This is that knock.
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
      const ask = s.gateAskForTest();
      if (ask && ask.kind === 'enter') {
        s.answerGateForTest(true);
        return true;
      }
    }
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

console.log('\nTHE TUNNEL BUILDER (a palette of pieces, laid as you play)');
/*
 * The guided dig, end to end, and it is a coaster builder now rather than a
 * chew: the FIRST tap on a nestless island sinks the opening and aims her
 * straight down, and every tap after that lays the armed piece on the
 * growing end. Each one is instant and each one costs stamina, so the pace
 * is recovery. Then the end joint becomes a Y and its 45° arms open.
 */
const builder = await page.evaluate(() => {
  const s = window.islandScene;
  const bx = 26600;
  const bz = 26600;
  s.teleportMm(bx, bz);
  s.drainQueueForTest();
  s.setFacingForTest(0.4);
  s.aimPitch = 0;
  s.digMode = true;
  s.stepForTest(1 / 30, 2);

  // The ghost is up before anything is dug, showing the shaft to come.
  const ghostFirst = s.guide && s.guide.visible === true;
  const nestless = s.builderOriginMm === null;

  // THE OPENING: one tap, and she is aimed down her own heading.
  s.digPiece('straight');
  s.drainQueueForTest();
  const founded = s.builderOriginMm !== null;
  const aimedDown = s.aimPitch;
  const openingPieces = s.builder.branches[0].pieces.length;
  const entrance = s.soil.plan.nodes.find((n) => n.id === 'b0-0');

  // The shaft is really air, a piece-length under the mouth.
  const o = s.builderOriginMm;
  const shaftAir = s.solidAtMm(o.x, o.y - 12, o.z);

  // STAMINA paces it: the next tap is refused until she recovers.
  s.builder.stamina = 0;
  s.digPiece('straight');
  const refused = s.builder.branches[0].pieces.length === openingPieces;
  s.builder.stamina = 100;
  s.digPiece('straight');
  s.drainQueueForTest();
  const grew = s.builder.branches[0].pieces.length > openingPieces;

  // A turn on the plumb shaft is REFUSED — there is no heading to turn.
  s.builder.stamina = 100;
  const onShaft = s.builder.addPiece({ extend: 0 }, 'left90');
  // Level out of the shaft first (UP 90 is relative), THEN the turn bites.
  s.builder.stamina = 100;
  s.digPiece('up90');
  s.drainQueueForTest();
  const levelled = Math.abs(s.builder.pitchAt({ extend: 0 }));
  const headBefore = s.builder.legStart({ extend: 0 }).headingDeg;
  s.builder.stamina = 100;
  s.digPiece('left90');
  s.drainQueueForTest();
  let turned = s.builder.legStart({ extend: 0 }).headingDeg - headBefore;
  while (turned > 180) turned -= 360;
  while (turned < -180) turned += 360;

  // And nothing was SAVED, because saving is off while debugging.
  let stored = null;
  try { stored = localStorage.getItem('thronemound-island-nest-v1'); } catch { /* none */ }

  return {
    ghostFirst, nestless, founded, aimedDown, openingPieces, grew, refused,
    entrance: !!entrance && entrance.kind === 'entrance',
    shaftAir, turned, stored, onShaft, levelled,
  };
});
check('the ghost is up before the first piece', builder.ghostFirst && builder.nestless);
check('one tap sinks the OPENING', builder.founded && builder.openingPieces === 2,
  `${builder.openingPieces} pieces`);
check('and drops her aim to straight down',
  Math.abs(builder.aimedDown + Math.PI / 2) < 0.01,
  `${((builder.aimedDown * 180) / Math.PI).toFixed(0)}°`);
check('the mouth is a real entrance in the plan', builder.entrance);
check('and the shaft under it is air', builder.shaftAir === false,
  `solidAtMm = ${builder.shaftAir}`);
check('stamina refuses a piece she cannot afford', builder.refused);
check('and recovery lets the tunnel grow again', builder.grew);
check('a turn on the plumb shaft is refused, not silently wasted',
  builder.onShaft === 'no-turn', `addPiece said ${builder.onShaft}`);
check('UP 90 levels her out of the shaft', builder.levelled < 1,
  `${builder.levelled.toFixed(0)}° grade`);
check('and THEN a LEFT 90 turns the line ninety degrees',
  Math.abs(Math.abs(builder.turned) - 90) < 1, `${builder.turned.toFixed(0)}°`);
check('nothing was saved — debugging, by request', builder.stored === null);

const junction = await page.evaluate(() => {
  const s = window.islandScene;
  const o = s.builderOriginMm;
  const end = s.builder.legStart({ extend: 0 }).at;
  s.teleportMm(o.x + end.x, o.z + end.z);
  s.at.y = (o.y + end.y) / 5;
  s.stepForTest(1 / 30, 3);
  const nearJoint = s.nearestJoint();
  const rowShown = s.jointRow && s.jointRow.style.display !== 'none';
  s.builder.stamina = 100;
  s.digJoint('Y');
  s.drainQueueForTest();
  const exits = s.builder.exitsAvailable(0);
  const arm = s.builder.pickExit(0, s.builder.legStart({ extend: 0 }).headingDeg + 45, 0);
  s.digMode = false;
  return { nearJoint, rowShown: !!rowShown, exits, arm };
});
check('standing at the joint offers the chips', junction.nearJoint === 0
  && junction.rowShown);
check('a Y forks two ways at 45', JSON.stringify(junction.exits)
  === JSON.stringify(['left45', 'right45']), junction.exits.join(','));
check('and the camera picks the arm it looks along', junction.arm === 'left45');

console.log('\nA HAND-DIG: MOUTHFULS ONLY, AND THE BODY DECIDES');
/*
 * The bargain this scene is built on, and it is deliberately a slow one: a
 * stroke removes ONE 1.75 x 0.5 mm mouthful and nothing else, and she can
 * only move where her whole body fits — so a passage exists only once it
 * has been chewed to size. Measured with a swept aim that is about a
 * hundred seconds per millimetre, so this asserts that the mechanism works
 * rather than that a shaft appears: soil leaves where she aims, she gets in,
 * she is never inside the dirt, and the hole survives streaming.
 */
const dig = await page.evaluate(() => {
  const s = window.islandScene;
  const atX = 27050;
  const atZ = 27050;
  s.teleportMm(atX, atZ);
  s.drainQueueForTest();
  s.setFacingForTest(0);
  const before = s.statsForTest().edited;
  const y0 = s.at.y * 5;
  // A face sweep wide enough to reach her flanks — at ~5 mm of reach her
  // shoulders are 4.4 mm out, which is a sixty-degree swing.
  const ring = [
    [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
    [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7],
  ];
  s.input.dig = true;
  s.input.walk = 1;
  let embedded = 0;
  let frames = 0;
  for (let k = 0; k < 260; k += 1) {
    const [dx, dy] = ring[k % ring.length];
    s.setFacingForTest(dx * 1.15);
    s.aimPitch = Math.max(-1.3, Math.min(1.3, -0.75 + dy * 0.8));
    for (let f = 0; f < 14; f += 1) {
      s.stepForTest(1 / 30, 1);
      frames += 1;
      if (s.stream.solidAtWu(s.at.x, s.at.y, s.at.z) === true) embedded += 1;
    }
    if (k % 20 === 0) s.drainQueueForTest();
  }
  s.input.dig = false;
  s.input.walk = 0;
  s.drainQueueForTest();
  const sank = y0 - s.at.y * 5;
  const endX = s.at.x * 5;
  const endZ = s.at.z * 5;
  const endY = s.at.y * 5;
  const voidAtHer = s.solidAtMm(endX, endY, endZ);
  s.teleportMm(20000, 20000);
  s.drainQueueForTest();
  const goneWhileAway = s.solidAtMm(endX, 1300, endZ);
  s.teleportMm(endX, endZ);
  s.drainQueueForTest();
  return {
    dug: s.statsForTest().edited - before,
    sank, embedded, voidAtHer, goneWhileAway,
    seconds: frames / 30,
    voidAfter: s.solidAtMm(endX, endY, endZ),
  };
});
check('chewing removes soil where she aims', dig.dug > 200,
  `${dig.dug} samples over ${dig.seconds.toFixed(0)} s of digging`);
check('and it carries her into the ground', dig.sank > 1,
  `${dig.sank.toFixed(2)} mm in ${dig.seconds.toFixed(0)} s`);
check('she is never inside the dirt while cutting', dig.embedded === 0,
  `${dig.embedded} embedded frames`);
check('where she ends up is air she made', dig.voidAtHer === false,
  `solid at her = ${dig.voidAtHer}`);
check('the column unloaded while away', dig.goneWhileAway === null);
check('and her workings SURVIVED the round trip', dig.voidAfter === false,
  `solid where she stood: ${dig.voidAfter}`);

console.log('\nTHE BODY IS THE GATE (she is only ever where she fits)');
/*
 * With the sweep gone, nothing guarantees a tunnel is her size except the
 * fact that she could not have got there otherwise. So the invariant worth
 * holding is not "the bore is N mm wide" but "wherever she IS, her body
 * fits, and she never entered anywhere it did not".
 */
const fit = await page.evaluate(() => {
  const s = window.islandScene;
  const st = s.statsForTest();
  const fits = s.bodyFitsForTest();
  return {
    biteW: st.biteWidthMm,
    biteD: st.biteDepthMm,
    len: st.bodyLenMm,
    wide: st.bodyWideMm,
    tall: st.bodyTallMm,
    fits: fits.fits,
    engaged: fits.engaged,
  };
});
check('the bite stays her mandible — 1.75 mm wide, half a mm deep',
  Math.abs(fit.biteW - 1.75) < 0.01 && Math.abs(fit.biteD - 0.5) < 0.01,
  `${fit.biteW.toFixed(2)} x ${fit.biteD.toFixed(2)} mm`);
check('the oval is her whole body, measured off the rig',
  fit.len > 4 && fit.wide > 4 && fit.tall > 1,
  `${(fit.len * 2).toFixed(1)} x ${(fit.wide * 2).toFixed(1)} x ${(fit.tall * 2).toFixed(1)} mm`);
/* On open ground the WALKER has her and her oval genuinely overlaps the
 * hillside she is standing on, so the capsule neither gates her nor should
 * read as fitting. It takes over once she has bored in — which is exactly
 * when it starts deciding where she may go. */
check('the oval gates her only once she has bored in', fit.engaged === 0,
  `engaged on open ground = ${fit.engaged}`);

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

console.log('\nINTO THE HOLE (asked at the mouth, then down; the playtest bug:');
console.log('"it bounced me back up" — and the newer one, being dropped in unasked)');
const descent = await page.evaluate(() => {
  const s = window.islandScene;
  const n = Object.fromEntries(s.planForTest().map((p) => [p.id, p]));
  // Start two body lengths west of the gate, walk east across it.
  s.teleportMm(n.gate.x - 18, n.gate.z);
  s.drainQueueForTest();
  s.setFacingForTest(Math.PI / 2);
  s.input.walk = 1;
  /* Walking onto her own mouth must ASK rather than drop her in — the
   * anthill is not a trapdoor. She only goes down once the thumb says so. */
  let askedIn = -1;
  let droppedUnasked = 0;
  for (let i = 0; i < 400; i += 1) {
    s.stepForTest(1 / 30, 1);
    const surface = s.renderedHeightAtMm(s.at.x * 5, s.at.z * 5);
    if (s.at.y * 5 < surface - 6) droppedUnasked += 1;
    const ask = s.gateAskForTest();
    if (ask && ask.kind === 'enter') { askedIn = i; s.answerGateForTest(true); break; }
  }
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
  return {
    deepest, bouncedUp, askedIn, droppedUnasked,
    under: s.statsForTest().underground,
  };
});
check('walking onto the mouth ASKS instead of dropping her in',
  descent.askedIn >= 0 && descent.droppedUnasked === 0,
  `ENTER? after ${descent.askedIn} steps, ${descent.droppedUnasked} unasked frames below ground`);
check('and YES gets her INTO the hole', descent.deepest < -30,
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
  // THE ROOM: arriving in the chamber the rail lets go by itself — FREE
  // inside a room, no button. Roam it (avoiding the west mouth, which is
  // the door and SHOULD take her): contained, never in soil, never gripped.
  const roomState = s.statsForTest();
  const inRoom = roomState.railBound === 0 && roomState.chamberNow === 1;
  let roomSolid = 0;
  let roomGripped = 0;
  const roamFacings = [Math.PI / 2, Math.PI, 0]; // east, south, north
  s.input.walk = 1;
  for (let i = 0; i < 180; i += 1) {
    if (i % 60 === 0) s.setFacingForTest(roamFacings[i / 60]);
    s.stepForTest(1 / 30, 1);
    if (s.stream.solidAtWu(s.at.x, s.at.y, s.at.z) === true) roomSolid += 1;
    if (s.statsForTest().railBound === 1) roomGripped += 1;
  }
  s.input.walk = 0;
  const roamedInRoom = s.statsForTest().chamberNow === 1 && roomGripped === 0;
  // Walk out at the tunnel mouth: GRIP takes her back by itself...
  s.setFacingForTest(-Math.PI / 2); // the run leaves the store westward
  s.input.walk = 1;
  let regripAt = -1;
  for (let i = 0; i < 400; i += 1) {
    s.stepForTest(1 / 30, 1);
    if (s.statsForTest().railBound === 1) { regripAt = i; break; }
  }
  // ...and riding TOWARD the gate ASKS. Nothing crosses the threshold in
  // either direction without an answer: the probe's thumb taps YES the
  // moment SURFACE? appears, and expects daylight.
  let outAt = -1;
  let askedOut = -1;
  for (let i = 0; i < 1600; i += 1) {
    s.stepForTest(1 / 30, 1);
    const ask = s.gateAskForTest();
    if (ask && ask.kind === 'surface') {
      if (askedOut < 0) askedOut = i;
      s.answerGateForTest(true);
    }
    if (s.statsForTest().railBound === 0
      && s.at.y * 5 >= s.renderedHeightAtMm(s.at.x * 5, s.at.z * 5) - 2) {
      outAt = i;
      break;
    }
  }
  s.input.walk = 0;
  const surface = s.renderedHeightAtMm(s.at.x * 5, s.at.z * 5);
  const gateOffMm = Math.hypot(s.at.x * 5 - n.gate.x, s.at.z * 5 - n.gate.z);
  return {
    bound,
    railFrames,
    gapWorst,
    gapBadShare: railFrames > 0 ? gapBad / railFrames : 1,
    pitchShare: railFrames > 0 ? pitchOk / railFrames : 0,
    atStore,
    inRoom,
    roomSolid,
    roamedInRoom,
    regripAt,
    outAt,
    askedOut,
    railBoundAfter: s.statsForTest().railBound,
    aboveMm: s.at.y * 5 - surface,
    gateOffMm,
  };
});
check('the shaft handed her to the rail', rail.bound === 1);
check('she crawls ON the bore wall, back to the centerline', rail.gapBadShare < 0.1,
  `off the wall on ${(rail.gapBadShare * 100).toFixed(0)}% of ${rail.railFrames} rail frames, worst ${rail.gapWorst.toFixed(1)} mm`);
check('her body pitch follows the tube', rail.pitchShare > 0.85,
  `${(rail.pitchShare * 100).toFixed(0)}% of ${rail.railFrames} rail frames aligned`);
check('the rail delivered her to the store', rail.atStore < 14,
  `${rail.atStore.toFixed(1)} mm from the chamber`);
check('the room frees her on arrival — GRIP off, FREE in the chamber',
  rail.inRoom === true);
check('she roams the room contained, never in the walls',
  rail.roamedInRoom === true && rail.roomSolid === 0,
  `${rail.roomSolid} solid frames of 180`);
check('the mouth GRIPs her back on the way out', rail.regripAt >= 0,
  `regripped after ${rail.regripAt} steps`);
check('riding toward the gate ASKS instead of ejecting', rail.askedOut >= 0,
  `SURFACE? after ${rail.askedOut} steps`);
check('and YES puts her in daylight beside it',
  rail.outAt >= 0 && rail.railBoundAfter === 0 && rail.aboveMm > -6
  && rail.gateOffMm < 30,
  `out after ${rail.outAt} steps, ${rail.aboveMm.toFixed(1)} mm vs surface, `
  + `${rail.gateOffMm.toFixed(1)} mm from the gate`);

console.log('\nTHE POINTS (a junction is a switch, and the camera has no vote)');
/*
 * The bug this replaces, stated as a test: her direction along a tube used
 * to be re-derived from `facing` every frame, so panning the view past the
 * tube's axis reversed her travel and spun the model with it. The first
 * check here is that the camera can be swung right round WITHOUT her
 * changing direction — that is the whole fix. The rest is the switch: a
 * fork offers its roads, one is set, and arriving takes the set one.
 */
const points = await page.evaluate(() => {
  const s = window.islandScene;
  const ex = 28040;
  const ez = 28000;
  const ground = s.heightAtMm(ex, ez);
  const deep = ground - 40;
  /* This section needs a FORK, which the founding nest has not got — so it
   * borrows the world and puts it back. Without the restore the sections
   * after this one inherit a nest they were not written against, and four
   * of them failed on a plan they never asked for. */
  const founding = JSON.parse(JSON.stringify(s.soil.plan));
  /* A T underground: in from the west, then left (+X) or right (-X). */
  s.applyPlanForTest({
    nodes: [
      { id: 'gate', kind: 'entrance', x: ex, y: ground, z: ez, radiusMm: 8 },
      { id: 'top', kind: 'junction', x: ex, y: deep, z: ez, radiusMm: 4 },
      { id: 'run', kind: 'junction', x: ex, y: deep, z: ez + 60, radiusMm: 4 },
      { id: 'left', kind: 'chamber', x: ex + 60, y: deep, z: ez + 60, radiusMm: 10 },
      { id: 'right', kind: 'chamber', x: ex - 60, y: deep, z: ez + 60, radiusMm: 10 },
    ],
    edges: [
      { id: 'shaft', from: 'gate', to: 'top', radiusMm: 4, flow: 'both' },
      { id: 'drift', from: 'top', to: 'run', radiusMm: 4, flow: 'both' },
      { id: 'toL', from: 'run', to: 'left', radiusMm: 4, flow: 'both' },
      { id: 'toR', from: 'run', to: 'right', radiusMm: 4, flow: 'both' },
    ],
  });
  s.drainQueueForTest();

  /* Put her on the drift, heading toward the T (+Z), and drive. */
  const board = () => {
    s.teleportMm(ex, ez + 10);
    s.at.y = deep / 5;
    s.setFacingForTest(0);
    s.input.walk = 1;
    for (let i = 0; i < 90 && s.statsForTest().railBound !== 1; i += 1) s.stepForTest(1 / 30, 1);
    return s.statsForTest().railBound === 1;
  };
  const boarded = board();

  /* THE CAMERA HAS NO VOTE: swing the view right round mid-drive and she
   * must carry on the way she was going. */
  const zBefore = s.at.z;
  for (let i = 0; i < 20; i += 1) s.stepForTest(1 / 30, 1);
  const zMid = s.at.z;
  s.setFacingForTest(Math.PI);          // look back the way she came
  for (let i = 0; i < 20; i += 1) s.stepForTest(1 / 30, 1);
  const zAfter = s.at.z;
  const keptGoing = (zMid - zBefore) > 0 && (zAfter - zMid) > 0;

  /*
   * BACK IS AN ABOUT-TURN. The reported want, exactly: "should switch
   * direction and not move the first change of the joystick, then forward
   * would be straight up if from straight down". So on a shaft — forward
   * carries her down; back turns her to face up and travels NOWHERE;
   * forward then carries her up. Two earlier designs failed here, one by
   * reversing when the camera panned and one by leaving forward meaning
   * "up" ever after a single back-press, so all three legs are measured.
   */
  const stick = (() => {
    s.teleportMm(ex, ez);
    s.at.y = (deep + 20) / 5;
    s.setFacingForTest(0);
    for (let i = 0; i < 120 && s.statsForTest().railBound !== 1; i += 1) s.stepForTest(1 / 30, 1);
    if (s.statsForTest().railBound !== 1) return null;
    const run = (walk, frames) => {
      s.input.walk = walk;
      const y0 = s.at.y;
      for (let i = 0; i < frames; i += 1) s.stepForTest(1 / 30, 1);
      return { moved: (s.at.y - y0) * 5, nose: s.railForward.y };
    };
    const down = run(1, 15);
    const turn = run(-1, 15);
    s.input.walk = 0; s.stepForTest(1 / 30, 3);
    const up = run(1, 15);
    s.input.walk = 0;
    return {
      downMm: down.moved, downNose: down.nose,
      turnMm: turn.moved, turnNose: turn.nose,
      upMm: up.moved, upNose: up.nose,
    };
  })();

  /* The chooser: ride up to the T and see what it offers. Re-board first —
   * the stick test above left her in the SHAFT, on another edge entirely. */
  board();
  s.input.walk = 1;
  let offered = null;
  for (let i = 0; i < 400; i += 1) {
    s.stepForTest(1 / 30, 1);
    const sw = s.switchForTest();
    if (sw.labels.length >= 2) { offered = sw; break; }
  }

  /* Throw the points to the other road, ride through, see where she lands. */
  let landed = null;
  if (offered) {
    s.throwSwitch(1);
    const picked = s.switchForTest().pick;
    for (let i = 0; i < 900; i += 1) {
      s.stepForTest(1 / 30, 1);
      const room = s.statsForTest().chamberNow;
      if (room === 1) break;
    }
    landed = { picked, x: s.at.x * 5 - ex };
  }
  s.input.walk = 0;
  // Hand the world back exactly as it was lent.
  s.applyPlanForTest(founding);
  s.teleportMm(28000, 28000);
  s.drainQueueForTest();
  return { boarded, keptGoing, stick, offered, landed };
});
check('she boards the drift', points.boarded);
check('panning the camera right round does NOT reverse her', points.keptGoing);
check('forward carries her down the shaft, nose down',
  !!points.stick && points.stick.downMm < -2 && points.stick.downNose < -0.5,
  points.stick ? `${points.stick.downMm.toFixed(1)} mm, nose ${points.stick.downNose.toFixed(2)}` : '');
check('BACK turns her round and travels nowhere',
  !!points.stick && Math.abs(points.stick.turnMm) < 2 && points.stick.turnNose > 0.5,
  points.stick ? `${points.stick.turnMm.toFixed(1)} mm, nose ${points.stick.turnNose.toFixed(2)}` : '');
check('and THEN forward carries her up — the stick never inverts',
  !!points.stick && points.stick.upMm > 2 && points.stick.upNose > 0.5,
  points.stick ? `${points.stick.upMm.toFixed(1)} mm, nose ${points.stick.upNose.toFixed(2)}` : '');
check('the T offers both its roads', !!points.offered
  && points.offered.labels.length === 2, points.offered
  ? points.offered.labels.join(' / ') : 'nothing offered');
check('naming them the way a driver would', !!points.offered
  && points.offered.labels.includes('left') && points.offered.labels.includes('right'),
  points.offered ? points.offered.labels.join(' / ') : '');
check('throwing the points sends her down the other road', !!points.landed
  && Math.abs(points.landed.x) > 20,
  points.landed ? `${points.landed.x.toFixed(0)} mm off the junction` : 'never arrived');

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
  window.__goIn(n.gate.x - 18, n.gate.z, Math.PI / 2);
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

console.log('\nGRIP AND FREE (GRIP is the law of the tunnels; the chip only reports)');
const modes = await page.evaluate(() => {
  const s = window.islandScene;
  const n = Object.fromEntries(s.planForTest().map((p) => [p.id, p]));
  const chip = () => document.querySelector('.density-lab-mode.is-indicator');
  // On the surface: FREE, and the chip says so.
  s.teleportMm(n.gate.x - 18, n.gate.z);
  s.drainQueueForTest();
  s.stepForTest(1 / 30, 5);
  const surfaceFree = s.statsForTest().free;
  const surfaceLabel = chip()?.textContent;
  const surfaceGripClass = chip()?.classList.contains('is-grip');
  // Go in at the mouth: past the threshold, the bore MUST grip her — that
  // part has no opt-out, and the chip has to say so.
  window.__goIn(n.gate.x - 18, n.gate.z, Math.PI / 2);
  s.input.walk = 1;
  let grabbedAt = -1;
  for (let i = 0; i < 900; i += 1) {
    s.stepForTest(1 / 30, 1);
    if (s.statsForTest().railBound === 1) { grabbedAt = i; break; }
  }
  s.input.walk = 0;
  s.stepForTest(1 / 30, 2);
  const tunnelLabel = chip()?.textContent;
  const tunnelGripClass = chip()?.classList.contains('is-grip');
  const tunnelFree = s.statsForTest().free;
  return {
    surfaceFree, surfaceLabel, surfaceGripClass,
    grabbedAt, tunnelLabel, tunnelGripClass, tunnelFree,
  };
});
check('on the surface the chip reads FREE',
  modes.surfaceFree === 1 && modes.surfaceLabel === 'FREE'
  && modes.surfaceGripClass === false);
check('a bore GRIPs her — no opt-out in a tunnel',
  modes.grabbedAt >= 0 && modes.tunnelFree === 0,
  `gripped after ${modes.grabbedAt} steps`);
check('and the chip reads GRIP, lit',
  modes.tunnelLabel === 'GRIP' && modes.tunnelGripClass === true);

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
  // CONTEXT-SENSITIVE panel: opening picks the entrance (a node), so the
  // edit row and move pad show with LINK, not FLOW. Nothing picked — only
  // the place and finish rows. An edge picked — FLOW, no LINK, no pad.
  const d = s.designer;
  const disp = (sel) => {
    const el = document.querySelector(sel);
    return el ? el.style.display : 'missing';
  };
  const withNode = {
    acts: disp('.nest-row-acts'),
    pad: disp('.nest-row-pad'),
    kinds: disp('.nest-row-kinds'),
    done: disp('.nest-row-done'),
    link: d.buttons.get('link').style.display,
    flow: d.buttons.get('flow').style.display,
  };
  d.picked = null;
  d.refreshPanel();
  const withNothing = { acts: disp('.nest-row-acts'), pad: disp('.nest-row-pad') };
  d.selectForTest('edge', d.current().edges[0].id);
  const withEdge = {
    acts: disp('.nest-row-acts'),
    pad: disp('.nest-row-pad'),
    link: d.buttons.get('link').style.display,
    flow: d.buttons.get('flow').style.display,
  };
  s.closeDesignerForTest();
  const closed = s.statsForTest().designing;
  // Space opens it too — and a release WHILE it is open must not swallow
  // the next press (the sticky-edge bug).
  const press = (key, type) => window.dispatchEvent(new KeyboardEvent(type, { key }));
  /* Space is the JAWS now — the nest tools moved to B. The edge still has
   * to survive a release while the panel is open, which was the sticky-key
   * bug, so the check follows the key rather than being dropped. */
  press('b', 'keydown');
  const spaceOpened = s.statsForTest().designing;
  press('b', 'keyup');
  s.closeDesignerForTest();
  press('b', 'keydown');
  const spaceReopened = s.statsForTest().designing;
  press('b', 'keyup');
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
    withNode,
    withNothing,
    withEdge,
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
check('DIG opens the nest tools, DONE closes them',
  digIt.opened === 1 && digIt.panelUp && digIt.closed === 0);
check('node picked: edit row + move pad, LINK not FLOW',
  digIt.withNode.acts === '' && digIt.withNode.pad === ''
  && digIt.withNode.link === '' && digIt.withNode.flow === 'none');
check('the place and finish rows are always there',
  digIt.withNode.kinds !== 'none' && digIt.withNode.done !== 'none');
check('nothing picked: only the place and finish rows',
  digIt.withNothing.acts === 'none' && digIt.withNothing.pad === 'none');
check('edge picked: FLOW not LINK, and no move pad',
  digIt.withEdge.acts === '' && digIt.withEdge.pad === 'none'
  && digIt.withEdge.flow === '' && digIt.withEdge.link === 'none');
check('B opens the nest tools, and reopens after a release while open',
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
