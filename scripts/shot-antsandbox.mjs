/**
 * THE ANT MECHANICS SANDBOX, driven.
 *
 * Someone else's scene, so nothing about it is taken on trust: this presses
 * the keys it claims to bind and reports what actually changed — did she
 * move, did the heading turn, did the head aim, did a drag orbit the camera,
 * and did Space eventually take a voxel out of the world.
 *
 * The scene publishes no handle of its own, so the review build sets
 * `window.__ams` in its constructor. Without that this can only compare
 * screenshots, which cannot tell a moving ant from a moving camera.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/shot-antsandbox.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

await page.goto(`${base}/?scene=ant-sandbox`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ams?.ready, null, { timeout: 90000 });
await page.waitForFunction(() => window.__ams.workerReady, null, { timeout: 90000 });
await page.waitForTimeout(2500);

const read = () => page.evaluate(() => {
  const s = window.__ams;
  return {
    x: s.antPos.x, y: s.antPos.y, z: s.antPos.z,
    facing: s.facing, headYaw: s.headYaw, headPitch: s.headPitch,
    orbitYaw: s.orbitYaw, orbitPitch: s.orbitPitch, dist: s.orbitDistance,
    camY: s.camera.position.y,
    excavated: s.world.excavated,
    digging: s.session.digging !== null,
    meshes: s.meshes.size,
    footY: s.worker.root.position.y,
  };
});

const hold = async (key, ms) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
  await page.waitForTimeout(400);
};

const start = await read();
console.log(`\nTHE ANT MECHANICS SANDBOX  (?scene=ant-sandbox)`);
console.log(`  loaded: ${start.meshes} terrain chunks, she is at `
  + `(${start.x.toFixed(1)}, ${start.y.toFixed(1)}, ${start.z.toFixed(1)}) mm`);
await page.screenshot({ path: '/tmp/ams-start.png', timeout: 90000 });

await hold('KeyW', 2500);
const walked = await read();
const movedMm = Math.hypot(walked.x - start.x, walked.z - start.z);
console.log(`  W for 2.5 s        -> moved ${movedMm.toFixed(1)} mm `
  + `(12 mm/s would be ~30 mm), her seat ${walked.y.toFixed(2)} mm`);
await page.screenshot({ path: '/tmp/ams-walked.png', timeout: 90000 });

await hold('KeyA', 1200);
const turned = await read();
console.log(`  A for 1.2 s        -> heading ${((turned.facing - walked.facing) * 180 / Math.PI).toFixed(0)}° `
  + `(2.4 rad/s would be ~165°)`);

await hold('ArrowUp', 800);
await hold('ArrowLeft', 800);
const aimed = await read();
console.log(`  arrows             -> head yaw ${(aimed.headYaw * 180 / Math.PI).toFixed(0)}°, `
  + `pitch ${(aimed.headPitch * 180 / Math.PI).toFixed(0)}° (clamped at ±45 / ±30)`);

await page.mouse.move(500, 320);
await page.mouse.down();
await page.mouse.move(780, 250, { steps: 14 });
await page.mouse.up();
await page.waitForTimeout(700);
const orbited = await read();
console.log(`  drag 280 px across -> orbit yaw ${((orbited.orbitYaw - aimed.orbitYaw) * 180 / Math.PI).toFixed(0)}°, `
  + `pitch ${((orbited.orbitPitch - aimed.orbitPitch) * 180 / Math.PI).toFixed(0)}°`);
await page.mouse.wheel(0, 400);
await page.waitForTimeout(400);
const zoomed = await read();
console.log(`  wheel down         -> arm ${orbited.dist.toFixed(0)} -> ${zoomed.dist.toFixed(0)} mm `
  + `(clamped 24..85)`);
await page.screenshot({ path: '/tmp/ams-orbited.png', timeout: 90000 });

await page.keyboard.press('KeyR');
await page.waitForTimeout(600);
const reset = await read();
console.log(`  R                  -> orbit back to `
  + `${(reset.orbitYaw * 180 / Math.PI).toFixed(0)}° / ${reset.dist.toFixed(0)} mm`);

/* DIG. Press once, then watch for the world to actually lose a voxel. */
await page.keyboard.press('Space');
await page.waitForTimeout(300);
const armed = await read();
console.log(`\n  Space              -> digging: ${armed.digging}`);
let dug = armed;
for (let i = 0; i < 30 && dug.excavated === start.excavated; i += 1) {
  await page.waitForTimeout(400);
  dug = await read();
}
console.log(`  after the chew     -> excavated ${start.excavated} -> ${dug.excavated} voxels, `
  + `${dug.meshes} chunks`);
await page.screenshot({ path: '/tmp/ams-dug.png', timeout: 90000 });

/* Can she walk off the edge of the 56-voxel world? */
await page.evaluate(() => { window.__ams.antPos.set(2, window.__ams.antPos.y, 2); });
await hold('KeyW', 2500);
const edge = await read();
console.log(`\n  walked at the corner -> (${edge.x.toFixed(1)}, ${edge.y.toFixed(1)}, `
  + `${edge.z.toFixed(1)}) mm  [world is 0..${56 * 2} mm]`);

console.log(`\npage errors: ${errs.length ? errs.slice(0, 6).join(' | ') : 'none'}`);
await browser.close();
