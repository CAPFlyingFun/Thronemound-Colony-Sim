/**
 * Reproduce the "glue trap" on the side face, frame by frame.
 *
 * Holds walk=1 from the top of the block, over the edge, onto the +Z side,
 * and keeps holding for several seconds. Every frame it records the drive
 * report, her frame, and for each leg the excursion vector (home-world minus
 * anchor, with the body-up component removed): its length, its projection on
 * the leg's plant-time `dir`, and the leg's spread limit.
 *
 * Then it tries yaw=1 and walk=-1 from the locked state.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4401/Thronemound-Colony-Sim/?scene=block';
const SECS = Number(process.env.SECS ?? 12);

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

const out = await page.evaluate((SECS) => {
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

  const snapLegs = () => {
    const at = V(lab.at.x, lab.at.y, lab.at.z);
    const up = V(lab.up.x, lab.up.y, lab.up.z);
    const fwd = V(lab.forward.x, lab.forward.y, lab.forward.z);
    const right = norm(cross(up, fwd));
    const legs = lab.drive.legs;
    const out = [];
    for (const slot of SLOTS) {
      const leg = legs.find((l) => l.slot === slot);
      if (!leg) { out.push(null); continue; }
      const homeW = add(add(add(at, scale(right, leg.home.x)), scale(up, leg.home.y)), scale(fwd, leg.home.z));
      const anchor = V(leg.anchor.x, leg.anchor.y, leg.anchor.z);
      let d = sub(homeW, anchor);
      d = sub(d, scale(up, dot(d, up)));
      const dir = V(leg.dir.x, leg.dir.y, leg.dir.z);
      out.push({
        p: leg.planted ? 1 : 0,
        g: leg.groping ? 1 : 0,
        exc: +(len(d) * MM).toFixed(3),
        along: +(dot(d, dir) * MM).toFixed(3),
        spread: +(leg.spread * MM).toFixed(3),
        t: +leg.t.toFixed(2),
        dir: [dir.x, dir.y, dir.z].map((n) => +n.toFixed(2)),
        anchor: [anchor.x, anchor.y, anchor.z].map((n) => +(n * MM).toFixed(2)),
      });
    }
    return out;
  };

  const frames = [];
  const rec = (tag) => {
    const r = lab.report;
    frames.push({
      tag,
      moved: r ? +r.movedMm.toFixed(4) : null,
      held: r ? +r.heldBackMm.toFixed(4) : null,
      allowed: r ? +r.allowed.toFixed(4) : null,
      strain: r ? +r.strain.toFixed(3) : null,
      planted: r ? r.planted : null,
      groping: r ? r.groping : null,
      clear: r ? +r.clearanceMm.toFixed(3) : null,
      up: [lab.up.x, lab.up.y, lab.up.z].map((n) => +n.toFixed(3)),
      fwd: [lab.forward.x, lab.forward.y, lab.forward.z].map((n) => +n.toFixed(3)),
      at: [lab.at.x, lab.at.y, lab.at.z].map((n) => +(n * MM).toFixed(3)),
      grip: lab.gripping,
      legs: snapLegs(),
    });
  };

  lab.input.walk = 1;
  lab.input.yaw = 0;
  const N = Math.round(SECS * 60);
  for (let i = 0; i < N; i += 1) {
    lab.stepForTest(1 / 60, 1);
    rec(`w${i}`);
  }
  const lockedAt = [lab.at.x, lab.at.y, lab.at.z];

  // Now try yaw while locked.
  const yawFrames = [];
  lab.input.walk = 0;
  lab.input.yaw = 1;
  const beforeYaw = { at: [...lockedAt], fwd: [lab.forward.x, lab.forward.y, lab.forward.z] };
  for (let i = 0; i < 180; i += 1) {
    lab.stepForTest(1 / 60, 1);
    const r = lab.report;
    yawFrames.push({
      moved: +r.movedMm.toFixed(4), held: +r.heldBackMm.toFixed(4), allowed: +r.allowed.toFixed(4),
      strain: +r.strain.toFixed(3), planted: r.planted, groping: r.groping,
      fwd: [lab.forward.x, lab.forward.y, lab.forward.z].map((n) => +n.toFixed(3)),
      at: [lab.at.x, lab.at.y, lab.at.z].map((n) => +(n * MM).toFixed(3)),
    });
  }
  const afterYaw = {
    at: [lab.at.x, lab.at.y, lab.at.z], fwd: [lab.forward.x, lab.forward.y, lab.forward.z],
    up: [lab.up.x, lab.up.y, lab.up.z],
  };

  // And backwards.
  lab.input.yaw = 0;
  lab.input.walk = -1;
  const backFrames = [];
  for (let i = 0; i < 180; i += 1) {
    lab.stepForTest(1 / 60, 1);
    const r = lab.report;
    backFrames.push({
      moved: +r.movedMm.toFixed(4), held: +r.heldBackMm.toFixed(4), allowed: +r.allowed.toFixed(4),
      strain: +r.strain.toFixed(3), planted: r.planted, groping: r.groping,
      at: [lab.at.x, lab.at.y, lab.at.z].map((n) => +(n * MM).toFixed(3)),
      up: [lab.up.x, lab.up.y, lab.up.z].map((n) => +n.toFixed(3)),
    });
  }
  lab.input.walk = 0;

  return { frames, yawFrames, backFrames, beforeYaw, afterYaw, slots: SLOTS };
}, SECS);

console.log(JSON.stringify({ errors: errors.slice(0, 3) }));
const fs = await import('node:fs');
fs.writeFileSync('/tmp/sidelock-jc.json', JSON.stringify(out));
console.log('frames', out.frames.length, 'wrote /tmp/sidelock-jc.json');

// Summary per 30 frames.
const f = out.frames;
console.log('\n== every 15th frame ==');
console.log('fr    moved   held  allow strain P G   up                       at(mm)');
for (let i = 0; i < f.length; i += 15) {
  const r = f[i];
  console.log(
    String(i).padStart(4),
    r.moved.toFixed(4).padStart(7), r.held.toFixed(4).padStart(6),
    r.allowed.toFixed(3).padStart(6), String(r.strain).padStart(7),
    r.planted, r.groping,
    JSON.stringify(r.up).padEnd(24), JSON.stringify(r.at),
  );
}
await browser.close();
