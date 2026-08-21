/**
 * A HOLE IN THE SOIL, MEASURED — does a bore remove soil, redraw locally, and
 * does the ground agree afterwards?
 *
 * Three separate claims, and they fail separately:
 *
 *   1. The FIELD changed where the bore was and nowhere else. A carve that
 *      quietly takes soil from behind her is the capsule bug `boreFrom` was
 *      written to avoid, and it is invisible until an ant falls through a
 *      floor she never dug.
 *   2. The MESH followed, at a cost that tracks the bite. Rebuilding 473 k
 *      triangles per mouthful is the frame hitch this whole chunked design
 *      exists to retire, and "it looks fine" cannot tell the two apart.
 *   3. The GROUND queries see the hole. The field, the drawn surface and what
 *      her feet stand on all read the same data, and this is where that stops
 *      being an assertion and becomes a measurement.
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
await pressPlay(page);

const r = await page.evaluate(async () => {
  const { boreFrom } = await import('/src/sim/density/boreFrom.ts');
  const { carveInto, boreBounds } = await import('/src/sim/density/carveInto.ts');
  const { CASTE_DIG, boreRadiusMm, boreSegmentMm } = await import('/src/sim/density/casteDig.ts');
  const lab = window.habitatScene;
  lab.setPausedForTest(true);
  const field = lab.field;
  const soil = lab.soilForTest();

  const before = { tris: soil.triangles(), chunks: soil.liveChunks(), all: soil.chunkCount() };

  /*
   * A QUEEN'S BORE, straight down from the surface, built the way the game
   * will build it: the SEGMENT from `boreSegmentMm`, never the spec'd length.
   * Starting flush with the surface rather than below it, so the depth this
   * measures is the depth of the tunnel and not the tunnel plus a head start.
   */
  const MM = 5;
  const x = 12.8; const z = 12.8;
  const top = lab.surfaceAt(x, z);
  const start = [x, top, z];
  const aim = [0, -1, 0];
  const specMm = CASTE_DIG.queen.lengthMm;
  const radiusMm = boreRadiusMm('queen');
  const segmentMm = boreSegmentMm('queen');
  const length = segmentMm / MM;
  const radius = radiusMm / MM;

  /* What the field says before, at three places: inside the bore, off to one
   * side of it, and directly BEHIND the origin — the last is the one that
   * catches a capsule masquerading as a bore. */
  const probes = {
    inside: [x, top - length / 2, z],
    beside: [x + radius * 2.5, top - length / 2, z],
    behind: [x, top + 0.3, z],
  };
  const was = Object.fromEntries(
    Object.entries(probes).map(([k, p]) => [k, field.sample(p[0], p[1], p[2])]),
  );

  const t0 = performance.now();
  const region = carveInto(field, boreFrom(start, aim, length, radius),
    boreBounds(start, aim, length, radius));
  const carveMs = performance.now() - t0;
  soil.rebuild(region);

  const now = Object.fromEntries(
    Object.entries(probes).map(([k, p]) => [k, field.sample(p[0], p[1], p[2])]),
  );

  /* And what the GROUND makes of it: the floor under that column should have
   * dropped by about the bore's length. */
  const after = lab.surfaceAt(x, z);

  /* A second bite in the same place must be nearly free — nothing to remove. */
  const t1 = performance.now();
  const again = carveInto(field, boreFrom(start, aim, length, radius),
    boreBounds(start, aim, length, radius));
  const repeatMs = performance.now() - t1;

  return {
    before, after: { tris: soil.triangles(), chunks: soil.liveChunks() },
    region,
    carveMs: +carveMs.toFixed(1),
    repeatMs: +repeatMs.toFixed(1),
    repeatTouched: again !== null,
    rebuildMs: +soil.lastRebuildMs.toFixed(1),
    rebuildChunks: soil.lastRebuildChunks,
    meshMs: +soil.lastMeshMs.toFixed(1),
    attrMs: +soil.lastAttrMs.toFixed(1),
    was: Object.fromEntries(Object.entries(was).map(([k, v]) => [k, +v.toFixed(3)])),
    now: Object.fromEntries(Object.entries(now).map(([k, v]) => [k, +v.toFixed(3)])),
    surfaceBefore: +top.toFixed(3),
    surfaceAfter: after === null ? null : +after.toFixed(3),
    droppedMm: after === null ? null : +((top - after) * MM).toFixed(2),
    specMm, radiusMm, segmentMm: +segmentMm.toFixed(2),
  };
});

