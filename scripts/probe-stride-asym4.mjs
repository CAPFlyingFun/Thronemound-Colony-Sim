/**
 * LENS v4: the rear-foot sawtooth.
 *
 * v3 showed the drawn rear foot drifting 0.02 -> 0.57 mm away from the point
 * the stepper nailed it to, over each stance, then snapping back on lift.
 * This asks WHY: is the rear target outside the leg's reachable sphere (a
 * reach failure), or inside it and simply not converged (a CCD failure)? And
 * how does the drift scale with the stance excursion the gait hands it?
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
  const IK_JOINTS = 3;
  const FOOT_CLEARANCE = 0.005 / MM;
  const SLOTS = ['frontLeft', 'frontRight', 'midLeft', 'midRight', 'rearLeft', 'rearRight'];

  const V = (x, y, z) => ({ x, y, z });
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const sub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
  const add = (a, b) => V(a.x + b.x, a.y + b.y, a.z + b.z);
  const mul = (a, s) => V(a.x * s, a.y * s, a.z * s);
  const len = (a) => Math.sqrt(dot(a, a));
  const cp = (v) => V(v.x, v.y, v.z);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

  // The chain solveFeet actually builds, per leg: bones up to and including
  // the tip, and the joints it is allowed to rotate (the last IK_JOINTS).
  const chains = {};
  for (const legRig of lab.queen.rig.legs) {
    const tipName = lab.queen.limbTipName(legRig.slot);
    const bones = [];
    for (const n of legRig.bones) {
      const b = lab.queen.bones.get(n);
      if (b) bones.push(b);
      if (n === tipName) break;
    }
    chains[legRig.slot] = {
      bones,
      tipName,
      lowest: Math.max(0, bones.length - 1 - IK_JOINTS),
      sole: FOOT_CLEARANCE + (lab.queen.limbRadius.get(tipName) ?? 0),
      mobility: bones.map((b) => lab.queen.boneMobility.get(b.name) ?? 1),
    };
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

  // Static geometry of each chain, from the rest pose: how much bone the
  // solver has between its highest movable joint and the foot.
  seat();
  const geom = {};
  for (const s of SLOTS) {
    const c = chains[s];
    let armLen = 0;
    for (let j = c.lowest; j < c.bones.length - 1; j += 1) {
      armLen += len(sub(worldOf(c.bones[j + 1]), worldOf(c.bones[j])));
    }
    geom[s] = {
      boneCount: c.bones.length,
      lowest: c.lowest,
      armMm: +(armLen * MM).toFixed(3),
      soleMm: +(c.sole * MM).toFixed(3),
      mobility: c.mobility.map((m) => +m.toFixed(2)),
      names: c.bones.map((b) => b.name),
    };
  }

  const run = (walk, yaw, secs) => {
    seat();
    lab.input.walk = walk; lab.input.yaw = yaw;
    const legOf = (s) => lab.drive.legs.find((l) => l.slot === s);
    const per = {};
    for (const s of SLOTS) {
      per[s] = {
        stanceStart: [], stanceEnd: [], stanceDrift: [], residAll: [],
        overreach: [], excursion: [], armSlack: [], samples: [],
      };
      per[s].cur = null;
    }
    const frames = Math.round(secs * 60);
    for (let f = 0; f < frames; f += 1) {
      lab.stepForTest(1 / 60, 1);
      const up = V(lab.up.x, lab.up.y, lab.up.z);
      const fwd = V(lab.forward.x, lab.forward.y, lab.forward.z);
      const rightV = (() => {
        const c = V(up.y * fwd.z - up.z * fwd.y, up.z * fwd.x - up.x * fwd.z,
          up.x * fwd.y - up.y * fwd.x);
        const l = len(c) || 1; return mul(c, 1 / l);
      })();
      for (const s of SLOTS) {
        const l = legOf(s);
        const c = chains[s];
        const want = add(cp(l.at), mul(up, c.sole));
        const foot = worldOf(c.bones[c.bones.length - 1]);
        const resid = len(sub(foot, want));
        per[s].residAll.push(resid);
        // Is the target inside the movable arm's reachable sphere?
        const root = worldOf(c.bones[c.lowest]);
        const need = len(sub(want, root));
        per[s].overreach.push(need - c.armLen);
        per[s].armSlack.push(need);
        if (l.planted) {
          const home = add(add(add(cp(lab.at), mul(rightV, l.home.x)),
            mul(up, l.home.y)), mul(fwd, l.home.z));
          let d = sub(cp(l.anchor), home);
          d = add(d, mul(up, -dot(d, up)));
          const ex = dot(d, fwd); // + = foot ahead of home
          per[s].excursion.push(ex);
          per[s].samples.push({ ex: +(ex * MM).toFixed(3), resid: +(resid * MM).toFixed(3),
            need: +(need * MM).toFixed(3) });
          if (per[s].cur === null) per[s].cur = { first: resid, last: resid };
          else per[s].cur.last = resid;
        } else if (per[s].cur) {
          per[s].stanceStart.push(per[s].cur.first);
          per[s].stanceEnd.push(per[s].cur.last);
          per[s].stanceDrift.push(per[s].cur.last - per[s].cur.first);
          per[s].cur = null;
        }
      }
    }
    lab.input.walk = 0; lab.input.yaw = 0;
    const res = { walk, yaw, legs: {} };
    for (const s of SLOTS) {
      const p = per[s];
      res.legs[s] = {
        stanceStartMm: +(mean(p.stanceStart) * MM).toFixed(3),
        stanceEndMm: +(mean(p.stanceEnd) * MM).toFixed(3),
        stanceDriftMm: +(mean(p.stanceDrift) * MM).toFixed(3),
        residPkPkMm: +((Math.max(...p.residAll) - Math.min(...p.residAll)) * MM).toFixed(3),
        residMaxMm: +(Math.max(...p.residAll) * MM).toFixed(3),
        needMeanMm: +(mean(p.armSlack) * MM).toFixed(3),
        needMaxMm: +(Math.max(...p.armSlack) * MM).toFixed(3),
        exMinMm: +(Math.min(...p.excursion) * MM).toFixed(3),
        exMaxMm: +(Math.max(...p.excursion) * MM).toFixed(3),
        samples: p.samples.slice(0, 40),
      };
    }
    return res;
  };

  // Fill in armLen on the chain objects for the overreach maths above.
  for (const s of SLOTS) chains[s].armLen = geom[s].armMm / MM;

  return { geom, runs: [run(1, 0, 2.4), run(0.5, 0, 2.4), run(0, 1, 2.4)] };
});

console.log(JSON.stringify({ errors: errors.slice(0, 3) }));
const ORDER = ['frontLeft', 'frontRight', 'midLeft', 'midRight', 'rearLeft', 'rearRight'];
console.log('\nIK CHAIN GEOMETRY (rest pose):');
for (const s of ORDER) {
  const g = out.geom[s];
  console.log(' ', s.padEnd(12), 'bones', g.boneCount, 'movable from idx', g.lowest,
    'movable arm', String(g.armMm).padStart(6), 'mm  sole', String(g.soleMm).padStart(5),
    'mobility', JSON.stringify(g.mobility));
}
for (const r of out.runs) {
  console.log(`\n=== walk ${r.walk} yaw ${r.yaw} : drawn-foot residual over each STANCE ===`);
  console.log('    leg          resid@stance-start  resid@stance-end   drift   pk-pk   max   need(mean/max)  excursion(min..max)');
  for (const s of ORDER) {
    const l = r.legs[s];
    console.log('   ', s.padEnd(12), l.stanceStartMm.toFixed(3).padStart(14),
      l.stanceEndMm.toFixed(3).padStart(18), l.stanceDriftMm.toFixed(3).padStart(8),
      l.residPkPkMm.toFixed(3).padStart(7), l.residMaxMm.toFixed(3).padStart(6),
      `${l.needMeanMm.toFixed(2)}/${l.needMaxMm.toFixed(2)}`.padStart(15),
      `${l.exMinMm.toFixed(2)}..${l.exMaxMm.toFixed(2)}`.padStart(19));
  }
  console.log('    rearLeft  (excursion mm, residual mm, root->target mm) first 40 stance frames:');
  console.log('     ', r.legs.rearLeft.samples.map((x) => `${x.ex}/${x.resid}/${x.need}`).join(' '));
  console.log('    frontLeft:');
  console.log('     ', r.legs.frontLeft.samples.map((x) => `${x.ex}/${x.resid}/${x.need}`).join(' '));
}
await browser.close();
