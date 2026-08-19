/**
 * CAN SHE WALK DOWN HER OWN TUNNEL?
 *
 *     npx vite --port 5173                                  # then
 *     SMOKE_URL=http://127.0.0.1:5173/?scene=island npm run probe:tube
 *
 * Reported from the device: "the Queen seems to get stuck with digging and
 * doesn't like to walk seamlessly underground like above ground and maybe
 * because it doesn't know what to grab to, but should be obvious in a small
 * tube."
 *
 * That last clause is the diagnosis, and it is right. Underground the island
 * has no rail: she is a free `SurfaceWalker` gripping whatever the soil's
 * gradient offers, and the inside of a tube offers a full circle of equally
 * good answers. So she rolls around the bore, and the measurement below is
 * of her doing exactly that — `upY` going NEGATIVE is her walking on the
 * ceiling, upside down, back the way she came.
 *
 * WHY THE TEST BED IS A STAMPED COLONY rather than a freshly dug hole: the
 * shape of a dug tunnel depends on how well she dug it, which is the thing
 * under test. `colonyNest`'s tunnels are known, straight, and the same every
 * run, so a failure here is about WALKING and nothing else.
 *
 * The bar is deliberately loose. This does not ask for a tidy walk — it asks
 * that holding forward in a straight 4 mm bore takes her toward the far end
 * and keeps her feet on the floor. Today it does neither.
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
  await s.stampColonyForTest(s.at.x * MM, s.at.z * MM);
  s.drainQueueForTest();
  for (let i = 0; i < 60; i += 1) await new Promise((r) => requestAnimationFrame(r));

  const c = s.stampedColonyForTest();
  const nursery = c.rooms.find((r) => r.id === 'nursery').centreMm;
  const landing = s.planForTest().find((n) => n.id === 'landing');

  /* Out of the nursery, up the brood-run, to the landing. Pointed by hand
   * because this is a walking test, not a pathfinding one. */
  s.setFacingForTest(Math.atan2(landing.x - nursery.x, landing.z - nursery.z));
  const start = { x: s.at.x * MM, y: s.at.y * MM, z: s.at.z * MM };
  const reach = Math.hypot(landing.x - start.x, landing.y - start.y, landing.z - start.z);

  s.input.walk = 1;
  const DT = 0.02;
  const STEPS = 900;               // 18 simulated seconds — plenty for 25 mm
  const trail = [];
  let closest = reach;
  let onCeiling = 0;
  let offFloor = 0;
  let stalled = 0;
  let last = { ...start };
  for (let i = 0; i < STEPS; i += 1) {
    s.stepForTest(DT, 1);
    const p = { x: s.at.x * MM, y: s.at.y * MM, z: s.at.z * MM };
    const upY = s.biteProbeForTest().upY;
    if (upY < 0) onCeiling += 1;
    if (upY < 0.5) offFloor += 1;
    const d = Math.hypot(p.x - landing.x, p.y - landing.y, p.z - landing.z);
    closest = Math.min(closest, d);
    if (Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z) < 0.002) stalled += 1;
    last = p;
    if (i % 90 === 0) {
      trail.push({ t: +(i * DT).toFixed(1), toEnd: +d.toFixed(1), upY: +upY.toFixed(2) });
    }
  }
  s.input.walk = 0;
  const end = { x: s.at.x * MM, y: s.at.y * MM, z: s.at.z * MM };
  return {
    reachMm: +reach.toFixed(1),
    closestMm: +closest.toFixed(1),
    endMm: +Math.hypot(end.x - landing.x, end.y - landing.y, end.z - landing.z).toFixed(1),
    onCeiling, offFloor, stalled, steps: STEPS, trail,
  };
});

const checks = [];
const say = (name, ok, detail) => {
  checks.push(ok);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log('\nWALKING A TUNNEL SHE DID NOT DIG\n');
console.log('    t     to end   upY');
for (const r of out.trail) {
  console.log(`  ${String(r.t).padStart(5)}   ${String(r.toEnd).padStart(6)}   ${r.upY}`);
}
console.log('  (upY is her own UP against the world\'s. Below zero is upside down.)\n');

say('she gets down the tunnel at all', out.closestMm < out.reachMm * 0.4,
  `closed to ${out.closestMm} mm of ${out.reachMm}`);
say('and she is still there at the end of it', out.endMm < out.reachMm * 0.5,
  `finished ${out.endMm} mm away`);
/* The two that name the actual fault. A bore is round, so some roll is
 * honest; hanging from the roof of it is not. */
say('she never ends up on the ceiling', out.onCeiling === 0,
  `${out.onCeiling}/${out.steps} frames upside down`);
say('and her feet stay under her', out.offFloor < out.steps * 0.15,
  `${out.offFloor}/${out.steps} frames past 60° of roll`);
say('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

const passed = checks.filter(Boolean).length;
const ok = passed === checks.length;
console.log(`\n  ${ok ? 'PASS' : 'FAIL'} — ${passed}/${checks.length}\n`);
await browser.close();
process.exit(ok ? 0 : 1);
