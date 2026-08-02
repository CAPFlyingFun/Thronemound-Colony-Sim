/**
 * LENS v5: how much stroke can each leg's IK actually TRACK?
 *
 * The gait is taken out of the loop entirely. She stands still, and
 * `solveFeet` is called directly with a hand-made anchor that slides one foot
 * from ahead of its home to behind it. The residual — drawn tip bone vs the
 * point it was told to stand on — is then a pure function of excursion, per
 * leg, and the gait circle radius can be read off it as "how far can this leg
 * be dragged before the drawn foot stops following".
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4403/Thronemound-Colony-Sim/?scene=block';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.drive, null, { timeout: 60000 });
await page.waitForTimeout(2500);

const out = await page.evaluate(() => {
  const lab = window.blockScene;
  const MM = 5;
  const FOOT_CLEARANCE = 0.005 / MM;
  const SLOTS = ['frontLeft', 'frontRight', 'midLeft', 'midRight', 'rearLeft', 'rearRight'];

  // Park her: middle of the top face, stick centred, feet under their homes.
  lab.input.walk = 0; lab.input.yaw = 0;
  lab.up.set(0, 1, 0); lab.forward.set(0, 0, 1);
  lab.at.set(6.7, 13.1 + lab.ride, 6.7);
  lab.gripping = true; lab.fallSpeed = 0;
  lab.drive.plantAll({ at: lab.at, up: lab.up, forward: lab.forward }, lab.groundForLegs);
  lab.stepForTest(1 / 60, 60);

  const sole = {};
  const tip = {};
  for (const s of SLOTS) {
    const n = lab.queen.limbTipName(s);
    tip[s] = lab.queen.bones.get(n);
    sole[s] = FOOT_CLEARANCE + (lab.queen.limbRadius.get(n) ?? 0);
  }
  const scratch = lab.queen.root.position.clone();

  // The ground plane under her, in world terms: the block's top face.
  const surfaceY = lab.surfaceUnder(lab.at.x, lab.at.y, lab.at.z);
  const homeWorld = {};
  for (const l of lab.drive.legs) {
    // up = +Y, forward = +Z, right = up x forward = +X.
    homeWorld[l.slot] = {
      x: lab.at.x + l.home.x, y: lab.at.y + l.home.y, z: lab.at.z + l.home.z,
    };
  }

  const surf = (x, y, z) => lab.surfaceUnder(x, y, z);
  const frame = { up: [0, 1, 0], surface: surf };
  const groundAt = (x, z, y) => surf(x, y, z);

  const sweep = (slot) => {
    const rows = [];
    for (let mm = 2.0; mm >= -3.0; mm -= 0.125) {
      const d = mm / MM;
      const target = {
        x: homeWorld[slot].x,
        y: surfaceY,
        z: homeWorld[slot].z + d,
      };
      // Every other leg stays exactly where the stepper has it; only this one
      // is moved, so nothing else in the solve changes.
      const anchorFor = (id) => {
        if (id === slot) return [target.x, target.y, target.z];
        const a = lab.drive.anchorFor(id);
        return a;
      };
      lab.queen.solveFeet(groundAt, FOOT_CLEARANCE, 1.4 / MM * 2, anchorFor, frame);
      tip[slot].getWorldPosition(scratch);
      const want = { x: target.x, y: target.y + sole[slot], z: target.z };
      const err = Math.hypot(scratch.x - want.x, scratch.y - want.y, scratch.z - want.z);
      rows.push({ ex: +mm.toFixed(3), errMm: +(err * MM).toFixed(3) });
    }
    return rows;
  };

  const res = {};
  for (const s of SLOTS) res[s] = sweep(s);
  return { res, surfaceY, soleMm: Object.fromEntries(SLOTS.map((s) => [s, +(sole[s] * MM).toFixed(3)])) };
});

console.log(JSON.stringify({ errors: errors.slice(0, 3) }));
const ORDER = ['frontLeft', 'frontRight', 'midLeft', 'midRight', 'rearLeft', 'rearRight'];
console.log('\nDrawn-foot tracking error (mm) vs how far the foot is dragged from home along her forward.');
console.log('Positive excursion = foot AHEAD of home (start of stance); negative = BEHIND (end of stance).');
console.log('The gait circle radius is 1.000 mm on a straight walk and 0.400 mm on a spin, so a stance');
console.log('sweeps +1.000 -> -1.000 (walk) or +0.400 -> -0.400 (spin) -- plus the strain overshoot.\n');
const marks = [2.0, 1.5, 1.0, 0.5, 0.0, -0.5, -1.0, -1.25, -1.5, -2.0, -2.5, -3.0];
process.stdout.write('    ex(mm) '.padEnd(14));
for (const m of marks) process.stdout.write(String(m.toFixed(2)).padStart(8));
process.stdout.write('\n');
for (const s of ORDER) {
  process.stdout.write(`    ${s.padEnd(11)}`);
  for (const m of marks) {
    const row = out.res[s].find((r) => Math.abs(r.ex - m) < 1e-6);
    process.stdout.write((row ? row.errMm.toFixed(3) : '  -  ').padStart(8));
  }
  process.stdout.write('\n');
}
console.log('\nWorst error inside the WALK stance band (+1.00 .. -1.00 mm), and inside the band the');
console.log('gait actually reaches once the strain overshoot is counted (+1.00 .. -1.27 mm):');
for (const s of ORDER) {
  const band = out.res[s].filter((r) => r.ex <= 1.0 && r.ex >= -1.0);
  const over = out.res[s].filter((r) => r.ex <= 1.0 && r.ex >= -1.27);
  const spin = out.res[s].filter((r) => r.ex <= 0.4 && r.ex >= -0.4);
  console.log('   ', s.padEnd(12),
    'walk band', Math.max(...band.map((r) => r.errMm)).toFixed(3).padStart(6),
    ' with overshoot', Math.max(...over.map((r) => r.errMm)).toFixed(3).padStart(6),
    ' spin band', Math.max(...spin.map((r) => r.errMm)).toFixed(3).padStart(6));
}
console.log('\nHow far behind home each leg can be dragged before the drawn foot lags by 0.10 mm:');
for (const s of ORDER) {
  const rows = out.res[s].filter((r) => r.ex <= 0.5).sort((a, b) => b.ex - a.ex);
  let limit = null;
  for (const r of rows) if (r.errMm > 0.10) { limit = r.ex; break; }
  console.log('   ', s.padEnd(12), limit === null ? 'never (>3.0 mm)' : `${limit.toFixed(3)} mm`);
}
await browser.close();
