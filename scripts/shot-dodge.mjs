/**
 * LEFT THUMB MOVES; RIGHT THUMB LOOKS; A FLICK DODGES.
 *
 * Driven through the REAL pointer handlers, because the thing being checked
 * is the wiring, not the arithmetic — the arithmetic is in
 * `tests/dodge.test.ts`. Every gesture here is a genuine pointerdown, a
 * genuine set of moves and a genuine pointerup, at real wall-clock timings,
 * so the flick reader sees exactly what a thumb produces.
 *
 * Movement is then advanced on SIMULATED time, because software GL renders
 * about a frame a second and a quarter-second burst would otherwise be one
 * frame long and unmeasurable.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/shot-dodge.mjs
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
await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 90000 });
await page.waitForFunction(
  () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 90000 },
);
await page.waitForTimeout(2000);

const MM = 5;
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const reset = () => page.evaluate(() => {
  const s = window.islandScene;
  s.input.walk = 0; s.input.yaw = 0; s.input.strafe = 0;
  s.camYaw = 0;
  s.dodge.cancel();
  s.stepForTest(1 / 60, 20);
});

/** Her frame and where she is, right now. */
const mark = () => page.evaluate(() => {
  const s = window.islandScene;
  return {
    at: { x: s.at.x, y: s.at.y, z: s.at.z },
    fwd: { x: s.fwd.x, y: s.fwd.y, z: s.fwd.z },
    up: { x: s.up.x, y: s.up.y, z: s.up.z },
    camYaw: s.camYaw,
    facing: s.facing,
  };
});

/** How far she moved along her own nose and her own right, in mm. */
const travelled = (from, to) => {
  const dx = to.at.x - from.at.x;
  const dy = to.at.y - from.at.y;
  const dz = to.at.z - from.at.z;
  /* `up x fwd` is her model +X, which is screen-LEFT — so her screen-right
   * is the negative of it. Settled in `shot-hands.mjs`. */
  const rx = -(from.up.y * from.fwd.z - from.up.z * from.fwd.y);
  const ry = -(from.up.z * from.fwd.x - from.up.x * from.fwd.z);
  const rz = -(from.up.x * from.fwd.y - from.up.y * from.fwd.x);
  return {
    aheadMm: (dx * from.fwd.x + dy * from.fwd.y + dz * from.fwd.z) * MM,
    rightMm: (dx * rx + dy * ry + dz * rz) * MM,
    totalMm: Math.hypot(dx, dy, dz) * MM,
  };
};

/** A slow drag on the right half — a LOOK. */
const pan = async (px, ms = 700) => {
  await page.mouse.move(700, 320);
  await page.mouse.down();
  const steps = 14;
  for (let i = 0; i < steps; i += 1) {
    await page.mouse.move(700 + ((i + 1) * px) / steps, 320);
    await page.waitForTimeout(ms / steps);
  }
  await page.mouse.up();
};

/** A fast throw on the right half — a FLICK. */
const flick = async (dx, dy) => {
  await page.mouse.move(700, 320);
  await page.mouse.down();
  for (let i = 0; i < 4; i += 1) {
    await page.mouse.move(700 + (dx * (i + 1)) / 4, 320 + (dy * (i + 1)) / 4);
  }
  await page.mouse.up();
};

/** Hold the left stick at a deflection and leave it there. */
const holdStick = async (dx, dy) => {
  await page.mouse.move(220, 400);
  await page.mouse.down();
  await page.mouse.move(220 + dx, 400 + dy, { steps: 6 });
};
const releaseStick = () => page.mouse.up();

const step = (n) => page.evaluate((k) => window.islandScene.stepForTest(1 / 60, k), n);

console.log('\nCAMERA AND MOVEMENT ARE INDEPENDENT');

for (const [name, px] of [['right', 240], ['left', -240]]) {
  await reset();
  const a = await mark();
  await pan(px, 500);
  await step(40);
  const b = await mark();
  const d = travelled(a, b);
  check(`slow ${name} drag pans the camera and does NOT move her`,
    d.totalMm < 0.5 && Math.abs(b.camYaw - a.camYaw) > 0.2,
    `moved ${d.totalMm.toFixed(2)} mm, camYaw ${a.camYaw.toFixed(2)} -> ${b.camYaw.toFixed(2)}`);
}

await reset();
{
  await holdStick(0, -40);
  const a = await mark();
  await step(30);
  await pan(240, 600);
  await step(30);
  const b = await mark();
  await releaseStick();
  const d = travelled(a, b);
  check('joystick forward + camera drag keeps going FORWARD with no sideways drift',
    d.aheadMm > 1 && Math.abs(d.rightMm) < d.aheadMm * 0.25,
    `${d.aheadMm.toFixed(2)} mm ahead, ${d.rightMm.toFixed(2)} mm sideways`);
}

await reset();
{
  await pan(240);
  const a = await mark();
  /* The camera swings home over the next second; she must not go with it. */
  await step(60);
  const b = await mark();
  const d = travelled(a, b);
  check('releasing after a pan leaves NO residual strafe',
    d.totalMm < 0.5, `drifted ${d.totalMm.toFixed(2)} mm while the view recentred`);
}

console.log('\nA FLICK DODGES');

