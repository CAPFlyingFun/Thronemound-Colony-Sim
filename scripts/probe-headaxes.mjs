/**
 * Which way do the head bone's LOCAL axes point, in her body frame?
 *
 * The gait writes Euler triples into bones, so "yaw the head" means picking
 * the component whose axis is her up. On an auto-rig that is not X, Y or Z by
 * default and guessing costs a day: a 60 degree yaw written on local Y moved
 * her face 4.5 degrees, because local Y is not her up.
 *
 * So this rotates the bone a known amount about each local axis in turn and
 * reports how far her FACE — the head joint to the mouth tip, geometry, not a
 * bone axis — swings in yaw and in pitch as a result.
 */
import { chromium } from 'playwright';
const DEG = 180 / Math.PI;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const p = await b.newPage();
await p.goto(process.env.SMOKE_URL ?? 'http://localhost:4450/Thronemound-Colony-Sim/?scene=block', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await p.waitForTimeout(1500);
console.log(JSON.stringify(await p.evaluate(() => {
  const lab = window.blockScene, DEG = 180 / Math.PI;
  const V = Object.getPrototypeOf(lab.at).constructor;
  const rig = lab.queen.rig;
  const name = rig.thorax[rig.thorax.length - 1];
  const bone = lab.queen.bones.get(name);
  const rest = lab.queen.rest.get(name);
  const Q = Object.getPrototypeOf(bone.quaternion).constructor;
  const E = Object.getPrototypeOf(lab.queen.root.rotation).constructor;
  const face = () => {
    lab.queen.root.updateMatrixWorld(true);
    const h = new V(); bone.getWorldPosition(h);
    const j = new V(); lab.queen.jawPosition(j);
    const f = j.sub(h).normalize();
    const right = new V().crossVectors(lab.up, lab.forward).normalize();
    const flat = f.clone().addScaledVector(lab.up, -f.dot(lab.up));
    return {
      yaw: Math.atan2(flat.dot(right), flat.dot(lab.forward)) * DEG,
      pitch: Math.asin(Math.max(-1, Math.min(1, f.dot(lab.up)))) * DEG,
    };
  };
  const set = (e) => { bone.quaternion.copy(rest).multiply(new Q().setFromEuler(new E(e[0], e[1], e[2]))); };
  set([0, 0, 0]);
  const base = face();
  const out = { bone: name, base: { yaw: +base.yaw.toFixed(2), pitch: +base.pitch.toFixed(2) }, axes: {} };
  const A = 30 / DEG;
  for (const [tag, e] of [['X', [A, 0, 0]], ['Y', [0, A, 0]], ['Z', [0, 0, A]]]) {
    set(e);
    const f = face();
    out.axes[tag] = { dYaw: +(f.yaw - base.yaw).toFixed(2), dPitch: +(f.pitch - base.pitch).toFixed(2) };
  }
  set([0, 0, 0]);
  return out;
}), null, 1));
await b.close();
