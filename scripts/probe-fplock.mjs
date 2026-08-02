/**
 * Onboard, do the JAWS stay put on screen as the head moves?
 *
 * The report: looking straight down works, then a thirty degree turn and you
 * are no longer looking through the mandibles — while the profile inset shows
 * the head plainly turned. The cause was that the eye rode the head but the
 * DIRECTION was built from her body, so the camera was positionally on her
 * head and rotationally on her thorax.
 *
 * So this asks the only question that matters, in screen terms: how far off
 * the centre of the view do her jaws sit? If the camera is locked to the head
 * it is the same answer at every yaw and every pitch. If it is not, it grows.
 */
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(process.env.SMOKE_URL ?? 'http://localhost:4520/Thronemound-Colony-Sim/?scene=block', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await p.waitForTimeout(2000);
const out = await p.evaluate(() => {
  const lab = window.blockScene, DEG = 180 / Math.PI;
  const V = Object.getPrototypeOf(lab.at).constructor;
  lab.setFirstPerson(true);
  lab.setMode(1);
  /** Angle between the view's centre and the direction to her jaws. */
  const jawOffScreen = () => {
    lab.stepForTest(1 / 60, 20);
    const jaw = new V();
    lab.queen.jawPosition(jaw);
    const toJaw = jaw.sub(lab.camera.position).normalize();
    const look = lab.camera.getWorldDirection(new V());
    return +(Math.acos(Math.max(-1, Math.min(1, toJaw.dot(look)))) * DEG).toFixed(2);
  };
  const rows = [];
  for (const [yaw, pitch] of [[0, 0], [-30, 0], [30, 0], [-60, 0], [0, -45], [-30, -45], [30, -75], [-55, -75]]) {
    lab.follow.yawOffset = (yaw * Math.PI) / 180;
    lab.setAimPitchForTest((pitch * Math.PI) / 180);
    rows.push({ yaw, pitch, off: jawOffScreen() });
  }
  return rows;
});
console.log(JSON.stringify({ errors: errs.slice(0, 2) }));
console.log('  head yaw   head pitch    jaws off the view centre');
for (const r of out) {
  console.log(`  ${String(r.yaw).padStart(8)}° ${String(r.pitch).padStart(11)}° ${r.off.toFixed(2).padStart(20)}°`);
}
const spread = Math.max(...out.map((r) => r.off)) - Math.min(...out.map((r) => r.off));
console.log(`\nspread across every look: ${spread.toFixed(2)}°`);
console.log(spread < 1 ? 'LOCKED — the view is rigid to the head' : 'DRIFTS with the look');
await b.close();
