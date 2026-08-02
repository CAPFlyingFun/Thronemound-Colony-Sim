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
  /**
   * And is the view SQUARE on her head, or skewed to one side?
   *
   * Her two antenna sockets sit symmetrically either side of her head axis,
   * so if the camera is mounted square they subtend the same angle from the
   * view centre. A camera whose offset runs along the BODY rather than the
   * head drifts off that axis the moment the head turns — which reads as the
   * mandibles splitting evenly when straight and unevenly when turned.
   */
  const socketSkew = () => {
    const V2 = Object.getPrototypeOf(lab.at).constructor;
    const l = new V2(); const r = new V2();
    lab.queen.bones.get(lab.queen.rig.antennaLeft[0]).getWorldPosition(l);
    lab.queen.bones.get(lab.queen.rig.antennaRight[0]).getWorldPosition(r);
    const look = lab.camera.getWorldDirection(new V2());
    const ang = (v) => Math.acos(Math.max(-1, Math.min(1,
      v.clone().sub(lab.camera.position).normalize().dot(look)))) * DEG;
    return +(ang(l) - ang(r)).toFixed(2);
  };
  const rows = [];
  for (const [yaw, pitch] of [[0, 0], [-60, 0], [60, 0], [-30, -45], [60, -75], [-60, -75]]) {
    lab.follow.yawOffset = (yaw * Math.PI) / 180;
    lab.setAimPitchForTest((pitch * Math.PI) / 180);
    const off = jawOffScreen();
    rows.push({ yaw, pitch, off, skew: socketSkew() });
  }
  return rows;
});
console.log(JSON.stringify({ errors: errs.slice(0, 2) }));
console.log('  head yaw   head pitch    jaws off centre    left-right skew');
for (const r of out) {
  console.log(
    `  ${String(r.yaw).padStart(8)}° ${String(r.pitch).padStart(11)}°`,
    `${r.off.toFixed(2).padStart(16)}° ${r.skew.toFixed(2).padStart(17)}°`,
  );
}
const worstSkew = Math.max(...out.map((r) => Math.abs(r.skew)));
console.log(`\nworst left-right skew: ${worstSkew.toFixed(2)}°`
  + (worstSkew < 1 ? '  — square on her head at every turn' : '  — SKEWED'));
const spread = Math.max(...out.map((r) => r.off)) - Math.min(...out.map((r) => r.off));
console.log(`\nspread across every look: ${spread.toFixed(2)}°`);
console.log(spread < 1 ? 'LOCKED — the view is rigid to the head' : 'DRIFTS with the look');
await b.close();
