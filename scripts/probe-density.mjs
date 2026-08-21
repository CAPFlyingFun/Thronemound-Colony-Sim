/**
 * THE DENSITY TRAY, MEASURED — does she stand on it, walk on it, and stay on it?
 *
 * This probe exists because the first one lied. Its predecessor drove
 * `tickForTest(dt, 1, 0)` — full walk, straight ahead, for ten seconds — and
 * reported 1.46 feet planted and 3.91 groping, which read as a catastrophic
 * regression against the voxel tray's 3.3 / 0.0. It was not. The density tray
 * was 64 mm across at the time where the voxel tray had been 480 mm, so ten
 * seconds of forced marching walked her 70 mm: clean off the end of the soil
 * and 6.6 mm out through the glass, where six feet groping is the correct
 * answer. The numbers were measuring a probe artefact.
 *
 * So this one drives `tick()`, which is the REAL frame — stroll AI, senses,
 * avoidance and all — and asserts on what the game actually does. The lesson
 * is written here rather than in a commit message because the next person to
 * add a movement probe will be tempted to force the input again.
 */
import { chromium } from 'playwright';
import { pressPlay } from './lib/pressPlay.mjs';

const PORT = process.env.PORT ?? '5177';
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
/* Service workers OFF and a cache-buster on the URL. A probe that measures a
 * stale bundle reports on a build nobody is running; this has happened. */
