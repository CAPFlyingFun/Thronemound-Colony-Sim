import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const p = await b.newPage();
await p.goto('http://localhost:4421/Thronemound-Colony-Sim/?scene=block', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.blockScene?.drive, null, { timeout: 45000 });
console.log(JSON.stringify(await p.evaluate(() => {
  const d = window.blockScene.drive;
  return {
    stanceRadiusUnits: +d.stanceRadius.toFixed(4),
    stanceRadiusMm: +(d.stanceRadius * 5).toFixed(3),
    perLegMm: d.legs.map((l) => ({ slot: l.slot, r: +(Math.hypot(l.home.x, l.home.z) * 5).toFixed(3) })),
  };
}), null, 1));
await b.close();
