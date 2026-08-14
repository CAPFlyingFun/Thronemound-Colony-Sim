/**
 * DOES THE VIEW SHAKE WHEN SHE POINTS DOWN?
 *
 * `probe:eyeshake` asks whether WALKING shakes the lens, which is a
 * different question and passed clean through two separate versions of this
 * bug. The reports were both about AIM: "the camera when pointing down did
 * shaking really bad again", and then "it's more obvious while in digging
 * mode". So this sweeps the aim from level to nearly straight down and asks
 * the same question at every angle, in the mode the report named.
 *
 * THE NUMBER IS NOT HOW FAR THE VIEW MOVES. The view is allowed to move —
 * walking her forward carries the lens 0.13 mm a frame and that is the game
 * working. A shake is the lens changing its MIND: consecutive movement
 * vectors pointing opposite ways. So the signal is the REVERSAL fraction,
 * and the mean movement is reported beside it only for scale.
 *
 * WHAT IT CAUGHT. Standing perfectly still, aimed 70 degrees down in a dig,
 * her head pitch alternated -35 / -70 / -35 / -70 degrees on strictly
 * alternating frames — because `clampedHeadPitch` probed for soil FROM her
 * posed head, so the answer moved the head and the moved head changed the
 * answer. In first person the lens rides that head. Reversals ran at 100%
 * from -55 degrees down; they run at 0% now.
 *
 * Two versions of this fix have been shipped before (the eye's retreat, in
 * fifths and then bisected) without the symptom going away, because both
 * were downstream of the actual oscillator. Hence a permanent probe.
 */
import { chromium } from 'playwright';

const DEG = 180 / Math.PI;
/* Below this and it is noise in the last bit of a float; a real two-frame
 * flip runs at 100%, so there is no judgement call in the middle. */
const SHAKE = 0.25;

const b = await chromium.launch({
  executablePath: process.env.CHROME
    ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const p = await b.newPage({ viewport: { width: 932, height: 430 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/?scene=island',
  { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.islandScene?.ready === true, null,
  { timeout: 180000 });
await p.waitForFunction(() => !document.querySelector('.tm-loading-root'), null,
  { timeout: 180000 });
await p.waitForTimeout(700);

const sweep = async (dig, first, walk) => p.evaluate(({ dig, first, walk }) => {
  const s = window.islandScene;
  const D = 180 / Math.PI;
  s.digMode = dig;
  s.firstPerson = first;
  const rows = [];
  for (let deg = 0; deg >= -85; deg -= 5) {
    /* `aimPitchForTest`, not `aimPitch`. The latter is DERIVED from the look
     * every frame, so writing it alone lasts until the next camera update —
     * which is why the first cut of this reported a flat zero everywhere. */
    s.aimPitchForTest(deg / D);
    s.input.walk = walk;
    /* Settle, so this measures the STEADY state at each angle rather than
     * the transient of having just arrived at it. */
    s.stepForTest(1 / 60, 40);
    const pos = [];
    for (let i = 0; i < 45; i += 1) {
      s.stepForTest(1 / 60, 1);
      const c = s.camera.position;
      pos.push({ x: c.x, y: c.y, z: c.z });
    }
    let flips = 0;
    let pairs = 0;
    let move = 0;
    for (let i = 2; i < pos.length; i += 1) {
      const a = {
        x: pos[i - 1].x - pos[i - 2].x,
        y: pos[i - 1].y - pos[i - 2].y,
        z: pos[i - 1].z - pos[i - 2].z,
      };
      const c = {
        x: pos[i].x - pos[i - 1].x,
        y: pos[i].y - pos[i - 1].y,
        z: pos[i].z - pos[i - 1].z,
      };
      const la = Math.hypot(a.x, a.y, a.z);
      const lc = Math.hypot(c.x, c.y, c.z);
      move += lc * 5;
      if (la < 1e-7 || lc < 1e-7) continue;
      pairs += 1;
      if ((a.x * c.x + a.y * c.y + a.z * c.z) / (la * lc) < -0.2) flips += 1;
    }
    const h = s.headPitchForTest();
    rows.push({
      deg,
      move: move / (pos.length - 2),
      flip: pairs ? flips / pairs : 0,
      neck: h.neck * D,
    });
  }
  s.input.walk = 0;
  return rows;
}, { dig, first, walk });

const CASES = [
  { name: 'DIG, first person, standing', dig: true, first: true, walk: 0 },
  { name: 'DIG, first person, walking', dig: true, first: true, walk: 1 },
  { name: 'walk mode, first person', dig: false, first: true, walk: 0 },
  { name: 'DIG, third person', dig: true, first: false, walk: 0 },
];

console.log('\nTHE AIM-SHAKE PROBE — does pointing down make the view buzz?\n');
let bad = 0;
for (const c of CASES) {
  const rows = await sweep(c.dig, c.first, c.walk);
  const worst = rows.reduce((a, r) => (r.flip > a.flip ? r : a), rows[0]);
  const shaking = rows.filter((r) => r.flip > SHAKE);
  bad += shaking.length;
  console.log(`  ${c.name.padEnd(30)} worst ${(worst.flip * 100).toFixed(0)
    .padStart(3)}% reversals at ${String(worst.deg).padStart(4)}deg`
    + `  (${shaking.length} of ${rows.length} angles shaking)`);
  for (const r of shaking) {
    console.log(`      ${String(r.deg).padStart(4)}deg  `
      + `${(r.flip * 100).toFixed(0).padStart(3)}% reversals  `
      + `${r.move.toFixed(3)}mm/frame  neck ${r.neck.toFixed(1)}deg`);
  }
}

console.log(`\npage errors: ${errs.length ? errs.slice(0, 2).join(' | ') : 'none'}`);
await b.close();
if (bad || errs.length) {
  console.log(`\nFAILED: ${bad} aim angles shaking, ${errs.length} page errors`);
  process.exit(1);
}
console.log('\nOK: no angle in any mode reverses the lens frame to frame.');
