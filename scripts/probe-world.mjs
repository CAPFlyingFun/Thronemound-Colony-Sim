/**
 * THE HYBRID WORLD PROTOTYPE, PROVEN OR NOT — `?scene=world`.
 *
 * The request's fourteen acceptance steps, condensed to what a headless
 * browser can actually assert:
 *
 *   1. the scene boots on the macro surface with the full window meshed
 *   2. the fine soil's top agrees with the analytic ground (macro hand-off
 *      has nothing to stitch)
 *   3. the born-with nest's tunnels are OPEN in the streamed soil, at points
 *      chosen to cross 32 mm tile lines
 *   4. the entrance is open THROUGH the surface: the live field's top at the
 *      gate is far below the analytic ground
 *   5. leave (teleport far, window scrolls away, gate column unloads) and
 *      return: the same tunnel samples are air again — deterministic
 *      reconstruction from the plan, nothing saved
 *   6. a hand-dig opens the fine surface and is REMEMBERED across the same
 *      leave-and-return
 *   7. a continuous walk across several tile lines scrolls the window with
 *      no discontinuity in the ground underfoot (the "no pops" check, as a
 *      number rather than an eye)
 *   8. no page errors the whole way
 *
 *   SMOKE_URL=http://localhost:4173/Thronemound-Colony-Sim/ node scripts/probe-world.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://localhost:4173/Thronemound-Colony-Sim/')
  .replace(/\/$/, '');
const OUT = process.env.SMOKE_OUT ?? '/tmp/world-probe';

/* The world's height function, duplicated from worldScape.ts so the probe can
 * aim its samples. If the octaves change there, change them here. */
const heightMmAt = (x, z) => 185
  + 30 * Math.sin(x * 0.00052) * Math.cos(z * 0.00047)
  + 14 * Math.sin(x * 0.00405 + 1.0) * Math.cos(z * 0.00437 - 0.4)
  + 6 * Math.sin(x * 0.0146 + 1.7) * Math.cos(z * 0.0171 - 0.9)
  + 2 * Math.sin(x * 0.0447 - 0.4) * Math.cos(z * 0.0409 + 2.2)
  + 0.7 * Math.sin(x * 0.139 + 0.8) * Math.cos(z * 0.151 - 1.3);

/* The nest sits at the centre of the 57,344 mm world. */
const EX = 28672;
const EZ = 28672;

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

await page.goto(`${base}/?scene=world`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.worldScene?.ready, null, { timeout: 60000 });
await page.evaluate(() => window.worldScene.setPausedForTest(true));

/* -------------------------------------------------- 1. boot and first mesh */
console.log('\nBOOT');
const boot = await page.evaluate(() => window.worldScene.statsForTest());
check('full window meshed with no queue', boot.queued === 0,
  `${boot.meshed} chunks, first build ${boot.initialMeshMs.toFixed(0)} ms`);
check('nothing dug yet', boot.edited === 0);

/* -------------------------------- 2. fine surface agrees with the analytic */
console.log('\nSURFACE HAND-OFF (fine top vs analytic ground, away from the nest)');
const seam = await page.evaluate(() => {
  const s = window.worldScene;
  const o = s.originMm();
  const out = [];
  for (const [dx, dz] of [[40, 40], [150, 60], [90, 130], [40, 150]]) {
    const x = (o.x + dx) / 5;
    const z = (o.z + dz) / 5;
    const fine = s.stream.surfaceHeightAt(x, z);
    out.push({ dx, dz, fineMm: fine === null ? null : fine * 5 });
  }
  return { originMm: o, points: out };
});
for (const p of seam.points) {
  const want = heightMmAt(seam.originMm.x + p.dx, seam.originMm.z + p.dz);
  const off = p.fineMm === null ? Infinity : Math.abs(p.fineMm - want);
  check(`window +(${p.dx}, ${p.dz}) mm`, off < 1.0,
    `fine ${p.fineMm?.toFixed(2)} vs analytic ${want.toFixed(2)} mm (Δ ${off.toFixed(2)})`);
}

/* -------------------- 3. the born nest is open, across 32 mm tile lines */
console.log('\nNEST TUNNELS IN THE STREAMED SOIL');
const G = heightMmAt(EX, EZ);
/* The drift runs hall (EX, G-56) → bend (EX+64, G-72): the probe samples it
 * mid-tile and ON a 32 mm tile line. The shaft is sampled under the gate. */
