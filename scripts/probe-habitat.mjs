/**
 * MILESTONE 0 — CAN SHE STAND ON VOXEL SOIL, AND WALK ON IT BY HERSELF?
 *
 *     npx vite --port 5173                                  # then
 *     SMOKE_URL=http://127.0.0.1:5173/?scene=habitat npm run probe:habitat
 *
 * The acceptance list for the bridge, driven end to end:
 *
 *   - Queen stands correctly on voxel soil
 *   - walks autonomously
 *   - turns/stops correctly
 *   - handles small surface variation
 *   - real legged model/IK is active
 *   - no player input required
 *   - no IslandScene dependency
 *   - no digging yet
 *
 * NOTHING TOUCHES THE KEYBOARD OR THE MOUSE IN THIS FILE, and that is the
 * point of the "no player input" line: if she moves, she moved herself.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/?scene=habitat';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.habitatScene?.ready === true, null, { timeout: 200000 });

const out = await page.evaluate(async () => {
  const lab = window.habitatScene;
  lab.setPausedForTest(true);          // drive the clock ourselves
  const bounds = lab.boundsForTest();

  /*
   * FIRST: DOES SHE STAND?
   *
   * Told to hold still, with the brain bypassed. This has to be asked
   * separately from walking, because a tripod gait deliberately carries her
   * on three feet — six-down is a claim about an ant at rest, and asking it
   * of a walking one measures the gait rather than the ground.
   */
  for (let i = 0; i < 120; i += 1) lab.tickForTest(1 / 60, 0, 0);
  let standPlanted = 0;
  let standGroping = 0;
  for (let i = 0; i < 60; i += 1) {
    lab.tickForTest(1 / 60, 0, 0);
    const r = lab.reportForTest();
    standPlanted += r.planted;
    standGroping += r.groping;
  }
  const standing = { planted: standPlanted / 60, groping: standGroping / 60 };

  const start = lab.reportForTest();

  /* Sixty simulated seconds at a fixed step, sampled as she goes. */
  const DT = 1 / 60;
  const STEPS = 60 * 60;
  const trail = [];
  let planted = 0;
  let groping = 0;
  let moved = 0;
  let offSurface = 0;
  let outOfBox = 0;
  let rideMin = Infinity;
  let rideMax = -Infinity;
  const states = new Set();
  const headings = [];

  for (let i = 0; i < STEPS; i += 1) {
    lab.tick(DT);
    const r = lab.reportForTest();
    planted += r.planted;
    groping += r.groping;
    moved += Math.abs(r.movedMm);
    states.add(r.state);
    headings.push(r.heading);
    if (r.surfaceUnder === null) offSurface += 1;
    else { rideMin = Math.min(rideMin, r.ride); rideMax = Math.max(rideMax, r.ride); }
    /* Inside the tank, always. The panes are one cell thick at the rim. */
    if (r.at.x < 1 || r.at.z < 1 || r.at.x > bounds.size - 1
      || r.at.z > bounds.size - 1 || r.at.y > bounds.ceilingY) outOfBox += 1;
    if (i % 300 === 0) {
      trail.push({
        t: +(i * DT).toFixed(1),
        x: +r.at.x.toFixed(1), y: +r.at.y.toFixed(2), z: +r.at.z.toFixed(1),
        planted: r.planted, state: r.state, ride: +r.ride.toFixed(3),
      });
    }
  }
  const end = lab.reportForTest();
  const travelled = Math.hypot(end.at.x - start.at.x, end.at.z - start.at.z);

  /* How much her heading actually changed over the run — a turret that only
   * ever walks straight is not strolling. */
  let turned = 0;
  for (let i = 1; i < headings.length; i += 1) {
    let d = headings[i] - headings[i - 1];
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    turned += Math.abs(d);
  }

  return {
    bounds,
    standing,
    start,
    end,
    steps: STEPS,
    trail,
    travelledVoxels: travelled,
    turnedDeg: (turned * 180) / Math.PI,
    meanPlanted: planted / STEPS,
    meanGroping: groping / STEPS,
    movedMm: moved,
    offSurface,
    outOfBox,
    rideMin,
    rideMax,
    states: [...states],
  };
});

/*
 * AND THE OBSERVER'S HALF, reported from an iPhone: "I can't pan or move the
 * camera around and it's not recentering on screen rotation."
 *
 * Both are about looking, not about her — she walked fine through both
 * faults. Driven as real pointer events and a real viewport change so the
 * whole path is under test.
 */
