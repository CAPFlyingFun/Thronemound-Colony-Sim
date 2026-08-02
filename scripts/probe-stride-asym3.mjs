/**
 * LENS v3: pin down (a) whether the phone stick can even reach a mixed
 * walk+yaw, which is the only input where the per-leg radius blend differs at
 * all, and (b) the rear-leg wobble, measured on the DRAWN bone with the
 * `sole` offset removed so the residual is honest.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4403/Thronemound-Colony-Sim/?scene=block';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
// iPhone-ish landscape, as reported.
const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.drive, null, { timeout: 60000 });
await page.waitForTimeout(2500);

/* ---- (a) what the real touch stick can produce -------------------------- */
const stickOut = await page.evaluate(() => {
  const lab = window.blockScene;
  const canvas = lab.renderer.domElement;
  const fire = (type, x, y, id) => canvas.dispatchEvent(new PointerEvent(type, {
    pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true,
  }));
  const R = 70;
  const ox = 150; const oy = 300;
  const samples = [];
  fire('pointerdown', ox, oy, 1);
  // Walk the thumb right around the stick's rim, 24 bearings.
  for (let i = 0; i < 24; i += 1) {
    const a = (i / 24) * Math.PI * 2;
    fire('pointermove', ox + Math.cos(a) * R, oy + Math.sin(a) * R, 1);
    samples.push({
      degFromUp: +((Math.atan2(Math.cos(a), -Math.sin(a)) * 180 / Math.PI + 360) % 360).toFixed(0),
      walk: +lab.input.walk.toFixed(3),
      yaw: +lab.input.yaw.toFixed(3),
    });
  }
  fire('pointerup', ox, oy, 1);
  lab.input.walk = 0; lab.input.yaw = 0;
  const both = samples.filter((s) => Math.abs(s.walk) > 1e-6 && Math.abs(s.yaw) > 1e-6);
  return { samples, bothCount: both.length, total: samples.length };
});

