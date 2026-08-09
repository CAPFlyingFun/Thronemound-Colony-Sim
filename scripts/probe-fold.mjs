/**
 * WHAT DO THE THREE PITCHES ACTUALLY DO TO HER BACK?
 *
 * `posture` returns three numbers and `QueenModel.aimHead` turns them into
 * bone rotations through a local/absolute conversion. Whether "head 30,
 * thorax 30, gaster 30" comes out as ninety degrees of fold nose to tail is
 * a question about that conversion and about the rig it drives, and the only
 * honest way to answer it is to set the pitches and MEASURE the bones.
 *
 * Reports, for each trial, the world-space angle between the direction her
 * head section points and the direction her gaster section points — which is
 * the fold a player sees.
 *
 *   SMOKE_URL=http://127.0.0.1:4181/ node scripts/probe-fold.mjs
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
await page.waitForTimeout(1200);

const measure = (h, t, g) => page.evaluate(([hd, th, ga]) => {
  const s = window.islandScene;
  const q = s.queen;
  const rig = q.rig;
  const rad = (d) => (d * Math.PI) / 180;
  /* Freeze the train on the asked-for pose, then let one frame draw it. */
  s.spine.set({ head: rad(hd), thorax: rad(th), gaster: rad(ga) });
  s.stepForTest(1 / 60, 1);
  s.spine.set({ head: rad(hd), thorax: rad(th), gaster: rad(ga) });
  s.stepForTest(1 / 60, 1);
  q.root.updateMatrixWorld(true);

  /*
   * MEASURED OFF POINTS THAT ACTUALLY TRAVEL. Rotating a bone turns its
   * children about its own joint and leaves its own origin exactly where it
   * was — so an angle taken between bone ORIGINS barely moves, which is why
   * the first cut of this probe reported less fold for 30/14/22 than for a
   * completely straight body.
   *
   * Her eye is carried by the head bone; the last gaster bone is carried by
   * the first. Both move when the pitches move, which is the whole point.
   */
  const hubName = rig.body[rig.body.length - 1];
  const pos = (name) => {
    const b = q.bones.get(name);
    if (!b) return null;
    const e = b.matrixWorld.elements;
    return [e[12], e[13], e[14]];
  };
  const eye = new (Object.getPrototypeOf(s.at).constructor)();
  const gotEye = q.eyeWorldPosition(eye);
  const nose = gotEye ? [eye.x, eye.y, eye.z] : pos(rig.mouth?.[0] ?? rig.thorax[rig.thorax.length - 1]);
  const tail = pos(rig.gaster[rig.gaster.length - 1]);
  const hub = pos(hubName);
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const toHead = norm(sub(nose, hub));
  const toTail = norm(sub(tail, hub));
  const between = Math.acos(Math.max(-1, Math.min(1, dot(toHead, toTail))));
  return {
    foldDeg: +(180 - (between * 180) / Math.PI).toFixed(1),
    noseMm: nose.map((v) => +(v * 5).toFixed(2)),
    tailMm: tail.map((v) => +(v * 5).toFixed(2)),
  };
}, [h, t, g]);

console.log('\nPITCHES IN, FOLD OUT — measured off the bones, not the convention');
console.log('  "fold" is how far her nose-to-tail line bends away from straight.\n');
console.log('   head thorax gaster |  fold');
/*
 * STAGGERED, because equal values are not a bend. `aimHead` reads these as
 * ABSOLUTE pitches in her frame and drives the bones with the DIFFERENCES —
 * head local is `head - thorax`, gaster local is `gaster - thorax` — so
 * 30/30/30 pitches her whole body thirty degrees and folds nothing, which is
 * what the first sweep measured at 2.1 degrees.
 *
 * A fold is a STAGGER. These walk it out.
 */
const TRIALS = [
  [0, 0, 0],
  [30, 0, 0],
  [30, 15, 0],
  [45, 22, 0],
  [60, 30, 0],
  [90, 45, 0],
  [60, 30, -30],
  [90, 45, -45],
  [90, 60, -30],
];
for (const [h, t, g] of TRIALS) {
  const r = await measure(h, t, g);
  console.log(`  ${String(h).padStart(5)} ${String(t).padStart(6)} ${String(g).padStart(6)} |`
    + ` ${String(r.foldDeg).padStart(5)}`);
}
console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
