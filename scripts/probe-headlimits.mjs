/**
 * The head's limits, in BONE degrees, in BOTH cameras — they have to agree.
 *
 * Reported: third person stopped short of where first person went, and past
 * about -76 of bone the first-person eye clips into the soil. So -75 is the
 * floor, the up end stays where it was, and the two cameras must land on the
 * same pair of numbers.
 *
 * Also checks that a horizontal drag turns her head ONBOARD, which it did not:
 * the rig cleared its look offset in first person, so the drag did nothing.
 */
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(process.env.SMOKE_URL ?? 'http://localhost:4500/Thronemound-Colony-Sim/?scene=block', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await p.waitForTimeout(2000);
const out = await p.evaluate(() => {
  const lab = window.blockScene, DEG = 180 / Math.PI;
  const V = Object.getPrototypeOf(lab.at).constructor;
  const rig = lab.queen.rig;
  const bonePitch = () => {
    const h = new V(); lab.queen.headJointPosition(h);
    const j = new V(); lab.queen.jawPosition(j);
    const d = j.sub(h).normalize();
    return +(Math.atan2(d.dot(lab.up), d.dot(lab.forward)) * DEG).toFixed(2);
  };
  const boneYaw = () => {
    const h = new V(); lab.queen.headJointPosition(h);
    const j = new V(); lab.queen.jawPosition(j);
    const d = j.sub(h).normalize();
    const right = new V().crossVectors(lab.up, lab.forward).normalize();
    const flat = d.addScaledVector(lab.up, -d.dot(lab.up));
    return +(Math.atan2(flat.dot(right), flat.dot(lab.forward)) * DEG).toFixed(2);
  };
  const limits = (first) => {
    lab.setFirstPerson(first);
    lab.setMode(1);
    /*
     * Driven the way each camera actually receives it. Onboard the head
     * follows `aimPitch`; over her shoulder it follows the ORBIT arm, so a
     * probe that pokes `aimPitch` in third person moves nothing and reports
     * the same number for both stops — which is exactly what it did.
     */
    const drive = (dir) => {
      for (let i = 0; i < 200; i += 1) {
        if (first) lab.setAimPitchForTest(lab.aimPitch + dir * 0.05);
        else lab.follow.orbit(0, -dir * 0.05);
        lab.stepForTest(1 / 60, 1);
      }
      lab.stepForTest(1 / 60, 20);
      return bonePitch();
    };
    const min = drive(-1);
    const max = drive(1);
    return { min, max };
  };
  const third = limits(false);
  const first = limits(true);
  // And the yaw, onboard: a horizontal drag must turn her face.
  lab.setFirstPerson(true);
  lab.stepForTest(1 / 60, 10);
  const yaw0 = boneYaw();
  const canvas = document.querySelector('canvas');
  const cx = Math.round(window.innerWidth * 0.75);
  const cy = Math.round(window.innerHeight * 0.5);
  const send = (t, x, y) => canvas.dispatchEvent(new PointerEvent(t, { pointerId: 93, clientX: x, clientY: y, bubbles: true }));
  send('pointerdown', cx, cy);
  for (let i = 1; i <= 12; i += 1) send('pointermove', cx - i * 20, cy);
  send('pointerup', cx - 240, cy);
  lab.stepForTest(1 / 60, 20);
  const yawAfter = boneYaw();
  return { third, first, yaw0, yawAfter };
});
console.log(JSON.stringify({ errors: errs.slice(0, 2) }));
console.log(`third person   BONE min ${out.third.min}°   max ${out.third.max}°`);
console.log(`first person   BONE min ${out.first.min}°   max ${out.first.max}°`);
console.log(out.third.min === out.first.min && out.third.max === out.first.max
  ? 'the two cameras agree' : 'THE CAMERAS DISAGREE');
console.log(`\nonboard horizontal drag: head yaw ${out.yaw0}° -> ${out.yawAfter}°`
  + (Math.abs(out.yawAfter - out.yaw0) > 5 ? '  (turns)' : '  DOES NOT TURN'));
await b.close();
