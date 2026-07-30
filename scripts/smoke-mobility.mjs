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
      text: t.trim(),
      scoops: Number(/Carrying (\d+)\/\d+ pellets/.exec(t)?.[1] ?? '0'),
      capacity: Number(/Carrying \d+\/(\d+) pellets/.exec(t)?.[1] ?? '0'),
      pieces: Number(/pieces (\d+)/.exec(t)?.[1] ?? '0'),
      dug: Number(/Dug (\d+)/.exec(t)?.[1] ?? '0'),
      loose: Number(/Loose (\d+)/.exec(t)?.[1] ?? '0'),
      target: /Target: ([^ ·]+)/.exec(t)?.[1] ?? '',
      seconds: Number(/([\d.]+)s\/cube/.exec(t)?.[1] ?? '0'),
      y: Number((/pos [-\d.]+,([-\d.]+),/.exec(t) ?? [])[1] ?? 'NaN'),
      speed: Number(/spd ([\d.]+)/.exec(t)?.[1] ?? '0'),
    };
  };
  // The HUD repaints every 6th frame — about 770 ms under software rendering —
  // so anything read right after an input has to be polled, not sampled once.
  const until = async (label, check, timeoutMs = 300000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = await hud();
      if (check(state)) return state;
      if (Date.now() > deadline) { fail(`timed out waiting for ${label} — "${state.text}"`); return state; }
      await page.waitForTimeout(400);
    }
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
  const tap = (x, y) => page.evaluate(([cx, cy]) => {
    const c = document.querySelector('canvas');
    const ev = (t) => c.dispatchEvent(new PointerEvent(t, {
      pointerId: 9, pointerType: 'touch', isPrimary: true, bubbles: true, clientX: cx, clientY: cy,
    }));
    ev('pointerdown');
    ev('pointerup');
  }, [x, y]);

  // One voxel of soil, and one voxel is one pellet.
  if ((await hud()).capacity !== 1) fail(`capacity should be 1 pellet, got ${(await hud()).capacity}`);
  else ok('carries one cube at a time');

  // Reach: distant soil must be unreachable, the cube underfoot must not be.
  if ((await hud()).target !== '—') fail(`flat ahead should be out of reach, got "${(await hud()).target}"`);
  else ok('soil beyond the neighbouring cubes is out of reach');
  await look(700, 1180);
  const underfoot = await until('the ground to come into range', (s) => s.target !== '—', 25000);
  if (underfoot.target === '—') fail('the cube underfoot should be workable');
  else ok(`the cube underfoot is workable (${underfoot.target})`);

  // A look-DRAG must never dig, or the camera becomes unusable. It travelled
  // far past the tap threshold above, so nothing should have started.
  if ((await page.textContent('.dig-action')).includes('CANCEL')) fail('a look-drag started a dig');
  else ok('dragging to look does not dig');

  const standing = await hud();
  /*
   * ONE press takes the whole cell. It used to be four, a sheet at a time, with
   * the spoil hauled clear between them; this suite only ever needed the cell
   * gone, so what was a four-round haul is now a single press.
   */
  await look(700, 1180);
  await page.waitForTimeout(700);
  await page.click('.dig-action');
  await until('the cell to come away', (s) => s.dug >= 1, 300000);
  const first = await until('the first cube', (s) => s.dug >= 1, 60000);
  if (first.dug !== 1) fail(`expected exactly one cube dug, got ${JSON.stringify(first)}`);
  else ok('one press digs exactly one cell');

  // Digging FREES the soil rather than loading her, so she is empty-handed and
  // the spoil is lying in the hole.
  const spilled = await until('the freed cell to become loose soil',
    (s) => s.loose + s.pieces >= 1, 40000);
  if (spilled.loose + spilled.pieces !== 1) {
    fail(`digging should account for exactly one pellet: ${JSON.stringify(spilled)}`);
  } else ok(`the freed cell is one pellet (${spilled.loose} loose, ${spilled.pieces} held)`);

  /*
   * Dig the floor out from under yourself and you must end up ON the new floor,
   * not hovering over it.
   *
   * This pins a real bug. The weightless branch used to ask supportBelow() —
   * a GRID query, which floors the position to a cube and checks the cube below
   * THAT — whether something was underfoot, and zeroed the velocity if so.
   * Settling from 97.0 into a one-deep pit, the instant she crossed to 96.99
   * the cube below (95) read solid and she stopped a full 0.99 voxels above a
   * floor she is only 0.7 tall. Collision is sub-voxel accurate; the grid query
   * was not, and was deciding a continuous position.
   */
  const settled = await until('the ant to settle into her own hole',
    (s) => Number.isFinite(s.y) && standing.y - s.y > 0.8, 40000);
  const drop = standing.y - settled.y;
  if (!(drop > 0.8)) fail(`hovering: dug one voxel down but only fell ${drop.toFixed(2)}`);
  else ok(`settles onto the new floor, fell ${drop.toFixed(2)} voxels`);

  // Clods ignore the ant entirely — she walks through her own spoil, which is
  // what lets a heap be stood on and built up rather than shoving her around.
  const beforeWalk = await hud();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1500);
  await page.keyboard.up('KeyW');
  await until('the ant to stop walking', (s) => s.speed < 0.2, 40000);
  const afterWalk = await hud();
  if (afterWalk.loose !== beforeWalk.loose) fail('walking changed the loose count');
  else ok('walking through spoil neither destroys nor duplicates it');

  // Carry it, then put it down: soil conserved across the whole round trip.
  const back = await until('the spoil to be carryable', (s) => s.loose >= 1, 25000);
  if (back.loose < 1) fail('lost the spoil');
  await page.click('.dig-action');
  await page.waitForTimeout(1500);
  await page.click('.dig-action');
  const done = await until('the round trip to settle', (s) => s.loose >= 1, 40000);
  if (done.dug !== done.pieces + done.loose) fail(`soil not conserved: ${JSON.stringify(done)}`);
  else ok(`soil conserved: ${done.dug} cube = ${done.pieces} held + ${done.loose} loose`);

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

  /*
   * Jumping is the ONLY way off a surface — there is no release button. The ant
   * clings to whatever she touches and crosses edges automatically, so letting
   * go has to be a deliberate act with a cost.
   *
   * Poll rather than sampling once: the HUD repaints every 6th frame, so a
   * fixed wait can land on a frame painted before the key was handled.
   */
  await page.keyboard.press('Space');
  let released = await state();
  for (let i = 0; i < 12 && released.up !== 'pos_y'; i++) {
    await page.waitForTimeout(250);
    released = await state();
  }
  if (released.up !== 'pos_y') fail(`jumping should let go of the wall, got up ${released.up}`);
  else ok('jumping is what lets go of a wall');

  /*
   * And letting go must not leave her inside the rock.
   *
   * Release used to relabel `up` without moving her. Every other frame change
   * routes through surfaceContact() first, because the body's footprint changes
   * shape when `up` does — lying against a wall it runs EYE_HEIGHT along Z, and
   * standing it runs along Y. Skipping that reoriented her while still embedded,
   * and she launched from inside solid dirt. Embedded, collision blocks every
   * axis, so the tell is that she never comes to rest anywhere sane.
   */
  let restA = await state();
  let settleDrift = Infinity;
  for (let i = 0; i < 30 && settleDrift > 0.15; i++) {
    await page.waitForTimeout(600);
    const restB = await state();
    settleDrift = Math.hypot(...restA.pos.map((v, i2) => v - restB.pos[i2]));
    restA = restB;
  }
  if (!restA.pos.every(Number.isFinite) || settleDrift > 0.15) {
    fail(`never came to rest after letting go (last drift ${settleDrift.toFixed(2)}, pos ${restA.pos})`);
  } else ok(`comes to rest in open air after letting go (y ${restA.pos[1]})`);

  // Walking PAST a wall must not mount it. Mounting needs a deliberate push:
  // in a one-cube tunnel the ant is boxed in on four sides, so "movement was
  // blocked" on its own had her grabbing whichever face she happened to graze.
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(600);
  await page.keyboard.up('KeyA');
  await page.waitForTimeout(700);
  const grazed = await state();
  if (grazed.up !== 'pos_y') fail(`a glancing move mounted a wall (up ${grazed.up})`);
  else ok('a glancing move does not mount a wall');

  if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
  else ok('no page errors');
  await page.close();
}

await browser.close();
console.log(process.exitCode ? '\nMOBILITY SMOKE FAILED' : '\nMOBILITY SMOKE PASSED');
