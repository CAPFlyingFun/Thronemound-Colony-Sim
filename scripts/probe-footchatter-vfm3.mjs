/**
 * LENS: visible foot motion. Pass 3 — clean top-face frames only.
 *
 * A frame counts only if EVERY foot is >= 6 mm inside the block footprint,
 * so no leg is reaching over the rounded rim. Three straight segments,
 * separated by 180-degree turns, to get statistics without walking off.
 * Then a dt sweep of the LOCK_AT landing snap.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4404/Thronemound-Colony-Sim/?scene=block';
const MM = 5;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.drive, null, { timeout: 60000 });
await page.waitForTimeout(1500);

const out = await page.evaluate(() => {
  const lab = window.blockScene;
  const legs = lab.drive.legs;
  const q = lab.queen;
  const tipBone = {};
  for (const leg of legs) {
    const name = q.limbTip?.get?.(leg.slot);
    tipBone[leg.slot] = name ? (q.bones?.get?.(name) ?? null) : null;
  }
  const v3 = (v) => [v.x, v.y, v.z];
  const bw = (b) => { if (!b) return null; const m = b.matrixWorld.elements; return [m[12], m[13], m[14]]; };
  const snap = (phase) => ({
    phase, body: v3(lab.at), up: v3(lab.up), fwd: v3(lab.forward),
    legs: legs.map((l) => ({
      slot: l.slot, at: v3(l.at), anchor: v3(l.anchor), from: v3(l.from), to: v3(l.to),
      planted: l.planted, groping: l.groping, t: l.t, tip: bw(tipBone[l.slot]),
    })),
  });
  const trail = [];
  const run = (walk, yaw, n, phase) => {
    lab.input.walk = walk; lab.input.yaw = yaw;
    for (let i = 0; i < n; i += 1) { lab.stepForTest(1 / 60, 1); trail.push(snap(phase)); }
  };
  // 3 straight legs of ~150 frames each, 180-degree turns between them
  run(1, 0, 150, 'straight0');
  run(0, 1, 95, 'turn');
  run(1, 0, 150, 'straight1');
  run(0, 1, 95, 'turn');
  run(1, 0, 150, 'straight2');
  lab.input.walk = 0; lab.input.yaw = 0;

  // --- dt sweep of the landing snap ---
  // For each dt, walk a while and record the drawn step on the frame each leg
  // locks, plus the t it locked at.
  const sweep = [];
  for (const dt of [1 / 30, 1 / 45, 1 / 50, 1 / 60, 1 / 72, 1 / 90, 1 / 120]) {
    lab.input.walk = 1; lab.input.yaw = 0;
    const locks = [];
    let prev = legs.map((l) => ({ p: l.planted, at: v3(l.at) }));
    const N = Math.round(2.0 / dt);
    for (let i = 0; i < N; i += 1) {
      lab.stepForTest(dt, 1);
      legs.forEach((l, k) => {
        if (!prev[k].p && l.planted) {
          const a = prev[k].at; const b = v3(l.at);
          locks.push({ t: l.t, mm: Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 5 });
        }
      });
      prev = legs.map((l) => ({ p: l.planted, at: v3(l.at) }));
    }
    lab.input.walk = 0;
    sweep.push({ dt, locks });
    // re-centre her so the sweep never reaches the rim
    lab.at.set(6.7, lab.at.y, 6.7);
    lab.forward.set(0, 0, 1); lab.up.set(0, 1, 0);
    lab.drive.plantAll({ at: lab.at, up: lab.up, forward: lab.forward }, lab.groundForLegs);
    lab.stepForTest(1 / 60, 30);
  }

  // --- jittered dt, as a real phone delivers it ---
  lab.at.set(6.7, lab.at.y, 6.7); lab.forward.set(0, 0, 1); lab.up.set(0, 1, 0);
  lab.drive.plantAll({ at: lab.at, up: lab.up, forward: lab.forward }, lab.groundForLegs);
  lab.input.walk = 1;
  const jitter = [];
  let prevJ = legs.map((l) => ({ p: l.planted, at: v3(l.at) }));
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 240; i += 1) {
    const dt = (1 / 60) * (0.7 + 0.6 * rnd());
    lab.stepForTest(dt, 1);
    legs.forEach((l, k) => {
      if (!prevJ[k].p && l.planted) {
        const a = prevJ[k].at; const b = v3(l.at);
        jitter.push({ slot: l.slot, t: l.t, mm: Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 5 });
      }
    });
    prevJ = legs.map((l) => ({ p: l.planted, at: v3(l.at) }));
  }
  lab.input.walk = 0;

  return { trail, slots: legs.map((l) => l.slot), sweep, jitter };
});

if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 3));
const { trail, slots, sweep, jitter } = out;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const pad = (s, n) => String(s).padEnd(n);
const nf = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
const stats = (v) => {
  if (!v.length) return { n: 0, mean: NaN, max: NaN, p95: NaN, argmax: -1 };
  const s = [...v].sort((a, b) => a - b);
  let am = 0; for (let i = 1; i < v.length; i += 1) if (v[i] > v[am]) am = i;
  return { n: v.length, mean: v.reduce((a, b) => a + b, 0) / v.length, max: s[s.length - 1], p95: s[Math.floor(s.length * 0.95)], argmax: am };
};

// block footprint, world units: LOW = 0.3, HIGH = 13.1 (MARGIN 3 cells of 0.1)
const LOW = 0.3; const HIGH = 13.1; const INSET = 6 / MM;
const flatTop = (f) => f.up[1] > 0.9999
  && f.legs.every((l) => {
    const p = l.at;
    return p[0] > LOW + INSET && p[0] < HIGH - INSET && p[2] > LOW + INSET && p[2] < HIGH - INSET;
  });
const clean = trail.map((f, i) => (f.phase.startsWith('straight') && flatTop(f) ? i : -1));
const usable = [];
for (let i = 1; i < trail.length; i += 1) {
  if (clean[i] >= 0 && clean[i - 1] >= 0 && trail[i].phase === trail[i - 1].phase) usable.push(i);
}
console.log(`clean straight top-face frame PAIRS: ${usable.length} of ${trail.length} recorded`
  + ` (${(usable.length / 60).toFixed(2)} s)`);

const ys = [];
for (const i of usable) for (const l of trail[i].legs) if (l.planted) ys.push(l.at[1]);
ys.sort((a, b) => a - b);
const groundY = ys[Math.floor(ys.length / 2)];

const toBody = (f, p) => {
  const r = cross(f.up, f.fwd); const d = sub(p, f.body);
  return [dot(d, r), dot(d, f.up), dot(d, f.fwd)];
};

const per = {};
for (const s of slots) {
  per[s] = {
    atStep: [], tipStep: [], swingStep: [], stanceTip: [], stanceTipF: [],
    stanceBody: [], lockMove: [], lockTele: [], lifts: [], lands: [],
    peakAt: -Infinity, peakTip: -Infinity, bodyR: [[1e9, -1e9], [1e9, -1e9], [1e9, -1e9]],
    atMaxF: -1, tipMaxF: -1,
  };
}
for (const i of usable) {
  const A = trail[i - 1]; const C = trail[i];
  for (let k = 0; k < slots.length; k += 1) {
    const s = slots[k]; const a = A.legs[k]; const c = C.legs[k]; const p = per[s];
    const d = dist(a.at, c.at) * MM;
    p.atStep.push(d);
    if (a.tip && c.tip) p.tipStep.push(dist(a.tip, c.tip) * MM);
    p.peakAt = Math.max(p.peakAt, (c.at[1] - groundY) * MM);
    if (c.tip) p.peakTip = Math.max(p.peakTip, (c.tip[1] - groundY) * MM);
    const bf = toBody(C, c.tip ?? c.at);
    for (let j = 0; j < 3; j += 1) {
      p.bodyR[j][0] = Math.min(p.bodyR[j][0], bf[j] * MM);
      p.bodyR[j][1] = Math.max(p.bodyR[j][1], bf[j] * MM);
    }
    if (a.planted && !c.planted) p.lifts.push(i);
    if (!a.planted && c.planted) {
      p.lands.push(i); p.lockMove.push(d);
      const tt = c.t; const r = 1 / MM;
      const cont = [0, 1, 2].map((j) => a.from[j] + (c.to[j] - a.from[j]) * tt);
      const arc = Math.sin(Math.PI * tt) * r * 0.35;
      p.lockTele.push(dist(cont.map((v, j) => v + C.up[j] * arc), c.at) * MM);
    }
    if (!a.planted && !c.planted && !c.groping) p.swingStep.push(d);
    if (a.planted && c.planted && dist(a.anchor, c.anchor) < 1e-12 && a.tip && c.tip) {
      p.stanceTip.push(dist(a.tip, c.tip) * MM); p.stanceTipF.push(i);
      p.stanceBody.push(dist(toBody(A, a.tip), toBody(C, c.tip)) * MM);
    }
  }
}
const secs = usable.length / 60;

console.log('\n=== A. DRAWN TARGET leg.at — clean flat top ===');
console.log(pad('slot', 12), pad('maxJump', 9), pad('mean', 9), pad('p95', 9),
  pad('peakLift', 9), pad('steps', 6), pad('steps/s', 8));
for (const s of slots) {
  const p = per[s]; const t = stats(p.atStep);
  console.log(pad(s, 12), pad(nf(t.max), 9), pad(nf(t.mean), 9), pad(nf(t.p95), 9),
    pad(nf(p.peakAt), 9), pad(p.lifts.length, 6), pad(nf(p.lifts.length / secs, 2), 8));
}
console.log('\n=== B. DRAWN TIP BONE — clean flat top ===');
console.log(pad('slot', 12), pad('maxJump', 9), pad('mean', 9), pad('p95', 9), pad('peakLift', 9));
for (const s of slots) {
  const p = per[s]; const t = stats(p.tipStep);
  console.log(pad(s, 12), pad(nf(t.max), 9), pad(nf(t.mean), 9), pad(nf(t.p95), 9), pad(nf(p.peakTip), 9));
}
console.log('\n=== C. PLANTED JITTER (anchor fixed, drawn tip moved) ===');
console.log(pad('slot', 12), pad('n', 6), pad('mean', 9), pad('p95', 9), pad('max', 9),
  pad('max@frame', 10), pad('bodyframe mean', 15), pad('bodyframe max', 14));
for (const s of slots) {
  const p = per[s]; const t = stats(p.stanceTip); const b = stats(p.stanceBody);
  console.log(pad(s, 12), pad(t.n, 6), pad(nf(t.mean), 9), pad(nf(t.p95), 9), pad(nf(t.max), 9),
    pad(p.stanceTipF[t.argmax] ?? -1, 10), pad(nf(b.mean), 15), pad(nf(b.max), 14));
}
console.log('\n=== D. SWING frames only ===');
console.log(pad('slot', 12), pad('n', 5), pad('mean', 9), pad('max', 9));
for (const s of slots) { const t = stats(per[s].swingStep); console.log(pad(s, 12), pad(t.n, 5), pad(nf(t.mean), 9), pad(nf(t.max), 9)); }
console.log('\n=== E. LOCK frame ===');
console.log(pad('slot', 12), pad('n', 4), pad('frameMove mean', 15), pad('max', 9),
  pad('TELEPORT mean', 14), pad('max', 9), pad('x mean frame', 13));
for (const s of slots) {
  const p = per[s]; const a = stats(p.lockMove); const e = stats(p.lockTele); const m = stats(p.atStep);
  console.log(pad(s, 12), pad(a.n, 4), pad(nf(a.mean), 15), pad(nf(a.max), 9),
    pad(nf(e.mean), 14), pad(nf(e.max), 9), pad(nf(a.mean / m.mean, 2) + 'x', 13));
}
console.log('\n=== F. body-frame excursion of the drawn tip (mm) ===');
console.log(pad('slot', 12), pad('right', 22), pad('up', 22), pad('fwd', 22));
for (const s of slots) {
  const r = per[s].bodyR;
  const sp = (x) => `${nf(x[0], 2)}..${nf(x[1], 2)} (${nf(x[1] - x[0], 2)})`;
  console.log(pad(s, 12), pad(sp(r[0]), 22), pad(sp(r[1]), 22), pad(sp(r[2]), 22));
}
console.log('\n=== G. gait timing ===');
for (const s of slots) {
  const p = per[s]; const g = [];
  for (let i = 1; i < p.lifts.length; i += 1) g.push(p.lifts[i] - p.lifts[i - 1]);
  console.log(pad(s, 12), 'lift-to-lift', pad(g.filter((x) => x < 200).join(' '), 46),
    'min', g.length ? Math.min(...g) : 'n/a');
}

console.log('\n=== H. dt SWEEP of the landing lock ===');
console.log(pad('dt', 10), pad('fps', 6), pad('n locks', 8), pad('t at lock', 11),
  pad('lock move mean mm', 18), pad('max', 8));
for (const row of sweep) {
  const ts = row.locks.map((l) => l.t); const ms = row.locks.map((l) => l.mm);
  const t = stats(ms);
  const tset = [...new Set(ts.map((x) => x.toFixed(4)))].join('/');
  console.log(pad(nf(row.dt, 5), 10), pad(nf(1 / row.dt, 1), 6), pad(row.locks.length, 8),
    pad(tset, 11), pad(nf(t.mean), 18), pad(nf(t.max), 8));
}
console.log('\n=== I. JITTERED dt (60 fps +/- 30%), lock frames ===');
const jm = stats(jitter.map((j) => j.mm)); const jt = stats(jitter.map((j) => j.t));
console.log('locks', jitter.length, ' lock-move mean', nf(jm.mean), ' max', nf(jm.max),
  ' min', nf(Math.min(...jitter.map((j) => j.mm))),
  ' | t at lock: min', nf(Math.min(...jitter.map((j) => j.t))), 'max', nf(jt.max), 'mean', nf(jt.mean));
const byT = jitter.slice().sort((a, b) => a.t - b.t);
console.log('t vs lock-move, sorted:',
  byT.filter((_, i) => i % 3 === 0).map((j) => `${j.t.toFixed(2)}:${j.mm.toFixed(2)}`).join(' '));
await browser.close();
