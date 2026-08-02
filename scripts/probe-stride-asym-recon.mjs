/** Recon: what is actually reachable at runtime, and what do the legs look like. */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4403/Thronemound-Colony-Sim/?scene=block';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.drive, null, { timeout: 60000 });
await page.waitForTimeout(2000);

const out = await page.evaluate(() => {
  const lab = window.blockScene;
  return {
    ready: lab.ready,
    keys: Object.keys(lab).filter((k) => typeof lab[k] !== 'function'),
    hasSurfaceUnder: typeof lab.surfaceUnder,
    hasForward: !!lab.forward,
    at: [lab.at.x, lab.at.y, lab.at.z],
    up: [lab.up.x, lab.up.y, lab.up.z],
    forward: lab.forward ? [lab.forward.x, lab.forward.y, lab.forward.z] : null,
    ride: lab.ride,
    surfHere: typeof lab.surfaceUnder === 'function'
      ? lab.surfaceUnder(lab.at.x, lab.at.y, lab.at.z) : null,
    legs: lab.drive.legs.map((l) => ({
      slot: l.slot,
      home: [l.home.x, l.home.y, l.home.z],
      homeMm: [l.home.x * 5, l.home.y * 5, l.home.z * 5].map((n) => +n.toFixed(3)),
      spreadMm: +(l.spread * 5).toFixed(3),
      downMm: +(l.down * 5).toFixed(3),
      planted: l.planted,
      anchor: [l.anchor.x, l.anchor.y, l.anchor.z],
      at: [l.at.x, l.at.y, l.at.z],
      dir: [l.dir.x, l.dir.y, l.dir.z],
      t: l.t,
    })),
  };
});
console.log(JSON.stringify({ errors: errors.slice(0, 3) }));
console.log(JSON.stringify(out, null, 2));
await browser.close();