const tunnelPoints = [
  ['shaft below gate', EX, G - 20, EZ],
  ['shaft at hall', EX, G - 56, EZ],
  ['drift mid-tile', EX + 16, G - 60, EZ + 2.5],
  ['drift on a tile line', EX + 32, G - 64, EZ + 5],
];
/* The store sits 112 mm east of the gate — outside a gate-centred window,
 * which is the point: it only ever exists by being streamed in. Checked from
 * its own stance. */
const storePoints = [
  ['store chamber', EX + 112, G - 84, EZ + 18],
];
const soilPoints = [
  ['soil beside the shaft', EX + 22, G - 30, EZ],
  ['soil above the drift', EX + 32, G - 40, EZ + 5],
];
const storeSoilPoints = [
  ['soil below the store', EX + 112, G - 110, EZ + 18],
];
const probeSolids = async (points) => page.evaluate(
  (ps) => ps.map(([name, x, y, z]) => [name, window.worldScene.solidAtMm(x, y, z)]),
  points,
);
const visit = async (xMm, zMm) => page.evaluate(([x, z]) => {
  window.worldScene.teleportMm(x, z);
  window.worldScene.drainQueueForTest();
}, [xMm, zMm]);
for (const [name, solid] of await probeSolids(tunnelPoints)) {
  check(`${name} is air`, solid === false, `solidAtMm=${solid}`);
}
for (const [name, solid] of await probeSolids(soilPoints)) {
  check(`${name} is soil`, solid === true, `solidAtMm=${solid}`);
}
await visit(EX + 82, EZ + 2);
for (const [name, solid] of await probeSolids(storePoints)) {
  check(`${name} is air`, solid === false, `solidAtMm=${solid}`);
}
for (const [name, solid] of await probeSolids(storeSoilPoints)) {
  check(`${name} is soil`, solid === true, `solidAtMm=${solid}`);
}
await visit(EX, EZ - 34);

/* --------------------------- 4. the entrance is open THROUGH the surface */
console.log('\nTHE ENTRANCE');
const gate = await page.evaluate(() => {
  const s = window.worldScene;
  return {
    fineTopMm: s.stream.surfaceHeightAt(28672 / 5, 28672 / 5) * 5,
    rimTopMm: s.stream.surfaceHeightAt((28672 + 24) / 5, 28672 / 5) * 5,
  };
});
check('live surface at the gate falls into the shaft',
  gate.fineTopMm < G - 30,
  `top ${gate.fineTopMm.toFixed(1)} mm vs ground ${G.toFixed(1)} mm`);
check('the rim beside it is still ground height',
  Math.abs(gate.rimTopMm - heightMmAt(EX + 24, EZ)) < 6,
  `rim ${gate.rimTopMm.toFixed(1)} mm (mound may raise it)`);

/* ------------------------------------------- 5. leave, return, reconstruct */
console.log('\nLEAVE AND RETURN (deterministic reconstruction)');
await page.evaluate(() => window.worldScene.teleportMm(1000, 1000));
await page.evaluate(() => window.worldScene.drainQueueForTest());
const away = await page.evaluate(() => ({
  origin: window.worldScene.originMm(),
  gateLoaded: window.worldScene.solidAtMm(28672, 180, 28672),
}));
check('window followed the teleport', Math.abs(away.origin.x - 904) < 64,
  `origin ${away.origin.x}, ${away.origin.z} mm`);
check('gate column is unloaded while away', away.gateLoaded === null);

await visit(EX, EZ - 28);
for (const [name, solid] of await probeSolids(tunnelPoints)) {
  check(`${name} is air AGAIN`, solid === false, `solidAtMm=${solid}`);
}
await visit(EX + 82, EZ + 2);
for (const [name, solid] of await probeSolids(storePoints)) {
  check(`${name} is air AGAIN`, solid === false, `solidAtMm=${solid}`);
}
const editedAfterReturn = await page.evaluate(
  () => window.worldScene.statsForTest().edited,
);
check('reconstruction cost zero saved samples', editedAfterReturn === 0,
  `${editedAfterReturn} edits stored`);

