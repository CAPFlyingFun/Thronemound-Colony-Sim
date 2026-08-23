/**
 * IS THE SOIL SOLID TO HER, AND IS IT ONLY SOLID WHERE IT SHOULD BE?
 *
 * Two claims that fail in opposite directions, which is why they are both
 * here. A body-collision system that refuses everything passes any test that
 * only checks for penetration — and this one did exactly that on its first
 * cut, freezing her for two minutes with 3 mm travelled and calling it zero
 * millimetres of burial.
 *
 *   REFUSE — driven straight at undug soil, she stops at the face.
 *   PERMIT — driven down a tunnel that has already been cut, she travels it.
 *
 * The tunnel is carved here rather than dug, so the test is about her body
 * and not about her brain.
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
const ctx = await browser.newContext({
  viewport: { width: 932, height: 430 }, serviceWorkers: 'block',
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/?cb=${Date.now()}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.habitatScene?.ready === true, null, { timeout: 240000 });
await page.evaluate(() => window.habitatScene.setPausedForTest(true));
await pressPlay(page);

const out = await page.evaluate(async () => {
  const MM = 5;
  const { carveSweep } = await import('/src/sim/density/digSweep.ts');
  const lab = window.habitatScene;
  lab.setPausedForTest(true);
  lab.setDiggingForTest(false);
  const ant = lab.ant;
  const THREE = ant.at.constructor;

  /** Cut a straight horizontal gallery and hand back its two ends. */
  const gallery = (radiusMm, lengthMm, y, z0) => {
    const r = radiusMm / MM;
    const points = [];
    const step = r * 0.5;
    for (let t = 0; t <= lengthMm / MM + 1e-9; t += step) {
      points.push({ x: lab.boundsForTest().size / 2, y, z: z0 + t });
    }
    const region = carveSweep(lab.field, points, r);
    if (region) lab.soilForTest()?.rebuild(region);
    return { z0, z1: z0 + lengthMm / MM, r };
  };

  /** Drive her with a fixed intent and report how far she got and how deep. */
  const drive = (seconds, walk, turn) => {
    const from = ant.at.clone();
    let worst = 0;
    /*
     * STEPS TAKEN, AND STEPS THAT WENT NOWHERE.
     *
     * A foot that lifts and lands back on the anchor it left is a step in
     * the gait's books and nothing at all in the world. Six of them a second
     * is what Joshua saw as her body wiggling in place with her legs fixed.
     * Counting both is the only way to tell walking from dancing.
     */
    let lifts = 0;
    let futile = 0;
    /*
     * And the same two counted over the LAST QUARTER of the drive only.
     *
     * Walking into a face is not instantaneous: she covers real ground, and
     * those steps are real. The question this probe asks is what she does
     * once she has ARRIVED and cannot go further, so the steady state is
     * what has to be clean. Counting the whole run conflates the approach
     * with the stall and reads 5 futile steps that were mostly neither.
     */
    let liftsLate = 0;
    let futileLate = 0;
    const planted = new Map(ant.drive.legs.map((l) => [l.slot, l.planted]));
    const anchor = new Map(ant.drive.legs.map((l) => [l.slot, l.anchor.clone()]));
    const frames = Math.round(seconds * 60);
    for (let f = 0; f < frames; f += 1) {
      lab.tickForTest(1 / 60, walk, turn);
      const late = f >= frames * 0.75;
      const d = ant.inside;
      if (d > worst) worst = d;
      for (const l of ant.drive.legs) {
        if (planted.get(l.slot) && !l.planted) { lifts += 1; if (late) liftsLate += 1; }
        if (!planted.get(l.slot) && l.planted) {
          if (l.anchor.distanceTo(anchor.get(l.slot)) * MM < 0.05) {
            futile += 1;
            if (late) futileLate += 1;
          }
          anchor.get(l.slot).copy(l.anchor);
        }
        planted.set(l.slot, l.planted);
      }
    }
    return {
      travelledMm: +(ant.at.distanceTo(from) * MM).toFixed(2),
      alongMm: +((ant.at.z - from.z) * MM).toFixed(2),
      worstInsideMm: +(worst * MM).toFixed(4),
      lifts,
      futile,
      liftsLate,
      futileLate,
    };
  };

  /*
   * SEATED IN THE MIDDLE OF THE GALLERY, not with her origin on its axis.
   *
   * Her body origin is not her centre — it sits near her belly, and her
   * spine rides above it — so placing `at` on the centreline presses her
   * back against the ceiling. The first cut did that and read 0.43 mm of
   * penetration before she had moved at all, which is a fact about the test
   * rig and would have been reported as a fact about her.
   */
  const seatIn = (x, z, centreY, heading) => {
    let bestY = centreY;
    let best = Infinity;
    for (let d = -1.2; d <= 1.2; d += 0.05) {
      ant.place(x, z, centreY + d - ant.ride, heading);
      const inside = ant.inside;
      if (inside < best) { best = inside; bestY = centreY + d; }
      if (best <= 0) break;
    }
    ant.place(x, z, bestY - ant.ride, heading);
    ant.plant(lab.ground);
    return +(ant.inside * MM).toFixed(4);
  };

  const size = lab.boundsForTest().size;
  const mid = size / 2;
  const grade = lab.gradeForTest();
  /* Well below the surface, so every direction out of the gallery is soil. */
  const y = grade - 20 / MM;

  const results = {};

  /*
   * A GALLERY WIDE ENOUGH FOR HER STANCE, for both of the claims this file
   * makes. Body collision is what is under test; whether her LEGS fit a
   * 6 mm bore is Phase 6's question and is reported separately below rather
   * than folded in here, because a test that fails for two reasons at once
   * cannot say which one moved.
   */
  const g = gallery(6, 44, y, mid - 44 / MM);

  /* REFUSE — driven at the dead end with walk pinned to 1. No AI involved. */
  results.faceSeatMm = seatIn(mid, g.z1 - 8 / MM, y, 0);
  results.atFace = drive(4, 1, 0);
  results.faceStopZ = +(ant.at.z * MM).toFixed(2);
  results.faceEndZ = +(g.z1 * MM).toFixed(2);

  /* PERMIT — the same gallery, driven the way that is already air. */
  results.runSeatMm = seatIn(mid, g.z1 - 4 / MM, y, Math.PI);
  results.downGallery = drive(6, 1, 0);

  /* AND HER NOMINAL BORE, recorded only. See the note on the check below. */
  const g6 = gallery(3, 30, y - 12 / MM, mid - 30 / MM);
  results.bore6SeatMm = seatIn(mid, g6.z1 - 4 / MM, y - 12 / MM, Math.PI);
  results.downBore6 = drive(6, 1, 0);

  results.shell = ant.shell ? {
    samples: ant.shell.sampleCount,
    widestMm: +(Math.max(
      ant.shell.radiusOf('head'), ant.shell.radiusOf('thorax'),
      ant.shell.radiusOf('gaster'),
    ) * 2 * MM).toFixed(2),
  } : null;
  return results;
});

