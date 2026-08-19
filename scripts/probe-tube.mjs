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
  const nodes = s.planForTest();
  const landing = nodes.find((n) => n.id === 'landing');
  /*
   * LEG TWO IS THE ROYAL RUN, not the descent, and the reason is worth
   * writing down: the descent is PLUMB. Sending her up it would test
   * chimney-climbing — a genuinely different and harder problem, with no
   * floor in it to prefer — and a probe that fails for two unrelated
   * reasons at once diagnoses neither. The royal run is sloped, so what it
   * tests is purely getting THROUGH a junction and into the next bore.
   *
   * Vertical shafts are therefore NOT covered here. That is a gap, stated
   * rather than hidden, and it wants its own probe.
   */
  const throne = nodes.find((n) => n.id === 'throne');

  /* Out of the nursery, up the brood-run, to the landing. Pointed by hand
   * because this is a walking test, not a pathfinding one. */
  s.setFacingForTest(Math.atan2(landing.x - nursery.x, landing.z - nursery.z));
  const start = { x: s.at.x * MM, y: s.at.y * MM, z: s.at.z * MM };
  const reach = Math.hypot(landing.x - start.x, landing.y - start.y, landing.z - start.z);

  /*
   * SHE TURNS AT THE JUNCTION AND KEEPS GOING — a two-leg journey, because
   * one leg does not test the thing that breaks.
   *
   * A first cut held the stick down for eighteen seconds and counted every
   * frame. That scored badly for the wrong reason: an ant shoved into the
   * far wall of a dead end scrabbles, and counting that as "rolling" blames
   * the walk for what the test was doing to her.
   *
   * The second cut stopped the clock on arrival — and stopped it right
   * before the interesting part. Verified by reverting the fix and
   * re-running: the UNFIXED build also scored 0 frames inverted over the
   * approach, because she does not roll on the way in. She rolls once she
   * reaches the junction, where three bores meet and the soil's gradient
   * has three equally good opinions about which way is up.
   *
   * So the journey goes THROUGH: down the brood-run to the landing, then
   * turn and climb the descent toward the hall. That is what a player does,
   * it keeps the whole trip in the score, and the junction — the place it
   * actually fails — sits in the middle of it rather than at the end.
   */
  /* A junction is a point; a chamber is a ROOM. Arriving at the throne
   * means being IN it, not standing on its centre spot — it is thirty
   * millimetres across, so a flat six-millimetre bullseye would score her
   * as short while she stood inside the doorway. */
  const ARRIVED_MM = 6;
  const inRoomMm = (throne.radiusMm ?? 11);
  s.input.walk = 1;
  const DT = 0.02;
  const STEPS = 900;               // 18 simulated seconds — plenty for 25 mm
  const trail = [];
  let closest = reach;
  let onCeiling = 0;
  let offFloor = 0;
  let stalled = 0;
  let travelFrames = 0;
  let arrived = false;
  let last = { ...start };
  let goal = landing;
  let leg = 1;
  let reachedLanding = false;
  for (let i = 0; i < STEPS; i += 1) {
    s.stepForTest(DT, 1);
    const p = { x: s.at.x * MM, y: s.at.y * MM, z: s.at.z * MM };
    const upY = s.biteProbeForTest().upY;
    const d = Math.hypot(p.x - goal.x, p.y - goal.y, p.z - goal.z);
    if (leg === 2 && d < inRoomMm) arrived = true;
    if (d < ARRIVED_MM) {
      if (leg === 1) {
        /* Through the junction and up the next bore, steered by hand —
         * this is a walking test, not a pathfinding one. */
        reachedLanding = true;
        leg = 2;
        goal = throne;
        s.setFacingForTest(Math.atan2(throne.x - p.x, throne.z - p.z));
      }
    }
    travelFrames += 1;
    if (upY < 0) onCeiling += 1;
    if (upY < 0.5) offFloor += 1;
    if (Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z) < 0.002) stalled += 1;
    closest = Math.min(closest, d);
    last = p;
    if (i % 90 === 0) {
      trail.push({
        t: +(i * DT).toFixed(1), toEnd: +d.toFixed(1), upY: +upY.toFixed(2),
        here: `leg ${leg}`,
      });
    }
    if (arrived) break;
  }
  s.input.walk = 0;
  const end = { x: s.at.x * MM, y: s.at.y * MM, z: s.at.z * MM };
  return {
    reachMm: +reach.toFixed(1),
    closestMm: +closest.toFixed(1),
    endMm: +Math.hypot(end.x - goal.x, end.y - goal.y, end.z - goal.z).toFixed(1),
    onCeiling, offFloor, stalled, steps: STEPS, travelFrames, arrived,
    reachedLanding, trail,
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
  console.log(`  ${String(r.t).padStart(5)}   ${String(r.toEnd).padStart(6)}   `
    + `${String(r.upY).padEnd(6)} ${r.here}`);
}
console.log('  (upY is her own UP against the world\'s. Below zero is upside down.)\n');

say('she reaches the junction', out.reachedLanding);
say('and gets THROUGH it into the next bore', out.arrived,
  out.arrived ? `${out.travelFrames} frames` : `gave up ${out.endMm} mm short`);
/* The two that name the actual fault. A bore is round, so some roll is
 * honest; hanging from the roof of it is not. */
say('she never ends up on the ceiling', out.onCeiling === 0,
  `${out.onCeiling}/${out.travelFrames} frames upside down`);
say('and her feet stay under her', out.offFloor < Math.max(1, out.travelFrames) * 0.15,
  `${out.offFloor}/${out.travelFrames} frames past 60° of roll`);
say('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

const passed = checks.filter(Boolean).length;
const ok = passed === checks.length;
console.log(`\n  ${ok ? 'PASS' : 'FAIL'} — ${passed}/${checks.length}\n`);
await browser.close();
process.exit(ok ? 0 : 1);
