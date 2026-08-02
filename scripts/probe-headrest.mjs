/**
 * What IS her resting head angle, exactly?
 *
 * "Normal head usually pitches down like 40 degrees due to the head's
 * position" — so this measures it rather than assuming which line is meant.
 * Three different lines can each fairly be called "the head angle" on this
 * rig and they are tens of degrees apart, so all three are reported, at the
 * rest pose and with the camera level.
 *
 * Elevation is relative to HER body forward: negative is nose-down.
 */
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
await p.goto(process.env.SMOKE_URL ?? 'http://localhost:4492/Thronemound-Colony-Sim/?scene=block', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await p.waitForTimeout(2000);
const out = await p.evaluate(() => {
  const lab = window.blockScene, DEG = 180 / Math.PI;
  const V = Object.getPrototypeOf(lab.at).constructor;
  const rig = lab.queen.rig;
  const at = (n) => { const bo = lab.queen.bones.get(n); if (!bo) return null; const v = new V(); bo.getWorldPosition(v); return v; };
  const elev = (from, to) => {
    if (!from || !to) return null;
    const d = to.clone().sub(from).normalize();
    return +(Math.asin(Math.max(-1, Math.min(1, d.dot(lab.up)))) * DEG).toFixed(2);
  };
  const sample = (tag) => {
    lab.stepForTest(1 / 60, 10);
    const neck = at(rig.thorax[0]);
    const headEnd = at(rig.thorax[rig.thorax.length - 1]);
    const mouth0 = at(rig.mouth[0]);
    const jaw = new V(); lab.queen.jawPosition(jaw);
    const socket = new V(); lab.queen.eyePosition(socket);
    return {
      tag,
      'neck base -> jaw': elev(neck, jaw),
      'head end -> jaw': elev(headEnd, jaw),
      'mouth chain (mouth0 -> jaw)': elev(mouth0, jaw),
      'antenna sockets -> jaw': elev(socket, jaw),
    };
  };
  lab.setFirstPerson(false);
  lab.setMode(0);           // WALK: head neither pitched nor dipped
  const rest = sample('rest, WALK, camera level');
  lab.setFirstPerson(true);
  lab.setMode(1);
  lab.setAimPitchForTest(0);
  const digLevel = sample('DIG, first person, camera 0');
  return { rest, digLevel };
});
for (const s of [out.rest, out.digLevel]) {
  console.log(`\n${s.tag}`);
  for (const [k, v] of Object.entries(s)) {
    if (k === 'tag') continue;
    console.log(`  ${k.padEnd(30)} ${String(v).padStart(8)}°`);
  }
}
await b.close();
