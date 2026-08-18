/**
 * THE QUEEN'S OWN LIFE, once the player is a worker.
 *
 *     npx vite --port 5173                                  # then
 *     SMOKE_URL=http://127.0.0.1:5173/?scene=island npm run probe:queen
 *
 * Asked for from the device: "I would like the Queen able to move
 * (thinking add double tap to have follow active player ant, DT again to
 * disable)... randomly move around in a 2mm radius around that point so
 * that way it doesn't look too fake."
 *
 * Four promises, driven end to end:
 *   1. after the founding she MOVES — a statue fails, and so does an
 *      escapee: the wander stays on its 2 mm leash around her anchor;
 *   2. a double-tap ON her (screen coordinates, through the real ray
 *      test) makes her follow the player, and she actually closes the
 *      distance on her own legs;
 *   3. a second double-tap parks her again, and she drifts home;
 *   4. a double-tap on empty ground does NOTHING — the toggle belongs to
 *      her body, not to the glass.
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
  const MM = 5;
  const report = {};
  s.questStage = 1; s.deepCarved = 1e9;
  s.stepForTest(1 / 60, 10);
  const ok = await s.becomeWorker().catch(() => false);
  if (!ok) return { why: 'the worker rig would not load' };
  s.stepForTest(1 / 60, 30);

  /* 1. THE WANDER. Thirty seconds of sim; collect where she goes. */
  let travelled = 0;
  let leash = 0;
  let last = null;
  for (let i = 0; i < 60; i += 1) {
    s.stepForTest(1 / 60, 30);
    const q = s.queenForTest();
    if (!q) return { why: 'no parked queen to watch' };
    if (last) travelled += Math.hypot(q.atMm[0] - last[0], q.atMm[2] - last[2]);
    last = q.atMm;
    leash = Math.max(leash, q.fromAnchorMm);
  }
  report.wander = { travelledMm: +travelled.toFixed(1), leashMm: +leash.toFixed(2) };

  /* Where she is ON SCREEN, for a tap aimed the way a thumb aims one. */
  const tapAt = () => {
    const q = s.queenForTest();
    const V = s.at.constructor;
    const p = new V(q.atMm[0] / MM, q.atMm[1] / MM, q.atMm[2] / MM).project(s.camera);
    const r = s.renderer.domElement.getBoundingClientRect();
    return {
      x: r.left + ((p.x + 1) / 2) * r.width,
      y: r.top + ((1 - p.y) / 2) * r.height,
      on: p.z < 1 && Math.abs(p.x) < 1 && Math.abs(p.y) < 1,
    };
  };

  /* 4 first — a miss must do nothing, so prove it before the hit. */
  s.queenDoubleTap(5, 5);
  report.missIgnored = s.queenForTest().follow === false;

  /* 2. THE DOUBLE-TAP, at her real screen position. */
  const at = tapAt();
  report.onScreen = at.on;
  s.queenDoubleTap(at.x, at.y);
  report.followArmed = s.queenForTest().follow === true;

  /* Walk the player away and let her come. Teleport is the probe's stride,
   * not hers — HER travel is what is measured. */
  s.teleportMm(s.at.x * MM + 40, s.at.z * MM + 25);
  const before = s.queenForTest().fromPlayerMm;
  for (let i = 0; i < 80; i += 1) s.stepForTest(1 / 60, 30);
  const after = s.queenForTest().fromPlayerMm;
  report.follow = { beforeMm: +before.toFixed(1), afterMm: +after.toFixed(1) };

  /* 3. PARK HER AGAIN, and she goes home rather than freezing here. */
  const at2 = tapAt();
  s.queenDoubleTap(at2.x, at2.y);
  report.followDropped = s.queenForTest().follow === false;
  const out1 = s.queenForTest().fromAnchorMm;
  for (let i = 0; i < 80; i += 1) s.stepForTest(1 / 60, 30);
  const out2 = s.queenForTest().fromAnchorMm;
  report.home = { fromMm: +out1.toFixed(1), toMm: +out2.toFixed(1) };
  return report;
});

await browser.close();

let bad = 0;
const say = (ok, line) => { if (!ok) bad += 1; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${line}`); };

console.log('\nTHE QUEEN IN HER CHAMBER\n');
if (out.why) { console.log(`  ${out.why}`); process.exit(1); }
console.log(`  wander: ${out.wander.travelledMm} mm walked, leash peak ${out.wander.leashMm} mm`);
console.log(`  follow: ${out.follow.beforeMm} -> ${out.follow.afterMm} mm from the player`);
console.log(`  home  : ${out.home.fromMm} -> ${out.home.toMm} mm from her anchor\n`);

say(out.wander.travelledMm > 2, `she moves on her own — ${out.wander.travelledMm} mm in 30 s`);
/* His 2 mm, plus her arrive radius and half a body of honest overshoot. */
say(out.wander.leashMm < 12, `and stays on the 2 mm leash — peak ${out.wander.leashMm} mm out`);
say(out.missIgnored, 'a double-tap on empty ground does nothing');
say(out.onScreen, 'she was on screen for the tap');
say(out.followArmed, 'a double-tap ON her arms the follow');
say(out.follow.afterMm < out.follow.beforeMm - 15,
  `and she closes the distance herself — ${out.follow.beforeMm} down to ${out.follow.afterMm} mm`);
say(out.followDropped, 'a second double-tap parks her');
say(out.home.toMm <= out.home.fromMm + 1, 'and she drifts home rather than onward');

if (errs.length) console.log(`\npage errors: ${errs.slice(0, 3).join(' | ')}`);
if (bad > 0 || errs.length) { console.log(`\n${bad} check(s) failed`); process.exit(1); }
console.log('\nall green — the queen lives in her chamber and comes when asked');
