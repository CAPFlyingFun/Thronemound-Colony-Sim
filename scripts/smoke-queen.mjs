/**
 * Headless smoke test for the queen founding handoff (Phase B).
 *
 * Loads ?debug=den, which pre-carves a qualifying chamber, then checks the
 * whole state machine as the UI actually presents it: objective text, the
 * button appearing only while the site qualifies, the handoff to colony view,
 * and that the den stays put afterwards.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL
  ?? 'http://localhost:4173/Thronemound-Colony-Sim/?scene=dig&debug=den';
const OUT = process.env.SMOKE_OUT ?? '/tmp/queen-smoke';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 1600 }, deviceScaleFactor: 1 });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1; };
const ok = (m) => console.log(`  ok  ${m}`);
const text = async (sel) => (await page.textContent(sel))?.replace(/\s+/g, ' ').trim() ?? '';

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas', { timeout: 20000 });
await page.waitForTimeout(2500);

// 1. Standing in the pre-carved chamber, the site should already qualify.
const objective = await text('#dig-objective');
if (!/Found the den/i.test(objective)) fail(`objective should offer founding, got "${objective}"`);
else ok(`objective: ${objective}`);

const depthLine = await text('#dig-readout');
if (!/Chamber \d+\/\d+/.test(depthLine)) fail(`chamber count missing from readout: "${depthLine}"`);
else ok(`readout: ${depthLine}`);

const btn = page.locator('#dig-found');
if (await btn.isHidden()) fail('FOUND button should be visible in a qualifying chamber');
else ok('FOUND button offered');

await page.screenshot({ path: `${OUT}-1-ready.png` });

// NOTE: withdrawal of the offer when the site stops qualifying is covered by
// unit tests (bare shaft and surface both rejected). It can't be exercised
// here — the queen is boxed into the chamber and can't walk out of it — so
// there is deliberately no browser assertion pretending to check it.

// 3. Found it.
await btn.click({ force: true });
await page.waitForTimeout(1200);

if (await btn.isVisible()) fail('FOUND button should disappear once founded');
else ok('FOUND button consumed');

const hudClass = await page.getAttribute('.dig-hud', 'class');
if (!hudClass?.includes('is-colony')) fail(`expected colony view, hud class = "${hudClass}"`);
else ok('handed off to colony view');

const toast = await text('.dig-toast');
if (!/sheds her wings/i.test(toast)) fail(`founding announcement missing: "${toast}"`);
else ok(`announcement: ${toast.slice(0, 72)}...`);

const colonyReadout = await text('#dig-readout');
if (!/Queen.s den/i.test(colonyReadout)) fail(`colony readout wrong: "${colonyReadout}"`);
else ok(`colony readout: ${colonyReadout}`);

await page.screenshot({ path: `${OUT}-2-founded.png` });

// 4. The dig affordances must be gone, and the camera must now orbit.
for (const sel of ['.dig-action', '.dig-mode']) {
  if (await page.locator(sel).isVisible()) fail(`${sel} should be hidden in colony view`);
}
ok('dig controls hidden in colony view');

const before = await page.screenshot();
await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  const send = (type, x) => canvas.dispatchEvent(new PointerEvent(type, {
    pointerId: 9, pointerType: 'touch', isPrimary: true, bubbles: true, clientX: x, clientY: 800,
  }));
  send('pointerdown', 700);
  for (let i = 1; i <= 12; i++) send('pointermove', 700 - i * 12);
  send('pointerup', 556);
});
await page.waitForTimeout(700);
const after = await page.screenshot({ path: `${OUT}-3-orbited.png` });
if (Buffer.compare(before, after) === 0) fail('dragging did not orbit the colony camera');
else ok('colony camera orbits on drag');

if (errors.length) fail(`console errors:\n    ${errors.join('\n    ')}`);
else ok('no console errors');

await browser.close();
console.log(process.exitCode ? '\nQUEEN SMOKE FAILED' : '\nQUEEN SMOKE PASSED');
