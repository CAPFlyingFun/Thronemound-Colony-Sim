/**
 * Is `excursion . dir == 0` STRUCTURAL for a leg left behind on the old face?
 *
 * After a 90-degree face change the plant-time `dir` of a stale leg is
 * (anti)parallel to the NEW body up. `excursion()` projects the up component
 * out. So the dot product is identically zero, not merely small. This checks
 * dot(dir, up) alongside the excursion for both the +Y->side lock and the
 * side->underside lock.
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
  function rows(){
    var lab = window.blockScene;
    var at=V(lab.at.x,lab.at.y,lab.at.z), up=V(lab.up.x,lab.up.y,lab.up.z),
        fwd=V(lab.forward.x,lab.forward.y,lab.forward.z);
    var right = norm(cross(up,fwd));
    return SLOTS.map(function(s){
      var leg = lab.drive.legs.find(function(l){return l.slot===s;});
      var homeW = add(add(add(at, scale(right, leg.home.x)), scale(up, leg.home.y)), scale(fwd, leg.home.z));
      var d = sub(homeW, V(leg.anchor.x,leg.anchor.y,leg.anchor.z));
      var e = sub(d, scale(up, dot(d,up)));
      var dir = V(leg.dir.x,leg.dir.y,leg.dir.z);
      return { slot:s, p:leg.planted?1:0, g:leg.groping?1:0,
        exc:+(len(e)*MM).toFixed(4), spread:+(leg.spread*MM).toFixed(4),
        ratio:+(len(e)/leg.spread).toFixed(4),
        along:+(dot(e,dir)*MM).toFixed(5),
        spent:+((dot(e,dir)/0.2)).toFixed(4),
        dirDotUp:+dot(dir,up).toFixed(4),
        anchorOnOldFace: +(leg.anchor.y*MM).toFixed(2) };
    });
  }
`;

const go = async (label, script) => {
  const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.blockScene?.drive, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const r = await page.evaluate(({ SETUP, script }) => {
    eval(SETUP);
    const lab = window.blockScene;
    // eslint-disable-next-line no-eval
    eval(script);
    return {
      report: lab.report,
      up: [lab.up.x, lab.up.y, lab.up.z].map((n) => +n.toFixed(4)),
      fwd: [lab.forward.x, lab.forward.y, lab.forward.z].map((n) => +n.toFixed(4)),
      at: [lab.at.x, lab.at.y, lab.at.z].map((n) => +(n * 5).toFixed(3)),
      legs: rows(),
    };
  }, { SETUP, script });
  console.log(`\n===== ${label} =====`);
  console.log('up', JSON.stringify(r.up), 'fwd', JSON.stringify(r.fwd), 'at(mm)', JSON.stringify(r.at));
  console.log('report', JSON.stringify(r.report));
  console.log('leg          st     exc/spread        ratio   along(mm)   spent   dir.up   anchorY(mm)');
  for (const l of r.legs) {
    console.log(l.slot.padEnd(12), (l.p ? 'DOWN ' : (l.g ? 'GROPE' : 'swing')),
      `${String(l.exc).padStart(7)}/${String(l.spread).padEnd(7)}`,
      l.ratio.toFixed(3).padStart(6), String(l.along).padStart(11),
      String(l.spent).padStart(8), String(l.dirDotUp).padStart(8),
      String(l.anchorOnOldFace).padStart(9));
  }
  await page.close();
};

// A: top -> -X side lock (turn right 90, then hold forward)
await go('lock at the TOP -> -X SIDE edge', `
  lab.input.walk=0; lab.input.yaw=-1; lab.stepForTest(1/60, 43);
  lab.input.yaw=0; lab.input.walk=1; lab.stepForTest(1/60, 700);
`);

// B: straight ahead down the +Z side, then round onto the underside
await go('lock at the +Z SIDE -> UNDERSIDE edge', `
  lab.input.walk=1; lab.input.yaw=0; lab.stepForTest(1/60, 60*22);
`);

// C: control - walking on the top, never locks
await go('CONTROL: 3 s on the top face only', `
  lab.input.walk=1; lab.input.yaw=0; lab.stepForTest(1/60, 180);
`);
await browser.close();
