/**
 * From a FRESH lock (no other input applied first), does yaw or reverse free
 * her? One page load per attempt so no attempt contaminates the next.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4401/Thronemound-Colony-Sim/?scene=block';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const SETUP = `
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
  function legRows(){
    var lab = window.blockScene;
    var at = V(lab.at.x,lab.at.y,lab.at.z), up = V(lab.up.x,lab.up.y,lab.up.z),
        fwd = V(lab.forward.x,lab.forward.y,lab.forward.z);
    return SLOTS.map(function(s){
      var leg = lab.drive.legs.find(function(l){return l.slot===s;});
      var e = excFor(leg, at, up, fwd);
      return { slot:s, p:leg.planted?1:0, g:leg.groping?1:0,
        exc:+(len(e)*MM).toFixed(4), spread:+(leg.spread*MM).toFixed(4),
        ratio:+(len(e)/leg.spread).toFixed(4),
        along:+(dot(e,V(leg.dir.x,leg.dir.y,leg.dir.z))*MM).toFixed(4),
        dir:[leg.dir.x,leg.dir.y,leg.dir.z].map(function(n){return +n.toFixed(3);}),
        anchor:[leg.anchor.x,leg.anchor.y,leg.anchor.z].map(function(n){return +(n*MM).toFixed(2);}) };
    });
  }
  function lockHer(){
    var lab = window.blockScene;
    lab.input.walk = 0; lab.input.yaw = -1;
    lab.stepForTest(1/60, 43);
    lab.input.yaw = 0; lab.input.walk = 1;
    lab.stepForTest(1/60, 700);
    lab.input.walk = 0; lab.input.yaw = 0;
  }
`;

const attempt = async (walk, yaw, label) => {
  const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.blockScene?.drive, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const r = await page.evaluate(({ SETUP, walk, yaw }) => {
    eval(SETUP);
    const lab = window.blockScene;
    lockHer();
    const before = {
      at: [lab.at.x, lab.at.y, lab.at.z].map((n) => +(n * 5).toFixed(4)),
      fwd: [lab.forward.x, lab.forward.y, lab.forward.z].map((n) => +n.toFixed(4)),
      up: [lab.up.x, lab.up.y, lab.up.z].map((n) => +n.toFixed(4)),
      legs: legRows(),
    };
    lab.input.walk = walk; lab.input.yaw = yaw;
    let moved = 0; let swaps = 0; let prevP = lab.report.planted; let firstFree = -1;
    const rows = [];
    for (let i = 0; i < 600; i += 1) {
      lab.stepForTest(1 / 60, 1);
      const rr = lab.report;
      moved += rr.movedMm;
      if (rr.planted < prevP) swaps += 1;
      prevP = rr.planted;
      if (firstFree < 0 && rr.allowed > 0.5 && i > 5) firstFree = i;
      if (i < 6 || i % 100 === 0) {
        rows.push({ i, moved: +rr.movedMm.toFixed(4), held: +rr.heldBackMm.toFixed(4),
          allowed: +rr.allowed.toFixed(4), strain: +rr.strain.toFixed(4),
          P: rr.planted, G: rr.groping,
          maxRatio: +Math.max(...legRows().filter((l) => l.p).map((l) => l.ratio)).toFixed(4) });
      }
    }
    lab.input.walk = 0; lab.input.yaw = 0;
    return {
      before, rows, swaps, totalMoved: +moved.toFixed(4), firstFree,
      after: {
        at: [lab.at.x, lab.at.y, lab.at.z].map((n) => +(n * 5).toFixed(4)),
        fwd: [lab.forward.x, lab.forward.y, lab.forward.z].map((n) => +n.toFixed(4)),
        up: [lab.up.x, lab.up.y, lab.up.z].map((n) => +n.toFixed(4)),
        legs: legRows(),
      },
    };
  }, { SETUP, walk, yaw });
  console.log(`\n===== ${label} (10 s from a fresh lock) =====`);
  console.log('before at', JSON.stringify(r.before.at), 'fwd', JSON.stringify(r.before.fwd), 'up', JSON.stringify(r.before.up));
  for (const l of r.before.legs) {
    console.log('  ', l.slot.padEnd(11), l.p ? 'DOWN ' : (l.g ? 'GROPE' : 'swing'),
      `exc ${String(l.exc).padStart(7)}/${String(l.spread).padEnd(6)} = ${l.ratio.toFixed(3)}`,
      `along ${String(l.along).padStart(7)}`, 'dir', JSON.stringify(l.dir).padEnd(22),
      'anchor', JSON.stringify(l.anchor));
  }
  console.log('  --- during ---');
  for (const q of r.rows) {
    console.log('  fr', String(q.i).padStart(3), 'moved', q.moved.toFixed(4).padStart(7),
      'held', q.held.toFixed(4).padStart(7), 'allowed', q.allowed.toFixed(4).padStart(7),
      'strain', String(q.strain).padStart(8), `P${q.P}G${q.G}`, 'maxExc/spread', q.maxRatio);
  }
  console.log('  TOTAL moved', r.totalMoved, 'mm   gait swaps', r.swaps,
    '  first frame allowed>0.5:', r.firstFree);
  console.log('  after at', JSON.stringify(r.after.at), 'fwd', JSON.stringify(r.after.fwd), 'up', JSON.stringify(r.after.up));
  for (const l of r.after.legs) {
    console.log('  ', l.slot.padEnd(11), l.p ? 'DOWN ' : (l.g ? 'GROPE' : 'swing'),
      `exc ${String(l.exc).padStart(7)}/${String(l.spread).padEnd(6)} = ${l.ratio.toFixed(3)}`,
      `along ${String(l.along).padStart(7)}`, 'dir', JSON.stringify(l.dir).padEnd(22),
      'anchor', JSON.stringify(l.anchor));
  }
  await page.close();
};

await attempt(-1, 0, 'walk = -1 (reverse)');
await attempt(0, 1, 'yaw = +1');
await attempt(0, -1, 'yaw = -1');
await attempt(1, 0, 'walk = +1 (hold forward, control)');
await browser.close();
