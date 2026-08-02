import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
await p.goto('http://localhost:4542/Thronemound-Colony-Sim/?scene=block', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await p.waitForTimeout(1500);
await p.evaluate(() => {
  const lab = window.blockScene;
  lab.setPlannerForTest(true);
  lab.planPieces = [
    { pitch: -15, turn: 45, roll: 30, length: 6 },
    { pitch: -30, turn: 0, roll: 0, length: 4 },
    { pitch: 0, turn: -45, roll: -15, length: 3 },
  ];
  lab.draft = { pitch: -15, turn: 45, roll: 30, length: 6 };
  lab.updatePlanHudForTest();
});
await p.waitForTimeout(400);
await p.screenshot({ path: process.env.OUT });
await b.close();
