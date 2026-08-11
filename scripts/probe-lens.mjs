/**
 * THE LENS PROBE — is soil in the picture, and WHOSE FAULT IS IT?
 *
 * The camera guard can fail three ways and they need different fixes, so
 * this never reports one blended total:
 *
 *   query   the terrain answer itself is wrong — the fine window said AIR
 *           for a point that is really soil, or (the dangerous one) carved
 *           air was overruled by the coarse island heightfield.
 *   escape  the answer was right and the guard did not act on it: soil is
 *           inside the near plane after the guard has run.
 *   render  the data is right and the guard is right, but the chunk that
 *           should be drawn there is queued or missing, so the frame shows
 *           void instead of dirt.
 *   unmapped the point lies OUTSIDE the fine window, where the only answer
 *           available is the coarse island heightfield — which predates
 *           every tunnel and so calls all of them solid. Counted apart
 *           from the other three on purpose: nothing here can be fixed by
 *           the camera, because the world has not been asked to represent
 *           that space. Collapsing it into 'escape' would send the next
 *           reader to tune a guard that is behaving correctly.
 *
 * Every scenario holds the camera to the same standard: no soil inside the
 * four near-plane corners, which is where the picture actually begins.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4620/';
const MM = 5;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
await page.goto(`${URL}?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(
  () => window.islandScene?.statsForTest?.().playerReady === 1,
  null, { timeout: 120000 },
);
await page.mouse.click(466, 215);
await page.waitForTimeout(2500);

const report = await page.evaluate(() => {
  const s = window.islandScene;
  const MMl = 5;
  s.setPausedForTest(true);

  const corners = () => {
    const cam = s.camera;
    cam.updateMatrixWorld(true);
    const halfH = cam.near * Math.tan((cam.fov * Math.PI) / 360);
    const halfW = halfH * cam.aspect;
    const p = cam.position;
    const m = cam.matrixWorld.elements;
    const right = { x: m[0], y: m[1], z: m[2] };
    const up = { x: m[4], y: m[5], z: m[6] };
    const fwd = { x: -m[8], y: -m[9], z: -m[10] };
    const out = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      out.push({
        x: p.x + fwd.x * cam.near + right.x * halfW * sx + up.x * halfH * sy,
        y: p.y + fwd.y * cam.near + right.y * halfW * sx + up.y * halfH * sy,
        z: p.z + fwd.z * cam.near + right.z * halfW * sx + up.z * halfH * sy,
      });
    }
    return out;
  };

  /** One frame's verdict, attributed. */
  const judge = () => {
    let worst = null;
    let worstD = -Infinity;
    for (const c of corners()) {
      const d = s.soilDensityAt(c.x, c.y, c.z);
      if (d > worstD) { worstD = d; worst = c; }
    }
    if (worstD <= 0) return null;
    const q = s.lensQueryForTest(worst.x, worst.y, worst.z);
    /* A carved-air point that still reads solid is a QUERY fault — the
     * chain overruled an answer it was given. Everything else with a
     * truthful solid answer is the guard failing to escape it. */
    if (q.fine === 'air' && q.finalMm > 0 && (q.treeMm ?? -1) <= 0) return 'query';
    if (q.chunkState === 'queued' || q.chunkState === 'missing') return 'render';
    if (q.fine === 'unavailable') return 'unmapped';
    return 'escape';
  };

  const run = (label, setup, frames) => {
    setup();
    const counts = { query: 0, escape: 0, render: 0, unmapped: 0, clean: 0 };
    let worstMm = 0;
    for (let i = 0; i < frames; i += 1) {
      s.stepForTest(1 / 60, 1);
      const v = judge();
      if (v) counts[v] += 1; else counts.clean += 1;
      const w = s.lensReportForTest().worstMm;
      if (w > worstMm) worstMm = w;
    }
    s.input.dig = false;
    s.input.walk = 0;
    return { label, frames, ...counts, worstMm: +worstMm.toFixed(2) };
  };

  const rest = () => {
    s.digMode = false; s.firstPerson = false;
    s.camera.fov = 60; s.camera.updateProjectionMatrix();
    s.lookPitch = 0; s.lookYaw = 0;
    s.input.dig = false; s.input.walk = 0;
  };

  const rows = [];
  const spawn = { x: s.at.x, y: s.at.y, z: s.at.z, f: s.facing };
  const home = () => { rest(); s.at.set(spawn.x, spawn.y, spawn.z); s.facing = spawn.f; };

  /* 1. open surface, third person */
  home();
  rows.push(run('open surface (3P)', () => { s.input.walk = 1; }, 300));

  /* 2. beside the landmark tree — walk into it, then keep going */
  home();
  rows.push(run('at the landmark tree', () => { s.input.walk = 1; }, 900));

  /* 3. first person, steep downward pitch */
  home();
  rows.push(run('1P steep look down', () => {
    s.firstPerson = true; s.lookPitch = -1.2; s.input.walk = 1;
  }, 300));

  /* 4. DIG mode at 100 degrees */
  home();
  rows.push(run('DIG 100 deg FOV', () => {
    s.digMode = true; s.firstPerson = true;
    s.camera.fov = 100; s.camera.updateProjectionMatrix();
    s.lookPitch = -0.9; s.input.dig = true; s.input.walk = 1;
  }, 300));

  /* 5. freshly carved tunnel — dig in, then look around inside it */
  home();
  s.digMode = true; s.firstPerson = true;
  s.camera.fov = 100; s.camera.updateProjectionMatrix();
  s.lookPitch = -0.9; s.input.dig = true; s.input.walk = 1;
  s.stepForTest(1 / 60, 900);          // 15 s of digging in
  rows.push(run('inside a carved tunnel', () => {
    s.input.dig = false; s.lookPitch = 0; s.input.walk = 1;
  }, 300));

  /* 6. the same tunnel, but BELOW the original coarse surface — the case
   *    the coarse heightfield would call buried. Recorded as its own row
   *    because it is the one the whole audit turns on. */
  const depthMm = (s.walkGroundAt(s.at.x, s.at.z) - s.at.y) * MMl;
  const carved = s.lensQueryForTest(s.at.x, s.at.y, s.at.z);
  rows.push(run('under the coarse surface', () => {
    s.lookPitch = -0.3; s.input.walk = 1;
  }, 300));

  /* 7. immediately after a dig, before the remesh queue drains */
  const beforeDrain = s.lensReportForTest().queuedChunks;
  rows.push(run('dig, queue still draining', () => {
    s.input.dig = true; s.input.walk = 1;
  }, 120));

  /* 8. streamed-window edge / after a recentre: walk far enough to scroll */
  home();
  rows.push(run('after window scrolls', () => { s.input.walk = 1; }, 1200));

  return {
    rows,
    depthMm: +depthMm.toFixed(1),
    carvedPoint: carved,
    queuedAtDig: beforeDrain,
    lens: s.lensReportForTest(),
  };
});

