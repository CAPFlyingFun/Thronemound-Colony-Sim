/**
 * CAN SHE GET OUT OF A HOLE SHE DUG?
 *
 * Reported as: after digging, the feet stick to random surfaces instead of
 * staying under her. The telemetry showed the real shape of it — twenty-five
 * unbroken seconds of `acquireFront` and `recover` with the stick held down
 * and `act` at 0.0, and `turn` frozen at about 55 degrees. She was trying to
 * corner onto the wall of her own pit and never finishing.
 *
 * Reproduced here: walk, dig a pit at -57 degrees, then hold forward and try
 * to leave. Before the fix, 898 of 900 frames were spent in `acquireFront`
 * and she moved 3.5 mm. The corner scheduler had a stall guard for exactly
 * this and it could never fire, for two reasons this probe now pins.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/probe-pit.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 120000 });
await page.waitForFunction(
  () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 120000 },
);
await page.waitForTimeout(1200);

const out = await page.evaluate(() => {
  const s = window.islandScene;
  s.setPausedForTest(true);
  const MM = 5;

  s.input.walk = 1;
  s.stepForTest(0.023, 100);
  s.input.walk = 0;
  s.aimPitchForTest(-1.0);
  s.input.dig = true;
  s.stepForTest(0.023, 130);
  s.input.dig = false;

  /* Hands off: nothing may drag her around her own pit. */
  let idleMoved = 0;
  let prev = { x: s.at.x, y: s.at.y, z: s.at.z };
  for (let i = 0; i < 300; i += 1) {
    s.stepForTest(0.023, 1);
    idleMoved += Math.hypot(s.at.x - prev.x, s.at.y - prev.y, s.at.z - prev.z) * MM;
    prev = { x: s.at.x, y: s.at.y, z: s.at.z };
  }

  /* Now hold forward and try to leave. */
  const phases = {};
  let stuck = 0;
  const startDepth = (s.groundHeightAt(s.at.x, s.at.z) - s.at.y) * MM;
  s.input.walk = 1;
  for (let i = 0; i < 900; i += 1) {
    const bx = s.at.x;
    const bz = s.at.z;
    s.stepForTest(0.023, 1);
    const ph = s.driveReport?.corner.phase ?? '?';
    phases[ph] = (phases[ph] ?? 0) + 1;
    if (Math.hypot(s.at.x - bx, s.at.z - bz) * MM < 0.02) stuck += 1;
  }
  s.input.walk = 0;
  return {
    idleMoved: +idleMoved.toFixed(2),
    phases, stuck,
    startDepth: +startDepth.toFixed(1),
    endDepth: +((s.groundHeightAt(s.at.x, s.at.z) - s.at.y) * MM).toFixed(1),
  };
});

const total = Object.values(out.phases).reduce((a, v) => a + v, 0);
const cornering = total - (out.phases.normal ?? 0);
console.log(`idle drift after digging : ${out.idleMoved} mm over 300 frames`);
console.log(`phases while leaving     : ${JSON.stringify(out.phases)}`);
console.log(`frames going nowhere     : ${out.stuck} of 900`);
console.log(`depth below surface      : ${out.startDepth} mm -> ${out.endDepth} mm`);

const fail = [];
/* Nothing may move her while the stick is down and the shovel is idle. */
if (out.idleMoved > 3) fail.push(`she drifted ${out.idleMoved} mm with no input`);
/*
 * The corner scheduler may try — a pit wall IS a corner — but it must not
 * OWN her. Before the fix it held 898 of 900 frames; the ordinary gait,
 * whose walker can wrap onto a wall unaided, never got a turn.
 */
if (cornering > total * 0.5) {
  fail.push(`corner scheduler held ${cornering}/${total} frames — it is livelocked`);
}
if (out.stuck > 450) fail.push(`${out.stuck} of 900 frames made no progress`);
/* And the point of all of it: she is shallower than she started. */
if (out.endDepth >= out.startDepth) {
  fail.push(`no shallower than she started (${out.startDepth} -> ${out.endDepth} mm)`);
}

console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
if (fail.length) {
  console.log(`\nFAILED: ${fail.join('; ')}`);
  process.exit(1);
}
console.log('\nall green — she climbs out of her own pit');
