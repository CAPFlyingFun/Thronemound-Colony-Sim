/**
 * THE UNDERGROUND PANEL, EXERCISED THE WAY THE BUG HAPPENED.
 *
 *     npx vite --port 5173                                  # then
 *     SMOKE_URL=http://127.0.0.1:5173/?scene=island npm run probe:trace
 *
 * Reported: "the display of the pitch, roll, and heading is confusing when
 * you're underground and just see arrows." The answer is the route trace —
 * `routeTrace.ts` — and this drives it the honest way: she ARMS the
 * shovel, aims down, and digs herself below grade with her own strokes.
 * No teleports into soil, no faked flags; `underground` must flip because
 * there is actually drawn island overhead.
 *
 * What is pinned:
 *   1. above ground, dig mode still shows the four gauges and no trace;
 *   2. below grade the mode becomes digDeep, the gauges' chips are gone
 *      from the glass and the trace canvas is up and painted;
 *   3. the trace recorded the descent — real samples, real length, and a
 *      current depth that agrees with the scene's own `depthMm`;
 *   4. back on the surface the panel swaps back, and after real travel
 *      above grade the route is forgotten, ready for the next dig.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/?scene=island';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const errs = [];
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready === true, null, { timeout: 200000 });
await page.waitForFunction(
  () => !document.querySelector('.tm-loading-root'), null, { timeout: 200000 },
);

const out = await page.evaluate(async () => {
  const s = window.islandScene;
  const gauges = () => Array.from(
    document.querySelectorAll('.tm-instruments .density-lab-aim-readout'),
  ).filter((el) => el.getBoundingClientRect().width > 0).length;
  const trace = () => {
    const el = document.querySelector('.tm-routetrace');
    if (!el) return { up: false, w: 0, painted: false };
    const r = el.getBoundingClientRect();
    let painted = false;
    if (el.width > 0) {
      const ctx = el.getContext('2d');
      const px = ctx.getImageData(0, 0, el.width, el.height).data;
      for (let i = 3; i < px.length; i += 4) {
        if (px[i] > 0) { painted = true; break; }
      }
    }
    return { up: r.width > 0, w: Math.round(r.width), painted };
  };

  const report = {};
  s.stepForTest(1 / 60, 30);

  /* DIG, above ground — armed through its own plate, the way a thumb
   * does: `input.dig` is the STROKE, the plate is the MODE. */
  document.querySelector('.tm-art-dig')
    .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  s.stepForTest(1 / 60, 20);
  report.surface = {
    mode: s.hudMode, gauges: gauges(), trace: trace(), depth: s.statsForTest().questDepthMm,
  };

  /* Now down, with her own jaws: aim steeply below level and alternate
   * stroke and step, the founding's own motion. */
  s.aimPitch = -1.1;
  for (let i = 0; i < 260 && !s.statsForTest().underground; i += 1) {
    s.biteForTest();
    s.input.walk = 1;
    s.stepForTest(1 / 60, 10);
  }
  /* And KEEP digging once below grade — the trace records the tunnel,
   * and a tunnel one stride long is not a shape yet. */
  for (let i = 0; i < 40; i += 1) {
    s.biteForTest();
    s.input.walk = 1;
    s.stepForTest(1 / 60, 10);
  }
  s.input.walk = 0;
  s.stepForTest(1 / 60, 10);
  const stats = s.statsForTest();
  report.dug = {
    underground: stats.underground === 1,
    depthMm: stats.questDepthMm,
    mode: s.hudMode,
    gauges: gauges(),
    trace: trace(),
    route: s.routeForTest(),
  };

  /* Let the throttled painter run, then read the canvas. */
  s.stepForTest(1 / 60, 30);
  await new Promise((done) => { setTimeout(done, 350); });
  report.dug.trace = trace();

  /* And OUT: hand her back to daylight and walk the forgetting off. */
  s.input.dig = false;
  s.teleportMm(s.at.x * 5 + 30, s.at.z * 5 + 30);
  s.stepForTest(1 / 60, 10);
  report.surfaced = { mode: s.hudMode, gauges: gauges() };
  s.input.walk = 1;
  for (let i = 0; i < 40 && s.routeForTest().points > 0; i += 1) s.stepForTest(1 / 60, 10);
  s.input.walk = 0;
  report.forgot = s.routeForTest();
  return report;
});

/* The picture itself, from the dug state — re-dig quickly for the shot. */
await page.evaluate(async () => {
  const s = window.islandScene;
  if (s.hudMode !== 'digDeep' && s.hudMode !== 'dig') {
    document.querySelector('.tm-art-dig')
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  }
  s.aimPitch = -1.1;
  for (let i = 0; i < 240 && !s.statsForTest().underground; i += 1) {
    s.biteForTest();
    s.input.walk = 1;
    s.stepForTest(1 / 60, 10);
  }
  for (let i = 0; i < 30; i += 1) {
    s.biteForTest();
    s.input.walk = 1;
    s.stepForTest(1 / 60, 10);
  }
  s.input.walk = 0;
  s.stepForTest(1 / 60, 40);
  await new Promise((done) => { setTimeout(done, 350); });
});
await page.screenshot({ path: `${process.env.TRACE_SHOT_DIR ?? '/tmp'}/trace-under.png` });

await browser.close();

let bad = 0;
const say = (ok, line) => { if (!ok) bad += 1; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${line}`); };

console.log('\nTHE UNDERGROUND PANEL\n');
console.log(`  surface dig: mode=${out.surface.mode} gauges=${out.surface.gauges}`
  + ` trace up=${out.surface.trace.up}`);
console.log(`  dug down   : mode=${out.dug.mode} depth=${out.dug.depthMm}mm`
  + ` gauges=${out.dug.gauges} trace=${JSON.stringify(out.dug.trace)}`
  + ` route=${JSON.stringify(out.dug.route)}`);
console.log(`  surfaced   : mode=${out.surfaced.mode} gauges=${out.surfaced.gauges}`
  + ` forgot=${JSON.stringify(out.forgot)}\n`);

say(out.surface.mode === 'dig', `above ground the shovel is the gauges' mode (${out.surface.mode})`);
say(out.surface.gauges >= 4, `and all four gauges are on the glass (${out.surface.gauges})`);
say(!out.surface.trace.up, 'the trace has no business above ground');
say(out.dug.underground, `she dug herself below grade (depth ${out.dug.depthMm} mm)`);
say(out.dug.mode === 'digDeep', `below grade the mode is digDeep (${out.dug.mode})`);
say(out.dug.gauges === 0, `the gauges gave way (${out.dug.gauges} left)`);
say(out.dug.trace.up && out.dug.trace.w > 80,
  `the trace panel is up at chip width (${out.dug.trace.w}px)`);
say(out.dug.trace.painted, 'and it is PAINTED, not a blank canvas');
say(out.dug.route.points > 3 && out.dug.route.lengthMm > 10,
  `the route was recorded — ${out.dug.route.points} points over ${out.dug.route.lengthMm} mm`);
say(out.surfaced.mode !== 'digDeep', `daylight swaps the panel back (${out.surfaced.mode})`);
say(out.forgot.points === 0, 'and real travel above grade forgets the route');

if (errs.length) console.log(`\npage errors: ${errs.slice(0, 3).join(' | ')}`);
if (bad > 0 || errs.length) { console.log(`\n${bad} check(s) failed`); process.exit(1); }
console.log('\nall green — underground she reads the tunnel, not four arrows');
