import { chromium } from 'playwright';
const base = (process.env.SMOKE_URL ?? '').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
for (const flag of ['', '&ik=off']) {
  const errs = [];
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${base}/?scene=island${flag}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 90000 });
  await page.waitForFunction(
    () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 90000 });
  await page.waitForTimeout(1200);
  const r = await page.evaluate(() => {
    const s = window.islandScene;
    const q = s.queen;
    const foot = q.rig.legs[0].bones[q.rig.legs[0].bones.length - 1];
    const before = [];
    s.input.walk = 1;
    for (let f = 0; f < 120; f += 1) {
      s.stepForTest(1 / 60, 1);
      q.root.updateMatrixWorld(true);
      const b = q.bones.get(foot);
      const e = b.matrixWorld.elements;
      before.push([e[12], e[13], e[14]]);
    }
    s.input.walk = 0;
    /* How far the drawn foot sits from where the GAIT says it should be. */
    let gap = 0;
    const a = s.drive?.anchorFor('frontLeft');
    const fl = q.bones.get(q.rig.legs.find((l) => l.slot === 'frontLeft').bones.slice(-1)[0]);
    if (a && fl) {
      const e = fl.matrixWorld.elements;
      gap = Math.hypot(e[12] - a[0], e[13] - a[1], e[14] - a[2]) * 5;
    }
    /* And how much the foot moved over the run, so a frozen rig is visible. */
    let travel = 0;
    for (let i = 1; i < before.length; i += 1) {
      travel += Math.hypot(before[i][0] - before[i - 1][0],
        before[i][1] - before[i - 1][1], before[i][2] - before[i - 1][2]) * 5;
    }
    return { ik: s.ikEnabled, gapMm: +gap.toFixed(2), footTravelMm: +travel.toFixed(1) };
  });
  console.log(`  ${flag || '(default)'} -> ikEnabled=${r.ik} `
    + `frontLeft foot to its anchor: ${r.gapMm} mm · foot travelled ${r.footTravelMm} mm`
    + ` · page errors: ${errs.length ? errs.join(' | ') : 'none'}`);
  await page.close();
}
await browser.close();
