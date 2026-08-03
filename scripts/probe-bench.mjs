/*
 * ONE OF EACH ANT, AND A TAP HANDS OVER THE CONTROLS.
 *
 * Opens the nest room, waits for all three castes to load, then does what a
 * thumb does: taps the parked major, drives her, taps the minor worker,
 * drives him. Switching is asserted through real pointer events on projected
 * screen positions — the same path a finger takes — not through the test
 * hook, because "the tap didn't register" is a bug this room has had before.
 *
 *   SMOKE_URL=http://localhost:4351/ node scripts/probe-bench.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://localhost:4351/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
page.on('pageerror', e => errs.push(e.message));
await page.goto(`${base}/?scene=block&shape=nest`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await page.waitForFunction(
  () => window.blockScene.benchForTest().ants.every(a => a.ready),
  null, { timeout: 60000 },
);

/*
 * BUILD A NEST FIRST, through the same buttons a player presses. The default
 * plan is only the Station — a sixteen-millimetre pit with nothing under it —
 * and the first run of this probe tried to drive three ants "underground" in
 * a block with no underground to be in: the queen strode across the dimple,
 * and only the four-millimetre worker was small enough to read its lip as a
 * roof. A shaft four pieces deep with a room at the bottom is the actual
 * scenario the bench exists for.
 */
await page.locator('.density-lab-dig').first().dispatchEvent('pointerdown');
await page.waitForTimeout(500);
if (await page.locator('.nest-help').isVisible()) {
  await page.locator('.nest-help .nest-designer-chip').dispatchEvent('pointerdown');
  await page.waitForTimeout(200);
}
const chip = (t) => page.locator('.nest-designer-chip', { hasText: new RegExp(`^${t}$`) }).first();
for (let i = 0; i < 3; i += 1) {
  await chip('\\+ PLACE').dispatchEvent('pointerdown');
  await page.waitForTimeout(120);
}
await chip('ROOM').dispatchEvent('pointerdown');
await chip('\\+ PLACE').dispatchEvent('pointerdown');
await page.waitForTimeout(150);
await chip('DIG IT').dispatchEvent('pointerdown');
await page.waitForTimeout(2500);
await chip('DONE').dispatchEvent('pointerdown');
await page.waitForTimeout(800);
const built = await page.evaluate(() => {
  const plan = window.blockScene.nestForTest();
  return { nodes: plan.nodes.length, edges: plan.edges.length };
});
console.log(`built: ${built.nodes} pieces, ${built.edges} tunnels`);

const bench = await page.evaluate(() => window.blockScene.benchForTest());
console.log('\nTHE BENCH');
for (let i = 0; i < bench.ants.length; i += 1) {
  const a = bench.ants[i];
  console.log(`  ${i === bench.driven ? '>' : ' '} ${a.caste.padEnd(7)} ready=${a.ready}`);
}

const screenOf = (index) => page.evaluate((i) => {
  const s = window.blockScene;
  const V = Object.getPrototypeOf(s.at).constructor;
  const a = s.benchForTest().ants[i].at;
  const v = new V(a[0], a[1], a[2]).project(s.camera);
  const r = document.querySelector('canvas').getBoundingClientRect();
  return {
    x: (v.x * 0.5 + 0.5) * r.width + r.left,
    y: (-v.y * 0.5 + 0.5) * r.height + r.top,
  };
}, index);

const tap = async (index) => {
  const at = await screenOf(index);
  const canvas = page.locator('canvas').first();
  await canvas.dispatchEvent('pointerdown', { pointerId: 7, clientX: at.x, clientY: at.y });
  await canvas.dispatchEvent('pointerup', { pointerId: 7, clientX: at.x, clientY: at.y });
  await page.waitForTimeout(200);
};

/*
 * Drive whoever is current at the nest mouth, deterministically.
 *
 * Stepped with `stepForTest` under `setPausedForTest`, like every movement
 * probe in this repo, because the live loop on this box renders through
 * SwiftShader at about two frames a second — six real seconds is a dozen sim
 * frames, and the first version of this probe concluded nobody could walk
 * when nobody had been given time to. Aimed at the mouth first, because the
 * parked ants stand off the mouth's axis and "can this caste get down the
 * tunnel" is the question — not "can it find the door blind", which the
 * queen already answered slowly.
 */
