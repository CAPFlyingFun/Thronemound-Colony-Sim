import { chromium } from 'playwright';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
page.on('pageerror', e => console.log('PAGEERR', e.message.slice(0, 160)));
await page.goto('http://localhost:4620/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.statsForTest?.().playerReady === 1, null, { timeout: 120000 });
await page.mouse.click(466, 215);
await page.waitForTimeout(3000);
const r = await page.evaluate(() => {
  const s = window.islandScene;
  const DEG = Math.PI / 180;
  s.setPausedForTest(true);
  const pos = () => ({ x: +(s.at.x * 5).toFixed(1), y: +(s.at.y * 5).toFixed(1), z: +(s.at.z * 5).toFixed(1) });
  const events = [];
  // Chew the ground into a pocked mess: short shallow digs at varied
  // headings, surfacing between each — the post-play battlefield.
  for (let k = 0; k < 6; k += 1) {
    s.bore.headingNow = (k * 60) * DEG; // reset heading if accessor exists
    s.aimPitch = -50 * DEG;
    s.input.dig = true; s.input.walk = 1;
    s.stepForTest(1 / 60, 240); // 4 s in
    s.aimPitch = 75 * DEG;
    s.stepForTest(1 / 60, 420); // 7 s back out
    s.input.dig = false;
    s.stepForTest(1 / 60, 120); // settle
  }
  // Now WALK the crater field in eight directions, watch for seizure.
  s.input.dig = false;
  for (let d = 0; d < 8; d += 1) {
    const before = pos();
    s.aimPitch = 0;
    s.input.yaw = 0;
    // steer: force facing via bore heading? drive yaw input toward target
    const target = d * 45 * DEG;
    for (let t = 0; t < 240; t += 1) {
      // crude steering: yaw toward target heading
      let err = target - s.facing;
      while (err > Math.PI) err -= 2 * Math.PI;
      while (err < -Math.PI) err += 2 * Math.PI;
      s.input.yaw = Math.max(-1, Math.min(1, err * 3));
      s.input.walk = 1;
      s.stepForTest(1 / 60, 1);
    }
    const after = pos();
    const moved = Math.hypot(after.x - before.x, after.z - before.z);
    events.push({
      dir: d * 45, moved: +moved.toFixed(1),
      y: after.y, gnd: +(s.walkGroundAt(s.at.x, s.at.z) * 5).toFixed(1),
      under: s.underground, eng: s.boreEngaged, embed: s.embedFrames,
      centreSolid: s.stream.solidAtWu(s.at.x, s.at.y, s.at.z) === true,
    });
  }
  s.input.walk = 0; s.input.yaw = 0;
  return events;
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
