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
  const lab = window.habitatScene;
  lab.setPausedForTest(true);
  const field = lab.field;
  const soil = lab.soilForTest();

  const before = { tris: soil.triangles(), chunks: soil.liveChunks(), all: soil.chunkCount() };

  /* A queen's bore, straight down from a point on the surface: radius 3 mm
   * and 9 mm long, in world units (one unit is 5 mm). */
  const MM = 5;
  const x = 12.8; const z = 12.8;
  const top = lab.surfaceAt(x, z);
  const start = [x, top - 0.05, z];
  const aim = [0, -1, 0];
  const length = 9 / MM;
  const radius = 3 / MM;

  /* What the field says before, at three places: inside the bore, off to one
   * side of it, and directly BEHIND the origin — the last is the one that
   * catches a capsule masquerading as a bore. */
  const probes = {
    inside: [x, top - 0.05 - length / 2, z],
    beside: [x + radius * 2.5, top - 0.05 - length / 2, z],
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
    boreLenMm: 9,
    boreRadiusMm: 3,
    startBelowMm: 0.25,
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
 * A BORE REMOVES `length + radius`, NOT `length` — and that is worth pinning
 * because it is a live design question rather than an accident.
 *
 * `boreFrom` is a capsule cut flat at the thorax plane: flat where it starts,
 * ROUND where it works. The round cap is the point — a tunnel does not end in
 * a disc — and it reaches one radius past the end of the segment. So a
 * queen's 9 mm segment at 3 mm radius takes out 12 mm of soil, measured here
 * as 12.25 including the quarter-millimetre the jaw started below the surface.
 *
 * Joshua's spec says "Queen = 6 mm wide x 6 mm tall x 9 mm deep/long". If the
 * 9 is meant to be the DEPTH OF THE HOLE, the segment should be 6 mm and this
 * expectation becomes `length` exactly. That is his call, not one to make by
 * quietly changing a constant — decision 1 on this work was "do not silently
 * resize the design" — so the check pins what the geometry ACTUALLY does and
 * will go red the moment anyone changes it in either direction.
 */
check('and by the bore segment plus its rounded cap',
  r.droppedMm !== null
    && Math.abs(r.droppedMm - (r.boreLenMm + r.boreRadiusMm + r.startBelowMm)) < 0.6,
  `${r.droppedMm} mm vs ${r.boreLenMm} + ${r.boreRadiusMm} cap + ${r.startBelowMm} start`);

await browser.close();
const bad = checks.filter((c) => !c.ok);
console.log(`\n  ${checks.length - bad.length}/${checks.length} checks passed`);
if (bad.length > 0) process.exit(1);
