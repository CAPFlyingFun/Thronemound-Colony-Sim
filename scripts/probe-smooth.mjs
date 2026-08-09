/**
 * IS SHE ACTUALLY MOVING SMOOTHLY? — and how far into the ground is she?
 *
 * The average speed says almost nothing. An ant that covers 0.375 mm on one
 * frame and nothing on the next two averages a perfect walk and looks like
 * she is stuttering, and "sticky" is exactly what a player calls that. So
 * this reports the DISTRIBUTION of her per-frame displacement, on open soil
 * where nothing complicated is happening.
 *
 * Beside it, the sink: how far the lowest drawn point of each foot, and of
 * her gaster, sits below the surface it is standing on.
 *
 *   SMOKE_URL=http://127.0.0.1:4183/ node scripts/probe-smooth.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 90000 });
await page.waitForFunction(
  () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 90000 },
);
await page.waitForFunction(() => window.islandScene.tree?.solid != null, null, { timeout: 60000 });
await page.waitForTimeout(1200);

const run = (frames, sprint) => page.evaluate(([n, run_]) => {
  const s = window.islandScene;
  const q = s.queen;
  /* Somewhere flat and far from the landmark, so nothing else is in play. */
  const t = s.tree.root.position;
  s.teleportMm((t.x + 1600 / 5) * 5, t.z * 5);
  s.setFacingForTest(Math.PI / 2);
  s.input.walk = 0; s.stepForTest(1 / 60, 40);

  const steps = [];
  const sinks = [];
  const gasters = [];
  const slips = [];
  const anchors = new Map();
  const was = new Map();
  s.input.walk = 1; s.input.sprint = run_;
  const prev = { x: s.at.x, y: s.at.y, z: s.at.z };
  for (let f = 0; f < n; f += 1) {
    s.stepForTest(1 / 60, 1);
    steps.push(Math.hypot(s.at.x - prev.x, s.at.y - prev.y, s.at.z - prev.z) * 5);
    prev.x = s.at.x; prev.y = s.at.y; prev.z = s.at.z;

    q.root.updateMatrixWorld(true);
    /*
     * THE CLAW, AND THE SURFACE SHE IS ACTUALLY ON.
     *
     * Two corrections, and the first cut of this probe got both wrong. The
     * last bone in a leg chain is an auto-rig TERMINAL that carries no
     * geometry and sits above the claw — measuring it measures a marker
     * swinging on the ankle, not a foot. `limbTipName` is the last bone with
     * vertices on it, which is the thing a player sees touch the ground.
     *
     * And `walkGroundAt` is the COARSE island heightfield, which disagrees
     * with the fine streamed soil she is really standing on by millimetres
     * wherever the hill curves. The walker's own cast is the surface that
     * matters, because it is the one everything else is seated against.
     */
    for (const leg of q.rig.legs) {
      const name = q.limbTipName(leg.slot) ?? leg.bones[leg.bones.length - 1];
      const b = q.bones.get(name);
      if (!b) continue;
      const e = b.matrixWorld.elements;
      const from = new (Object.getPrototypeOf(s.at).constructor)(
        e[12] + s.up.x * 0.4, e[13] + s.up.y * 0.4, e[14] + s.up.z * 0.4,
      );
      const dir = new (Object.getPrototypeOf(s.at).constructor)(-s.up.x, -s.up.y, -s.up.z);
      const hit = s.walker.cast(from, dir, 1.6);
      if (hit) {
        const dx = e[12] - hit.x;
        const dy = e[13] - hit.y;
        const dz = e[14] - hit.z;
        /* Positive = below the surface, along her own up. */
        sinks.push(-(dx * s.up.x + dy * s.up.y + dz * s.up.z) * 5);
      }
      /* Slip: a PLANTED foot's drawn position must not move. */
      const a = s.drive?.anchorFor(leg.slot);
      if (a) {
        const key = `${a[0].toFixed(6)},${a[1].toFixed(6)},${a[2].toFixed(6)}`;
        const seen = anchors.get(leg.slot);
        const last = was.get(leg.slot);
        if (seen === key && last) {
          slips.push(Math.hypot(e[12] - last[0], e[13] - last[1], e[14] - last[2]) * 5);
        }
        anchors.set(leg.slot, key);
        was.set(leg.slot, [e[12], e[13], e[14]]);
      }
    }
    const g = new (Object.getPrototypeOf(s.at).constructor)();
    const rad = q.segmentShell ? q.segmentShell('gaster', g) : 0;
    if (rad) gasters.push((s.walkGroundAt(g.x, g.z) - (g.y - rad * 0.5)) * 5);
  }
  s.input.walk = 0; s.input.sprint = false;

  const stat = (a) => {
    if (a.length === 0) return null;
    const sorted = a.slice().sort((x, y) => x - y);
    const mean = a.reduce((p, c) => p + c, 0) / a.length;
    const sd = Math.sqrt(a.reduce((p, c) => p + (c - mean) ** 2, 0) / a.length);
    return {
      n: a.length,
      mean: +mean.toFixed(4),
      sd: +sd.toFixed(4),
      min: +sorted[0].toFixed(4),
      p50: +sorted[Math.floor(a.length * 0.5)].toFixed(4),
      p95: +sorted[Math.floor(a.length * 0.95)].toFixed(4),
      max: +sorted[a.length - 1].toFixed(4),
    };
  };
  return {
    step: stat(steps),
    stalled: steps.filter((v) => v < 1e-4).length,
    frames: n,
    sink: stat(sinks),
    gaster: stat(gasters),
    slip: stat(slips),
  };
}, [frames, sprint]);

for (const [tag, sprint] of [['WALK', false], ['RUN', true]]) {
  const r = await run(600, sprint);
  const want = sprint ? 14.9 / 60 : 7.5 / 60;
  console.log(`\n${tag} ON OPEN SOIL — 600 frames`);
  console.log(`  per-frame travel, mm   mean ${r.step.mean}  (a steady walk would be `
    + `${want.toFixed(4)})`);
  console.log(`                         sd ${r.step.sd}  min ${r.step.min}  `
    + `median ${r.step.p50}  p95 ${r.step.p95}  max ${r.step.max}`);
  console.log(`  frames that moved nothing at all: ${r.stalled}/${r.frames}`);
  console.log(`  foot below the surface, mm   mean ${r.sink.mean}  median ${r.sink.p50}  `
    + `p95 ${r.sink.p95}  worst ${r.sink.max}`);
  console.log(`  gaster below the surface, mm mean ${r.gaster?.mean}  worst ${r.gaster?.max}`);
  console.log(`  planted-foot slip per frame, mm  median ${r.slip?.p50}  `
    + `p95 ${r.slip?.p95}  worst ${r.slip?.max}`);
}

console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
