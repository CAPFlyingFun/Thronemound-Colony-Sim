/**
 * LENS v6: a big sample of lift counts. A pure spin cannot reach an edge, so
 * it can run long; the mixed cases are steered back to the middle between
 * bursts instead of being allowed to walk off.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4403/Thronemound-Colony-Sim/?scene=block';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.drive, null, { timeout: 60000 });
await page.waitForTimeout(2500);

const out = await page.evaluate(() => {
  const lab = window.blockScene;
  const MM = 5;
  const SLOTS = ['frontLeft', 'frontRight', 'midLeft', 'midRight', 'rearLeft', 'rearRight'];
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

  const seat = () => {
    lab.input.walk = 0; lab.input.yaw = 0;
    lab.up.set(0, 1, 0); lab.forward.set(0, 0, 1);
    lab.at.set(6.7, 13.1 + lab.ride, 6.7);
    lab.gripping = true; lab.fallSpeed = 0;
    lab.drive.plantAll({ at: lab.at, up: lab.up, forward: lab.forward }, lab.groundForLegs);
    lab.stepForTest(1 / 60, 30);
  };

  /**
   * Run in bursts, re-seating her BODY between bursts without touching the
   * legs' relationship to it, so a long sample never reaches an edge.
   */
  const run = (walk, yaw, bursts, burstSecs) => {
    seat();
    const legOf = (s) => lab.drive.legs.find((l) => l.slot === s);
    const lifts = {}; const jumps = {}; const prev = {}; const lastA = {};
    for (const s of SLOTS) {
      lifts[s] = 0; jumps[s] = [];
      prev[s] = legOf(s).planted;
      const a = legOf(s).anchor; lastA[s] = { x: a.x, y: a.y, z: a.z };
    }
    let maxOff = 0; let minUp = 1; let grope = 0;
    for (let b = 0; b < bursts; b += 1) {
      if (b > 0) seat();
      for (const s of SLOTS) {
        prev[s] = legOf(s).planted;
        const a = legOf(s).anchor; lastA[s] = { x: a.x, y: a.y, z: a.z };
      }
      lab.input.walk = walk; lab.input.yaw = yaw;
      for (let f = 0; f < Math.round(burstSecs * 60); f += 1) {
        lab.stepForTest(1 / 60, 1);
        if (lab.report) grope += lab.report.groping;
        for (const s of SLOTS) {
          const l = legOf(s);
          if (prev[s] && !l.planted) lifts[s] += 1;
          if (!prev[s] && l.planted) {
            jumps[s].push(Math.hypot(l.anchor.x - lastA[s].x, l.anchor.y - lastA[s].y,
              l.anchor.z - lastA[s].z));
            lastA[s] = { x: l.anchor.x, y: l.anchor.y, z: l.anchor.z };
          }
          prev[s] = l.planted;
        }
        const off = Math.hypot(lab.at.x - 6.7, lab.at.z - 6.7);
        if (off > maxOff) maxOff = off;
        if (lab.up.y < minUp) minUp = lab.up.y;
      }
      lab.input.walk = 0; lab.input.yaw = 0;
    }
    const legs = {};
    for (const s of SLOTS) {
      legs[s] = { lifts: lifts[s], steps: jumps[s].length,
        jumpMm: +(mean(jumps[s]) * MM).toFixed(3) };
    }
    return { walk, yaw, secs: bursts * burstSecs, legs,
      maxOffMm: +(maxOff * MM).toFixed(1), minUp: +minUp.toFixed(3), gropeFrames: grope };
  };

  return { runs: [run(0, 1, 1, 20), run(1, 0, 10, 2.0), run(1, 0.15, 10, 2.0), run(1, 0.4, 10, 2.0)] };
});

console.log(JSON.stringify({ errors: errors.slice(0, 3) }));
const ORDER = ['frontLeft', 'frontRight', 'midLeft', 'midRight', 'rearLeft', 'rearRight'];
for (const r of out.runs) {
  console.log(`\n=== walk ${r.walk} yaw ${r.yaw}  total ${r.secs}s  offCentre ${r.maxOffMm}mm `
    + `minUp ${r.minUp} grope ${r.gropeFrames} ===`);
  for (const s of ORDER) {
    console.log('   ', s.padEnd(12), 'lifts', String(r.legs[s].lifts).padStart(3),
      'steps', String(r.legs[s].steps).padStart(3), 'meanJump', r.legs[s].jumpMm.toFixed(3), 'mm');
  }
  const f = (r.legs.frontLeft.lifts + r.legs.frontRight.lifts) / 2;
  const m = (r.legs.midLeft.lifts + r.legs.midRight.lifts) / 2;
  const b = (r.legs.rearLeft.lifts + r.legs.rearRight.lifts) / 2;
  console.log(`    LIFTS front ${f} mid ${m} rear ${b}  ->  REAR/FRONT = ${(b / f).toFixed(4)}`);
}
await browser.close();