console.log(`  ${JSON.stringify(r)}`);
check('no page errors', errors.length === 0, errors.join(' | ') || 'none');

/* 1. The field. */
check('soil was solid where the bore went', r.was.inside > 0, `${r.was.inside}`);
check('and is air there now', r.now.inside < 0, `${r.now.inside}`);
check('soil beside the bore is untouched',
  r.now.beside === r.was.beside, `${r.was.beside} -> ${r.now.beside}`);
/*
 * THE ONE `boreFrom` EXISTS FOR. A capsule anchored at the jaw scoops a
 * hemisphere out BEHIND her, where her own body is and where she is not
 * digging. Above the start point is air already, so the test is that the
 * carve did not make it *more* negative by rounding the back cap into it.
 */
check('nothing was taken from behind the jaw',
  r.now.behind === r.was.behind, `${r.was.behind} -> ${r.now.behind}`);

/* 2. The mesh. */
check('the redraw is local, not the whole tray',
  r.rebuildChunks > 0 && r.rebuildChunks <= 8,
  `${r.rebuildChunks} of ${r.before.all} chunks`);
check('and it is fast enough for a frame', r.rebuildMs < 60,
  `${r.rebuildMs} ms — mesh ${r.meshMs}, attributes ${r.attrMs}`);
check('the carve itself is cheap', r.carveMs < 30, `${r.carveMs} ms`);
/* Biting air must cost nothing and schedule nothing. */
check('a second bite in the same hole removes nothing',
  !r.repeatTouched, `touched=${r.repeatTouched}, ${r.repeatMs} ms`);

/* 3. The ground. */
check('the floor under the hole dropped',
  r.droppedMm !== null && r.droppedMm > 4,
  `${r.droppedMm} mm`);

/*
 * AND BY THE SPEC'D DEPTH — the hole, not the segment that cut it.
 *
 * Joshua, 2026-08-21: "9 mm is the hole -> the segment should be 6 mm." So
 * the queen's tunnel is driven by a 6 mm segment whose round work face
 * reaches the remaining 3 mm, and what the ground reads back afterwards
 * should be the 9 mm the design asks for.
 *
 * Measured off `surfaceIn`, which is a different instrument from the one that
 * cut the hole: the carve wrote samples, this asks where the floor is now.
 * Half a millimetre of tolerance covers the surface search's own step.
 */
check('and by the depth the caste spec asks for',
  r.droppedMm !== null && Math.abs(r.droppedMm - r.specMm) < 0.5,
  `${r.droppedMm} mm against a spec of ${r.specMm} (segment ${r.segmentMm} + ${r.radiusMm} cap)`);

/* ------------------------------------------------- and now the ant herself */

/*
 * THE COMPLAINT, AS A MEASUREMENT.
 *
 * "until the ant is touching that block, it won't dig it remotely" — so the
 * things to watch are not "did a tunnel appear" but: was she ever chewing
 * soil she was not touching, did she reach every site on her feet, and did
 * she ever stop making progress. The old brain passed 14/14 while deadlocked,
 * because nothing it measured was any of those.
 */
