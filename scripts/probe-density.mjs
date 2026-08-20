/**
 * THE DENSITY TRAY, MEASURED — does she stand on it, walk on it, and stay on it?
 *
 * This probe exists because the first one lied. Its predecessor drove
 * `tickForTest(dt, 1, 0)` — full walk, straight ahead, for ten seconds — and
 * reported 1.46 feet planted and 3.91 groping, which read as a catastrophic
 * regression against the voxel tray's 3.3 / 0.0. It was not. The density tray
 * is 64 mm across where the voxel tray was 480 mm, so ten seconds of forced
 * marching walked her 70 mm: clean off the end of the soil and 6.6 mm out
 * through the glass, where six feet groping is the correct answer. The numbers
 * were measuring a probe artefact.
 *
 * So this one drives `tick()`, which is the REAL frame — stroll AI, senses,
 * avoidance and all — and asserts on what the game actually does. The lesson
 * is written here rather than in a commit message because the next person to
 * add a movement probe will be tempted to force the input again.
 */
import { chromium } from 'playwright';

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
const bootS = (Date.now() - t0) / 1000;

const r = await page.evaluate(() => {
  const lab = window.habitatScene;
  lab.setPausedForTest(true);
  const ant = lab.ant;
  const tank = lab.boundsForTest();

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
  }

  return {
    tank,
    tris: (lab.soilForTest?.().geometry.index?.count ?? 0) / 3,
    cellMm: settled.cellMm,
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
  };
});

console.log(`  booted in ${bootS.toFixed(1)} s`);
console.log(`  ${JSON.stringify(r)}`);

check('no page errors', errors.length === 0, errors.join(' | ') || 'none');
check('soil meshed', r.tris > 1000, `${r.tris} triangles`);
check('cells are 0.25 mm', Math.abs(r.cellMm - 0.25) < 1e-6, `${r.cellMm} mm`);
check('field fits the memory budget', r.memMB < 64, `${r.memMB} MB`);

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
check('settles on the seat it asked for', Math.abs(r.settledRideMm - r.seat.rideMm) < 0.02,
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

await page.screenshot({ path: 'scratch-density.png' });
await browser.close();

const bad = checks.filter((c) => !c.ok);
console.log(`\n  ${checks.length - bad.length}/${checks.length} checks passed`);
if (bad.length > 0) process.exit(1);