const drive = async (frames) => page.evaluate((n) => {
  const s = window.blockScene;
  s.setPausedForTest(true);
  const mouthNode = s.nestForTest().nodes.find(k => k.kind === 'entrance');
  const MM = 5, LOW = 3 * 0.1;
  const mouth = { x: LOW + mouthNode.x / MM, z: LOW + mouthNode.z / MM };
  const dx = mouth.x - s.at.x;
  const dz = mouth.z - s.at.z;
  const len = Math.hypot(dx, dz) || 1;
  s.forward.set(dx / len, 0, dz / len);
  const start = [...s.at.toArray()];
  let under = 0;
  s.input.walk = 1;
  for (let i = 0; i < n; i += 1) {
    s.stepForTest(1 / 60, 1);
    if (s.underground) under += 1;
  }
  s.input.walk = 0;
  const d = s.at.toArray();
  return {
    movedMm: +(Math.hypot(d[0] - start[0], d[1] - start[1], d[2] - start[2]) * 5).toFixed(1),
    droppedMm: +((start[1] - d[1]) * 5).toFixed(1),
    underFrames: under,
  };
}, frames);

/*
 * TAPS ARE TESTED ON THE SURFACE, where the ants are visible. The first
 * version tapped after driving the queen underground, and the taps missed —
 * correctly: the camera was down a tunnel and the parked ants were behind
 * the soil overhead, projecting off-screen or behind the eye. You cannot tap
 * what you cannot see, and that is the intended behaviour, not a bug.
 */
/*
 * Frozen for the tap tests: the probe computes an ant's screen position and
 * then taps it, and at SwiftShader's two frames a second the follow camera
 * can move BETWEEN those two moments — the scene then hit-tests the same tap
 * against a different projection and misses. Pausing the sim freezes the
 * camera, so both sides of the tap see the same screen. A thumb does not
 * have this problem; sixty frames a second is faster than a finger.
 */
await page.evaluate(() => window.blockScene.setPausedForTest(true));
await tap(1);
const tapMajor = (await page.evaluate(() => window.blockScene.benchForTest().driven)) === 1;
console.log(`  tap major  -> ${tapMajor ? 'OK' : 'MISSED'}`);
await tap(2);
const tapWorker = (await page.evaluate(() => window.blockScene.benchForTest().driven)) === 2;
console.log(`  tap worker -> ${tapWorker ? 'OK' : 'MISSED'}`);
await tap(0);
const tapQueen = (await page.evaluate(() => window.blockScene.benchForTest().driven)) === 0;
console.log(`  tap queen  -> ${tapQueen ? 'OK' : 'MISSED'}`);

// Now each caste takes the same trip down the designed shaft.
const queenRun = await drive(900);
console.log(`\n  queen  moved ${queenRun.movedMm} mm, dropped ${queenRun.droppedMm} mm, `
  + `underground ${queenRun.underFrames} frames`);
await page.evaluate(() => window.blockScene.switchForTest(1));
const majorRun = await drive(900);
console.log(`  major  moved ${majorRun.movedMm} mm, dropped ${majorRun.droppedMm} mm, `
  + `underground ${majorRun.underFrames} frames`);
await page.evaluate(() => window.blockScene.switchForTest(2));
const workerRun = await drive(900);
console.log(`  worker moved ${workerRun.movedMm} mm, dropped ${workerRun.droppedMm} mm, `
  + `underground ${workerRun.underFrames} frames`);

/*
 * And back to the queen, who was left parked at the bottom of the nest: the
 * handover must adopt her underground pose immediately — the roof judgement
 * is re-cast on switch rather than waiting out its quarter-second dwell.
 */
const resumed = await page.evaluate(() => {
  const s = window.blockScene;
  s.switchForTest(0);
  s.stepForTest(1 / 60, 2);
  return { under: s.underground, yMm: +(s.at.y * 5).toFixed(1) };
});
console.log(`  back to queen: underground=${resumed.under} at y=${resumed.yMm} mm`);

// The abandoned queen still stands where she was left.
const parked = await page.evaluate(() => window.blockScene.benchForTest().ants[0].at);
console.log(`  queen parked at ${parked.map(v => (v * 5).toFixed(0)).join(', ')} mm`);

const everyoneMoved = [queenRun, majorRun, workerRun].every(r => r.movedMm > 5);
const everyoneUnder = [queenRun, majorRun, workerRun].every(r => r.underFrames > 100);
console.log(`  every caste went underground: ${everyoneUnder}`);
const pass = bench.ants.length === 3 && tapMajor && tapWorker && tapQueen
  && everyoneMoved && everyoneUnder && resumed.under && !errs.length;
console.log(`\n  ${pass ? 'PASS' : 'FAIL'}`);
if (errs.length) console.log('  page errors:', errs.slice(0, 5));
await browser.close();
process.exit(pass ? 0 : 1);