/* ---- (b) the drawn rear foot -------------------------------------------- */
const out = await page.evaluate(() => {
  const lab = window.blockScene;
  const MM = 5;
  const SLOTS = ['frontLeft', 'frontRight', 'midLeft', 'midRight', 'rearLeft', 'rearRight'];
  const FOOT_CLEARANCE = 0.005 / MM;

  const V = (x, y, z) => ({ x, y, z });
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const sub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
  const add = (a, b) => V(a.x + b.x, a.y + b.y, a.z + b.z);
  const mul = (a, s) => V(a.x * s, a.y * s, a.z * s);
  const len = (a) => Math.sqrt(dot(a, a));
  const cp = (v) => V(v.x, v.y, v.z);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

  const tip = {};
  const sole = {};
  for (const s of SLOTS) {
    const n = lab.queen.limbTipName(s);
    tip[s] = n ? lab.queen.bones.get(n) : null;
    sole[s] = FOOT_CLEARANCE + (n ? (lab.queen.limbRadius.get(n) ?? 0) : 0);
  }
  const scratch = lab.queen.root.position.clone();
  const worldOf = (b) => { b.getWorldPosition(scratch); return V(scratch.x, scratch.y, scratch.z); };

  const seat = () => {
    lab.input.walk = 0; lab.input.yaw = 0;
    lab.up.set(0, 1, 0); lab.forward.set(0, 0, 1);
    lab.at.set(6.7, 13.1 + lab.ride, 6.7);
    lab.gripping = true; lab.fallSpeed = 0;
    lab.drive.plantAll({ at: lab.at, up: lab.up, forward: lab.forward }, lab.groundForLegs);
    lab.stepForTest(1 / 60, 30);
  };

  const run = (walk, yaw, secs) => {
    seat();
    lab.input.walk = walk; lab.input.yaw = yaw;
    const legOf = (s) => lab.drive.legs.find((l) => l.slot === s);
    const per = {};
    const prevBone = {}; const prevPlanted = {};
    for (const s of SLOTS) {
      per[s] = { resid: [], skateAcross: [], skateAlong: [], planted: 0, trace: [] };
      prevBone[s] = tip[s] ? worldOf(tip[s]) : null;
      prevPlanted[s] = legOf(s).planted;
    }
    const frames = Math.round(secs * 60);
    for (let f = 0; f < frames; f += 1) {
      lab.stepForTest(1 / 60, 1);
      for (const s of SLOTS) {
        const l = legOf(s);
        if (!tip[s]) continue;
        const b = worldOf(tip[s]);
        const up = V(lab.up.x, lab.up.y, lab.up.z);
        // Target the IK was actually handed: leg.at raised by this bone's sole.
        const want = add(cp(l.at), mul(up, sole[s]));
        per[s].resid.push(len(sub(b, want)));
        if (l.planted && prevPlanted[s] && prevBone[s]) {
          const d = sub(b, prevBone[s]);
          const along = dot(d, up);
          const across = len(sub(d, mul(up, along)));
          per[s].skateAlong.push(Math.abs(along));
          per[s].skateAcross.push(across);
          per[s].planted += 1;
        }
        // Trace: how far the drawn foot sits from where the stepper nailed it.
        if (l.planted) {
          const e = sub(b, want);
          per[s].trace.push(+(len(e) * MM).toFixed(3));
        } else per[s].trace.push(null);
        prevBone[s] = b;
        prevPlanted[s] = l.planted;
      }
    }
    lab.input.walk = 0; lab.input.yaw = 0;
    const res = { walk, yaw, legs: {} };
    for (const s of SLOTS) {
      const p = per[s];
      res.legs[s] = {
        soleMm: +(sole[s] * MM).toFixed(3),
        residMeanMm: +(mean(p.resid) * MM).toFixed(4),
        residMaxMm: +(Math.max(...p.resid) * MM).toFixed(4),
        skateAcrossMmS: +(mean(p.skateAcross) * MM * 60).toFixed(3),
        skateAlongMmS: +(mean(p.skateAlong) * MM * 60).toFixed(3),
        skateAcrossPeakMmS: +(Math.max(...p.skateAcross) * MM * 60).toFixed(3),
        plantedFrames: p.planted,
        trace: p.trace.slice(0, 90),
      };
    }
    return res;
  };

  return { runs: [run(1, 0, 2.4), run(0, 1, 2.4), run(1, 0.4, 2.4)] };
});

console.log(JSON.stringify({ errors: errors.slice(0, 3) }));
console.log('\n--- (a) what the on-screen stick can produce ---');
console.log(`frames with BOTH walk and yaw non-zero: ${stickOut.bothCount} / ${stickOut.total}`);
console.log(stickOut.samples.map((s) => `${String(s.degFromUp).padStart(3)}deg w=${s.walk} y=${s.yaw}`).join('\n'));

const ORDER = ['frontLeft', 'frontRight', 'midLeft', 'midRight', 'rearLeft', 'rearRight'];
for (const r of out.runs) {
  console.log(`\n--- (b) drawn foot, walk ${r.walk} yaw ${r.yaw} ---`);
  console.log('    leg          sole   resid(mean/max)   plantedSkate across  along  acrossPeak  (mm/s)');
  for (const s of ORDER) {
    const l = r.legs[s];
    console.log('   ', s.padEnd(12), l.soleMm.toFixed(3).padStart(6),
      `${l.residMeanMm.toFixed(3)}/${l.residMaxMm.toFixed(3)}`.padStart(16),
      l.skateAcrossMmS.toFixed(3).padStart(20), l.skateAlongMmS.toFixed(3).padStart(7),
      l.skateAcrossPeakMmS.toFixed(3).padStart(11));
  }
  console.log('    rearLeft   trace of |drawn - target| while planted (mm), first 90 frames:');
  console.log('     ', JSON.stringify(r.legs.rearLeft.trace));
  console.log('    frontLeft  trace:');
  console.log('     ', JSON.stringify(r.legs.frontLeft.trace));
  console.log('    midLeft    trace:');
  console.log('     ', JSON.stringify(r.legs.midLeft.trace));
}
await browser.close();
