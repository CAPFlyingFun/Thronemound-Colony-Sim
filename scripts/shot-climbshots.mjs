/**
 * HER, ON THE TRUNK, AT THREE HEIGHTS — SIDE AND BACK.
 *
 * The numeric probe stops being able to answer above the clear trunk: a
 * horizontal ray out of the axis meets boughs and leaves, not bark, so it
 * compares one thing against another and reports hundreds of millimetres of
 * nonsense. Above the branches the honest instrument is a photograph.
 *
 * Places her on the bark at a given height rather than walking her there —
 * software GL renders about a frame a second and climbing 25 m would take
 * all day — then lets the walker seat her, and shoots her from the SIDE
 * (along her own right, which is where a gap under her shows) and from
 * BEHIND (along her nose, where sinking into the trunk shows).
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/shot-climbshots.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 90000 });
await page.waitForFunction(
  () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 90000 },
);
await page.waitForFunction(() => window.islandScene.tree?.solid != null, null, { timeout: 60000 });
await page.waitForTimeout(1500);

/** Put her on the bark at `frac` of the tree's height, facing up it. */
const perch = (frac) => page.evaluate((f) => {
  const s = window.islandScene;
  const origin = s.tree.root.position;
  const y = origin.y + 5200 * f;
  /*
   * FIND THE AXIS, THEN THE SKIN.
   *
   * The first cut marched outward from the origin's column in 24
   * directions. Near the top that cannot work: the leader has wandered up
   * to 175 mm off the origin and is 2.5 mm through, so every ray misses and
   * the probe reported "could not find bark" for a trunk that is plainly
   * there. Sweep a grid for the DEEPEST point at this height — that is the
   * axis, whatever it has wandered to — and walk out from it.
   */
  let axis = null;
  let deepest = 0;
  for (let gx = -260; gx <= 260; gx += 1.5) {
    for (let gz = -260; gz <= 260; gz += 1.5) {
      const d = s.tree.solid.densityAt(origin.x + gx, y, origin.z + gz);
      if (d > deepest) { deepest = d; axis = { x: origin.x + gx, z: origin.z + gz }; }
    }
  }
  if (!axis) return null;
  let put = null;
  for (let k = 0; k < 24 && !put; k += 1) {
    const a = (k / 24) * Math.PI * 2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    let last = 0;
    for (let d = 0.05; d < 400; d += 0.05) {
      if (s.tree.solid.solidAt(axis.x + dx * d, y, axis.z + dz * d)) last = d;
      else if (last > 0) {
        put = { x: axis.x + dx * (last + 0.05), y, z: axis.z + dz * (last + 0.05), dx, dz };
        break;
      }
    }
  }
  if (!put) return null;
  s.at.set(put.x, put.y, put.z);
  s.up.set(put.dx, 0, put.dz).normalize();
  s.fwd.set(0, 1, 0);
  /* Let the walker seat her and settle her own up off the field. */
  s.input.walk = 0; s.input.yaw = 0; s.input.strafe = 0;
  s.stepForTest(1 / 60, 90);
  return {
    lodLevel: s.tree.root.getCurrentLevel(),
    upY: +s.up.y.toFixed(2),
    atMm: Math.round((s.at.y - origin.y) * 5),
    onWood: s.tree.solid.solidAt(s.at.x, s.at.y, s.at.z),
  };
}, frac);

/** Camera along her own right (side) or along her nose from behind (back). */
const shoot = (which, name) => page.evaluate(({ w }) => {
  const s = window.islandScene;
  const cam = s.camera;
  const up = s.up;
  const fwd = s.fwd;
  const right = {
    x: up.y * fwd.z - up.z * fwd.y,
    y: up.z * fwd.x - up.x * fwd.z,
    z: up.x * fwd.y - up.y * fwd.x,
  };
  const D = 5.5;
  const off = w === 'side' ? right : { x: -fwd.x, y: -fwd.y, z: -fwd.z };
  cam.position.set(
    s.at.x + off.x * D + up.x * 0.7,
    s.at.y + off.y * D + up.y * 0.7,
    s.at.z + off.z * D + up.z * 0.7,
  );
  cam.up.set(up.x, up.y, up.z);
  cam.lookAt(s.at.x, s.at.y, s.at.z);
  cam.updateMatrixWorld();
  s.paused = true;
  s.renderer.render(s.scene, cam);
}, { w: which }).then(() => page.screenshot({ path: `/tmp/climb-${name}.png`, timeout: 90000 }));

/* 89 and 91 straddle the old LOD boundary at spec.height * 0.9 — the swap
 * that was dropping the wood from 64 sides to 12 while the collision stayed
 * at 64, and dropping the twigs entirely while the collision kept them. */
for (const [frac, label] of [
  [0.02, 'base'], [0.5, 'half'], [0.89, 'p89'], [0.91, 'p91'], [0.98, 'top'],
]) {
  const info = await perch(frac);
  if (!info) { console.log(`  ${label}: could not find bark`); continue; }
  console.log(`  ${label.padEnd(4)} ${String(info.atMm).padStart(6)} mm up  `
    + `LOD ${info.lodLevel}  her up.y ${info.upY}  ${info.onWood ? 'IN the wood' : 'on the skin'}`);
  await page.evaluate(() => { window.islandScene.paused = false; });
  await shoot('side', `${label}-side`);
  await page.evaluate(() => { window.islandScene.paused = false; });
  await shoot('back', `${label}-back`);
}

console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
