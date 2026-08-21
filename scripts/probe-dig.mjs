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

await browser.close();
const bad = checks.filter((c) => !c.ok);
console.log(`\n  ${checks.length - bad.length}/${checks.length} checks passed`);
if (bad.length > 0) process.exit(1);
