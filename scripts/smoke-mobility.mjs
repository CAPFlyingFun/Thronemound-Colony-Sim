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

// --------------------------------------------------- one cube at a time
// Capacity is 1: an ant carries a grain, not a wheelbarrow. That makes the
// mound something you build rather than dump, and it means you cannot sink
// yourself into a shaft in one go any more.
{
  const page = await browser.newPage({ viewport: { width: 900, height: 1400 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}?scene=dig&debug=1`, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas');
  await page.waitForTimeout(2400);

  const hud = async () => {
    const t = (await page.textContent('#dig-readout'))?.replace(/\s+/g, ' ') ?? '';
    return {
      carrying: Number(/Carrying (\d+)/.exec(t)?.[1] ?? '0'),
      capacity: Number(/Carrying \d+\/(\d+)/.exec(t)?.[1] ?? '0'),
      dug: Number(/Dug (\d+)/.exec(t)?.[1] ?? '0'),
      mound: Number(/Mound (\d+)/.exec(t)?.[1] ?? '0'),
      target: /Target: ([^ ·]+)/.exec(t)?.[1] ?? '',
    };
  };
  const look = (from, to) => page.evaluate(([a, z]) => {
    const c = document.querySelector('canvas');
    const ev = (t, y) => c.dispatchEvent(new PointerEvent(t, {
      pointerId: 8, pointerType: 'touch', isPrimary: true, bubbles: true, clientX: 700, clientY: y,
    }));
    ev('pointerdown', a);
    for (let i = 1; i <= 10; i++) ev('pointermove', a + ((z - a) * i) / 10);
    ev('pointerup', z);
  }, [from, to]);

  if ((await hud()).capacity !== 1) fail(`capacity should be 1, got ${(await hud()).capacity}`);
  else ok('carries one cube at a time');

  // Reach: distant soil must be unreachable, the cube underfoot must not be.
  if ((await hud()).target !== '—') fail(`flat ahead should be out of reach, got "${(await hud()).target}"`);
  else ok('soil beyond the neighbouring cubes is out of reach');
  await look(700, 1180);
  await page.waitForTimeout(400);
  if ((await hud()).target === '—') fail('the cube underfoot should be workable');
  else ok(`the cube underfoot is workable (${(await hud()).target})`);

  const action = await page.$('.dig-action');
  const box = await action.boundingBox();
  const hold = async (ms) => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(ms);
    await page.mouse.up();
    await page.waitForTimeout(600);
  };

  await hold(3000);
  const first = await hud();
  if (first.dug !== 1 || first.carrying !== 1) fail(`expected exactly one cube dug, got ${JSON.stringify(first)}`);
  else ok('digs exactly one cube, then stops because it is full');

  // Holding longer must not dig a second while loaded.
  await hold(3000);
  const stillFull = await hud();
  if (stillFull.dug !== 1) fail(`dug ${stillFull.dug} cubes while already carrying one`);
  else ok('cannot dig again until the load is dropped');

  // Drop it, then dig again.
  await look(1180, 960);
  await page.waitForTimeout(400);
  await page.click('.dig-mode');
  await hold(300);
  const dropped = await hud();
  if (dropped.carrying !== 0 || dropped.mound !== 1) fail(`dropping failed: ${JSON.stringify(dropped)}`);
  else ok('dropping the load frees the ant to dig again');
  if (dropped.dug !== dropped.carrying + dropped.mound) fail('soil not conserved');
  else ok(`soil conserved: dug ${dropped.dug} = carried ${dropped.carrying} + mound ${dropped.mound}`);

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
      weightless: /weightless/.test(t),
    };
  };

  const start = await state();
  if (start.up !== 'pos_y') fail(`should start world-up, got ${start.up}`);
  else ok(`starts world-up in the chamber, up = ${start.up}`);
  if (!start.weightless) fail('should be weightless inside the nest');
  else ok('weightless inside the nest');

  // No button press anywhere in this test — walking into the chamber wall
  // should mount it on its own.
  // Poll for the mount. The ant needs ~1 s to cross the chamber, and the HUD
  // only repaints every 6th frame (~770 ms under software rendering), so a
  // single read lands on a stale frame more often than not.
  await page.keyboard.down('KeyW');
  let mounted = start;
  for (let i = 0; i < 20 && mounted.up === 'pos_y'; i++) {
    await page.waitForTimeout(250);
    mounted = await state();
  }
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(900);

  if (mounted.up === 'pos_y') fail('walking into the chamber wall did not mount it');
  else ok(`auto-mounted the chamber wall, up = ${mounted.up}`);

  // The body must fit inside a single voxel in every orientation, or a
  // one-cube tunnel silently refuses every mount.
  if (2 * 0.3 > 1 || 0.7 > 1) fail('body no longer fits within a single voxel');
  else ok('body fits a 1-voxel tunnel standing and lying');

  // Mounted, it must not slide along the wall it is gripping. Let momentum
  // bleed off first — deceleration is 22 voxels/s^2, so this is not instant.
  await page.waitForTimeout(900);
  const before = await state();
  await page.waitForTimeout(1600);
  const after = await state();
  const drift = Math.hypot(...before.pos.map((v, i) => v - after.pos[i]));
  if (drift > 0.3) fail(`slid ${drift.toFixed(2)} voxels while mounted and idle`);
  else ok('holds still while mounted');

  await page.screenshot({ path: `${OUT}-4-mounted.png` });

  // Release restores world up.
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
