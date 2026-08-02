import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const p = await b.newPage();
await p.goto(process.env.SMOKE_URL, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await p.waitForTimeout(2000);
console.log(await p.evaluate(() => {
  const lab = window.blockScene, MM = 5;
  lab.setMode(1); lab.setAimPitchForTest(-Math.PI / 2.4);
  const h0 = lab.at.dot(lab.up) * MM;
  const out = [];
  for (let r = 0; r < 10; r += 1) {
    lab.input.dig = true; lab.digCooldown = 0; lab.stepForTest(1 / 60, 20);
    out.push(lab.lastBiteWhy || 'dug');
  }
  lab.input.dig = false; lab.stepForTest(1 / 60, 60);
  return `height ${h0.toFixed(2)} -> ${(lab.at.dot(lab.up) * MM).toFixed(2)} mm | removed ${(lab.removed*125).toFixed(0)} mm3 | bites: ${out.join(', ')}`;
}));
await b.close();
