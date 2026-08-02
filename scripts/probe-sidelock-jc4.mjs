/**
 * In the locked state: which leg refuses which direction, and why can the
 * gait not fire? Replicates legDrive's clip in-page so the binding leg can be
 * named for an arbitrary probe displacement.
 *
 * Also sweeps the walk throttle on the SAME (-X) approach, and repeats the
 * +Z approach at several throttles, to test "is the lock face-specific or
 * gait-phase-specific".
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4401/Thronemound-Colony-Sim/?scene=block';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const HELPERS = `
  var MM = 5;
  var SLOTS = ['frontLeft','frontRight','midLeft','midRight','rearLeft','rearRight'];
  function V(x,y,z){return {x:x,y:y,z:z};}
  function sub(a,b){return V(a.x-b.x,a.y-b.y,a.z-b.z);}
  function dot(a,b){return a.x*b.x+a.y*b.y+a.z*b.z;}
  function cross(a,b){return V(a.y*b.z-a.z*b.y,a.z*b.x-a.x*b.z,a.x*b.y-a.y*b.x);}
  function scale(a,s){return V(a.x*s,a.y*s,a.z*s);}
  function add(a,b){return V(a.x+b.x,a.y+b.y,a.z+b.z);}
  function len(a){return Math.sqrt(dot(a,a));}
  function norm(a){var l=len(a)||1;return scale(a,1/l);}
  function excFor(leg, at, up, fwd){
    var right = norm(cross(up,fwd));
    var homeW = add(add(add(at, scale(right, leg.home.x)), scale(up, leg.home.y)), scale(fwd, leg.home.z));
    var d = sub(homeW, V(leg.anchor.x,leg.anchor.y,leg.anchor.z));
    return sub(d, scale(up, dot(d,up)));
  }
`;

const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.drive, null, { timeout: 60000 });
await page.waitForTimeout(2000);

const lock = await page.evaluate((H) => {
  eval(H);
  const lab = window.blockScene;
  // Turn right 90 then walk into the lock.
  lab.input.walk = 0; lab.input.yaw = -1;
  lab.stepForTest(1 / 60, 43);
  lab.input.yaw = 0; lab.input.walk = 1;
  lab.stepForTest(1 / 60, 700);
  lab.input.walk = 0;

  const at = V(lab.at.x, lab.at.y, lab.at.z);
  const up = V(lab.up.x, lab.up.y, lab.up.z);
  const fwd = V(lab.forward.x, lab.forward.y, lab.forward.z);

  const state = SLOTS.map((s) => {
    const leg = lab.drive.legs.find((l) => l.slot === s);
    const e = excFor(leg, at, up, fwd);
    return {
      slot: s, planted: leg.planted, groping: leg.groping, t: +leg.t.toFixed(2),
      exc: +(len(e) * MM).toFixed(4), spread: +(leg.spread * MM).toFixed(4),
      ratio: +(len(e) / leg.spread).toFixed(4),
      along: +(dot(e, V(leg.dir.x, leg.dir.y, leg.dir.z)) * MM).toFixed(4),
      spentPct: +((dot(e, V(leg.dir.x, leg.dir.y, leg.dir.z)) * MM) / 1.0).toFixed(4),
      dir: [leg.dir.x, leg.dir.y, leg.dir.z].map((n) => +n.toFixed(3)),
      anchor: [leg.anchor.x, leg.anchor.y, leg.anchor.z].map((n) => +(n * MM).toFixed(2)),
      footAt: [leg.at.x, leg.at.y, leg.at.z].map((n) => +(n * MM).toFixed(2)),
      down: +(leg.down * MM).toFixed(2),
    };
  });

  // Which leg refuses a nudge in a given world direction?
  const nudge = (d, mm) => {
    const step = scale(norm(d), mm / MM);
    const at2 = add(at, step);
    const rows = [];
    for (const s of SLOTS) {
      const leg = lab.drive.legs.find((l) => l.slot === s);
      if (!leg.planted) continue;
      const now = len(excFor(leg, at, up, fwd));
      const limit = Math.max(leg.spread, now);
      const then = len(excFor(leg, at2, up, fwd));
      rows.push({
        slot: s, nowMm: +(now * MM).toFixed(4), limitMm: +(limit * MM).toFixed(4),
        thenMm: +(then * MM).toFixed(4), refuses: then > limit,
      });
    }
    return rows;
  };

  const dirs = {
    'forward (down face)': V(fwd.x, fwd.y, fwd.z),
    'backward (up face)': scale(fwd, -1),
    'right': norm(cross(up, fwd)),
    'left': scale(norm(cross(up, fwd)), -1),
  };
  const refusals = {};
  for (const [k, d] of Object.entries(dirs)) refusals[k] = nudge(d, 0.02);

  // What does the ground under the groping leg's target look like?
  const grope = lab.drive.legs.filter((l) => !l.planted).map((leg) => {
    const right = norm(cross(up, fwd));
    const homeW = add(add(add(at, scale(right, leg.home.x)), scale(up, leg.home.y)), scale(fwd, leg.home.z));
    const ahead = add(homeW, scale(V(leg.dir.x, leg.dir.y, leg.dir.z), 1.0 / MM));
    return {
      slot: leg.slot, groping: leg.groping, t: +leg.t.toFixed(2),
      homeW: [homeW.x, homeW.y, homeW.z].map((n) => +(n * MM).toFixed(2)),
      ahead: [ahead.x, ahead.y, ahead.z].map((n) => +(n * MM).toFixed(2)),
      down: +(leg.down * MM).toFixed(2),
      dir: [leg.dir.x, leg.dir.y, leg.dir.z].map((n) => +n.toFixed(3)),
      solidAtAhead: lab.densityAt(ahead.x, ahead.y, ahead.z) > 0,
      densityAhead: +lab.densityAt(ahead.x, ahead.y, ahead.z).toFixed(4),
    };
  });

  return {
    at: [at.x, at.y, at.z].map((n) => +(n * MM).toFixed(3)),
    up: [up.x, up.y, up.z].map((n) => +n.toFixed(4)),
    fwd: [fwd.x, fwd.y, fwd.z].map((n) => +n.toFixed(4)),
    report: lab.report, state, refusals, grope,
  };
}, HELPERS);

console.log('errors', JSON.stringify(errors.slice(0, 3)));
console.log('\n=== LOCKED STATE ===');
console.log('at(mm)', JSON.stringify(lock.at), 'up', JSON.stringify(lock.up), 'fwd', JSON.stringify(lock.fwd));
console.log('report', JSON.stringify(lock.report));
console.log('\nleg          state   exc/spread          ratio  along(mm) spent%  dir                    anchor(mm)');
for (const l of lock.state) {
  console.log(
    l.slot.padEnd(12), (l.planted ? 'DOWN ' : (l.groping ? 'GROPE' : 'swing')),
    `${l.exc.toFixed(3).padStart(7)} / ${l.spread.toFixed(3).padEnd(6)}`,
    l.ratio.toFixed(3).padStart(6), l.along.toFixed(3).padStart(9),
    (l.spentPct * 100).toFixed(0).padStart(5) + '%',
    JSON.stringify(l.dir).padEnd(22), JSON.stringify(l.anchor),
  );
}
console.log('\n=== who refuses a 0.02 mm nudge ===');
for (const [k, rows] of Object.entries(lock.refusals)) {
  const bad = rows.filter((r) => r.refuses);
  console.log(k.padEnd(22), bad.length ? bad.map((r) => `${r.slot} ${r.nowMm}->${r.thenMm} > ${r.limitMm}`).join('; ') : 'nobody refuses');
}
console.log('\n=== legs in the air ===');
for (const g of lock.grope) console.log(JSON.stringify(g));
await page.close();

// --- phase sweep: does the +Z approach ever lock, at other throttles?
const sweep = async (yawSign, yawFrames, label, throttles) => {
  for (const th of throttles) {
    const p = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
    await p.goto(URL, { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => window.blockScene?.drive, null, { timeout: 60000 });
    await p.waitForTimeout(1500);
    const r = await p.evaluate(({ yawSign, yawFrames, th }) => {
      const lab = window.blockScene;
      lab.input.walk = 0; lab.input.yaw = yawSign;
      if (yawFrames) lab.stepForTest(1 / 60, yawFrames);
      lab.input.yaw = 0; lab.input.walk = th;
      let stuckRun = 0; let worst = 0;
      const N = 60 * 40;
      for (let i = 0; i < N; i += 1) {
        lab.stepForTest(1 / 60, 1);
        if (lab.report.movedMm < 0.001) stuckRun += 1; else stuckRun = 0;
        worst = Math.max(worst, stuckRun);
        if (stuckRun > 240) break;
      }
      lab.input.walk = 0;
      return {
        stuckRun, worst,
        up: [lab.up.x, lab.up.y, lab.up.z].map((n) => +n.toFixed(2)),
        at: [lab.at.x, lab.at.y, lab.at.z].map((n) => +(n * 5).toFixed(2)),
        strain: +lab.report.strain.toFixed(3), allowed: +lab.report.allowed.toFixed(3),
      };
    }, { yawSign, yawFrames, th });
    console.log(`${label} throttle ${th}  ->`, r.stuckRun > 240 ? 'LOCKED' : 'kept going',
      'longestStall', r.worst, 'frames  up', JSON.stringify(r.up), 'at', JSON.stringify(r.at),
      'strain', r.strain, 'allowed', r.allowed);
    await p.close();
  }
};
console.log('\n=== throttle sweep, +Z approach (no pre-turn) ===');
await sweep(0, 0, '+Z', [1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.6]);
console.log('\n=== throttle sweep, -X approach (turn right 90 first) ===');
await sweep(-1, 43, '-X', [1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.6]);
await browser.close();