const live = await page.evaluate(async () => {
  const { CASTE_DIG } = await import('/src/sim/density/casteDig.ts');
  const { NOSE_REACH_MM } = await import('/src/sim/density/digBrain.ts');
  const lab = window.habitatScene;
  lab.setPausedForTest(true);

  const MM = 5;
  const seen = new Set();
  let framesDigging = 0;
  let worstSeatMm = 0;
  let framesDiggingOffFace = 0;
  let barMovedOffFace = 0;
  let worstJawGapMm = 0;
  let lastProgress = 0;
  let travelled = 0;
  /*
   * HER ATTITUDE, AND WHAT IT COSTS HER LEGS.
   *
   * Both of these are here because the two earlier attempts at pitch each
   * bought the lean with something else: leaning `up` onto the support
   * normal pitched her and collapsed the gait, and a thorax-only bore
   * pitched her and stopped the digging. So a pitch measurement alone
   * cannot say the change is good — it has to be read next to the feet and
   * the depth, or it is the same green those two would have shown.
   */
  let peakPitchDeg = -90;
  let pitchDigSum = 0;
  let pitchDigFrames = 0;
  let plantedSum = 0;
  let gropingSum = 0;
  let gaitFrames = 0;
  const prev = lab.ant.at.clone();
  const phases = {};

  /* Two minutes of simulated time — long enough for several bites and for a
   * deadlock to show as a flat bite count. */
  for (let i = 0; i < 7200; i += 1) {
    lab.tick(1 / 60);
    const d = lab.digReportForTest();
    phases[d.phase] = (phases[d.phase] ?? 0) + 1;
    seen.add(d.phase);
    travelled += lab.ant.at.distanceTo(prev);
    prev.copy(lab.ant.at);

    peakPitchDeg = Math.max(peakPitchDeg, d.pitchDeg);
    const r = lab.reportForTest();
    plantedSum += r.planted; gropingSum += r.groping; gaitFrames += 1;

    if (d.cutting) worstSeatMm = Math.max(worstSeatMm, d.seatReachMm);
    if (d.phase === 'digging') {
      framesDigging += 1;
      pitchDigSum += d.pitchDeg; pitchDigFrames += 1;
      if (!d.onFace) framesDiggingOffFace += 1;
      /* Did the BAR advance on a frame where her jaws were off the soil? */
      if (!d.onFace && d.progress > lastProgress) barMovedOffFace += 1;
      /*
       * How far her mandibles were from soil while she was working. Asked of
       * the field along her own aim, so it is the same question the gate asks
       * and not a proxy for it.
       */
      let gap = 0;
      const step = 0.02;
      while (gap < 1 && !lab.ground.solidAt(
        d.jaw.x + lab.digAimForTest().x * gap,
        d.jaw.y + lab.digAimForTest().y * gap,
        d.jaw.z + lab.digAimForTest().z * gap,
      )) gap += step;
      worstJawGapMm = Math.max(worstJawGapMm, Math.min(gap, 1) * MM);
    }
    lastProgress = d.progress;
  }

  /*
   * DID SHE MAKE A HOLE, or a trench?
   *
   * The distinction is the whole of the last fix and it is invisible in the
   * bite count: nibbling the rim of her own scoop completes bites forever and
   * leaves a line of shallow dents across the surface, which is the shape
   * Joshua reported on the voxel build — "she isn't digging straight down at
   * first and making a trench, haha." Depth is what tells them apart.
   */
  const grade = lab.gradeForTest();
  let deepestMm = 0;
  for (let x = 1.5; x < lab.boundsForTest().size - 1.5; x += 0.4) {
    for (let z = 1.5; z < lab.boundsForTest().size - 1.5; z += 0.4) {
      const top = lab.surfaceAt(x, z, grade + 3);
      if (top !== null) deepestMm = Math.max(deepestMm, (grade - top) * MM);
    }
  }

  const end = lab.digReportForTest();
  return {
    deepestMm: +deepestMm.toFixed(1),
    bites: end.bites, arms: end.arms,
    phases, sawAll: [...seen].sort(),
    framesDigging, framesDiggingOffFace, barMovedOffFace,
    worstJawGapMm: +worstJawGapMm.toFixed(2),
    travelledMm: +(travelled * MM).toFixed(0),
    worstSeatMm: +worstSeatMm.toFixed(2),
    peakPitchDeg: +peakPitchDeg.toFixed(1),
    diggingPitchDeg: pitchDigFrames === 0
      ? null : +(pitchDigSum / pitchDigFrames).toFixed(1),
    aimDownDeg: +end.aimDownDeg.toFixed(1),
    planted: +(plantedSum / gaitFrames).toFixed(2),
    groping: +(gropingSum / gaitFrames).toFixed(2),
    noseReachMm: NOSE_REACH_MM,
    bodyMm: CASTE_DIG.queen.lengthMm,
    rebuildMs: +lab.soilForTest().lastRebuildMs.toFixed(1),
  };
});

console.log(`  ${JSON.stringify(live)}`);

