/**
 * The head cam: is the eye where her antenna sockets are, and does it see?
 *
 * Three things, each a number:
 *   - the eye sits at the sockets, so its distance from that midpoint is ~0
 *   - the field of view is the 120 degrees asked for, and goes back to 60
 *   - the view is not INSIDE the soil, which is the failure mode for any
 *     camera parented to a head that spends its time in a tunnel
 * Plus a rendered frame each way, so "it sees something" is not taken on
 * trust from a matrix.
 */
import { chromium } from 'playwright';
const B = process.env.SMOKE_URL ?? 'http://localhost:4480/Thronemound-Colony-Sim/?scene=block';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(B, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await p.waitForTimeout(2000);
const out = await p.evaluate(() => {
  const lab = window.blockScene, MM = 5;
  const V = Object.getPrototypeOf(lab.at).constructor;
  const read = () => {
    lab.stepForTest(1 / 60, 30);
    const socket = new V();
    const l = lab.queen.bones.get(lab.queen.rig.antennaLeft[0]);
    const r = lab.queen.bones.get(lab.queen.rig.antennaRight[0]);
    const a = new V(); const c = new V();
    l.getWorldPosition(a); r.getWorldPosition(c);
    socket.copy(a).add(c).multiplyScalar(0.5);
    return {
      fov: lab.camera.fov,
      onboard: lab.follow.firstPerson,
      eyeToSocketMm: +(lab.camera.position.distanceTo(socket) * MM).toFixed(3),
      // Decomposed in HER frame, so an offset can be attributed rather than
      // dialled out: which way is the eye actually wrong?
      offset: (() => {
        const d = lab.camera.position.clone().sub(socket);
        const right = new V().crossVectors(lab.up, lab.forward).normalize();
        return {
          fwd: +(d.dot(lab.forward) * MM).toFixed(3),
          up: +(d.dot(lab.up) * MM).toFixed(3),
          right: +(d.dot(right) * MM).toFixed(3),
        };
      })(),
      insideSoil: lab.solidAt(lab.camera.position),
    };
  };
  lab.setFirstPerson(false);
  const third = read();
  lab.setFirstPerson(true);
  const first = read();
  // And again after digging herself into a hole, which is the case that matters.
  lab.setMode(1);
  for (let i = 0; i < 12; i += 1) { lab.input.dig = true; lab.digCooldown = 0; lab.stepForTest(1 / 60, 20); }
  lab.input.dig = false;
  const dug = read();
  return { third, first, dug };
});
console.log(JSON.stringify({ errors: errs.slice(0, 2) }));
for (const [tag, r] of Object.entries(out)) {
  console.log(
    tag.padEnd(6),
    `fov ${String(r.fov).padStart(3)}`,
    `onboard ${String(r.onboard).padEnd(5)}`,
    `eye is ${r.eyeToSocketMm.toFixed(3).padStart(7)} mm from the antenna sockets`,
    r.insideSoil ? '  INSIDE SOIL' : '  clear of soil',
    `\n       offset in her frame: fwd ${r.offset.fwd} mm, up ${r.offset.up} mm, right ${r.offset.right} mm`,
  );
}
for (const [tag, first] of [['third', false], ['first', true]]) {
  await p.evaluate((on) => { window.blockScene.setFirstPerson(on); window.blockScene.stepForTest(1/60, 30); }, first);
  await p.waitForTimeout(400);
  await p.screenshot({ path: `/tmp/claude-0/-home-user/96160b5d-3c24-578d-8a39-e986daf3fc1a/scratchpad/view-${tag}.png` });
}
console.log('frames written to scratchpad: view-third.png, view-first.png');
await b.close();