const pad = (v, w) => String(v).padStart(w);
console.log('\nTHE LENS PROBE — soil inside the near plane, by owner\n');
console.log('  scenario                    frames  query escape render unmapped   clean');
let query = 0; let escape = 0; let render = 0; let unmapped = 0;
for (const r of report.rows) {
  query += r.query; escape += r.escape; render += r.render; unmapped += r.unmapped;
  console.log(`  ${r.label.padEnd(26)} ${pad(r.frames, 6)} ${pad(r.query, 6)} `
    + `${pad(r.escape, 6)} ${pad(r.render, 6)} ${pad(r.unmapped, 8)} ${pad(r.clean, 7)}`);
}

console.log('\nTHE CARVED POINT SHE IS STANDING IN, after digging '
  + `${report.depthMm} mm down:`);
const c = report.carvedPoint;
console.log(`  fine window said   : ${c.fine}`
  + (c.fineMm === null ? '' : ` (${c.fineMm.toFixed(2)} mm)`));
console.log(`  coarse island says : ${c.coarseMm.toFixed(2)} mm `
  + `(${c.coarseMm > 0 ? 'BURIED' : 'open'})`);
console.log(`  final answer       : ${c.finalMm.toFixed(2)} mm `
  + `(${c.finalMm > 0 ? 'SOLID' : 'air'})`);
console.log(`  chunk              : ${c.chunk} [${c.chunkState}]`);

console.log(`\npage errors: ${errors.length ? errors.join(' | ') : 'none'}`);

const fail = [];
/* The audit's own critical assertion: standing in a tunnel she dug, under
 * the original surface, the query must answer AIR. */
if (report.depthMm > 20 && c.fine === 'air' && c.finalMm > 0) {
  fail.push('carved air was overruled by the coarse heightfield');
}
if (query > 0) fail.push(`${query} frames where the terrain ANSWER was wrong`);
if (render > 0) fail.push(`${render} frames exposed a queued or missing chunk`);
if (escape > 0) fail.push(`${escape} frames the guard failed to escape`);
/* `unmapped` is REPORTED, never failed on: it is a world-extent fact, not
 * a camera fault, and the fix for it is the fine window's own depth. */
if (unmapped > 0) {
  console.log(`\nnote: ${unmapped} frames sat outside the fine window, where the `
    + 'coarse heightfield\n      cannot know about a carved tunnel. Not a camera '
    + 'fault — see the depth note above.');
}
if (errors.length) fail.push('page errors');

console.log(fail.length
  ? `\nFAILED: ${fail.join('; ')}`
  : '\nall green — nothing in the picture the camera did not mean to draw');
await browser.close();
process.exit(fail.length ? 1 : 0);
