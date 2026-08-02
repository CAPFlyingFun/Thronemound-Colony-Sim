/**
 * LENS: leg.dir, the travel direction captured at plant time.
 *
 * Walks her off the top of the block onto a side and, every frame, for every
 * leg, recomputes what legDrive's private travel() would say RIGHT NOW and
 * compares it with the stored leg.dir the gait actually measures against.
 *
 * Run A: untouched.
 * Run B: identical, except the probe fires the tripod swap itself using a
 *        spent measured along the CURRENT travel direction. No src is edited;
 *        the swap is replicated on lab.drive.legs from outside.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4402/Thronemound-Colony-Sim/?scene=block';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const HARNESS = `(() => {
  const MM = 5;
  const WALK_SPEED = 1.6;
  const YAW_RATE = 2.2;
  const STRIDE = { walk: 2.0, turn: 0.8 };
  const TRIPOD_A = ['frontLeft', 'midRight', 'rearLeft'];
  const TRIPOD_B = ['frontRight', 'midLeft', 'rearRight'];

  const V = (x, y, z) => ({ x, y, z });
  const add = (a, b) => V(a.x + b.x, a.y + b.y, a.z + b.z);
  const sub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
  const mul = (a, s) => V(a.x * s, a.y * s, a.z * s);
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const cross = (a, b) => V(
    a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x,
  );
  const len = (a) => Math.sqrt(dot(a, a));
  const norm = (a) => { const l = len(a); return l > 1e-12 ? mul(a, 1 / l) : V(0, 0, 0); };
  const cp = (v) => V(v.x, v.y, v.z);

  const radiusFor = (turn) => (STRIDE.walk + (STRIDE.turn - STRIDE.walk) * turn) / 2 / MM;

  /** Exactly legDrive.homeWorld / travel / excursion, recomputed from outside. */
  window.__lens = (lab, walk, yaw) => {
    const body = { at: cp(lab.at), up: cp(lab.up), forward: cp(lab.forward) };
    const right = norm(cross(body.up, body.forward));
    const out = [];
    for (const leg of lab.drive.legs) {
      const offset = add(add(mul(right, leg.home.x), mul(body.up, leg.home.y)),
        mul(body.forward, leg.home.z));
      const homeWorld = add(body.at, offset);
      const linear = mul(body.forward, WALK_SPEED * walk);
      const angular = mul(cross(body.up, offset), YAW_RATE * yaw);
      const stride = add(linear, angular);
      const speed = len(stride);
      const rotSpeed = len(angular);
      const turn = speed > 1e-9 ? Math.min(1, rotSpeed / speed) : 0;
      const cur = speed > 1e-9 ? mul(stride, 1 / speed) : cp(leg.dir);
      const radius = radiusFor(turn);

      // excursion: (homeWorld - anchor) with the body.up component removed
      let d = sub(homeWorld, cp(leg.anchor));
      d = add(d, mul(body.up, -dot(d, body.up)));
      const exMag = len(d);
      const stored = cp(leg.dir);
      const spentStored = dot(d, stored) / radius;      // what the code computes
      const spentCurrent = dot(d, cur) / radius;        // measured along current travel
      const cosang = Math.max(-1, Math.min(1, dot(norm(stored), cur)));
      const angle = Math.acos(cosang) * 180 / Math.PI;
      // How much of the stored dir points out of the current stance plane
      const outOfPlane = Math.abs(dot(norm(stored), body.up));
      out.push({
        slot: leg.slot,
        planted: leg.planted,
        groping: leg.groping,
        dir: [stored.x, stored.y, stored.z],
        cur: [cur.x, cur.y, cur.z],
        angle,
        outOfPlane,
        exMag,
        exMagMm: exMag * MM,
        spentStored,
        spentCurrent,
        radius,
        spread: leg.spread,
      });
    }
    return out;
  };

  window.__swapOnCurrent = (lab, rows) => {
    // Replicate legDrive's swap rule, but with spentCurrent.
    let inTransit = false;
    for (const r of rows) if (!r.planted && !r.groping) inTransit = true;
    if (inTransit) return null;
    let best = null;
    for (const r of rows) {
      if (!r.planted) continue;
      if (!best || r.spentCurrent > best.spentCurrent) best = r;
    }
    if (!best || best.spentCurrent < 1) return null;
    const group = TRIPOD_A.includes(best.slot) ? TRIPOD_A : TRIPOD_B;
    for (const leg of lab.drive.legs) {
      if (!group.includes(leg.slot) || !leg.planted) continue;
      leg.planted = false;
      leg.t = 0;
      leg.from.copy(leg.at);
    }
    return best.slot;
  };
})()`;

async function run(mode) {
  const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.blockScene?.drive, null, { timeout: 60000 });
  await page.waitForFunction(
    () => window.blockScene?.drive?.legs?.length === 6, null, { timeout: 60000 },
  );
  await page.waitForTimeout(1500);
  await page.evaluate(HARNESS);

  const out = await page.evaluate((m) => {
    const lab = window.blockScene;
    const FRAMES = 1500;
    const walk = 1;
    const yaw = 0;
    lab.input.walk = walk;
    lab.input.yaw = yaw;

    const trace = [];
    let swaps = 0;
    let forcedSwaps = 0;
    let lastPlanted = 6;

    for (let f = 0; f < FRAMES; f += 1) {
      lab.stepForTest(1 / 60, 1);
      const rows = window.__lens(lab, walk, yaw);
      const r = lab.report;
      if (r && r.planted < lastPlanted) swaps += 1;
      lastPlanted = r ? r.planted : lastPlanted;
      let forced = null;
      if (m === 'B') {
        forced = window.__swapOnCurrent(lab, rows);
        if (forced) forcedSwaps += 1;
      }
      trace.push({
        f,
        up: [lab.up.x, lab.up.y, lab.up.z],
        at: [lab.at.x * 5, lab.at.y * 5, lab.at.z * 5],
        fwd: [lab.forward.x, lab.forward.y, lab.forward.z],
        gripping: lab.gripping,
        moved: r ? r.movedMm : 0,
        held: r ? r.heldBackMm : 0,
        allowed: r ? r.allowed : 1,
        planted: r ? r.planted : 0,
        groping: r ? r.groping : 0,
        strain: r ? r.strain : 0,
        forced,
        legs: rows,
      });
    }
    lab.input.walk = 0;
    return { trace, swaps, forcedSwaps, ready: lab.ready };
  }, mode);

  await page.close();
  return { ...out, errors };
}

const fmt = (n, w = 6, p = 2) => (Number.isFinite(n) ? n.toFixed(p) : 'NaN').padStart(w);
const vec = (v, p = 2) => '[' + v.map((n) => n.toFixed(p).padStart(5)).join(',') + ']';

function describe(tag, out) {
  console.log('\n================ RUN ' + tag + ' ================');
  console.log(JSON.stringify({ errors: out.errors.slice(0, 3), ready: out.ready, nativeSwaps: out.swaps, forcedSwaps: out.forcedSwaps }));
  const T = out.trace;

  // Coarse trail
  console.log('\n-- coarse trail (every 0.5 s) --');
  console.log('   f   up                     at(mm)                     grip moved allowed planted strain');
  for (let i = 0; i < T.length; i += 30) {
    const t = T[i];
    console.log(
      String(t.f).padStart(4), vec(t.up), vec(t.at.map((n) => n / 10), 1).padEnd(22),
      t.gripping ? 'grip' : 'FALL', fmt(t.moved, 6, 3), fmt(t.allowed, 6, 3),
      String(t.planted).padStart(3), fmt(t.strain, 7, 3),
    );
  }

  // Find the corner: the frame her up first leaves the top by 5 degrees
  let corner = T.findIndex((t) => t.up[1] < Math.cos(5 * Math.PI / 180));
  if (corner < 0) corner = 0;
  console.log('\n-- corner (up.y < cos5deg) first at frame ' + corner + ' --');

  // Max stale angle over the whole run, per leg, while planted
  const slots = T[0].legs.map((l) => l.slot);
  console.log('\n-- per-leg worst stale angle while planted (whole run) --');
  for (const s of slots) {
    let worst = 0; let worstF = -1; let worstOOP = 0;
    for (const t of T) {
      const l = t.legs.find((x) => x.slot === s);
      if (!l || !l.planted) continue;
      if (l.angle > worst) { worst = l.angle; worstF = t.f; worstOOP = l.outOfPlane; }
    }
    console.log('  ' + s.padEnd(11) + 'worst angle ' + fmt(worst, 7, 1) + ' deg at f' + worstF
      + '  |dir.up| there ' + fmt(worstOOP, 6, 3));
  }

  // Detailed window around the corner
  const a = Math.max(0, corner - 20);
  const b = Math.min(T.length, corner + 400);
  console.log('\n-- per-frame detail, frames ' + a + '..' + (b - 1) + ' (every 5th) --');
  console.log('   f  up                  moved  allow pl gr  | per leg: slot P ang(deg) |ex|mm spentStored spentCur');
  for (let i = a; i < b; i += 5) {
    const t = T[i];
    let line = String(t.f).padStart(4) + ' ' + vec(t.up) + fmt(t.moved, 7, 3) + fmt(t.allowed, 6, 2)
      + String(t.planted).padStart(3) + String(t.groping).padStart(3);
    console.log(line);
    for (const l of t.legs) {
      console.log('        ' + l.slot.padEnd(11) + (l.planted ? 'P' : (l.groping ? 'G' : 's'))
        + ' ang' + fmt(l.angle, 7, 1)
        + ' |ex|' + fmt(l.exMagMm, 6, 3) + 'mm'
        + ' stored' + fmt(l.spentStored, 8, 3)
        + ' cur' + fmt(l.spentCurrent, 8, 3)
        + ' dir' + vec(l.dir) + ' cur' + vec(l.cur));
    }
  }

  // The decisive numbers, over the stuck tail
  const tail = T.slice(Math.max(0, T.length - 600));
  let maxStored = -1e9; let maxCur = -1e9;
  let movedTail = 0;
  for (const t of tail) {
    movedTail += t.moved;
    for (const l of t.legs) {
      if (!l.planted) continue;
      if (l.spentStored > maxStored) maxStored = l.spentStored;
      if (l.spentCurrent > maxCur) maxCur = l.spentCurrent;
    }
  }
  console.log('\n-- over the last 600 frames (10 s) --');
  console.log('  body moved total          ' + fmt(movedTail, 9, 3) + ' mm');
  console.log('  max spent (STORED dir)    ' + fmt(maxStored, 9, 3) + '   (swap needs >= 1)');
  console.log('  max spent (CURRENT dir)   ' + fmt(maxCur, 9, 3) + '   (swap needs >= 1)');
  const lastUp = T[T.length - 1].up;
  console.log('  final up ' + vec(lastUp) + '  final at(mm) ' + vec(T[T.length - 1].at, 1));
  return { corner, T };
}

const A = await run('A');
describe('A (untouched)', A);
const B = await run('B');
describe('B (swap fired on CURRENT dir)', B);

console.log('\n================ A vs B ================');
const dist = (o) => {
  const s = o.trace[0].at; const e = o.trace[o.trace.length - 1].at;
  return Math.hypot(e[0] - s[0], e[1] - s[1], e[2] - s[2]);
};
const sumMoved = (o) => o.trace.reduce((s, t) => s + t.moved, 0);
console.log('A: swaps ' + A.swaps + '  path ' + sumMoved(A).toFixed(1) + ' mm  net ' + dist(A).toFixed(1)
  + ' mm  final up ' + vec(A.trace[A.trace.length - 1].up));
console.log('B: native swaps ' + B.swaps + ' forced ' + B.forcedSwaps + '  path ' + sumMoved(B).toFixed(1)
  + ' mm  net ' + dist(B).toFixed(1) + ' mm  final up ' + vec(B.trace[B.trace.length - 1].up));

await browser.close();