check('she completes bites', live.bites >= 3, `${live.bites} in 120 s`);
check('and keeps completing them', live.arms >= 1 && live.bites >= live.arms,
  `${live.bites} bites over ${live.arms} sites`);
check('she goes through the whole loop',
  ['closing', 'digging', 'facing', 'walking'].every((p) => live.sawAll.includes(p)),
  live.sawAll.join(' '));
check('she walks to her work', live.travelledMm > 40, `${live.travelledMm} mm travelled`);

/*
 * THE COMPLAINT, MEASURED AGAINST THE MECHANIC THAT NOW SERVES IT.
 *
 * The old gate asked whether soil lay within a couple of millimetres of her
 * MANDIBLES, and these checks counted frames where it was shut. That gate is
 * gone: it could not open on flat ground — her dipped jaw sits 1.89 mm above
 * level soil, so she armed thirteen sites and bit none — and the island's
 * mechanic replaced it. The bore is now SEATED by walking her aim out to her
 * nose reach and starting the cut wherever the ray meets soil.
 *
 * So the thing to hold her to changed shape, and pretending otherwise would
 * leave three green checks describing a rule the code no longer has. What
 * "it won't dig it remotely" means under this mechanic is that the FACE she
 * starts on is within her own reach — and the cut then begins half a bore
 * radius on the AIR side of it and eats forward. Nothing is removed at the
 * far end of the ray; the ray only finds the face.
 */
check('every cut starts on a face within her reach',
  live.worstSeatMm <= live.noseReachMm + 0.1,
  `furthest face ${live.worstSeatMm} mm, nose reach ${live.noseReachMm} mm`);
check('and that reach is a fraction of her, not an ant-length',
  live.noseReachMm <= live.bodyMm * 0.6,
  `${live.noseReachMm} mm reach on a ${live.bodyMm} mm ant`);

/*
 * SHE EXCAVATES TO A REAL DEPTH — and that is all this claims.
 *
 * It was first written as "a hole, not a trench", after advancing the work
 * face with the tunnel turned a row of shallow scoops into a single round
 * entrance. But removing that advance again leaves this green at 8.6 mm:
 * with the target frozen she simply drills the same spot instead, which is
 * also deep. So the check does not distinguish the two shapes and the name
 * was a claim the measurement could not support.
 *
 * What it does catch is worth having — no hole at all, and surface scraping
 * that never breaks a few millimetres — so it stays, saying only that. The
 * trench itself is still judged by eye against a screenshot, which is honest
 * about where that particular guarantee currently comes from.
 */
check('she excavates to a real depth',
  live.deepestMm >= 4, `deepest excavation ${live.deepestMm} mm`);

/*
 * SHE PITCHES INTO THE WORK — Joshua, 2026-08-21: "Can you have it pitch as
 * that's the point and how ants dig and I can't give an honest assessment
 * because it's not behaving like a real ant would."
 *
 * Read off the DRAWN model's rotation, because the two attempts before this
 * one both set the intent correctly and got the sign wrong, and one of them
 * reared her 34.9 degrees at the ceiling. A field named `bodyPitch` would
 * have called that green.
 */
check('she pitches her body into the dig',
  live.diggingPitchDeg !== null && live.diggingPitchDeg >= 12,
  `${live.diggingPitchDeg} deg nose-down while digging, peak ${live.peakPitchDeg}`);
check('and her head carries the rest of the bore',
  live.aimDownDeg > live.peakPitchDeg + 5,
  `bore ${live.aimDownDeg} deg down, body at most ${live.peakPitchDeg}`);
