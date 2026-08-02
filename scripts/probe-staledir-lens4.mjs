/** Where do the big single-frame foot jumps happen on the flat top? */
import { chromium } from 'playwright';
const URL = process.env.SMOKE_URL ?? 'http://localhost:4402/Thronemound-Colony-Sim/?scene=block';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.drive?.legs?.length === 6, null, { timeout: 60000 });
await page.waitForTimeout(1500);
const out = await page.evaluate(() => {
  const lab = window.blockScene;
  lab.input.walk = 1; lab.input.yaw = 0;
  const prev = {}; const events = [];
  for (let f = 0; f < 220; f += 1) {
    lab.stepForTest(1/60, 1);
    if (lab.up.y < 0.999) break;
    for (const l of lab.drive.legs) {
      const p = prev[l.slot];
      const now = { at: [l.at.x, l.at.y, l.at.z], planted: l.planted, groping: l.groping, t: l.t };
      if (p) {
        const d = Math.hypot(now.at[0]-p.at[0], now.at[1]-p.at[1], now.at[2]-p.at[2]) * 5;
        if (d > 0.5) events.push({ f, slot: l.slot, d: +d.toFixed(3),
          was: (p.planted?'P':(p.groping?'G':'s'))+' t'+p.t.toFixed(2),
          now: (now.planted?'P':(now.groping?'G':'s'))+' t'+now.t.toFixed(2) });
      }
      prev[l.slot] = now;
    }
  }
  lab.input.walk = 0;
  return events;
});
console.log('single-frame foot jumps > 0.5 mm on the flat top, walk=1 yaw=0');
for (const e of out) console.log(' f'+String(e.f).padStart(4), e.slot.padEnd(11),
  e.d.toFixed(3)+' mm', e.was, '->', e.now);
console.log('total', out.length);
await browser.close();
