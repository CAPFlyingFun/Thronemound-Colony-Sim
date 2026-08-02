/**
 * LENS: stride-length asymmetry between the legs — the "dancing back feet".
 *
 * legDrive blends STRIDE_MM.walk -> STRIDE_MM.turn per leg by that leg's own
 * ratio of rotational to total travel speed. Rear legs sit further from the
 * turn axis, so |w x r| is bigger there and the blend pushes them toward the
 * SHORT stride. This measures, per leg and per stick setting:
 *   - lifts (planted -> airborne transitions)
 *   - mean straight-line anchor jump per re-plant (the actual step length)
 *   - the effective gait radius the code handed that leg
 *   - peak height of the drawn foot (leg.at) above the soil
 * and the rear/front step-count ratio.
 *
 * She is re-seated on the middle of the TOP face before every run so no run
 * can reach an edge.
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
  const WALK_SPEED = 1.6;
  const YAW_RATE = 2.2;
  const SLOTS = ['frontLeft', 'frontRight', 'midLeft', 'midRight', 'rearLeft', 'rearRight'];
  const TRIPOD_A = ['frontLeft', 'midRight', 'rearLeft'];

  const V = (x, y, z) => ({ x, y, z });
  const cross = (a, b) => V(
    a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x,
  );
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const len = (a) => Math.sqrt(dot(a, a));
  const add = (a, b) => V(a.x + b.x, a.y + b.y, a.z + b.z);
  const mul = (a, s) => V(a.x * s, a.y * s, a.z * s);
  const norm = (a) => { const l = len(a) || 1; return mul(a, 1 / l); };
  const cp = (v) => V(v.x, v.y, v.z);

  /** Faithful re-implementation of LegDrive.travel + radiusFor. */
  const travelOf = (leg, up, forward, walk, yaw) => {
    const right = norm(cross(up, forward));
    const offset = add(add(mul(right, leg.home.x), mul(up, leg.home.y)), mul(forward, leg.home.z));
    const linear = mul(forward, WALK_SPEED * walk);
    const angular = mul(cross(up, offset), YAW_RATE * yaw);
    const rotSpeed = len(angular);
    const into = add(linear, angular);
    const speed = len(into);
    const turn = speed > 1e-9 ? Math.min(1, rotSpeed / speed) : 0;
    const mm = 2.0 + (0.8 - 2.0) * turn;
    return { speed, turn, radius: mm / 2 / MM, dir: speed > 1e-9 ? mul(into, 1 / speed) : null };
  };

  const seat = () => {
    // Middle of the top face, facing +Z, feet re-planted.
    lab.input.walk = 0; lab.input.yaw = 0;
    lab.up.set(0, 1, 0);
    lab.forward.set(0, 0, 1);
    lab.at.set(6.7, 13.1 + lab.ride, 6.7);
    lab.gripping = true;
    lab.fallSpeed = 0;
    lab.drive.plantAll({ at: lab.at, up: lab.up, forward: lab.forward }, lab.groundForLegs);
    lab.stepForTest(1 / 60, 30); // settle with the stick centred
  };

  const run = (walk, yaw, secs) => {
    seat();
    const start = cp(lab.at);
    lab.input.walk = walk;
    lab.input.yaw = yaw;

    const per = {};
    for (const s of SLOTS) {
      per[s] = {
        lifts: 0, jumps: [], radii: [], radiiAtPlant: [], peakAbove: -1e9,
        spentAtSwap: [], turnFrac: [],
      };
    }
    const legOf = (s) => lab.drive.legs.find((l) => l.slot === s);
    const prevPlanted = {};
    const lastAnchor = {};
    for (const s of SLOTS) {
      const l = legOf(s);
      prevPlanted[s] = l.planted;
      lastAnchor[s] = cp(l.anchor);
    }

    let maxOff = 0;
    let minUpY = 1;
    let movedMm = 0;
    let heldMm = 0;
    let swaps = 0;
    const frames = Math.round(secs * 60);
    let gropeFrames = 0;

    for (let f = 0; f < frames; f += 1) {
      // Sample how spent each planted foot is BEFORE the step, so a swap
      // frame shows who was over its circle.
      const before = {};
      for (const s of SLOTS) {
        const l = legOf(s);
        if (!l.planted) continue;
        const right = norm(cross(lab.up, lab.forward));
        const home = add(add(add(cp(lab.at), mul(right, l.home.x)),
          mul(lab.up, l.home.y)), mul(lab.forward, l.home.z));
        let d = V(home.x - l.anchor.x, home.y - l.anchor.y, home.z - l.anchor.z);
        d = add(d, mul(lab.up, -dot(d, lab.up)));
        const t = travelOf(l, lab.up, lab.forward, walk, yaw);
        before[s] = dot(d, l.dir) / t.radius;
      }

      lab.stepForTest(1 / 60, 1);

      const r = lab.report;
      if (r) { movedMm += r.movedMm; heldMm += r.heldBackMm; gropeFrames += r.groping; }

      let lifted = false;
      for (const s of SLOTS) {
        const l = legOf(s);
        const t = travelOf(l, lab.up, lab.forward, walk, yaw);
        per[s].radii.push(t.radius);
        per[s].turnFrac.push(t.turn);
        // Height of the DRAWN foot above the soil, along her up.
        const surf = lab.surfaceUnder(l.at.x, l.at.y, l.at.z);
        const above = dot(l.at, lab.up) - surf;
        if (above > per[s].peakAbove) per[s].peakAbove = above;

        if (prevPlanted[s] && !l.planted) {
          per[s].lifts += 1;
          lifted = true;
          for (const k of SLOTS) if (before[k] !== undefined) per[k].spentAtSwap.push(before[k]);
          per[s].radiiAtPlant.push(t.radius);
        }
        if (!prevPlanted[s] && l.planted) {
          const a = cp(l.anchor);
          const p = lastAnchor[s];
          per[s].jumps.push(Math.hypot(a.x - p.x, a.y - p.y, a.z - p.z));
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

    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const res = { walk, yaw, secs, swaps, legs: {} };
    for (const s of SLOTS) {
      const p = per[s];
      res.legs[s] = {
        tripod: TRIPOD_A.includes(s) ? 'A' : 'B',
        lifts: p.lifts,
        steps: p.jumps.length,
        jumpMeanMm: +(mean(p.jumps) * MM).toFixed(3),
        jumpMinMm: +(p.jumps.length ? Math.min(...p.jumps) * MM : 0).toFixed(3),
        jumpMaxMm: +(p.jumps.length ? Math.max(...p.jumps) * MM : 0).toFixed(3),
        radiusMm: +(mean(p.radii) * MM).toFixed(4),
        strideMm: +(mean(p.radii) * MM * 2).toFixed(4),
        turnFrac: +mean(p.turnFrac).toFixed(4),
        peakAboveMm: +(p.peakAbove * MM).toFixed(4),
        spentAtSwapMean: +mean(p.spentAtSwap).toFixed(3),
        spentAtSwapMax: +(p.spentAtSwap.length ? Math.max(...p.spentAtSwap) : 0).toFixed(3),
      };
    }
    res.movedMm = +movedMm.toFixed(2);
    res.heldMm = +heldMm.toFixed(2);
    res.gropeFrames = gropeFrames;
    res.maxOffMm = +(maxOff * MM).toFixed(1);
    res.minUpY = +minUpY.toFixed(4);
    res.endAtMm = [lab.at.x, lab.at.y, lab.at.z].map((n) => +(n * MM).toFixed(1));
    return res;
  };

  // Sanity: confirm the speed constants this probe assumes.
  seat();
  lab.input.walk = 1; lab.input.yaw = 0;
  const a0 = cp(lab.at);
  lab.stepForTest(1 / 60, 1);
  const perFrameMm = Math.hypot(lab.at.x - a0.x, lab.at.y - a0.y, lab.at.z - a0.z) * MM;
  lab.input.walk = 0; lab.input.yaw = 1;
  const f0 = cp(lab.forward);
  lab.stepForTest(1 / 60, 1);
  const dAng = Math.acos(Math.min(1, dot(norm(f0), norm(lab.forward))));
  lab.input.yaw = 0;

  const homes = {};
  for (const l of lab.drive.legs) {
    homes[l.slot] = {
      homeMm: [l.home.x * MM, l.home.y * MM, l.home.z * MM].map((n) => +n.toFixed(3)),
      rMm: +(Math.hypot(l.home.x, l.home.z) * MM).toFixed(3),
      spreadMm: +(l.spread * MM).toFixed(3),
      downMm: +(l.down * MM).toFixed(3),
    };
  }

  return {
    calib: {
      perFrameMm: +perFrameMm.toFixed(4),
      expectFrameMm: +(WALK_SPEED * MM / 60).toFixed(4),
      yawPerFrameRad: +dAng.toFixed(5),
      expectYawRad: +(YAW_RATE / 60).toFixed(5),
    },
    homes,
    runs: [
      run(1, 0, 4),
      run(1, 0.15, 4),
      run(1, 0.4, 4),
      run(0, 1, 4),
    ],
  };
});

console.log(JSON.stringify({ errors: errors.slice(0, 3) }));
console.log('CALIB', JSON.stringify(out.calib));
console.log('\nLEG GEOMETRY (body frame, mm):');
for (const [s, h] of Object.entries(out.homes)) {
  console.log(' ', s.padEnd(11), 'home', JSON.stringify(h.homeMm).padEnd(26),
    '|r|', String(h.rMm).padStart(6), 'spread', String(h.spreadMm).padStart(6),
    'down', String(h.downMm).padStart(5));
}

const ORDER = ['frontLeft', 'frontRight', 'midLeft', 'midRight', 'rearLeft', 'rearRight'];
for (const r of out.runs) {
  console.log(`\n=== walk ${r.walk}  yaw ${r.yaw}  (${r.secs}s, ${r.secs * 60} frames) ===`);
  console.log(`    body moved ${r.movedMm} mm, held back ${r.heldMm} mm, swap frames ${r.swaps},`
    + ` grope-frames ${r.gropeFrames}, max off-centre ${r.maxOffMm} mm, min up.y ${r.minUpY}`);
  console.log('    leg          tripod lifts steps  radius  stride  turnFr  jumpMean  jumpMin  jumpMax  peakUp  spent@swap(mean/max)');
  for (const s of ORDER) {
    const l = r.legs[s];
    console.log('   ', s.padEnd(12),
      l.tripod.padStart(4),
      String(l.lifts).padStart(6),
      String(l.steps).padStart(5),
      l.radiusMm.toFixed(3).padStart(8),
      l.strideMm.toFixed(3).padStart(7),
      l.turnFrac.toFixed(3).padStart(7),
      l.jumpMeanMm.toFixed(3).padStart(9),
      l.jumpMinMm.toFixed(3).padStart(8),
      l.jumpMaxMm.toFixed(3).padStart(8),
      l.peakAboveMm.toFixed(3).padStart(7),
      `${l.spentAtSwapMean.toFixed(2)}/${l.spentAtSwapMax.toFixed(2)}`.padStart(13));
  }
  const front = (r.legs.frontLeft.lifts + r.legs.frontRight.lifts) / 2;
  const mid = (r.legs.midLeft.lifts + r.legs.midRight.lifts) / 2;
  const rear = (r.legs.rearLeft.lifts + r.legs.rearRight.lifts) / 2;
  console.log(`    lifts front ${front}  mid ${mid}  rear ${rear}   REAR/FRONT ratio `
    + `${front ? (rear / front).toFixed(3) : 'n/a'}`);
  const rf = r.legs.frontLeft.radiusMm;
  const rr = r.legs.rearLeft.radiusMm;
  console.log(`    radius front ${rf.toFixed(3)} mm  rear ${rr.toFixed(3)} mm  `
    + `rear/front ${(rr / rf).toFixed(3)}`);
}
await browser.close();
