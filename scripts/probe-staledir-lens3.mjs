/**
 * LENS 3.
 *  Part 1: the -X side lock (the user's HUD: up -1.00, 0.00, 0.00), in detail,
 *          and the same run with the swap fired on the CURRENT travel dir.
 *  Part 2: rear-leg foot motion on the flat top, to see whether leg.dir has
 *          anything to do with the "back feet wiggle" half of the report.
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
  const TRIPOD_A = ['frontLeft', 'midRight', 'rearLeft'];
  const TRIPOD_B = ['frontRight', 'midLeft', 'rearRight'];
  const V = (x,y,z) => ({x,y,z});
  const add = (a,b) => V(a.x+b.x, a.y+b.y, a.z+b.z);
  const sub = (a,b) => V(a.x-b.x, a.y-b.y, a.z-b.z);
  const mul = (a,s) => V(a.x*s, a.y*s, a.z*s);
  const dot = (a,b) => a.x*b.x + a.y*b.y + a.z*b.z;
  const cross = (a,b) => V(a.y*b.z-a.z*b.y, a.z*b.x-a.x*b.z, a.x*b.y-a.y*b.x);
  const len = (a) => Math.sqrt(dot(a,a));
  const norm = (a) => { const l = len(a); return l > 1e-12 ? mul(a, 1/l) : V(0,0,0); };
  const cp = (v) => V(v.x, v.y, v.z);
  const radiusFor = (t) => (STRIDE.walk + (STRIDE.turn - STRIDE.walk) * t) / 2 / MM;
  window.__dirAge = {};

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
      const turn = speed > 1e-9 ? Math.min(1, rotSpeed/speed) : 0;
      const cur = speed > 1e-9 ? mul(stride, 1/speed) : cp(leg.dir);
      const radius = radiusFor(turn);
      let d = sub(homeWorld, cp(leg.anchor));
      d = add(d, mul(body.up, -dot(d, body.up)));
      const stored = cp(leg.dir);
      const prev = window.__dirAge[leg.slot];
      if (!prev || Math.abs(prev.dir[0]-stored.x)>1e-9 || Math.abs(prev.dir[1]-stored.y)>1e-9
          || Math.abs(prev.dir[2]-stored.z)>1e-9) {
        window.__dirAge[leg.slot] = { frame, up:[body.up.x,body.up.y,body.up.z],
          dir:[stored.x,stored.y,stored.z] };
      }
      const rec = window.__dirAge[leg.slot];
      const c = Math.max(-1, Math.min(1, dot(norm(stored), cur)));
      out.push({
        slot: leg.slot, planted: leg.planted, groping: leg.groping,
        dir: [stored.x,stored.y,stored.z], cur: [cur.x,cur.y,cur.z],
        angle: Math.acos(c)*180/Math.PI,
        outOfPlane: Math.abs(dot(norm(stored), body.up)),
        exMm: len(d)*MM, radiusMm: radius*MM,
        spentStored: dot(d, stored)/radius,
        spentCurrent: dot(d, cur)/radius,
        spreadMm: leg.spread*MM,
        at: [leg.at.x, leg.at.y, leg.at.z],
        dirSetAt: rec.frame, dirSetUp: rec.up, dirAge: frame - rec.frame,
      });
    }
    return out;
  };

  window.__swapOnCurrent = (lab, rows) => {
    let inTransit = false;
    for (const r of rows) if (!r.planted && !r.groping) inTransit = true;
    if (inTransit) return null;
    let best = null;
    for (const r of rows) { if (!r.planted) continue; if (!best || r.spentCurrent > best.spentCurrent) best = r; }
    if (!best || best.spentCurrent < 1) return null;
    const group = TRIPOD_A.includes(best.slot) ? TRIPOD_A : TRIPOD_B;
    for (const leg of lab.drive.legs) {
      if (!group.includes(leg.slot) || !leg.planted) continue;
      leg.planted = false; leg.t = 0; leg.from.copy(leg.at);
    }
    return best.slot;
  };
})()`;

async function scenario(name, script, mode) {
  const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.blockScene?.drive?.legs?.length === 6, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.evaluate(HARNESS);
  const out = await page.evaluate((arg) => {
    const { plan, mode } = JSON.parse(arg);
    const lab = window.blockScene;
    const trace = []; let f = 0; let forcedSwaps = 0;
    for (const seg of plan) {
      lab.input.walk = seg.walk; lab.input.yaw = seg.yaw;
      for (let i = 0; i < seg.frames; i += 1) {
        lab.stepForTest(1/60, 1);
        const rows = window.__lens(lab, seg.walk, seg.yaw, f);
        const r = lab.report;
        let forced = null;
        if (mode === 'B') { forced = window.__swapOnCurrent(lab, rows); if (forced) forcedSwaps += 1; }
        trace.push({
          f, walk: seg.walk, yaw: seg.yaw,
          up: [lab.up.x, lab.up.y, lab.up.z], at: [lab.at.x*5, lab.at.y*5, lab.at.z*5],
          fwd: [lab.forward.x, lab.forward.y, lab.forward.z],
          moved: r?r.movedMm:0, held: r?r.heldBackMm:0, allowed: r?r.allowed:1,
          planted: r?r.planted:0, groping: r?r.groping:0, strain: r?r.strain:0,
          forced, legs: rows,
        });
        f += 1;
      }
    }
    lab.input.walk = 0; lab.input.yaw = 0;
    return { trace, forcedSwaps };
  }, JSON.stringify({ plan: script, mode }));
  await page.close();
  return { name, errors, ...out };
}

const f2 = (n,w=7,p=3) => (Number.isFinite(n)?n.toFixed(p):'NaN').padStart(w);
const vec = (v,p=2) => '['+v.map(n=>n.toFixed(p).padStart(5)).join(',')+']';

function lockFrame(T) {
  for (let i = 0; i < T.length; i += 1) {
    if (T[i].walk === 0) continue;
    let stuck = true;
    for (let j = i; j < Math.min(T.length, i+180); j += 1) if (T[j].moved > 0.005) { stuck = false; break; }
    if (stuck && T.length - i >= 180) return i;
  }
  return -1;
}

function detail(o, from, to, every) {
  const T = o.trace;
  for (let i = Math.max(0,from); i < Math.min(T.length,to); i += every) {
    const t = T[i];
    console.log(String(t.f).padStart(4)+' up'+vec(t.up)+' fwd'+vec(t.fwd)
      +' moved'+f2(t.moved)+' allow'+f2(t.allowed,6,2)
      +' pl'+String(t.planted).padStart(2)+' gr'+String(t.groping).padStart(2)
      +' STRAIN(hud stroke)'+f2(t.strain));
    for (const l of t.legs) {
      console.log('      '+l.slot.padEnd(11)+(l.planted?'P':(l.groping?'G':'s'))
        +' dir'+vec(l.dir)+' cur'+vec(l.cur)
        +' ang'+f2(l.angle,6,1)+'d'
        +' |dir.up|'+f2(l.outOfPlane,5,2)
        +' |ex|'+f2(l.exMm,6,3)+'/spread'+l.spreadMm.toFixed(2)
        +' r'+l.radiusMm.toFixed(2)
        +' STORED'+f2(l.spentStored)+' CUR'+f2(l.spentCurrent)
        +' dirAge '+String(l.dirAge).padStart(4)+'fr up@set'+vec(l.dirSetUp));
    }
  }
}

console.log('########## PART 1: the -X side face ##########');
const XA = await scenario('X-A untouched', [{walk:0,yaw:-1,frames:43},{walk:1,yaw:0,frames:900}], 'A');
const la = lockFrame(XA.trace);
console.log('errors', JSON.stringify(XA.errors.slice(0,3)));
console.log('LOCK at frame ' + la);
console.log('\n-- the two frames before the lock, the lock frame, and 3 steady-state samples --');
detail(XA, la-2, la+2, 1);
detail(XA, 500, 900, 200);

const Tl = XA.trace[XA.trace.length-1];
console.log('\nHUD at the end of run X-A:');
console.log('  On the side - up ' + Tl.up.map(n=>n.toFixed(2)).join(', '));
console.log('  Legs: ' + Tl.planted + ' planted - ' + Tl.groping + ' reaching - '
  + Tl.moved.toFixed(2) + ' mm moved, ' + Tl.held.toFixed(2) + ' held back - stroke '
  + (Tl.strain*100).toFixed(0) + '%');

const XB = await scenario('X-B swap on CURRENT dir', [{walk:0,yaw:-1,frames:43},{walk:1,yaw:0,frames:900}], 'B');
const sum = (o) => o.trace.reduce((s,t)=>s+t.moved,0);
console.log('\n-- counterfactual --');
console.log('X-A (stored dir):  path ' + sum(XA).toFixed(1) + ' mm, lock at f' + la
  + ', final up ' + vec(XA.trace.at(-1).up) + ' at ' + vec(XA.trace.at(-1).at,1));
console.log('X-B (current dir): path ' + sum(XB).toFixed(1) + ' mm, forced swaps ' + XB.forcedSwaps
  + ', lock at f' + lockFrame(XB.trace)
  + ', final up ' + vec(XB.trace.at(-1).up) + ' at ' + vec(XB.trace.at(-1).at,1));

// What spent WOULD have been at the moment the lock set in, per leg.
console.log('\n-- at X-A lock frame ' + la + ': the decisive comparison --');
for (const l of XA.trace[la].legs) {
  console.log('  ' + l.slot.padEnd(11)
    + ' excursion ' + f2(l.exMm,6,3) + ' mm = ' + f2(l.exMm/l.radiusMm,5,2) + ' x its ' + l.radiusMm.toFixed(2) + ' mm gait radius'
    + ' | spent STORED ' + f2(l.spentStored) + '  spent CURRENT ' + f2(l.spentCurrent)
    + '  ' + (l.spentCurrent >= 1 ? 'WOULD FIRE' : 'no'));
}

console.log('\n########## PART 2: flat top, rear-leg motion ##########');
for (const [tag, plan] of [
  ['walk 1, yaw 0  ', [{walk:1,yaw:0,frames:400}]],
  ['walk 1, yaw 0.4', [{walk:1,yaw:0.4,frames:400}]],
  ['walk 0, yaw 1  ', [{walk:0,yaw:1,frames:400}]],
]) {
  const R = await scenario(tag, plan, 'A');
  const T = R.trace.filter((t) => t.up[1] > 0.99); // stay on the top only
  const slots = T[0].legs.map(l=>l.slot);
  console.log('\n' + tag + '  (' + T.length + ' frames on the top)');
  for (const s of slots) {
    let replants = 0, maxStep = 0, sumStep = 0, n = 0, maxDirSwing = 0, maxRadius = 0, minRadius = 9;
    let prevAt = null, prevPlanted = null, prevDir = null;
    for (const t of T) {
      const l = t.legs.find(x=>x.slot===s);
      if (prevPlanted === false && l.planted) replants += 1;
      if (prevAt) {
        const d = Math.hypot(l.at[0]-prevAt[0], l.at[1]-prevAt[1], l.at[2]-prevAt[2]) * 5;
        maxStep = Math.max(maxStep, d); sumStep += d; n += 1;
      }
      if (prevDir) {
        const c = Math.max(-1, Math.min(1, l.dir[0]*prevDir[0]+l.dir[1]*prevDir[1]+l.dir[2]*prevDir[2]));
        maxDirSwing = Math.max(maxDirSwing, Math.acos(c)*180/Math.PI);
      }
      maxRadius = Math.max(maxRadius, l.radiusMm); minRadius = Math.min(minRadius, l.radiusMm);
      prevAt = l.at; prevPlanted = l.planted; prevDir = l.dir;
    }
    console.log('  ' + s.padEnd(11) + 'replants ' + String(replants).padStart(3)
      + '  foot move/frame mean ' + f2(sumStep/Math.max(1,n),6,3) + ' max ' + f2(maxStep,6,3) + ' mm'
      + '  gait radius ' + minRadius.toFixed(2) + '..' + maxRadius.toFixed(2) + ' mm'
      + '  max dir jump between frames ' + f2(maxDirSwing,6,1) + ' deg');
  }
}

await browser.close();
