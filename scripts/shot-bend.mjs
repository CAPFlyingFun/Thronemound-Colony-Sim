/**
 * DOES SHE REACH FOR IT? — the ground-to-trunk corner, in profile.
 *
 * The moment the articulated body exists for. Coming off soil onto bark her
 * head meets a surface her abdomen is nowhere near, so the three sections
 * should be visibly disagreeing: head already pitched onto the trunk, thorax
 * halfway, gaster still lying along the ground. A plank cannot do that, and
 * the difference is only legible from the SIDE.
 *
 * Shot at the approach, at the corner itself, part way up, and on the way
 * back down — always along her own right, because that is the one view in
 * which a hinge shows.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/shot-bend.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 90000 });
await page.waitForFunction(
  () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 90000 },
);
await page.waitForFunction(() => window.islandScene.tree?.solid != null, null, { timeout: 60000 });
await page.waitForTimeout(1500);

/* Point her at the trunk and hold the throttle down; the corner arrives on
 * its own. Simulated time, because software GL renders about once a second. */
await page.evaluate(() => {
  const s = window.islandScene;
  const p = s.tree.root.position;
  s.setFacingForTest(Math.atan2(p.x - s.at.x, p.z - s.at.z));
  s.firstPerson = false;
});

/** Her three section pitches and her surface normal, right now. */
const read = () => page.evaluate(() => {
  const s = window.islandScene;
  const deg = (r) => +(r * 180 / Math.PI).toFixed(1);
  return {
    upY: +s.up.y.toFixed(2),
    head: deg(s.spine.pose.head),
    thorax: deg(s.spine.pose.thorax),
    gaster: deg(s.spine.pose.gaster),
    onWood: s.tree.solid.solidAt(s.at.x, s.at.y, s.at.z),
  };
});

/** Side-on, along her own right, close enough to see the hinge. */
const shoot = (name) => page.evaluate(() => {
  const s = window.islandScene;
  const cam = s.camera;
  const up = s.up;
  const fwd = s.fwd;
  const right = {
    x: up.y * fwd.z - up.z * fwd.y,
    y: up.z * fwd.x - up.x * fwd.z,
    z: up.x * fwd.y - up.y * fwd.x,
  };
  cam.position.set(
    s.at.x + right.x * 4.6 + up.x * 0.8,
    s.at.y + right.y * 4.6 + up.y * 0.8,
    s.at.z + right.z * 4.6 + up.z * 0.8,
  );
  cam.up.set(up.x, up.y, up.z);
  cam.lookAt(s.at.x, s.at.y, s.at.z);
  cam.updateMatrixWorld();
  s.paused = true;
  s.renderer.render(s.scene, cam);
}).then(() => page.screenshot({ path: `/tmp/bend-${name}.png`, timeout: 90000 }))
  .then(() => page.evaluate(() => { window.islandScene.paused = false; }));

const walk = (frames) => page.evaluate((n) => {
  const s = window.islandScene;
  s.input.walk = 1; s.input.sprint = true;
  s.stepForTest(1 / 60, n);
  s.input.walk = 0; s.input.sprint = false;
}, frames);

console.log('\nGROUND -> TRUNK, in profile');
console.log('  stage        her up.y   head    thorax   gaster   on wood');

/* Approach, then step in until her up has tipped over — that tipping IS the
 * corner, so it is what decides when to shoot rather than a frame count. */
let shot = 0;
const label = ['approach', 'corner', 'onwall', 'climbing'];
let last = await read();
console.log(`  ${label[0].padEnd(12)} ${String(last.upY).padStart(7)}   `
  + `${String(last.head).padStart(5)}   ${String(last.thorax).padStart(6)}   `
  + `${String(last.gaster).padStart(6)}   ${last.onWood}`);
await shoot(label[0]);
shot = 1;

for (let i = 0; i < 60 && shot < label.length; i += 1) {
  await walk(20);
  const now = await read();
  /* Fire at roughly 45 degrees of tip, then again on the wall, then above. */
  const want = shot === 1 ? now.upY < 0.72 : shot === 2 ? now.upY < 0.3 : now.onWood;
  if (want) {
    console.log(`  ${label[shot].padEnd(12)} ${String(now.upY).padStart(7)}   `
      + `${String(now.head).padStart(5)}   ${String(now.thorax).padStart(6)}   `
      + `${String(now.gaster).padStart(6)}   ${now.onWood}`);
    await shoot(label[shot]);
    shot += 1;
  }
  last = now;
}
if (shot < label.length) console.log(`  (only reached stage ${shot} of ${label.length})`);

console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
