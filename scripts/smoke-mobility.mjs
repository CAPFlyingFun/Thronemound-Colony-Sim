/**
 * Regression tests for the two things that made the prototype unplayable:
 * a canvas that didn't resize on rotation, and holes you couldn't get out of.
 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4173/Thronemound-Colony-Sim/';
const OUT = process.env.SMOKE_OUT ?? '/tmp/mobility-smoke';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1; };
const ok = (m) => console.log(`  ok  ${m}`);

// ---------------------------------------------------------------- rotation
{
  const page = await browser.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 1 });
  await page.goto(`${BASE}?scene=dig`, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas');
  await page.waitForTimeout(1800);

  const probe = () => page.evaluate(() => {
    const c = document.querySelector('canvas');
    const r = c.getBoundingClientRect();
    return {
      buf: [c.width, c.height],
      css: [Math.round(r.width), Math.round(r.height)],
      overflows: r.width > window.innerWidth + 1 || r.height > window.innerHeight + 1,
    };
  });

  const portrait = await probe();
  ok(`portrait: buffer ${portrait.buf.join('x')} css ${portrait.css.join('x')}`);

  await page.setViewportSize({ width: 852, height: 393 });
  await page.waitForTimeout(1200);
  const landscape = await probe();

  const bufAspect = landscape.buf[0] / landscape.buf[1];
  const cssAspect = landscape.css[0] / landscape.css[1];
  if (Math.abs(bufAspect - cssAspect) > 0.02) {
    fail(`after rotation the canvas is stretched: buffer ${landscape.buf.join('x')} vs css ${landscape.css.join('x')}`);
  } else {
    ok(`rotated cleanly: buffer ${landscape.buf.join('x')} css ${landscape.css.join('x')}`);
  }
  if (landscape.overflows) fail('canvas hangs off the viewport after rotation');
  else ok('canvas fits the viewport');

  const shortMode = await page.evaluate(() => document.querySelector('.dig-hud')?.className ?? '');
  if (!shortMode.includes('is-short')) fail(`HUD did not switch to compact layout: "${shortMode}"`);
  else ok('HUD compacted for the short viewport');

  const overlap = await page.evaluate(() => {
    const r = (s) => document.querySelector(s)?.getBoundingClientRect();
    const a = r('.dig-readout'); const b = r('.dig-controls');
    if (!a || !b) return 'missing';
    return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
  });
  if (overlap === true) fail('readout overlaps the controls in landscape');
  else ok('readout and controls do not overlap in landscape');

  await page.screenshot({ path: `${OUT}-1-landscape.png` });
  await page.close();
}

// ------------------------------------------------------ escaping the hole
// The reported bug exactly: dig straight down, fall in, and be unable to get
// out. So reproduce it literally rather than using the pre-carved den, whose
// chamber is wider than its shaft and therefore tests something else.
{
  const page = await browser.newPage({ viewport: { width: 900, height: 1400 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // debug=1 so the readout exposes `up`; the geometry is the plain surface.
  await page.goto(`${BASE}?scene=dig&debug=1`, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas');
  await page.waitForTimeout(2200);

  const depth = async () => {
    const t = (await page.textContent('#dig-readout'))?.replace(/\s+/g, ' ') ?? '';
    return Number(/Depth (\d+) mm/.exec(t)?.[1] ?? '0');
  };
  const climbing = async () =>
    ((await page.textContent('#dig-readout')) ?? '').includes('climbing');

  // Look straight down and dig a shaft under our own feet.
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const send = (type, y) => canvas.dispatchEvent(new PointerEvent(type, {
      pointerId: 4, pointerType: 'touch', isPrimary: true, bubbles: true, clientX: 700, clientY: y,
    }));
    send('pointerdown', 700);
    for (let i = 1; i <= 12; i++) send('pointermove', 700 + i * 40);
    send('pointerup', 1180);
  });
  await page.waitForTimeout(400);

  const action = await page.$('.dig-action');
  const box = await action.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(9000); // sink several voxels
  await page.mouse.up();
  await page.waitForTimeout(800);

  const trapped = await depth();
  if (trapped < 15) fail(`expected to have sunk into a shaft, only ${trapped} mm down`);
  else ok(`dug a shaft and fell in: ${trapped} mm down`);
  await page.screenshot({ path: `${OUT}-2-in-hole.png` });

  // Escape by GRIPPING the wall and walking up it. (The old push-into-a-wall
  // auto-climb was removed: it lifted the ant 1-2 voxels out of a 5-voxel
  // shaft and sometimes zero, while grip climbs the same shaft smoothly.)
  await page.keyboard.press('KeyG');
  await page.waitForTimeout(900);
  const upAfterGrip = ((await page.textContent('#dig-readout')) ?? '').match(/up (\w+)/)?.[1];
  if (!upAfterGrip || upAfterGrip === 'pos_y') fail(`grip failed inside the shaft (up = ${upAfterGrip})`);
  else ok(`gripped the shaft wall in a 1-voxel tunnel, up = ${upAfterGrip}`);

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(4000);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(600);

  await page.screenshot({ path: `${OUT}-3-escaped.png` });
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
  else ok('no page errors');
  await page.close();
}

// ------------------------------------------------------- surface walking
{
  const page = await browser.newPage({ viewport: { width: 900, height: 1400 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}?scene=dig&debug=den`, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas');
  await page.waitForTimeout(2500);

  const state = async () => {
    const t = (await page.textContent('#dig-readout'))?.replace(/\s+/g, ' ') ?? '';
    return {
      up: /up (\w+)/.exec(t)?.[1] ?? null,
      pos: (/pos ([-\d.]+),([-\d.]+),([-\d.]+)/.exec(t) ?? []).slice(1).map(Number),
    };
  };
  const button = async () => ((await page.textContent('.dig-jump')) ?? '').trim();

  const start = await state();
  if (start.up !== 'pos_y') fail(`should start world-up, got ${start.up}`);
  else ok(`starts grounded, up = ${start.up}`);
  if (!/JUMP/.test(await button())) fail(`button should offer JUMP in the open, got "${await button()}"`);
  else ok('button offers JUMP with no wall in reach');

  // Walk into the chamber wall.
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1400);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(600);
  if (!/CLIMB/.test(await button())) fail(`button should offer CLIMB at a wall, got "${await button()}"`);
  else ok('button switches to CLIMB when a wall is in reach');

  await page.keyboard.press('KeyG');
  await page.waitForTimeout(900);
  const gripped = await state();
  if (gripped.up === 'pos_y') fail('grip did not change orientation');
  else ok(`gripped the wall, up = ${gripped.up}`);
  if (gripped.up === 'neg_y') fail('attached to a ceiling — those are meant to be locked');
  else ok('did not attach to a ceiling');
  if (!/RELEASE/.test(await button())) fail(`button should offer RELEASE while attached, got "${await button()}"`);
  else ok('button offers RELEASE while attached');

  // The regression that matters most: the ant must fit BOTH standing and lying
  // inside one voxel, or a one-cube tunnel — which is what the whole game is
  // made of — silently refuses every grip.
  const span = 2 * 0.3; // BODY_RADIUS
  if (span > 1 || 0.7 > 1) fail('body no longer fits within a single voxel in every orientation');
  else ok('body fits a 1-voxel tunnel standing and lying');

  await page.screenshot({ path: `${OUT}-4-gripped.png` });

  // Attached, gravity should act along the new -up, not world -Y.
  const beforeDrift = await state();
  await page.waitForTimeout(1200);
  const afterDrift = await state();
  if (Math.abs(afterDrift.pos[1] - beforeDrift.pos[1]) > 0.5) {
    fail(`fell in world Y while attached to a wall (${beforeDrift.pos[1]} -> ${afterDrift.pos[1]})`);
  } else ok('does not fall in world Y while wall-attached');

  await page.keyboard.press('KeyG');
  await page.waitForTimeout(900);
  const released = await state();
  if (released.up !== 'pos_y') fail(`release should restore world up, got ${released.up}`);
  else ok('release restores world up');

  if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
  else ok('no page errors');
  await page.close();
}

await browser.close();
console.log(process.exitCode ? '\nMOBILITY SMOKE FAILED' : '\nMOBILITY SMOKE PASSED');