for (const [name, dx, dy, expectAhead, expectRight] of [
  ['right', 90, 0, 0, 1],
  ['left', -90, 0, 0, -1],
  ['up = forward burst', 0, -90, 1, 0],
  ['down = back step', 0, 90, -1, 0],
]) {
  await reset();
  const a = await mark();
  await flick(dx, dy);
  const started = await page.evaluate(() => window.islandScene.dodge.active);
  await step(40);
  const b = await mark();
  const d = travelled(a, b);
  const along = expectAhead ? d.aheadMm * expectAhead : d.rightMm * expectRight;
  const across = expectAhead ? Math.abs(d.rightMm) : Math.abs(d.aheadMm);
  check(`quick swipe ${name}`,
    started && along > 3 && across < Math.abs(along) * 0.6,
    `${along.toFixed(2)} mm the asked way, ${across.toFixed(2)} mm across`);
}

console.log('\nIT WORKS WHILE THE STICK IS HELD, AND IN HER OWN FRAME');

await reset();
{
  await holdStick(0, -40);
  await step(20);
  const a = await mark();
  await flick(90, 0);
  await step(30);
  const b = await mark();
  await releaseStick();
  const d = travelled(a, b);
  check('a flick dodges even while the joystick is held',
    d.rightMm > 3, `${d.rightMm.toFixed(2)} mm to her right`);
}

/* ON THE TRUNK. Her up is the bark's normal there, so a "right" dodge has to
 * travel across the bark — not along world X — and must stay attached. */
await reset();
const climb = await page.evaluate(() => {
  const s = window.islandScene;
  const p = s.tree.root.position;
  s.setFacingForTest(Math.atan2(p.x - s.at.x, p.z - s.at.z));
  s.input.walk = 1; s.input.sprint = true;
  /* Enough to get her onto the bark and no further — every extra frame here
   * is soil streaming, which is the expensive part of this whole probe. */
  for (let i = 0; i < 24; i += 1) s.stepForTest(1 / 60, 20);
  s.input.walk = 0; s.input.sprint = false;
  s.stepForTest(1 / 60, 15);
  return { upY: +s.up.y.toFixed(2), onWood: s.tree.solid.solidAt(s.at.x, s.at.y, s.at.z) };
});
{
  const a = await mark();
  await flick(90, 0);
  await step(40);
  const b = await mark();
  const d = travelled(a, b);
  /* Across the bark means: along her right, and NOT along her up — she must
   * not be levered off the trunk. */
  const dx = b.at.x - a.at.x;
  const dy = b.at.y - a.at.y;
  const dz = b.at.z - a.at.z;
  const outMm = (dx * a.up.x + dy * a.up.y + dz * a.up.z) * MM;
  const still = await page.evaluate(() => {
    const s = window.islandScene;
    return { upY: +s.up.y.toFixed(2), gripped: s.soilSolidAt(
      s.at.x - s.up.x * 0.5, s.at.y - s.up.y * 0.5, s.at.z - s.up.z * 0.5,
    ) };
  });
  check(`dodge on a vertical trunk stays in HER frame (her up.y ${climb.upY})`,
    climb.upY < 0.5 && d.rightMm > 1 && Math.abs(outMm) < 3,
    `${d.rightMm.toFixed(2)} mm across the bark, ${outMm.toFixed(2)} mm off it`);
  check('and she is still attached to the wood afterwards',
    still.gripped === true, `up.y now ${still.upY}`);
}

console.log('\nNOTHING ELSE MOVED');

await reset();
{
  /* Turning is the stick's job and must be untouched by any of this. */
  const a = await mark();
  await holdStick(40, 0);
  await step(40);
  await releaseStick();
  const b = await mark();
  let turned = b.facing - a.facing;
  while (turned > Math.PI) turned -= Math.PI * 2;
  while (turned < -Math.PI) turned += Math.PI * 2;
  const d = travelled(a, b);
  check('the stick still turns her, and only turns her',
    Math.abs(turned) > 0.3 && Math.abs(d.rightMm) < 3,
    `${(turned * 180 / Math.PI).toFixed(0)}° turned, ${d.rightMm.toFixed(2)} mm sideways`);
}

await reset();
{
  /* First person: the drag aims her, and a quick aiming stroke must not be
   * read as a dodge or lining a bite up becomes a lottery. */
  await page.evaluate(() => { window.islandScene.firstPerson = true; });
  const a = await mark();
  await flick(90, 0);
  const fired = await page.evaluate(() => window.islandScene.dodge.active);
  await step(30);
  const b = await mark();
  const d = travelled(a, b);
  await page.evaluate(() => { window.islandScene.firstPerson = false; });
  check('a first-person aiming flick does NOT dodge',
    !fired && d.totalMm < 1, `moved ${d.totalMm.toFixed(2)} mm`);
}

await reset();
{
  await page.evaluate(() => { window.islandScene.digMode = true; });
  await flick(90, 0);
  const fired = await page.evaluate(() => window.islandScene.dodge.active);
  await page.evaluate(() => { window.islandScene.digMode = false; });
  check('a flick with DIG armed does NOT dodge', !fired);
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}`);
console.log(`page errors: ${errs.length ? errs.slice(0, 4).join(' | ') : 'none'}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