const view = await page.evaluate(async () => {
  const lab = window.habitatScene;
  const cam = lab.view;
  const before = cam.reportForTest();

  /* A drag across the glass must swing the view. */
  const canvas = document.querySelector('canvas');
  const send = (type, x, y, id = 1) => canvas.dispatchEvent(new PointerEvent(type, {
    pointerId: id, pointerType: 'touch', clientX: x, clientY: y,
    bubbles: true, cancelable: true,
  }));
  send('pointerdown', 400, 200);
  send('pointermove', 520, 240);
  window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
  const dragged = cam.reportForTest();

  /* A wheel must zoom. */
  const distBefore = cam.reportForTest().distance;
  canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 400, bubbles: true, cancelable: true }));
  await new Promise((r) => requestAnimationFrame(r));
  lab.tick(0.016);
  const zoomed = cam.reportForTest();

  /* And WATCH HER puts the pivot on the ant. */
  lab.setFollow(true);
  for (let i = 0; i < 40; i += 1) { lab.tick(1 / 60); }
  await new Promise((r) => requestAnimationFrame(r));
  const followed = cam.reportForTest();
  const her = lab.reportForTest().at;
  const onHer = Math.hypot(
    followed.pivot.x - her.x, followed.pivot.y - her.y, followed.pivot.z - her.z,
  );
  lab.setFollow(false);
  return {
    before, dragged, distBefore, zoomed, followed, onHer,
    following: lab.followingForTest,
  };
});

/* A rotation, as the browser actually reports one. */
const rotated = await page.evaluate(async () => {
  const lab = window.habitatScene;
  const wide = lab.view.reportForTest().distance;
  return { wide };
});
await page.setViewportSize({ width: 430, height: 932 });   // portrait
await page.waitForTimeout(500);
const portrait = await page.evaluate(() => ({
  distance: window.habitatScene.view.reportForTest().distance,
  aspect: window.habitatScene.camera.aspect,
  canvasW: document.querySelector('canvas').width,
}));
await page.setViewportSize({ width: 932, height: 430 });   // back to landscape
await page.waitForTimeout(500);
const landscape = await page.evaluate(() => ({
  distance: window.habitatScene.view.reportForTest().distance,
  aspect: window.habitatScene.camera.aspect,
  canvasW: document.querySelector('canvas').width,
}));

/*
 * AND THE CANVAS IS THE SIZE OF THE SCREEN — checked at a PHONE'S pixel
 * ratio, because that is the only place this can go wrong.
 *
 * Reported as "still not centering" with the ant off the right-hand edge.
 * The cause was `setSize(w, h, false)`: the third argument tells three.js
 * not to touch the canvas's CSS size, and this project's only canvas rule
 * is `display: block` — no width, no height. So the element laid out at its
 * DRAWING BUFFER size, which is `w * devicePixelRatio`. At the ratio 3 of a
 * modern phone the canvas was three times the viewport each way and the
 * player saw the top-left ninth of a perfectly correct render.
 *
 * At ratio 1 it is invisible — buffer and CSS sizes agree — which is why
 * every desktop run of this probe passed while the phone did not. So this
 * check opens its own page at ratio 3.
 */
const phone = await browser.newPage({
  viewport: { width: 402, height: 874 }, deviceScaleFactor: 3,
});
await phone.goto(URL, { waitUntil: 'domcontentloaded' });
await phone.waitForFunction(() => window.habitatScene?.ready === true, null, { timeout: 200000 });
await phone.waitForTimeout(600);
const fit = await phone.evaluate(() => {
  const c = document.querySelector('canvas');
  const r = c.getBoundingClientRect();
  return {
    cssW: Math.round(r.width), cssH: Math.round(r.height),
    bufW: c.width, bufH: c.height,
    viewW: window.innerWidth, viewH: window.innerHeight,
    dpr: window.devicePixelRatio,
    /* The renderer's OWN ratio, which is capped for performance and is
     * therefore the number the buffer should follow — not the device's. */
    ratio: window.habitatScene.rendererRatioForTest(),
  };
});
await phone.close();