/* -------------------------------------- 6. a dig opens the fine surface */
console.log('\nA HAND-DIG THROUGH THE SURFACE');
const digSpot = await page.evaluate(() => {
  const s = window.worldScene;
  s.teleportMm(2000, 1990);
  s.setFacingForTest(0); // facing +z; the mouth rides 1.4 mm ahead of her
  const mouthX = 2000 / 5;
  const mouthZ = (1990 + 1.4) / 5;
  const before = s.stream.surfaceHeightAt(mouthX, mouthZ) * 5;
  s.input.dig = true;
  s.stepForTest(1 / 30, 90); // three seconds of chewing, deterministic
  s.input.dig = false;
  s.drainQueueForTest();
  const after = s.stream.surfaceHeightAt(mouthX, mouthZ) * 5;
  return { before, after, stats: s.statsForTest() };
});
check('the surface under the mouth dropped',
  digSpot.after < digSpot.before - 1.5,
  `${digSpot.before.toFixed(1)} → ${digSpot.after.toFixed(1)} mm`);
check('the dig is in the sparse store', digSpot.stats.edited > 0,
  `${digSpot.stats.edited} samples`);

const digReturn = await page.evaluate(() => {
  const s = window.worldScene;
  s.teleportMm(3000, 1990); // far enough that the hole's column unloads
  s.drainQueueForTest();
  const goneWhileAway = s.solidAtMm(2000, 200, 1991);
  s.teleportMm(2000, 1990);
  s.drainQueueForTest();
  return {
    goneWhileAway,
    after: s.stream.surfaceHeightAt(2000 / 5, 1991.4 / 5) * 5,
    edited: s.statsForTest().edited,
  };
});
check('hole column unloaded while away', digReturn.goneWhileAway === null);
check('the hole SURVIVED the round trip',
  Math.abs(digReturn.after - digSpot.after) < 0.5,
  `${digSpot.after.toFixed(1)} mm before, ${digReturn.after.toFixed(1)} mm after`);
check('edits kept across the scroll', digReturn.edited === digSpot.stats.edited,
  `${digReturn.edited} samples`);

/* ------------------------------- 7. the walk: scrolls without pops */
console.log('\nTHE WALK (600 steps north across tile lines)');
const walk = await page.evaluate(async () => {
  const s = window.worldScene;
  s.teleportMm(1500, 1500);
  s.drainQueueForTest();
  s.setFacingForTest(0);
  s.input.walk = 1;
  const scrolls0 = s.statsForTest().scrolls;
  let worstStepMm = 0;
  let lastY = null;
  for (let i = 0; i < 600; i += 1) {
    s.stepForTest(1 / 60, 1);
    const y = s.at.y * 5;
    if (lastY !== null) worstStepMm = Math.max(worstStepMm, Math.abs(y - lastY));
    lastY = y;
    // Real milliseconds between batches so the scroll cooldown can elapse
    // the way it does under a real frame clock.
    if (i % 20 === 19) await new Promise((r) => setTimeout(r, 12));
  }
  s.input.walk = 0;
  const stats = s.statsForTest();
  return {
    scrolls: stats.scrolls - scrolls0,
    lastScrollMs: stats.lastScrollMs,
    worstStepMm,
    queued: stats.queued,
    travelledMm: (s.at.z * 5) - 1500,
  };
});
check('the window scrolled along the walk', walk.scrolls >= 3,
  `${walk.scrolls} scrolls over ${walk.travelledMm.toFixed(0)} mm`);
check('no pop underfoot', walk.worstStepMm < 1.0,
  `worst single-step height change ${walk.worstStepMm.toFixed(2)} mm`);
console.log(`  info  last scroll ${walk.lastScrollMs.toFixed(0)} ms, `
  + `${walk.queued} chunks still queued at the end`);

/* ------------------------------------------------------------- 8. errors */
console.log('\nERRORS');
check('no page errors', errs.length === 0, errs.join(' | ').slice(0, 200));

await page.evaluate(() => window.worldScene.setPausedForTest(false));
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}-walk.png` });
await page.evaluate(() => {
  window.worldScene.setPausedForTest(true);
  window.worldScene.teleportMm(2048, 2010);
  window.worldScene.drainQueueForTest();
  window.worldScene.setPausedForTest(false);
});
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}-nest.png` });

await browser.close();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECKS FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
