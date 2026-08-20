/* A/B/C for Joshua's proposal, measured over the founding descent. */
import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const rows = [];
for (const mode of ['shipped', 'no-up-search', 'ik-off']) {
  const ctx = await browser.newContext({ viewport: { width: 932, height: 430 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERR', e.message));
  await page.goto(`http://127.0.0.1:5177/?scene=habitat&cb=${Date.now()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.habitatScene?.ready === true, null, { timeout: 200000 });
  rows.push(await page.evaluate((m) => {
    const lab = window.habitatScene;
    lab.setPausedForTest(true);
    const a = lab.ant, model = a.model;
    if (m === 'no-up-search') a.drive.reachUpWu = 0.0001;
    if (m === 'ik-off') model.ikEnabled = false;
    const tip = new Map();
    for (const l of a.drive.legs) {
      const n = model.limbTipName(l.slot);
      if (n) tip.set(l.slot, model.root.getObjectByName(n));
    }
    const back = model.bodyTopAboveSole();
    let n = 0, sumHigh = 0, overBack = 0, maxHigh = -9;
    let offGround = 0, sunk = 0, planted = 0, groping = 0, frames = 0;
    let sealed = null, deepest = 0;
    for (let i = 0; i < 60 * 420; i += 1) {
      lab.tick(1/60);
      const r = lab.reportForTest();
      deepest = Math.max(deepest, r.depthMm);
      if (r.founding === 'sealed') { sealed = +(i/60).toFixed(0); break; }
      if (!['shaft','sinking','chambering'].includes(r.founding)) continue;
      frames += 1; planted += r.planted; groping += r.groping;
      for (const l of a.drive.legs) {
        if (!l.planted) continue;
        const bone = tip.get(l.slot);
        if (!bone) continue;
        const p = bone.getWorldPosition(bone.position.clone());
        const high = (p.y - a.at.y) * 5;
        n += 1; sumHigh += high; maxHigh = Math.max(maxHigh, high);
        if (high > back * 5) overBack += 1;
        /* How far the DRAWN foot is from the soil under it, in mm. */
        const floor = lab.surfaceAt(p.x, p.z, a.at.y + 1);
        if (floor !== null) {
          const gap = (p.y - floor) * 5;
          offGround += Math.abs(gap);
          if (gap < -0.3) sunk += 1;
        }
      }
    }
    return { mode: m, sealed, deepest: +deepest.toFixed(1),
      planted: +(planted/Math.max(1,frames)).toFixed(2),
      groping: +(groping/Math.max(1,frames)).toFixed(2),
      footHighMm: +(sumHigh/Math.max(1,n)).toFixed(2),
      worstHighMm: +maxHigh.toFixed(2),
      pctOverBack: +(100*overBack/Math.max(1,n)).toFixed(2),
      footOffGroundMm: +(offGround/Math.max(1,n)).toFixed(2),
      pctSunkInSoil: +(100*sunk/Math.max(1,n)).toFixed(1) };
  }, mode));
  await ctx.close();
  console.log(JSON.stringify(rows[rows.length-1]));
}
console.table(rows);
await browser.close();
