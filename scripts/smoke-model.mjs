/**
 * Headless smoke test for the queen model and her gait.
 *
 * The unit tests cover the gait's rules; this proves the parts they cannot
 * touch — that the meshopt decoder resolves through the bundler, that the WebP
 * textures decode, that the GLB is actually reachable at the Pages base path,
 * and that the rig map still matches the file. That last one is the real prize:
 * the bone names are meaningless (`Bone_000`…`Bone_052`), so a re-export that
 * renumbers them would silently animate nothing, and no unit test can see it.
 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_URL ?? 'http://localhost:4173/Thronemound-Colony-Sim/';
const OUT = process.env.SMOKE_OUT ?? '/tmp/model-smoke';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
/*
 * deviceScaleFactor 3, deliberately — a PHONE, not a desktop.
 *
 * The canvas-sizing bug this suite missed the first time only exists above
 * ratio 1: the draw buffer was set without the CSS size, so the element laid
 * out at twice the viewport and you saw the top-left quarter with the queen off
 * in the corner. At ratio 1 the two happen to agree and everything looks fine.
 */
const page = await browser.newPage({ viewport: { width: 900, height: 420 }, deviceScaleFactor: 3 });

const errors = [];
const badResponses = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('response', (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`); });

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`  ok  ${msg}`);

await page.goto(`${BASE}?scene=queen`, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas', { timeout: 20000 });

// 1. She loads at all — this is the meshopt decoder and the WebP textures.
const loaded = await page.waitForFunction(
  () => document.querySelector('.dig-hud')?.textContent?.includes('loaded') ?? false,
  { timeout: 30000 },
).then(() => true).catch(() => false);
if (!loaded) fail(`the queen never loaded — "${(await page.textContent('.dig-hud'))?.trim()}"`);
else ok('the GLB loads: meshopt decoder resolved and WebP textures decoded');

const readout = (await page.textContent('.dig-hud'))?.replace(/\s+/g, ' ').trim() ?? '';

/*
 * 1b. The canvas fills its host, in CSS pixels.
 *
 * This is the assertion that catches the off-centre queen directly, rather than
 * through a screenshot: if the element is laid out larger than the viewport,
 * the visible region is a crop and nothing is where the camera aimed it.
 */
const box = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  const host = document.getElementById('app');
  if (!c || !host) return null;
  const r = c.getBoundingClientRect();
  return { cw: Math.round(r.width), ch: Math.round(r.height),
    hw: host.clientWidth, hh: host.clientHeight, dpr: window.devicePixelRatio };
});
if (!box) fail('no canvas to measure');
else if (Math.abs(box.cw - box.hw) > 2 || Math.abs(box.ch - box.hh) > 2) {
  fail(`canvas is ${box.cw}x${box.ch} CSS px in a ${box.hw}x${box.hh} host `
    + `at dpr ${box.dpr} — the view is a crop, so nothing is centred`);
} else ok(`canvas fills its host at dpr ${box.dpr} (${box.cw}x${box.ch})`);

/*
 * 1c. She is actually in the MIDDLE of the frame.
 *
 * Sizing can be right and the framing still wrong. A crop of the centre has to
 * carry detail; the same-sized crop of a corner is background. Compared as
 * compressed PNG size, the way the dig suite already tells a rendered frame
 * from a flat one — a lone brown wash packs down to almost nothing.
 */
const size = { width: Math.round(box.hw / 4), height: Math.round(box.hh / 4) };
const middle = await page.screenshot({
  clip: { x: (box.hw - size.width) / 2, y: (box.hh - size.height) / 2, ...size },
});
const corner = await page.screenshot({ clip: { x: 0, y: 0, ...size } });
if (middle.length <= corner.length) {
  fail(`the centre of the frame is as empty as the corner `
    + `(${middle.length} B vs ${corner.length} B) — she is not centred`);
} else ok(`she is in the middle of the frame (${middle.length} B vs ${corner.length} B corner)`);

// 2. She is the size of a real ant, not of whatever the modeller exported.
const mm = Number(/\(([\d.]+) mm\)/.exec(readout)?.[1] ?? '0');
if (Math.abs(mm - 9) > 0.2) fail(`queen measures ${mm} mm, expected ~9`);
else ok(`scaled from millimetres: ${mm} mm, ${/([\d.]+) voxels/.exec(readout)?.[1]} voxels`);

/*
 * 3. The gait actually moves her.
 *
 * This is the rig-map check, and the only one that works. The bone names carry
 * no meaning, so a re-export that renumbers them would leave the gait
 * addressing bones that no longer exist — she would stand perfectly still and
 * nothing would throw. A frozen skeleton renders perfectly well, so the only
 * way to see it is to compare frames.
 */
const shot = async (name) => page.screenshot({ path: `${OUT}-${name}.png` });
await page.waitForTimeout(1500);
const a = await shot('a');
await page.waitForTimeout(1200);
const b = await shot('b');
if (Buffer.compare(a, b) === 0) fail('the queen is not moving — gait applied to no bones?');
else ok('the gait moves her between frames');

// 4. Digging must not simply freeze her: the front legs leave the gait, the
// other four go on walking.
await page.evaluate(() => {
  const sliders = [...document.querySelectorAll('input[type=range]')];
  const dig = sliders[2];
  if (dig) {
    dig.value = '1';
    dig.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
await page.waitForTimeout(1200);
const c = await shot('c-digging');
await page.waitForTimeout(1200);
const d = await shot('d-digging');
if (Buffer.compare(c, d) === 0) fail('she freezes while digging');
else ok('she keeps moving while digging');

if (badResponses.length) fail(`failed requests:\n    ${badResponses.join('\n    ')}`);
else ok('no failed requests');
if (errors.length) fail(`console errors:\n    ${errors.join('\n    ')}`);
else ok('no console errors');

console.log(`  readout: ${readout}`);
await browser.close();
console.log(process.exitCode ? '\nMODEL SMOKE FAILED' : '\nMODEL SMOKE PASSED');
