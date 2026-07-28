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
  await page.goto(`${BASE}?scene=dig`, { waitUntil: 'networkidle' });
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

  // Push into the shaft wall. Before wall climbing this did nothing at all —
  // a 1.44 voxel jump can't clear a 3 voxel hole.
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1000);
  const didClimb = await climbing();
  await page.waitForTimeout(4000);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(900);

  if (!didClimb) fail('climb never engaged while pushing into the shaft wall');
  else ok('climb engaged against the shaft wall');

  const out = await depth();
  if (out >= trapped) fail(`still trapped: ${trapped} mm -> ${out} mm`);
  else ok(`climbed out of the hole: ${trapped} mm -> ${out} mm`);

  await page.screenshot({ path: `${OUT}-3-escaped.png` });
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
  else ok('no page errors');
  await page.close();
}

await browser.close();
console.log(process.exitCode ? '\nMOBILITY SMOKE FAILED' : '\nMOBILITY SMOKE PASSED');
