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

say('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

const passed = checks.filter(Boolean).length;
const ok = passed === checks.length;
console.log(`\n  ${ok ? 'PASS' : 'FAIL'} — ${passed}/${checks.length}\n`);
await browser.close();
process.exit(ok ? 0 : 1);