const checks = [];
const say = (name, ok, detail) => {
  checks.push(ok);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log('\nLAB 00 — A QUEEN IN A GLASS BOX\n');
console.log(`  standing still: ${out.standing.planted.toFixed(2)} of 6 feet down, `
  + `${out.standing.groping.toFixed(2)} groping\n`);
console.log('     t        x       y       z   feet  ride   doing');
for (const r of out.trail) {
  console.log(`  ${String(r.t).padStart(5)}   ${String(r.x).padStart(6)}  `
    + `${String(r.y).padStart(6)}  ${String(r.z).padStart(6)}   ${r.planted}/6  `
    + `${String(r.ride).padStart(5)}  ${r.state}`);
}
console.log();

/*
 * SHE STANDS. Every foot down and none reaching, when she is asked to hold
 * still — this is the "stands correctly on voxel soil" line of the
 * acceptance list, and it is the one that fails loudly when the bridge is
 * wrong. It caught a ceiling of 53.5: a fractional cell index made the
 * surface scan walk half-integers, seat her 1.5 mm high, and leave all six
 * feet in the air.
 */
say('standing, every foot is on the ground', out.standing.planted >= 5.5,
  `${out.standing.planted.toFixed(2)} of 6 planted`);
say('and none of them are reaching for it', out.standing.groping <= 0.5,
  `${out.standing.groping.toFixed(2)} groping`);
/*
 * WALKING, three feet is the DESIGN — a tripod gait lifts half her legs at
 * once. What must stay near zero is groping: a swing leg that lands on
 * nothing is a leg the ground failed, not a leg the gait lifted.
 */
say('walking, she carries herself on a tripod', out.meanPlanted >= 2.4,
  `${out.meanPlanted.toFixed(2)} of 6 planted`);
say('and her swinging feet find the soil', out.meanGroping <= 1.0,
  `${out.meanGroping.toFixed(2)} groping`);
say('and she rides a steady height over the soil',
  out.rideMax - out.rideMin < 1.2,
  `${out.rideMin.toFixed(3)} to ${out.rideMax.toFixed(3)} voxels`);
say('never leaving the surface behind her', out.offSurface === 0,
  `${out.offSurface}/${out.steps} frames over nothing`);

/* SHE WALKS, BY HERSELF. No key was pressed in this file. */
say('she walks without being asked to', out.travelledVoxels > 8,
  `${out.travelledVoxels.toFixed(1)} voxels from where she started`);
say('and her legs are what moved her', out.movedMm > 100,
  `${out.movedMm.toFixed(0)} mm reported by the leg drive`);

/* SHE TURNS AND STOPS. */
say('she turns as well as walking', out.turnedDeg > 30,
  `${out.turnedDeg.toFixed(0)} degrees of heading change`);
say('and she does more than one thing', out.states.length >= 2,
  out.states.join(', '));

/* SHE STAYS IN THE TANK. */
say('she stays inside the glass', out.outOfBox === 0,
  `${out.outOfBox}/${out.steps} frames outside`);

/* THE OBSERVER CAN LOOK. */
say('a drag swings the view', Math.abs(view.dragged.yaw - view.before.yaw) > 0.05
  && Math.abs(view.dragged.pitch - view.before.pitch) > 0.05,
  `yaw ${view.before.yaw.toFixed(2)} -> ${view.dragged.yaw.toFixed(2)}, `
  + `pitch ${view.before.pitch.toFixed(2)} -> ${view.dragged.pitch.toFixed(2)}`);
say('a wheel pulls back', view.zoomed.distance > view.distBefore,
  `${view.distBefore.toFixed(1)} -> ${view.zoomed.distance.toFixed(1)}`);
say('WATCH HER puts the view on the ant', view.onHer < 3,
  `${view.onHer.toFixed(2)} voxels off her`);
say('and it lets go again', view.following === false);

/* AND THE SCREEN CAN TURN. */
say('rotating resizes the canvas', portrait.canvasW !== landscape.canvasW,
  `${landscape.canvasW}px wide -> ${portrait.canvasW}px`);
say('and the aspect follows it', Math.abs(portrait.aspect - 430 / 932) < 0.05
  && Math.abs(landscape.aspect - 932 / 430) < 0.05,
  `${portrait.aspect.toFixed(2)} portrait, ${landscape.aspect.toFixed(2)} landscape`);
say('and the tank is re-fitted, not left framed for the old screen',
  portrait.distance > landscape.distance,
  `${landscape.distance.toFixed(0)} landscape -> ${portrait.distance.toFixed(0)} portrait`);

/* THE CANVAS FILLS THE SCREEN AND NO MORE — at a phone's pixel ratio. */
say('the canvas is displayed at the size of the viewport',
  Math.abs(fit.cssW - fit.viewW) <= 2 && Math.abs(fit.cssH - fit.viewH) <= 2,
  `${fit.cssW}x${fit.cssH} css against a ${fit.viewW}x${fit.viewH} viewport`);
/* The buffer follows the RENDERER's ratio, which this scene caps at 2 — a
 * phone at 3 renders at 2 and is displayed at 1, which is the point. What
 * would be wrong is the buffer size leaking into the CSS size, above. */
say('and its buffer follows the renderer ratio, capped as intended',
  Math.abs(fit.bufW - fit.cssW * fit.ratio) <= 3 && fit.ratio <= fit.dpr,
  `${fit.bufW}px buffer = ${fit.cssW} css x ${fit.ratio} (device dpr ${fit.dpr})`);

say('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

const passed = checks.filter(Boolean).length;
const ok = passed === checks.length;
console.log(`\n  ${ok ? 'PASS' : 'FAIL'} — ${passed}/${checks.length}\n`);
await browser.close();
process.exit(ok ? 0 : 1);