await browser.close();

console.log(`  ${JSON.stringify(out)}\n`);
const TOL = 0.05;

check('no page errors', errors.length === 0, errors[0] ?? 'none');

/*
 * SHE STOPS AT UNDUG SOIL. Driven straight at the dead end of a gallery with
 * walk pinned to 1 for four seconds — the AI is not involved, this is the
 * body against the field.
 */
check('driven at undug soil, she stops at the face',
  out.atFace.worstInsideMm <= TOL,
  `${out.atFace.worstInsideMm} mm deepest, ${out.atFace.alongMm} mm advanced, `
  + `stopped at z ${out.faceStopZ} against a face at ${out.faceEndZ}`);

/*
 * AND SHE IS NOT MERELY FROZEN. The first cut of the shell reported perfect
 * solidity and had simply stopped her moving at all — 3 mm travelled in two
 * minutes, and every penetration check green. A refusal test on its own
 * cannot tell a constraint from a freeze, so this is the other half of it.
 */
check('and she still travels a gallery that is already air',
  out.downGallery.travelledMm > 6,
  `${out.downGallery.travelledMm} mm travelled`);
check('and stays out of the walls while doing it',
  out.downGallery.worstInsideMm <= TOL,
  `${out.downGallery.worstInsideMm} mm deepest`);

/*
 * HER NOMINAL 6 mm BORE — RECORDED, NOT ASSERTED, and the distinction is
 * Phase 6's whole subject.
 *
 * Her CORE BODY is 2.73 mm across and fits a 6 mm bore twice over; the check
 * below says so. Her planted STANCE is 7.22 mm and does not fit it at all,
 * and since the legs are what move her, she cannot walk a tunnel her feet
 * have nowhere to stand in. Asserting it here would fail on a leg problem
 * while pointing at the body, which is the mistake this file exists to
 * avoid. It becomes a check when the confined stance is built.
 */
console.log(`  NOTE  her nominal 6 mm bore: ${out.downBore6.travelledMm} mm travelled, `
  + `${out.downBore6.worstInsideMm} mm deepest — Phase 6 owns this, see the source`);

/*
 * SHE DOES NOT DANCE WHEN SHE CANNOT GO. Driven into a face she cannot pass,
 * the honest behaviour is to stand: any step she takes must actually move
 * the foot. Before the fix this ran at 27 lifts in four seconds with every
 * anchor unchanged.
 */
check('pinned at a face, she stands rather than marching in place',
  out.atFace.futileLate === 0,
  `${out.atFace.futileLate} of ${out.atFace.liftsLate} steps in the last second `
  + `landed back on their own anchor (${out.atFace.futile}/${out.atFace.lifts} over the whole run)`);

check('her core body is narrower than the bore she cuts',
  out.shell !== null && out.shell.widestMm < 6,
  out.shell ? `${out.shell.widestMm} mm across a 6 mm bore` : 'no shell measured');

const bad = checks.filter((c) => !c.ok);
console.log(`\n  ${checks.length - bad.length}/${checks.length} checks passed`);
process.exit(bad.length ? 1 : 0);
