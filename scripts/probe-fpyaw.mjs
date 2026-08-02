/**
 * Onboard, does the VIEW turn with the head — or only the head?
 *
 * Reported: the side inset shows her head turning, the first-person picture
 * does not follow, and the jaws never line up. So this measures the two
 * directions against each other: the camera's own world forward, and the
 * head's, both flattened into her frame. They must move together.
 */
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(process.env.SMOKE_URL ?? 'http://localhost:4510/Thronemound-Colony-Sim/?scene=block', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await p.waitForTimeout(2000);
const out = await p.evaluate(() => {
  const lab = window.blockScene, DEG = 180 / Math.PI;
  const V = Object.getPrototypeOf(lab.at).constructor;
  const yawOf = (d) => {
    const right = new V().crossVectors(lab.up, lab.forward).normalize();
    const flat = d.clone().addScaledVector(lab.up, -d.dot(lab.up));
    return +(Math.atan2(flat.dot(right), flat.dot(lab.forward)) * DEG).toFixed(2);
  };
  const headDir = () => {
    const h = new V(); lab.queen.headJointPosition(h);
    const j = new V(); lab.queen.jawPosition(j);
    return j.sub(h).normalize();
  };
  const camDir = () => lab.camera.getWorldDirection(new V());
  lab.setFirstPerson(true);
  lab.setMode(1);
  lab.stepForTest(1 / 60, 20);
  const rows = [];
  for (const yaw of [0, 20, 40, 60]) {
    lab.follow.yawOffset = (yaw * Math.PI) / 180;
    lab.stepForTest(1 / 60, 20);
    rows.push({ asked: yaw, head: yawOf(headDir()), cam: yawOf(camDir()) });
  }
  return rows;
});
console.log(JSON.stringify({ errors: errs.slice(0, 2) }));
console.log('  asked     head yaw    camera yaw   difference');
for (const r of out) {
  console.log(
    `  ${String(r.asked).padStart(5)}° ${r.head.toFixed(2).padStart(11)}° ${r.cam.toFixed(2).padStart(12)}°`,
    `${(r.cam - r.head).toFixed(2).padStart(11)}°`,
  );
}
await b.close();
