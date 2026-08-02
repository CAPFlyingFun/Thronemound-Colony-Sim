/**
 * The head-profile inset, shot at a spread of aims.
 *
 * Now that there is an instrument on screen for reading a nod, use it: three
 * frames at the top of her range, level, and the bottom. If the bone follows
 * the camera these are visibly different heads, and if it does not they are
 * the same head three times.
 */
import { chromium } from 'playwright';
const OUT = '/tmp/claude-0/-home-user/96160b5d-3c24-578d-8a39-e986daf3fc1a/scratchpad';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(process.env.SMOKE_URL ?? 'http://localhost:4492/Thronemound-Colony-Sim/?scene=block', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await p.waitForTimeout(2500);
for (const [tag, deg] of [['up15', 15], ['level', 0], ['down90', -90]]) {
  const got = await p.evaluate((d) => {
    const lab = window.blockScene;
    lab.setFirstPerson(true);
    lab.setMode(1);
    lab.setAimPitchForTest((d * Math.PI) / 180);
    lab.stepForTest(1 / 60, 20);
    return +(lab.follow.lookPitch * 180 / Math.PI).toFixed(1);
  }, deg);
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${OUT}/head-${tag}.png` });
  console.log(`${tag.padEnd(7)} asked ${String(deg).padStart(4)}°, camera settled at ${got}° -> head-${tag}.png`);
}
console.log(JSON.stringify({ errors: errs.slice(0, 2) }));
await b.close();
