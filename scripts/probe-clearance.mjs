import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const p = await b.newPage();
await p.goto(process.env.SMOKE_URL, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.blockScene?.drive, null, { timeout: 45000 });
await p.waitForTimeout(1500);
console.log(await p.evaluate(() => {
  const l = window.blockScene; l.stepForTest(1/60, 60);
  return `clearance ${l.report.clearanceMm.toFixed(3)} mm | settle off, still measured`;
}));
await b.close();