const ctx = await browser.newContext({
  viewport: { width: 932, height: 430 }, serviceWorkers: 'block',
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const t0 = Date.now();
await page.goto(`http://127.0.0.1:${PORT}/?cb=${Date.now()}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.habitatScene?.ready === true, null, { timeout: 240000 });
/* Through the door, as a player would — `reveal()` is on the other side. */
const doored = await pressPlay(page);
const bootS = (Date.now() - t0) / 1000;

const r = await page.evaluate(async () => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const lab = window.habitatScene;
  lab.setPausedForTest(true);
  const ant = lab.ant;
  const tank = lab.boundsForTest();
  /*
   * LOCOMOTION ONLY. This probe's question is "can she stand and walk on
   * density soil", and since the digger became her default brain `tick` was
   * driving her to work sites and measuring an ant halfway down a hole —
   * every foot number collapsed and the seat drifted, none of it about
   * walking. `probe:dig` is where the digging is held to account.
   */
  lab.setDiggingForTest(false);
  /*
   * AND PUT HER BACK WHERE SHE STARTED. The simulation begins the instant
   * PLAY is pressed, so a handful of live frames run before this probe can
   * pause it — enough for the digger to take a step or a bite, and enough to
   * make the settled seat read differently run to run. A locomotion probe
   * should measure the same ant on the same ground every time.
   */
  const mid = tank.size / 2;
  lab.ant.place(mid, mid, lab.surfaceAt(mid, mid) ?? 0, 0);
  lab.ant.plant(lab.ground);

  /* Three seconds to settle, then three standing still. */
  for (let i = 0; i < 180; i += 1) lab.tickForTest(1 / 60, 0, 0);
  const settled = lab.reportForTest();
  let sp = 0; let sg = 0;
  for (let i = 0; i < 180; i += 1) {
    lab.tickForTest(1 / 60, 0, 0);
    const s = lab.reportForTest();
    sp += s.planted; sg += s.groping;
  }

  /* Sixty seconds of the REAL frame — her own brain steering. */
  let wp = 0; let wg = 0; let moved = 0; let offSoil = 0;
  let lo = Infinity; let hi = -Infinity; let buried = 0; let floating = 0;
  /*
   * Buried and floating are asked of the FIELD, not of `surfaceIn`. A check
   * that compares her y against the same query that placed her there can only
   * ever agree with itself: a ground reporting the surface half a unit too
   * high passes it, which was measured by deliberately breaking one. `solidAt`
   * is an independent witness.
   */
  const belly = ant.seatForTest().bellyMm / 5;
  /*
   * THE SHAKE, watched at the tip of her abdomen.
   *
   * Measured in HER frame — gaster minus body, projected on her own right and
   * up — so her travel and her turning drop out and only the wobble is left.
   * The number that matters is the second difference: a sway has a small one
   * and a shake has a large one, and the two are indistinguishable from
   * amplitude alone. She is SUPPOSED to sway about a millimetre.
   */
  const gas = new THREE.Vector3();
  const right = new THREE.Vector3();
  let lastLat = null; let lastVel = 0;
  let latAccel = 0; let latSteps = 0; let latFlips = 0; let worstStep = 0;
  /* Runs of consecutive frames on which her brain asked for a turn. A run of
   * one is an impulse, and an impulse is what snapped her gaster. */
  let turnRun = 0; let impulses = 0;
  for (let i = 0; i < 3600; i += 1) {
    lab.tick(1 / 60);
    const s = lab.reportForTest();
    wp += s.planted; wg += s.groping; moved += s.movedMm;
    if (s.surfaceUnder === null) offSoil += 1;
    /* Her belly must be in air, and something within a body's depth of her
     * feet must be soil. Both read straight off the density field. */
    if (lab.ground.solidAt(ant.at.x, ant.at.y + belly, ant.at.z)) buried += 1;
    else if (!lab.ground.solidAt(ant.at.x, ant.at.y - 0.2, ant.at.z)) floating += 1;
    lo = Math.min(lo, ant.at.x, ant.at.z);
    hi = Math.max(hi, ant.at.x, ant.at.z);

    if (Math.abs(lab.intentForTest().turn) > 1e-9) turnRun += 1;
    else { if (turnRun === 1) impulses += 1; turnRun = 0; }

    ant.model.segmentShell('gaster', gas);
    right.crossVectors(ant.up, ant.forward).normalize();
    const lat = gas.sub(ant.at).dot(right) * 5;
    if (lastLat !== null) {
      const vel = lat - lastLat;
      worstStep = Math.max(worstStep, Math.abs(vel));
      if (latSteps > 0) {
        latAccel += Math.abs(vel - lastVel);
        if (vel !== 0 && lastVel !== 0 && Math.sign(vel) !== Math.sign(lastVel)) latFlips += 1;
      }
      lastVel = vel; latSteps += 1;
    }
    lastLat = lat;
  }

  return {
    tank,
    tris: lab.soilForTest?.().triangles() ?? 0,
    cellMm: settled.cellMm,
    soilDepthMm: +(lab.gradeForTest() * 5).toFixed(1),
    tankMm: +(tank.size * 5).toFixed(0),
    memMB: +(settled.samples * 4 / 1048576).toFixed(1),
    seat: ant.seatForTest(),
    settledRideMm: +(settled.ride * 5).toFixed(3),
    stand: { planted: +(sp / 180).toFixed(2), groping: +(sg / 180).toFixed(2) },
    walk: { planted: +(wp / 3600).toFixed(2), groping: +(wg / 3600).toFixed(2) },
    movedMm: +moved.toFixed(0),
    offSoil,
    buried,
    floating,
    span: [+lo.toFixed(2), +hi.toFixed(2)],
    gaster: {
      accelMm: +(latAccel / latSteps).toFixed(4),
      worstStepMm: +worstStep.toFixed(3),
      flipsPerSec: +(latFlips / (latSteps / 60)).toFixed(1),
      impulses,
    },
  };
});

console.log(`  booted in ${bootS.toFixed(1)} s`);
console.log(`  ${JSON.stringify(r)}`);

check('no page errors', errors.length === 0, errors.join(' | ') || 'none');
check('the PLAY door opens onto the tray', doored, doored ? 'pressed' : 'no door found');
check('soil meshed', r.tris > 1000, `${r.tris} triangles`);
check('cells are 0.5 mm', Math.abs(r.cellMm - 0.5) < 1e-6, `${r.cellMm} mm`);
check('field fits the memory budget', r.memMB < 64, `${r.memMB} MB`);

/*
 * ENOUGH SOIL UNDER HER TO DIG THE NEST THE DESIGN ASKS FOR.
 *
 * Card 01 puts the founding shaft at about 30 mm. The first tank was 48 mm
 * tall with the surface at 55% of it, which is 26.4 mm of soil — she would
 * have struck the glass floor part-way down her own burrow, and nothing in
 * the build said so because digging is not wired yet. A tank is not merely a
 * viewport; it has to hold the game.
 */
check('deep enough for a founding shaft', r.soilDepthMm >= 30,
  `${r.soilDepthMm} mm of soil below grade`);

/* She stands on six feet. Anything less on flat soil is a seating fault. */
check('stands on all six', r.stand.planted > 5.9, `${r.stand.planted} planted`);
check('stands without groping', r.stand.groping < 0.05, `${r.stand.groping} groping`);

/*
 * The seat the body ASKED for is the seat it GOT — `AntBody` and the density
 * ground agree about where they put her.
 *
 * Note what this does and does not prove. Both numbers come through
 * `surfaceIn`, so a ground that reports every surface half a unit too high
 * passes this line untroubled; it was tried. What it catches is the two
 * halves disagreeing — the seating loop settling somewhere other than where
 * the belly clearance says it should. `buried` and `floating` below are the
 * checks that ask the field itself.
 */
check('settles on the seat it asked for', Math.abs(r.settledRideMm - r.seat.rideMm) < 0.01,
  `ride ${r.settledRideMm.toFixed(3)} mm vs seat ${r.seat.rideMm.toFixed(3)} mm`);

/* A tripod gait keeps three down; below three she is dragging. */
check('keeps a tripod down while walking', r.walk.planted >= 3,
  `${r.walk.planted} planted`);
check('walks with little groping', r.walk.groping < 0.6, `${r.walk.groping} groping`);
check('actually travels', r.movedMm > 150, `${r.movedMm} mm in 60 s`);

/*
 * THE ONE THAT CAUGHT THE FALSE ALARM. Her senses must turn her back before
 * the soil runs out. Forcing walk=1 instead of letting her steer puts ~1900
 * frames in this counter, which is what the old probe was averaging over.
 */
check('never leaves the soil', r.offSoil === 0, `${r.offSoil} frames off it`);
check('stays inside the glass', r.span[0] > 0 && r.span[1] < r.tank.size,
  `x/z spanned ${r.span[0]}..${r.span[1]} of 0..${r.tank.size}`);
check('belly never inside soil', r.buried === 0, `${r.buried} frames buried`);
check('soil always under her feet', r.floating === 0, `${r.floating} frames floating`);

/*
 * HER ABDOMEN SWAYS; IT DOES NOT SHAKE.
 *
 * Three ways of asking the same question, because amplitude alone cannot tell
 * them apart — she is meant to sway about a millimetre side to side.
 *
 * `accelMm` is the mean absolute second difference of the gaster's lateral
 * offset in her own frame: 0.238 mm when she was shaking, 0.008 mm when she
 * was not. `worstStepMm` catches the single snap an average would hide — the
 * spikes were 0.497 mm against a 0.052 mm median. `flipsPerSec` catches a
 * wobble that is smooth but far too fast: her gait is about 1.9 Hz, so
 * reversals should come at roughly twice that, and 18.7 was what a shake
 * looked like.
 */
check('gaster sways smoothly', r.gaster.accelMm < 0.03, `${r.gaster.accelMm} mm/frame^2`);
check('gaster never snaps', r.gaster.worstStepMm < 0.25, `worst step ${r.gaster.worstStepMm} mm`);
check('gaster wobbles at gait rate', r.gaster.flipsPerSec < 9,
  `${r.gaster.flipsPerSec} reversals/s`);

/*
 * And the cause, checked at the source: a turn her brain holds for exactly
 * one frame is not a decision, it is a twitch, and it was the thing driving
 * the snap. Her stroll used to emit 239 of them in 30 seconds while she
 * ground along the glass.
 */
check('brain never twitches the turn', r.gaster.impulses === 0,
  `${r.gaster.impulses} one-frame turn impulses`);

await page.screenshot({ path: 'scratch-density.png' });
await browser.close();

const bad = checks.filter((c) => !c.ok);
console.log(`\n  ${checks.length - bad.length}/${checks.length} checks passed`);
if (bad.length > 0) process.exit(1);
