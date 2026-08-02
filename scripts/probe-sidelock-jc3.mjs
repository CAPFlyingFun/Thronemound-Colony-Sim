/**
 * Frame-by-frame across the +Y -> -X transition that locks, with per-leg
 * excursion, excursion.dir, and spread. Also probes yaw and reverse from the
 * locked state, and separates what drive.step() does from what hold() does.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4401/Thronemound-Colony-Sim/?scene=block';
const YAWSIGN = Number(process.env.YAWSIGN ?? -1);
const YAWSECS = Number(process.env.YAWSECS ?? 0.714);
const TAG = process.env.TAG ?? 'minusX';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.drive, null, { timeout: 60000 });
await page.waitForTimeout(2000);

const out = await page.evaluate(({ YAWSIGN, YAWSECS }) => {
  const lab = window.blockScene;
  const MM = 5;
  const SLOTS = ['frontLeft', 'frontRight', 'midLeft', 'midRight', 'rearLeft', 'rearRight'];
  const V = (x, y, z) => ({ x, y, z });
  const sub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const cross = (a, b) => V(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  const scale = (a, s) => V(a.x * s, a.y * s, a.z * s);
  const add = (a, b) => V(a.x + b.x, a.y + b.y, a.z + b.z);
  const len = (a) => Math.sqrt(dot(a, a));
  const norm = (a) => { const l = len(a) || 1; return scale(a, 1 / l); };

  const legSnap = () => {
    const at = V(lab.at.x, lab.at.y, lab.at.z);
    const up = V(lab.up.x, lab.up.y, lab.up.z);
    const fwd = V(lab.forward.x, lab.forward.y, lab.forward.z);
    const right = norm(cross(up, fwd));
    return SLOTS.map((slot) => {
      const leg = lab.drive.legs.find((l) => l.slot === slot);
      const homeW = add(add(add(at, scale(right, leg.home.x)), scale(up, leg.home.y)),
        scale(fwd, leg.home.z));
      const anchor = V(leg.anchor.x, leg.anchor.y, leg.anchor.z);
      let d = sub(homeW, anchor);
      d = sub(d, scale(up, dot(d, up)));
      const dir = V(leg.dir.x, leg.dir.y, leg.dir.z);
      return {
        p: leg.planted ? 1 : 0, g: leg.groping ? 1 : 0,
        exc: +(len(d) * MM).toFixed(3),
        along: +(dot(d, dir) * MM).toFixed(3),
        spread: +(leg.spread * MM).toFixed(3),
        dir: [dir.x, dir.y, dir.z].map((n) => +n.toFixed(2)),
        anchor: [anchor.x, anchor.y, anchor.z].map((n) => +(n * MM).toFixed(2)),
        t: +leg.t.toFixed(2),
      };
    });
  };

  const frames = [];
  const rec = () => {
    const r = lab.report;
    frames.push({
      moved: +r.movedMm.toFixed(4), held: +r.heldBackMm.toFixed(4),
      allowed: +r.allowed.toFixed(5), strain: +r.strain.toFixed(4),
      planted: r.planted, groping: r.groping, clear: +r.clearanceMm.toFixed(3),
      up: [lab.up.x, lab.up.y, lab.up.z].map((n) => +n.toFixed(4)),
      fwd: [lab.forward.x, lab.forward.y, lab.forward.z].map((n) => +n.toFixed(4)),
      at: [lab.at.x, lab.at.y, lab.at.z].map((n) => +(n * MM).toFixed(4)),
      grip: lab.gripping,
      legs: legSnap(),
    });
  };

  lab.input.walk = 0; lab.input.yaw = YAWSIGN;
  lab.stepForTest(1 / 60, Math.round(YAWSECS * 60));
  lab.input.yaw = 0;
  lab.input.walk = 1;
  for (let i = 0; i < 700; i += 1) { lab.stepForTest(1 / 60, 1); rec(); }

  // --- from the locked state: yaw only
  const probe = (walk, yaw, n) => {
    lab.input.walk = walk; lab.input.yaw = yaw;
    const rows = [];
    for (let i = 0; i < n; i += 1) {
      lab.stepForTest(1 / 60, 1);
      const r = lab.report;
      rows.push({
        moved: +r.movedMm.toFixed(4), held: +r.heldBackMm.toFixed(4),
        allowed: +r.allowed.toFixed(5), strain: +r.strain.toFixed(4),
        planted: r.planted, groping: r.groping,
        at: [lab.at.x, lab.at.y, lab.at.z].map((n2) => +(n2 * MM).toFixed(3)),
        up: [lab.up.x, lab.up.y, lab.up.z].map((n2) => +n2.toFixed(3)),
        fwd: [lab.forward.x, lab.forward.y, lab.forward.z].map((n2) => +n2.toFixed(3)),
        maxExc: Math.max(...legSnap().filter((l) => l.p).map((l) => l.exc / l.spread)).toFixed(3),
      });
    }
    lab.input.walk = 0; lab.input.yaw = 0;
    return rows;
  };
  const yawRows = probe(0, 1, 300);
  const yawRows2 = probe(0, -1, 300);
  const backRows = probe(-1, 0, 300);
  const fwdAgain = probe(1, 0, 120);

  return { frames, yawRows, yawRows2, backRows, fwdAgain, slots: SLOTS };
}, { YAWSIGN, YAWSECS });

fs.writeFileSync(`/tmp/sidelock-${TAG}.json`, JSON.stringify(out));
console.log(JSON.stringify({ errors: errors.slice(0, 3) }), 'frames', out.frames.length);

const f = out.frames;
// first frame after which she never moves more than 0.001 mm again
let lockFrame = -1;
for (let i = 0; i < f.length; i += 1) {
  if (f.slice(i).every((r) => r.moved < 0.001)) { lockFrame = i; break; }
}
console.log('first frame of permanent zero movedMm:', lockFrame);
const S = out.slots;
const show = (i) => {
  const r = f[i];
  console.log(`\n--- fr ${i}  moved ${r.moved} held ${r.held} allowed ${r.allowed} strain ${r.strain} P${r.planted} G${r.groping} clear ${r.clear}`);
  console.log(`    up ${JSON.stringify(r.up)} fwd ${JSON.stringify(r.fwd)} at ${JSON.stringify(r.at)}`);
  r.legs.forEach((l, k) => console.log(
    '   ', S[k].padEnd(11), l.p ? 'DOWN' : (l.g ? 'GROPE' : 'swing'),
    'exc', String(l.exc).padStart(7), '/', String(l.spread).padEnd(6),
    '=', (l.exc / l.spread).toFixed(2).padStart(5),
    'along', String(l.along).padStart(7),
    'dir', JSON.stringify(l.dir).padEnd(20),
    'anchor', JSON.stringify(l.anchor),
  ));
};
const lo = Math.max(0, lockFrame - 14);
for (let i = lo; i <= Math.min(f.length - 1, lockFrame + 6); i += 1) show(i);
show(f.length - 1);

const brief = (name, rows) => {
  console.log(`\n== ${name} ==`);
  for (let i = 0; i < rows.length; i += 20) {
    const r = rows[i];
    console.log(String(i).padStart(4), 'moved', r.moved.toFixed(4).padStart(7),
      'held', r.held.toFixed(4).padStart(7), 'allow', r.allowed.toFixed(4).padStart(7),
      'strain', String(r.strain).padStart(8), `P${r.planted}G${r.groping}`,
      'maxExc/spread', r.maxExc, 'at', JSON.stringify(r.at), 'fwd', JSON.stringify(r.fwd ?? []));
  }
  const tot = rows.reduce((s, r) => s + r.moved, 0);
  console.log(' total moved mm', tot.toFixed(3), 'last at', JSON.stringify(rows.at(-1).at),
    'last up', JSON.stringify(rows.at(-1).up));
};
brief('yaw=+1 (5s)', out.yawRows);
brief('yaw=-1 (5s)', out.yawRows2);
brief('walk=-1 (5s)', out.backRows);
brief('walk=+1 again (2s)', out.fwdAgain);
await browser.close();
