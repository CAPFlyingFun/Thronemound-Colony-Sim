/**
 * LENS 2: the lock itself, frame by frame, plus a SIDE-face reproduction.
 *
 * Scenario S: straight forward off the +Z edge (as lens 1) -> locks on the
 *   underside. Prints every frame around the lock.
 * Scenario X: yaw 90 deg first so she heads -X, then walk off the -X edge,
 *   which is the face the user reported (up -1.00, 0.00, 0.00).
 *
 * For every leg it also tracks WHEN leg.dir was last written and what body.up
 * was on that frame, so "stale" is a measured age and not an adjective.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4402/Thronemound-Colony-Sim/?scene=block';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const HARNESS = `(() => {
  const MM = 5, WALK_SPEED = 1.6, YAW_RATE = 2.2;
  const STRIDE = { walk: 2.0, turn: 0.8 };
  const V = (x, y, z) => ({ x, y, z });
  const add = (a, b) => V(a.x + b.x, a.y + b.y, a.z + b.z);
  const sub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
  const mul = (a, s) => V(a.x * s, a.y * s, a.z * s);
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const cross = (a, b) => V(a.y*b.z-a.z*b.y, a.z*b.x-a.x*b.z, a.x*b.y-a.y*b.x);
  const len = (a) => Math.sqrt(dot(a, a));
  const norm = (a) => { const l = len(a); return l > 1e-12 ? mul(a, 1/l) : V(0,0,0); };
  const cp = (v) => V(v.x, v.y, v.z);
  const radiusFor = (t) => (STRIDE.walk + (STRIDE.turn - STRIDE.walk) * t) / 2 / MM;

  window.__dirAge = {};   // slot -> { frame, up:[..], dir:[..] }

  window.__lens = (lab, walk, yaw, frame) => {
    const body = { at: cp(lab.at), up: cp(lab.up), forward: cp(lab.forward) };
    const right = norm(cross(body.up, body.forward));
    const out = [];
    for (const leg of lab.drive.legs) {
      const offset = add(add(mul(right, leg.home.x), mul(body.up, leg.home.y)), mul(body.forward, leg.home.z));
      const homeWorld = add(body.at, offset);
      const linear = mul(body.forward, WALK_SPEED * walk);
      const angular = mul(cross(body.up, offset), YAW_RATE * yaw);
      const stride = add(linear, angular);
      const speed = len(stride), rotSpeed = len(angular);
      const turn = speed > 1e-9 ? Math.min(1, rotSpeed / speed) : 0;
      const cur = speed > 1e-9 ? mul(stride, 1/speed) : cp(leg.dir);
      const radius = radiusFor(turn);
      let d = sub(homeWorld, cp(leg.anchor));
      d = add(d, mul(body.up, -dot(d, body.up)));
      const stored = cp(leg.dir);
      const prev = window.__dirAge[leg.slot];
      if (!prev || Math.abs(prev.dir[0]-stored.x) > 1e-9 || Math.abs(prev.dir[1]-stored.y) > 1e-9
          || Math.abs(prev.dir[2]-stored.z) > 1e-9) {
        window.__dirAge[leg.slot] = { frame, up: [body.up.x, body.up.y, body.up.z],
          dir: [stored.x, stored.y, stored.z] };
      }
      const rec = window.__dirAge[leg.slot];
      const cosang = Math.max(-1, Math.min(1, dot(norm(stored), cur)));
      out.push({
        slot: leg.slot, planted: leg.planted, groping: leg.groping,
        dir: [stored.x, stored.y, stored.z], cur: [cur.x, cur.y, cur.z],
        angle: Math.acos(cosang) * 180 / Math.PI,
        outOfPlane: Math.abs(dot(norm(stored), body.up)),
        exMm: len(d) * MM,
        spentStored: dot(d, stored) / radius,
        spentCurrent: dot(d, cur) / radius,
        spreadMm: leg.spread * MM,
        dirSetAt: rec.frame, dirSetUp: rec.up,
      });
    }
    return out;
  };
})()`;

async function scenario(name, script) {
  const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.blockScene?.drive?.legs?.length === 6, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.evaluate(HARNESS);
  const out = await page.evaluate((s) => {
    const lab = window.blockScene;
    const plan = JSON.parse(s); // [{walk,yaw,frames}, ...]
    const trace = [];
    let f = 0;
    for (const leg of plan) {
      lab.input.walk = leg.walk; lab.input.yaw = leg.yaw;
      for (let i = 0; i < leg.frames; i += 1) {
        lab.stepForTest(1 / 60, 1);
        const rows = window.__lens(lab, leg.walk, leg.yaw, f);
        const r = lab.report;
        trace.push({
          f, walk: leg.walk, yaw: leg.yaw,
          up: [lab.up.x, lab.up.y, lab.up.z],
          at: [lab.at.x * 5, lab.at.y * 5, lab.at.z * 5],
          fwd: [lab.forward.x, lab.forward.y, lab.forward.z],
          grip: lab.gripping,
          moved: r ? r.movedMm : 0, held: r ? r.heldBackMm : 0,
          allowed: r ? r.allowed : 1, planted: r ? r.planted : 0,
          groping: r ? r.groping : 0, strain: r ? r.strain : 0,
          legs: rows,
        });
        f += 1;
      }
    }
    lab.input.walk = 0; lab.input.yaw = 0;
    return { trace };
  }, JSON.stringify(script));
  await page.close();
  return { name, errors, ...out };
}

const f2 = (n, w = 7, p = 3) => (Number.isFinite(n) ? n.toFixed(p) : 'NaN').padStart(w);
const vec = (v, p = 2) => '[' + v.map((n) => n.toFixed(p).padStart(5)).join(',') + ']';

function report(o, detailFrom, detailTo, every) {
  const T = o.trace;
  console.log('\n############ ' + o.name + ' ############');
  console.log(JSON.stringify({ errors: o.errors.slice(0, 3) }));

  // Where does she stop for good?
  let lock = -1;
  for (let i = 0; i < T.length; i += 1) {
    if (T[i].walk === 0) continue;
    let stuck = true;
    for (let j = i; j < Math.min(T.length, i + 180); j += 1) {
      if (T[j].moved > 0.005) { stuck = false; break; }
    }
    if (stuck && T.length - i >= 180) { lock = i; break; }
  }
  console.log('LOCK (first frame after which she moves < 0.005 mm for 3 s): ' + lock);
  if (lock >= 0) {
    const t = T[lock];
    console.log('  at lock: up ' + vec(t.up) + '  at(mm) ' + vec(t.at, 1)
      + '  planted ' + t.planted + ' groping ' + t.groping
      + '  strain ' + f2(t.strain) + '  allowed ' + f2(t.allowed)
      + '  moved ' + f2(t.moved) + ' held ' + f2(t.held));
    const last = T[T.length - 1];
    console.log('  100 frames later HUD-equivalent: up ' + vec(last.up)
      + ' planted ' + last.planted + ' reaching ' + last.groping
      + ' moved ' + f2(last.moved) + ' held ' + f2(last.held)
      + ' stroke ' + (last.strain * 100).toFixed(0) + '%');
  }

  const a = Math.max(0, detailFrom), b = Math.min(T.length, detailTo);
  console.log('\n-- frames ' + a + '..' + (b - 1) + ' (every ' + every + ') --');
  for (let i = a; i < b; i += every) {
    const t = T[i];
    console.log(String(t.f).padStart(4) + ' up' + vec(t.up) + ' fwd' + vec(t.fwd)
      + ' moved' + f2(t.moved) + ' allow' + f2(t.allowed, 6, 2)
      + ' pl' + String(t.planted).padStart(2) + ' gr' + String(t.groping).padStart(2)
      + ' strain' + f2(t.strain));
    for (const l of t.legs) {
      console.log('      ' + l.slot.padEnd(11) + (l.planted ? 'P' : (l.groping ? 'G' : 's'))
        + ' dir' + vec(l.dir) + ' cur' + vec(l.cur)
        + ' ang' + f2(l.angle, 6, 1) + 'deg'
        + ' |dir.up|' + f2(l.outOfPlane, 6, 2)
        + ' |ex|' + f2(l.exMm, 6, 3) + '/' + l.spreadMm.toFixed(2) + 'mm'
        + ' spentSTORED' + f2(l.spentStored)
        + ' spentCUR' + f2(l.spentCurrent)
        + ' dirSetAt f' + String(l.dirSetAt).padStart(4) + ' up@set' + vec(l.dirSetUp));
    }
  }

  // Steady-state numbers over the tail
  const tail = T.slice(-300);
  let ms = -1e9, mc = -1e9, mv = 0, mex = 0;
  for (const t of tail) {
    mv += t.moved;
    for (const l of t.legs) {
      if (!l.planted) continue;
      ms = Math.max(ms, l.spentStored); mc = Math.max(mc, l.spentCurrent);
      mex = Math.max(mex, l.exMm);
    }
  }
  console.log('\n-- last 300 frames (5 s) --');
  console.log('  moved total        ' + f2(mv, 9) + ' mm');
  console.log('  max spent STORED   ' + f2(ms, 9) + '   (swap fires at >= 1)');
  console.log('  max spent CURRENT  ' + f2(mc, 9) + '   (swap fires at >= 1)');
  console.log('  max |excursion|    ' + f2(mex, 9) + ' mm');
}

// S: straight off the +Z edge, all the way round to the underside.
const S = await scenario('S: straight forward (top -> +Z side -> underside)',
  [{ walk: 1, yaw: 0, frames: 1000 }]);
report(S, 700, 800, 1);

// X: turn ~90 deg to face -X, then walk off the -X edge.
const X = await scenario('X: yaw to face -X, then walk off the -X edge',
  [{ walk: 0, yaw: -1, frames: 43 }, { walk: 1, yaw: 0, frames: 900 }]);
report(X, 0, 0, 1);

await browser.close();
