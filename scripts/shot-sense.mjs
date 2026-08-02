import { chromium } from 'playwright';
const OUT = '/tmp/claude-0/-home-user/96160b5d-3c24-578d-8a39-e986daf3fc1a/scratchpad';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
await p.goto(process.env.SMOKE_URL, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await p.waitForTimeout(2500);
// Dig straight down a while, then ride her head in.
await p.evaluate(() => {
  const lab = window.blockScene;
  lab.setFirstPerson(true);
  lab.setMode(1);
  lab.setAimPitchForTest(-Math.PI / 2.4);
  /*
   * Digging does not carry her down with it — she bites at her jaws and stays
   * on the rim. So the shaft is sunk first, then she is lowered into it a
   * bite at a time, which is what a player does with a thumb anyway.
   */
  for (let round = 0; round < 14; round += 1) {
    for (let i = 0; i < 4; i += 1) {
      lab.input.dig = true; lab.digCooldown = 0; lab.stepForTest(1 / 60, 20);
    }
    lab.input.dig = false;
    lab.at.addScaledVector(lab.up, -0.6 / 5);
    lab.stepForTest(1 / 60, 10);
  }
  lab.stepForTest(1 / 60, 90);
});
await p.waitForTimeout(1200);
await p.screenshot({ path: `${OUT}/sense-dug.png` });
console.log(await p.evaluate(() => {
  const l = window.blockScene;
  return `sense ${l.sense.uSense.value.toFixed(3)} at ${(l.buriedDepth(l.camera.position) * 5).toFixed(2)} mm deep, removed ${(l.removed * 125).toFixed(0)} mm3`;
}));
await b.close();
