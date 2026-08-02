/**
 * LENS: visible foot motion — amplitude, discontinuity, chatter. Pass 2.
 *
 * Restricted to the TOP face only (up.y > 0.999). Adds:
 *   - PLANTED JITTER: a leg whose world anchor did not change, but whose drawn
 *     tip bone moved. A planted foot that moves is the purest "wiggle".
 *   - foot position in HER body frame (what the following camera shows).
 *   - lock-frame snap vs. what a continuous swing would have drawn.
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

const FRAMES = Number(process.env.FRAMES ?? 240);

const out = await page.evaluate(({ FRAMES }) => {
  const lab = window.blockScene;
  const legs = lab.drive.legs;
  const q = lab.queen;
  const tipBone = {};
  for (const leg of legs) {
    const name = q.limbTip?.get?.(leg.slot);
    tipBone[leg.slot] = name ? (q.bones?.get?.(name) ?? null) : null;
  }
  const v3 = (v) => [v.x, v.y, v.z];
  const boneWorld = (b) => {
    if (!b) return null;
    const m = b.matrixWorld.elements;
    return [m[12], m[13], m[14]];
  };
  const snap = () => ({
    body: v3(lab.at), up: v3(lab.up), fwd: v3(lab.forward),
    legs: legs.map((l) => ({
      slot: l.slot, at: v3(l.at), anchor: v3(l.anchor), from: v3(l.from),
      to: v3(l.to), planted: l.planted, groping: l.groping, t: l.t,
      tip: boneWorld(tipBone[l.slot]),
    })),
  });
  lab.input.walk = 1; lab.input.yaw = 0;
  const trail = [snap()];
  for (let i = 0; i < FRAMES; i += 1) { lab.stepForTest(1 / 60, 1); trail.push(snap()); }
  lab.input.walk = 0;
  return { trail, slots: legs.map((l) => l.slot) };
}, { FRAMES });

if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 3));
const { trail, slots } = out;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// last frame still flat on the top face
let last = trail.length - 1;
for (let i = 0; i < trail.length; i += 1) {
  if (trail[i].up[1] < 0.9995) { last = i - 1; break; }
}
console.log(`frames on the flat top: 1..${last} of ${trail.length - 1} `
  + `(${(last / 60).toFixed(2)} s)`);
console.log('body', trail[0].body.map((n) => +(n * MM).toFixed(2)).join(','),
  '->', trail[last].body.map((n) => +(n * MM).toFixed(2)).join(','),
  ' up', trail[last].up.map((n) => +n.toFixed(4)).join(','));

const pad = (s, n) => String(s).padEnd(n);
const nf = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
const stats = (v) => {
  if (!v.length) return { n: 0, mean: NaN, max: NaN, p95: NaN };
  const s = [...v].sort((a, b) => a - b);
  return {
    n: v.length, mean: v.reduce((a, b) => a + b, 0) / v.length,
    max: s[s.length - 1], p95: s[Math.floor(s.length * 0.95)],
  };
};

const per = {};
for (const s of slots) {
  per[s] = {
    atStep: [], tipStep: [], swingStep: [], stanceTipStep: [], stanceAtStep: [],
    lifts: [], lands: [], snap: [], snapExtra: [], peakLift: -Infinity,
    bodyFrameRange: { x: [Infinity, -Infinity], y: [Infinity, -Infinity], z: [Infinity, -Infinity] },
    stanceBodyStep: [],
  };
}

// ground reference: median planted foot elevation on the top face
const ys = [];
for (let i = 0; i <= last; i += 1) for (const l of trail[i].legs) if (l.planted) ys.push(l.at[1]);
ys.sort((a, b) => a - b);
const groundY = ys[Math.floor(ys.length / 2)];

const toBody = (f, p) => {
  const up = f.up; const fwd = f.fwd; const right = cross(up, fwd);
  const d = sub(p, f.body);
  return [dot(d, right), dot(d, up), dot(d, fwd)];
};

for (let i = 1; i <= last; i += 1) {
  const A = trail[i - 1]; const C = trail[i];
  for (let k = 0; k < slots.length; k += 1) {
    const s = slots[k]; const a = A.legs[k]; const c = C.legs[k]; const p = per[s];
    const dAt = dist(a.at, c.at) * MM;
    p.atStep.push(dAt);
    if (a.tip && c.tip) p.tipStep.push(dist(a.tip, c.tip) * MM);
    const lift = (c.at[1] - groundY) * MM;
    if (lift > p.peakLift) p.peakLift = lift;

    const bf = toBody(C, c.tip ?? c.at);
    for (const [ax, idx] of [['x', 0], ['y', 1], ['z', 2]]) {
      p.bodyFrameRange[ax][0] = Math.min(p.bodyFrameRange[ax][0], bf[idx] * MM);
      p.bodyFrameRange[ax][1] = Math.max(p.bodyFrameRange[ax][1], bf[idx] * MM);
    }

    if (a.planted && !c.planted) p.lifts.push(i);
    if (!a.planted && c.planted) {
      p.lands.push(i);
      p.snap.push(dAt);
      // what a CONTINUOUS swing would have drawn at this same t
      const tt = c.t; const r = 1 / MM; // radius mm -> world, 1 mm
      const cont = [0, 1, 2].map((j) => a.from[j] + (c.to[j] - a.from[j]) * tt);
      const arc = Math.sin(Math.PI * tt) * r * 0.35;
      const contA = [0, 1, 2].map((j) => cont[j] + C.up[j] * arc);
      p.snapExtra.push(dist(contA, c.at) * MM);
    }
    if (!a.planted && !c.planted && !c.groping) p.swingStep.push(dAt);
    // stance: planted both frames AND the anchor is the same world point
    if (a.planted && c.planted && dist(a.anchor, c.anchor) < 1e-9) {
      p.stanceAtStep.push(dAt);
      if (a.tip && c.tip) p.stanceTipStep.push(dist(a.tip, c.tip) * MM);
      if (a.tip && c.tip) {
        const b1 = toBody(A, a.tip); const b2 = toBody(C, c.tip);
        p.stanceBodyStep.push(dist(b1, b2) * MM);
      }
    }
  }
}

const secs = last / 60;
console.log('\n=== A. DRAWN TARGET leg.at, per frame, TOP FACE ONLY ===');
console.log(pad('slot', 12), pad('maxJump', 9), pad('mean', 9), pad('p95', 9),
  pad('peakLift', 9), pad('steps', 6), pad('steps/s', 8));
for (const s of slots) {
  const p = per[s]; const t = stats(p.atStep);
  console.log(pad(s, 12), pad(nf(t.max), 9), pad(nf(t.mean), 9), pad(nf(t.p95), 9),
    pad(nf(p.peakLift), 9), pad(p.lifts.length, 6), pad(nf(p.lifts.length / secs, 2), 8));
}

console.log('\n=== B. DRAWN TIP BONE (what is on screen), per frame ===');
console.log(pad('slot', 12), pad('maxJump', 9), pad('mean', 9), pad('p95', 9));
for (const s of slots) {
  const t = stats(per[s].tipStep);
  console.log(pad(s, 12), pad(nf(t.max), 9), pad(nf(t.mean), 9), pad(nf(t.p95), 9));
}

console.log('\n=== C. PLANTED JITTER: anchor unchanged, yet the drawn tip moved ===');
console.log(pad('slot', 12), pad('n', 6), pad('at max', 9), pad('tip mean', 10),
  pad('tip max', 9), pad('tip p95', 9), pad('bodyframe mean', 15), pad('bodyframe max', 14));
for (const s of slots) {
  const p = per[s];
  const a = stats(p.stanceAtStep); const t = stats(p.stanceTipStep); const b = stats(p.stanceBodyStep);
  console.log(pad(s, 12), pad(t.n, 6), pad(nf(a.max, 5), 9), pad(nf(t.mean), 10),
    pad(nf(t.max), 9), pad(nf(t.p95), 9), pad(nf(b.mean), 15), pad(nf(b.max), 14));
}

console.log('\n=== D. SWING frames only (mid-air), per-frame drawn step ===');
console.log(pad('slot', 12), pad('n', 5), pad('mean', 9), pad('max', 9));
for (const s of slots) {
  const t = stats(per[s].swingStep);
  console.log(pad(s, 12), pad(t.n, 5), pad(nf(t.mean), 9), pad(nf(t.max), 9));
}

console.log('\n=== E. LANDING SNAP at LOCK_AT ===');
console.log(pad('slot', 12), pad('n', 4), pad('frameMove mean', 15), pad('frameMove max', 14),
  pad('TELEPORT mean', 14), pad('TELEPORT max', 13));
for (const s of slots) {
  const p = per[s]; const a = stats(p.snap); const e = stats(p.snapExtra);
  console.log(pad(s, 12), pad(a.n, 4), pad(nf(a.mean), 15), pad(nf(a.max), 14),
    pad(nf(e.mean), 14), pad(nf(e.max), 13));
}

console.log('\n=== F. FOOT EXCURSION in her body frame (tip bone), mm ===');
console.log(pad('slot', 12), pad('right span', 12), pad('up span', 12), pad('fwd span', 12));
for (const s of slots) {
  const r = per[s].bodyFrameRange;
  const sp = (x) => `${nf(x[0], 2)}..${nf(x[1], 2)} (${nf(x[1] - x[0], 2)})`;
  console.log(pad(s, 12), pad(sp(r.x), 12), pad(sp(r.y), 12), pad(sp(r.z), 12));
}

console.log('\n=== G. RE-LIFT CHATTER (frames between lifts of the same leg) ===');
for (const s of slots) {
  const p = per[s]; const gaps = [];
  for (let i = 1; i < p.lifts.length; i += 1) gaps.push(p.lifts[i] - p.lifts[i - 1]);
  const land2lift = [];
  for (const l of p.lands) { const n = p.lifts.find((f) => f > l); if (n !== undefined) land2lift.push(n - l); }
  console.log(pad(s, 12), 'lift-to-lift min', pad(gaps.length ? Math.min(...gaps) : 'n/a', 4),
    'gaps', pad(gaps.join(' '), 34),
    '| stance frames min', pad(land2lift.length ? Math.min(...land2lift) : 'n/a', 4),
    land2lift.join(' '));
}

// vertical trace of every leg for 60 frames, to eyeball the waveform
console.log('\n=== H. tip elevation above ground (mm) frames 60..120, per leg ===');
console.log(pad('f', 5), slots.map((s) => pad(s.slice(0, 9), 10)).join(''));
for (let i = 60; i <= Math.min(120, last); i += 1) {
  const row = slots.map((s, k) => {
    const l = trail[i].legs[k];
    const e = ((l.tip ? l.tip[1] : l.at[1]) - groundY) * MM;
    return pad(e.toFixed(3) + (l.planted ? '' : '*'), 10);
  }).join('');
  console.log(pad(i, 5), row);
}
await browser.close();