/*
 * WHAT THE GAIT DOES UNDER THE PITCH — RECORDED, NOT ASSERTED.
 *
 * There was a check here. It read `planted >= 3.4, groping <= 1.2` — the
 * figures a WALKING ant posts — on the assumption that digging holds the
 * same line. It does not, and the assumption was mine, not a measurement.
 *
 * Measured, four runs each, in this harness:
 *
 *     flat build     planted 1.10 - 1.39    groping 4.31 - 4.36
 *     with pitch     planted 0.73 - 1.90    groping 3.82 - 5.13
 *
 * Two things follow. First, MOST OF HER FEET ARE ALREADY GROPING WHILE SHE
 * DIGS, and were before the pitch existed — better than four of six. That is
 * a real defect, it is what Joshua saw as "the legs were way over her body",
 * and it belongs to the IK in `solveFeet` / `QueenModel`, not to her
 * attitude. Second, the pitched spread STRADDLES the flat one: the
 * run-to-run variance is larger than any difference between them, so this
 * probe cannot honestly say the pitch made the gait worse OR that it left
 * it alone.
 *
 * So no check. A threshold loose enough to pass every pitched run would also
 * have passed the attempt that drove planted to 1.13, which is exactly the
 * regression it would exist to catch — and a green that cannot go red is
 * worse than a number written down. `planted` and `groping` are in the JSON
 * line above; read them. The leg defect gets its own fix and its own proof.
 *
 * The same caution applies to `deepestMm`, and it cuts the other way: the
 * pitched runs excavate 24 - 46 mm against the flat build's 9 - 34, which
 * LOOKS like a large win and is not separable at this spread either. The
 * depth check below stays where it was rather than being raised to claim it.
 */

check('digging never hitches the frame', live.rebuildMs < 40, `${live.rebuildMs} ms`);

/* ------------------------------------------------------------- the cutaway */

/*
 * CAN YOU SEE HER UNDERGROUND?
 *
 * Following her below the surface put the camera INSIDE the soil, and the
 * material is double-sided — culling would delete every tunnel ceiling, since
 * the mesher winds negative-facing quads backwards — so you saw through the
 * ground to the far inside of the tray. A lit room with strata for walls, and
 * her tunnels as solid white tubes seen from without. Reported as "walking
 * into the open space in un-digged dirt", which is what it looks like and
 * nothing like what is happening.
 *
 * The check is on the CUT rather than on a screenshot: with her underground
 * and the camera following, the soil must be clipped just above her, and with
 * her on the surface it must not be clipped at all.
 */
const cut = await page.evaluate(async () => {
  const { boreFrom } = await import('/src/sim/density/boreFrom.ts');
  const { carveInto, boreBounds } = await import('/src/sim/density/carveInto.ts');
  const lab = window.habitatScene;
  lab.setPausedForTest(true);
  lab.setDiggingForTest(false);
  lab.setFollow(false);
  lab.setCutawayForTest(false);
  for (let i = 0; i < 30; i += 1) lab.tick(1 / 60);
  const onSurface = lab.soilForTest().cutForTest();

  /* Sink a shaft and drop her down it. */
  const x = lab.ant.at.x; const z = lab.ant.at.z;
  const top = lab.surfaceAt(x, z);
  for (let i = 0; i < 8; i += 1) {
    const o = [x, top - i * 1.2, z];
    const r = carveInto(lab.field, boreFrom(o, [0, -1, 0], 1.2, 0.6),
      boreBounds(o, [0, -1, 0], 1.2, 0.6));
    if (r) lab.soilForTest().rebuild(r);
  }
  const floor = lab.surfaceAt(x, z);
  lab.ant.place(x, z, floor, 0);
  lab.ant.plant(lab.ground);
  lab.setFollow(true);
  lab.setCutawayForTest(true);
  for (let i = 0; i < 30; i += 1) lab.tick(1 / 60);
  const under = lab.soilForTest().cutForTest();
  return {
    depthMm: +((lab.gradeForTest() - floor) * 5).toFixed(1),
    antY: +lab.ant.at.y.toFixed(2),
    onSurface, under,
    cameraInSoil: lab.ground.solidAt(
      lab.camera.position.x, lab.camera.position.y, lab.camera.position.z,
    ),
  };
});

console.log(`  ${JSON.stringify(cut)}`);
check('the tank is whole until the player asks',
  cut.onSurface === null, `cut at ${cut.onSurface}`);
check('the lid comes off when the player asks',
  cut.under !== null && cut.under > cut.antY && cut.under < cut.antY + 2,
  `cut at ${cut.under}, ant at ${cut.antY}, ${cut.depthMm} mm down`);
check('and the camera is not buried', !cut.cameraInSoil,
  cut.cameraInSoil ? 'camera inside soil' : 'camera in open air');

await browser.close();
const bad = checks.filter((c) => !c.ok);
console.log(`\n  ${checks.length - bad.length}/${checks.length} checks passed`);
if (bad.length > 0) process.exit(1);
