/**
 * LENS: stride-length asymmetry between the legs — the "dancing back feet".
 *
 * v2: runs are 2.4 s so she can never reach an edge (8 mm/s x 2.4 s = 19.2 mm
 * from the middle of a 64 mm face, 32 mm of room). Adds the DRAWN foot: the
 * tip bone the IK actually solves, so "wiggle" is measured on the thing the
 * player sees and not only on the stepper's target.
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

const out = await page.evaluate(async () => {
  const THREE = window.__three ?? null;
  const lab = window.blockScene;
  const MM = 5;
  const WALK_SPEED = 1.6;
  const YAW_RATE = 2.2;
  const SLOTS = ['frontLeft', 'frontRight', 'midLeft', 'midRight', 'rearLeft', 'rearRight'];
  const TRIPOD_A = ['frontLeft', 'midRight', 'rearLeft'];

  const V = (x, y, z) => ({ x, y, z });
  const cross = (a, b) => V(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const len = (a) => Math.sqrt(dot(a, a));
  const add = (a, b) => V(a.x + b.x, a.y + b.y, a.z + b.z);
  const sub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
  const mul = (a, s) => V(a.x * s, a.y * s, a.z * s);
  const norm = (a) => { const l = len(a) || 1; return mul(a, 1 / l); };
  const cp = (v) => V(v.x, v.y, v.z);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };

  const travelOf = (leg, up, forward, walk, yaw) => {
    const right = norm(cross(up, forward));
    const offset = add(add(mul(right, leg.home.x), mul(up, leg.home.y)), mul(forward, leg.home.z));
    const linear = mul(forward, WALK_SPEED * walk);
    const angular = mul(cross(up, offset), YAW_RATE * yaw);
    const rotSpeed = len(angular);
    const into = add(linear, angular);
    const speed = len(into);
    const turn = speed > 1e-9 ? Math.min(1, rotSpeed / speed) : 0;
    return { speed, turn, radius: (2.0 + (0.8 - 2.0) * turn) / 2 / MM };
  };

  // The bone the IK actually solves to, per leg.
  const tipBone = {};
  for (const s of SLOTS) {
    const n = lab.queen.limbTipName(s);
    tipBone[s] = n ? lab.queen.bones.get(n) : null;
  }
  const scratch = lab.queen.root.position.clone();
  const worldOf = (bone) => {
    bone.getWorldPosition(scratch);
    return V(scratch.x, scratch.y, scratch.z);
  };

  const seat = () => {
    lab.input.walk = 0; lab.input.yaw = 0;
    lab.up.set(0, 1, 0);
    lab.forward.set(0, 0, 1);
    lab.at.set(6.7, 13.1 + lab.ride, 6.7);
    lab.gripping = true;
    lab.fallSpeed = 0;
    lab.drive.plantAll({ at: lab.at, up: lab.up, forward: lab.forward }, lab.groundForLegs);
    lab.stepForTest(1 / 60, 30);
  };

  const run = (walk, yaw, secs) => {
    seat();
    lab.input.walk = walk;
    lab.input.yaw = yaw;
    const legOf = (s) => lab.drive.legs.find((l) => l.slot === s);

    const per = {};
    const prevPlanted = {};
    const lastAnchor = {};
    const prevBone = {};
    for (const s of SLOTS) {
      per[s] = {
        lifts: 0, jumps: [], radii: [], turnFrac: [], peakAt: -1e9, peakBone: -1e9,
        spentAtSwap: [], plantedBoneStep: [], boneErr: [], plantedAtStep: [], cycleFrames: [],
      };
      const l = legOf(s);
      prevPlanted[s] = l.planted;
      lastAnchor[s] = cp(l.anchor);
      prevBone[s] = tipBone[s] ? worldOf(tipBone[s]) : null;
      per[s].lastLiftFrame = -1;
      per[s].prevAt = cp(l.at);
    }

    let maxOff = 0; let minUpY = 1; let movedMm = 0; let heldMm = 0;
    let swaps = 0; let gropeFrames = 0; let strainMax = 0;
    const frames = Math.round(secs * 60);

    for (let f = 0; f < frames; f += 1) {
      const before = {};
      for (const s of SLOTS) {
        const l = legOf(s);
        if (!l.planted) continue;
        const right = norm(cross(lab.up, lab.forward));
        const home = add(add(add(cp(lab.at), mul(right, l.home.x)),
          mul(lab.up, l.home.y)), mul(lab.forward, l.home.z));
        let d = sub(home, cp(l.anchor));
        d = add(d, mul(lab.up, -dot(d, lab.up)));
        before[s] = dot(d, l.dir) / travelOf(l, lab.up, lab.forward, walk, yaw).radius;
      }

      lab.stepForTest(1 / 60, 1);

      const r = lab.report;
      if (r) {
        movedMm += r.movedMm; heldMm += r.heldBackMm; gropeFrames += r.groping;
        if (r.strain > strainMax) strainMax = r.strain;
      }
      let lifted = false;
      for (const s of SLOTS) {
        const l = legOf(s);
        const t = travelOf(l, lab.up, lab.forward, walk, yaw);
        per[s].radii.push(t.radius);
        per[s].turnFrac.push(t.turn);

        const atH = dot(cp(l.at), lab.up) - lab.surfaceUnder(l.at.x, l.at.y, l.at.z);
        if (atH > per[s].peakAt) per[s].peakAt = atH;

        const b = tipBone[s] ? worldOf(tipBone[s]) : null;
        if (b) {
          const bH = dot(b, lab.up) - lab.surfaceUnder(b.x, b.y, b.z);
          if (bH > per[s].peakBone) per[s].peakBone = bH;
          per[s].boneErr.push(len(sub(b, cp(l.at))));
          if (l.planted && prevPlanted[s] && prevBone[s]) {
            per[s].plantedBoneStep.push(len(sub(b, prevBone[s])));
            per[s].plantedAtStep.push(len(sub(cp(l.at), per[s].prevAt)));
          }
          prevBone[s] = b;
        }
        per[s].prevAt = cp(l.at);

        if (prevPlanted[s] && !l.planted) {
          per[s].lifts += 1;
          lifted = true;
          if (per[s].lastLiftFrame >= 0) per[s].cycleFrames.push(f - per[s].lastLiftFrame);
          per[s].lastLiftFrame = f;
          for (const k of SLOTS) if (before[k] !== undefined) per[k].spentAtSwap.push(before[k]);
        }
        if (!prevPlanted[s] && l.planted) {
          const a = cp(l.anchor);
          per[s].jumps.push(len(sub(a, lastAnchor[s])));
          lastAnchor[s] = a;
        }
        prevPlanted[s] = l.planted;
      }
      if (lifted) swaps += 1;
      const off = Math.hypot(lab.at.x - 6.7, lab.at.z - 6.7);
      if (off > maxOff) maxOff = off;
      if (lab.up.y < minUpY) minUpY = lab.up.y;
    }
    lab.input.walk = 0; lab.input.yaw = 0;

    const res = {
      walk, yaw, secs, swaps, movedMm: +movedMm.toFixed(2), heldMm: +heldMm.toFixed(2),
      gropeFrames, strainMax: +strainMax.toFixed(2),
      maxOffMm: +(maxOff * MM).toFixed(1), minUpY: +minUpY.toFixed(4), legs: {},
    };
    for (const s of SLOTS) {
      const p = per[s];
      res.legs[s] = {
        tripod: TRIPOD_A.includes(s) ? 'A' : 'B',
        lifts: p.lifts,
        steps: p.jumps.length,
        cycleFrames: +mean(p.cycleFrames).toFixed(2),
        jumpMeanMm: +(mean(p.jumps) * MM).toFixed(3),
        jumpSdMm: +(sd(p.jumps) * MM).toFixed(3),
        radiusMm: +(mean(p.radii) * MM).toFixed(4),
        turnFrac: +mean(p.turnFrac).toFixed(4),
        peakAtMm: +(p.peakAt * MM).toFixed(4),
        peakBoneMm: +(p.peakBone * MM).toFixed(4),
        boneErrMeanMm: +(mean(p.boneErr) * MM).toFixed(4),
        boneErrMaxMm: +(Math.max(...p.boneErr) * MM).toFixed(4),
        // A PLANTED foot should be nailed to the world. Any per-frame motion
        // of the drawn bone while planted is visible skating.
        plantedAtStepMm: +(mean(p.plantedAtStep) * MM * 60).toFixed(4),
        plantedBoneStepMm: +(mean(p.plantedBoneStep) * MM * 60).toFixed(4),
        plantedBoneStepMaxMm: +(Math.max(...p.plantedBoneStep) * MM * 60).toFixed(4),
        spentAtSwapMax: +(p.spentAtSwap.length ? Math.max(...p.spentAtSwap) : 0).toFixed(3),
        spentAtSwapMean: +mean(p.spentAtSwap).toFixed(3),
      };
    }
    return res;
  };

  const homes = {};
  for (const l of lab.drive.legs) {
    homes[l.slot] = {
      homeMm: [l.home.x * MM, l.home.y * MM, l.home.z * MM].map((n) => +n.toFixed(3)),
      rMm: +(Math.hypot(l.home.x, l.home.z) * MM).toFixed(3),
      spreadMm: +(l.spread * MM).toFixed(3),
      tip: lab.queen.limbTipName(l.slot),
    };
  }

  return {
    homes,
    runs: [run(1, 0, 2.4), run(1, 0.15, 2.4), run(1, 0.4, 2.4), run(0, 1, 2.4),
      run(0.5, 0, 2.4), run(0, 0.3, 2.4)],
  };
});

console.log(JSON.stringify({ errors: errors.slice(0, 3) }));
console.log('LEG GEOMETRY:');
for (const [s, h] of Object.entries(out.homes)) {
  console.log(' ', s.padEnd(11), 'home', JSON.stringify(h.homeMm).padEnd(26),
    '|r|', String(h.rMm).padStart(6), 'spread', String(h.spreadMm).padStart(6), h.tip);
}
const ORDER = ['frontLeft', 'frontRight', 'midLeft', 'midRight', 'rearLeft', 'rearRight'];
for (const r of out.runs) {
  console.log(`\n=== walk ${r.walk}  yaw ${r.yaw}  (${r.secs}s) ===`);
  console.log(`    moved ${r.movedMm} mm  held ${r.heldMm} mm  swaps ${r.swaps}  grope-fr ${r.gropeFrames}`
    + `  strainMax ${r.strainMax}  offCentre ${r.maxOffMm} mm  minUpY ${r.minUpY}`);
  console.log('    leg          tri lifts  cyc  radius turnFr  jumpMean  jumpSd  peak(at) peak(bone) boneErr(mean/max) plantedSkate(at/bone/max, mm/s) spent@swap(mean/max)');
  for (const s of ORDER) {
    const l = r.legs[s];
    console.log('   ', s.padEnd(12), l.tripod.padStart(3), String(l.lifts).padStart(5),
      l.cycleFrames.toFixed(1).padStart(5), l.radiusMm.toFixed(3).padStart(7),
      l.turnFrac.toFixed(3).padStart(6), l.jumpMeanMm.toFixed(3).padStart(9),
      l.jumpSdMm.toFixed(3).padStart(7), l.peakAtMm.toFixed(3).padStart(9),
      l.peakBoneMm.toFixed(3).padStart(10),
      `${l.boneErrMeanMm.toFixed(3)}/${l.boneErrMaxMm.toFixed(3)}`.padStart(17),
      `${l.plantedAtStepMm.toFixed(2)}/${l.plantedBoneStepMm.toFixed(2)}/${l.plantedBoneStepMaxMm.toFixed(2)}`.padStart(30),
      `${l.spentAtSwapMean.toFixed(2)}/${l.spentAtSwapMax.toFixed(2)}`.padStart(14));
  }
  const f = (r.legs.frontLeft.lifts + r.legs.frontRight.lifts) / 2;
  const m = (r.legs.midLeft.lifts + r.legs.midRight.lifts) / 2;
  const b = (r.legs.rearLeft.lifts + r.legs.rearRight.lifts) / 2;
  console.log(`    LIFTS front ${f} mid ${m} rear ${b}   REAR/FRONT ${f ? (b / f).toFixed(3) : 'n/a'}`);
  const jf = (r.legs.frontLeft.jumpMeanMm + r.legs.frontRight.jumpMeanMm) / 2;
  const jm = (r.legs.midLeft.jumpMeanMm + r.legs.midRight.jumpMeanMm) / 2;
  const jb = (r.legs.rearLeft.jumpMeanMm + r.legs.rearRight.jumpMeanMm) / 2;
  console.log(`    STEP LEN front ${jf.toFixed(3)} mid ${jm.toFixed(3)} rear ${jb.toFixed(3)} mm  `
    + `REAR/FRONT ${(jb / jf).toFixed(3)}`);
  const rf = (r.legs.frontLeft.radiusMm + r.legs.frontRight.radiusMm) / 2;
  const rm = (r.legs.midLeft.radiusMm + r.legs.midRight.radiusMm) / 2;
  const rb = (r.legs.rearLeft.radiusMm + r.legs.rearRight.radiusMm) / 2;
  console.log(`    RADIUS   front ${rf.toFixed(3)} mid ${rm.toFixed(3)} rear ${rb.toFixed(3)} mm  `
    + `REAR/FRONT ${(rb / rf).toFixed(3)}  spread(min/max) `
    + `${Math.min(...ORDER.map((s) => r.legs[s].radiusMm)).toFixed(3)}/`
    + `${Math.max(...ORDER.map((s) => r.legs[s].radiusMm)).toFixed(3)}`);
}
await browser.close();
