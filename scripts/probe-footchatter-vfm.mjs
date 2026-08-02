/**
 * LENS: visible foot motion — amplitude, discontinuity, chatter.
 *
 * Walks her straight on the TOP face and records, every single frame:
 *   - each leg's drawn target `at` (world units)
 *   - the actual world position of the rig's tip bone for that leg
 *   - planted / groping / t / swing endpoints
 * Then reports per-leg: max single-frame jump, mean per-frame motion, peak
 * lift, steps per second, landing-snap size, re-lift gap, target drift.
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

const FRAMES = Number(process.env.FRAMES ?? 300);

const out = await page.evaluate(({ FRAMES }) => {
  const lab = window.blockScene;
  const legs = lab.drive.legs;
  const q = lab.queen;

  // Resolve the tip bone for each leg slot so we can read the DRAWN claw.
  const tipBone = {};
  for (const leg of legs) {
    const name = q.limbTip?.get?.(leg.slot);
    const bone = name ? q.bones?.get?.(name) : null;
    tipBone[leg.slot] = bone ?? null;
  }

  const v3 = (v) => [v.x, v.y, v.z];
  const boneWorld = (b) => {
    if (!b) return null;
    const m = b.matrixWorld.elements;
    return [m[12], m[13], m[14]];
  };

  const snap = () => ({
    body: v3(lab.at),
    up: v3(lab.up),
    fwd: v3(lab.forward),
    gripping: lab.gripping,
    report: lab.report ? { ...lab.report } : null,
    legs: legs.map((l) => ({
      slot: l.slot,
      at: v3(l.at),
      anchor: v3(l.anchor),
      from: v3(l.from),
      to: v3(l.to),
      dir: v3(l.dir),
      planted: l.planted,
      groping: l.groping,
      t: l.t,
      spread: l.spread,
      tip: boneWorld(tipBone[l.slot]),
    })),
  });

  lab.input.walk = 1;
  lab.input.yaw = 0;
  const trail = [snap()];
  for (let i = 0; i < FRAMES; i += 1) {
    lab.stepForTest(1 / 60, 1);
    trail.push(snap());
  }
  lab.input.walk = 0;

  return {
    trail,
    slots: legs.map((l) => l.slot),
    spreads: Object.fromEntries(legs.map((l) => [l.slot, l.spread])),
    homes: Object.fromEntries(legs.map((l) => [l.slot, v3(l.home)])),
    haveTips: Object.fromEntries(legs.map((l) => [l.slot, !!tipBone[l.slot]])),
  };
}, { FRAMES });

if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 3));

const { trail, slots, spreads, homes, haveTips } = out;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

console.log('tip bones resolved:', JSON.stringify(haveTips));
console.log('frames:', trail.length - 1, 'dt 1/60');
const b0 = trail[0].body; const bN = trail[trail.length - 1].body;
console.log('body start mm', b0.map((n) => +(n * MM).toFixed(2)).join(', '),
  '-> end mm', bN.map((n) => +(n * MM).toFixed(2)).join(', '),
  ' up end', trail[trail.length - 1].up.map((n) => +n.toFixed(3)).join(','));
console.log('travelled mm', (dist(b0, bN) * MM).toFixed(2),
  ' gripping all frames:', trail.every((f) => f.gripping));

// surface elevation reference: the top face y, from planted feet
const plantedYs = [];
for (const f of trail) for (const l of f.legs) if (l.planted) plantedYs.push(l.at[1]);
plantedYs.sort((a, b) => a - b);
const groundY = plantedYs[Math.floor(plantedYs.length / 2)];
console.log('median planted foot y (world units):', groundY.toFixed(5),
  '=', (groundY * MM).toFixed(3), 'mm');

const per = {};
for (const s of slots) {
  per[s] = {
    jumps: [], maxJump: 0, maxJumpFrame: -1, sum: 0, n: 0,
    tipJumps: [], tipMax: 0, tipMaxFrame: -1, tipSum: 0, tipN: 0,
    peakLift: -Infinity, lifts: [], lands: [], lockSnaps: [], toDrift: [],
    swingLens: [],
  };
}

for (let i = 1; i < trail.length; i += 1) {
  const prev = trail[i - 1]; const cur = trail[i];
  for (let k = 0; k < slots.length; k += 1) {
    const s = slots[k];
    const a = prev.legs[k]; const c = cur.legs[k];
    const d = dist(a.at, c.at) * MM;
    const p = per[s];
    p.jumps.push(d); p.sum += d; p.n += 1;
    if (d > p.maxJump) { p.maxJump = d; p.maxJumpFrame = i; }
    if (a.tip && c.tip) {
      const td = dist(a.tip, c.tip) * MM;
      p.tipJumps.push(td); p.tipSum += td; p.tipN += 1;
      if (td > p.tipMax) { p.tipMax = td; p.tipMaxFrame = i; }
    }
    const lift = (c.at[1] - groundY) * MM;
    if (lift > p.peakLift) p.peakLift = lift;
    if (a.planted && !c.planted) p.lifts.push(i);
    if (!a.planted && c.planted) {
      p.lands.push(i);
      // The LOCK snap: distance from where it was drawn last frame to the
      // locked anchor. a.at is the last mid-swing drawn point.
      p.lockSnaps.push({ frame: i, snapMm: d, tPrev: a.t, tNow: c.t });
    }
    // target drift while swinging: `to` recomputed every frame
    if (!a.planted && !c.planted && !a.groping && !c.groping) {
      p.toDrift.push(dist(a.to, c.to) * MM);
    }
  }
}

const pad = (s, n) => String(s).padEnd(n);
const num = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
const secs = (trail.length - 1) / 60;

console.log('\n=== PER-LEG, drawn target leg.at, straight walk on top, '
  + secs.toFixed(2) + ' s ===');
console.log(pad('slot', 12), pad('maxJump mm', 12), pad('@frame', 8),
  pad('meanFrame mm', 14), pad('peakLift mm', 12), pad('steps', 7),
  pad('steps/s', 9), pad('spread mm', 10));
for (const s of slots) {
  const p = per[s];
  console.log(pad(s, 12), pad(num(p.maxJump), 12), pad(p.maxJumpFrame, 8),
    pad(num(p.sum / Math.max(1, p.n)), 14), pad(num(p.peakLift), 12),
    pad(p.lifts.length, 7), pad(num(p.lifts.length / secs, 2), 9),
    pad(num(spreads[s] * MM, 2), 10));
}

console.log('\n=== PER-LEG, actual drawn tip bone world position ===');
console.log(pad('slot', 12), pad('maxJump mm', 12), pad('@frame', 8), pad('meanFrame mm', 14));
for (const s of slots) {
  const p = per[s];
  console.log(pad(s, 12), pad(num(p.tipMax), 12), pad(p.tipMaxFrame, 8),
    pad(num(p.tipSum / Math.max(1, p.tipN)), 14));
}

console.log('\n=== LANDING SNAP (frame the leg locks: last drawn -> anchor) ===');
console.log(pad('slot', 12), pad('n', 4), pad('mean mm', 10), pad('max mm', 10),
  pad('t at lock', 10), 'all snaps mm');
for (const s of slots) {
  const p = per[s];
  const v = p.lockSnaps.map((x) => x.snapMm);
  const mean = v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
  console.log(pad(s, 12), pad(v.length, 4), pad(num(mean), 10),
    pad(num(Math.max(...v, 0)), 10),
    pad(num(p.lockSnaps[0]?.tNow ?? NaN, 3), 10),
    v.map((x) => x.toFixed(3)).join(' '));
}

console.log('\n=== RE-LIFT CHATTER: frames between consecutive lifts, same leg ===');
console.log(pad('slot', 12), pad('minGap', 8), pad('meanGap', 9), 'gaps (frames)');
for (const s of slots) {
  const p = per[s];
  const gaps = [];
  for (let i = 1; i < p.lifts.length; i += 1) gaps.push(p.lifts[i] - p.lifts[i - 1]);
  const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : NaN;
  console.log(pad(s, 12), pad(gaps.length ? Math.min(...gaps) : 'n/a', 8),
    pad(num(mean, 1), 9), gaps.join(' '));
}

console.log('\n=== LAND -> NEXT LIFT (frames planted before lifting again) ===');
console.log(pad('slot', 12), pad('min', 6), 'gaps');
for (const s of slots) {
  const p = per[s];
  const gaps = [];
  for (const land of p.lands) {
    const next = p.lifts.find((f) => f > land);
    if (next !== undefined) gaps.push(next - land);
  }
  console.log(pad(s, 12), pad(gaps.length ? Math.min(...gaps) : 'n/a', 6), gaps.join(' '));
}

console.log('\n=== SWING TARGET DRIFT (|to(f) - to(f-1)| mid-swing) ===');
console.log(pad('slot', 12), pad('n', 5), pad('mean mm', 10), pad('max mm', 10), pad('sum mm', 10));
for (const s of slots) {
  const p = per[s];
  const v = p.toDrift;
  const mean = v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
  console.log(pad(s, 12), pad(v.length, 5), pad(num(mean), 10),
    pad(num(Math.max(...v, 0)), 10), pad(num(v.reduce((a, b) => a + b, 0)), 10));
}

// Dump one full swing for the worst rear leg, frame by frame.
for (const s of ['rearLeft', 'frontLeft']) {
  const k = slots.indexOf(s);
  const p = per[s];
  const lift = p.lifts[1] ?? p.lifts[0];
  if (lift === undefined) continue;
  console.log(`\n=== ${s}: frame-by-frame around a swing (lift at frame ${lift}) ===`);
  console.log(pad('f', 5), pad('planted', 8), pad('grope', 6), pad('t', 6),
    pad('at (mm)', 30), pad('step mm', 9), pad('lift mm', 9), pad('to (mm)', 30));
  for (let i = Math.max(1, lift - 2); i < Math.min(trail.length, lift + 16); i += 1) {
    const c = trail[i].legs[k]; const a = trail[i - 1].legs[k];
    console.log(pad(i, 5), pad(c.planted, 8), pad(c.groping, 6), pad(c.t.toFixed(3), 6),
      pad(c.at.map((n) => (n * MM).toFixed(3)).join(','), 30),
      pad((dist(a.at, c.at) * MM).toFixed(3), 9),
      pad(((c.at[1] - groundY) * MM).toFixed(3), 9),
      pad(c.to.map((n) => (n * MM).toFixed(3)).join(','), 30));
  }
}

// Body motion per frame, for context (is the body itself smooth?)
let bmax = 0; let bsum = 0; let bmaxF = -1;
for (let i = 1; i < trail.length; i += 1) {
  const d = dist(trail[i - 1].body, trail[i].body) * MM;
  bsum += d; if (d > bmax) { bmax = d; bmaxF = i; }
}
console.log('\nBODY: max frame move', bmax.toFixed(4), 'mm @', bmaxF,
  ' mean', (bsum / (trail.length - 1)).toFixed(4), 'mm/frame',
  ' => ', (bsum / (trail.length - 1) * 60).toFixed(2), 'mm/s');
console.log('homes (mm):', JSON.stringify(Object.fromEntries(
  Object.entries(homes).map(([k, v]) => [k, v.map((n) => +(n * MM).toFixed(2))]),
)));

await browser.close();
