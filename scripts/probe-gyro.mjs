/**
 * THE GYRO: does an attitude hold let her dig DOWNWARD, and what does it cost?
 *
 * She could not descend. `hold()` casts through her soles, finds a face, and
 * seats her on it — so nosing into the floor and biting just carved a divot
 * she was then pulled straight back out of. Five bites, 57 mm³ gone, height
 * 65.24 mm before and 65.24 mm after.
 *
 * The idea under test is that the missing degree of freedom is a commanded
 * attitude: hold a grade, and because the grip cast runs along her own down,
 * a nose-down body aims that cast into the hole she is making. Four questions,
 * in the order they can invalidate each other:
 *
 *   SIGN      does a negative command actually point her nose DOWN?
 *   HOLD      does she converge on the commanded grade, and STAY there —
 *             a trim taken against the local soil instead of the world would
 *             compound every frame and roll her over inside a second or two.
 *   DESCEND   with the gyro on, does digging now take her below the surface?
 *   COST      does holding a grade break the six-face walk, which works?
 */
import { chromium } from 'playwright';

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const p = await b.newPage({ viewport: { width: 932, height: 430 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(process.env.SMOKE_URL ?? 'http://localhost:4534/Thronemound-Colony-Sim/?scene=block',
  { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await p.waitForTimeout(1500);

const out = await p.evaluate(() => {
  const lab = window.blockScene;
  const MM = 5;
  const D = Math.PI / 180;
  const report = {};

  /*
   * Put her back where she SPAWNED, not where I guess the block is.
   *
   * The first version of this teleported her to the world origin, which is not
   * the middle of the top face — so `fall()` caught her inside the soil and
   * flung her back to the surface, and every descent case then measured the
   * same fifty-millimetre RISE. Snapshot the real spawn once and restore it.
   */
  const spawn = { at: lab.at.clone(), up: lab.up.clone(), forward: lab.forward.clone() };
  const reset = () => {
    lab.setTrim(false);
    lab.input.walk = 0; lab.input.yaw = 0; lab.input.dig = false;
    lab.at.copy(spawn.at);
    lab.up.copy(spawn.up);
    lab.forward.copy(spawn.forward);
    lab.gripping = true;
    lab.stepForTest(1 / 60, 90);
  };

  // SIGN + HOLD: command a grade, run two seconds, see where her nose sits and
  // whether it is still there after two more.
  report.hold = [];
  for (const want of [-60, -40, -20, 0, 20, 40]) {
    reset();
    lab.setTrim(true, want * D);
    lab.stepForTest(1 / 60, 120);
    const at2s = lab.gradeDeg();
    lab.stepForTest(1 / 60, 120);
    const at4s = lab.gradeDeg();
    report.hold.push({
      want, at2s: +at2s.toFixed(1), at4s: +at4s.toFixed(1),
      err: +(at2s - want).toFixed(1), drift: +(at4s - at2s).toFixed(1),
    });
  }

  /*
   * COST, asked the RIGHT way round.
   *
   * The first version demanded that walking with the gyro holding level match
   * walking without it, and that is not a defect when they differ — it is the
   * gyro working. Holding a world grade is flatly incompatible with rounding
   * the block's edge onto the underside, which needs the nose to swing through
   * ninety degrees down and back. So a level hold reaching only the top and
   * sides is the design, and it is exactly the objection about sticking to the
   * side of things.
   *
   * The two things that ARE defects if they fail: with the gyro off she must
   * be the same ant she was before any of this existed, and releasing it must
   * hand her straight back. A hold you cannot get out of is the stuck stick
   * again with a different name.
   */
  const walk = (label, setup) => {
    reset();
    setup();
    lab.input.walk = 1;
    const seen = new Set();
    let fell = 0;
    for (let i = 0; i < 1800; i += 1) {
      lab.stepForTest(1 / 60, 1);
      const u = lab.up;
      seen.add(Math.abs(u.y) > 0.7 ? (u.y > 0 ? 'top' : 'under') : 'side');
      if (!lab.gripping) fell += 1;
    }
    lab.input.walk = 0;
    return { label, faces: [...seen].sort().join('+'), framesFalling: fell };
  };
  report.walk = [
    walk('gyro off', () => {}),
    walk('holding level', () => lab.setTrim(true, 0)),
    walk('holding -60', () => lab.setTrim(true, -60 * D)),
    walk('held then released', () => {
      lab.setTrim(true, -60 * D);
      lab.input.walk = 1;
      lab.stepForTest(1 / 60, 300);
      lab.setTrim(false);
    }),
  ];
  reset();
  return report;
});

/*
 * DESCEND, each case on VIRGIN SOIL.
 *
 * These ran back to back in one page at first, and `reset()` puts her body
 * back but cannot put the dirt back — so every case was digging through the
 * craters of the one before it, and the same gyro-off baseline measured
 * 0.03 mm on one run and 26.27 mm on the next. Not a measurement. A fresh
 * load per case costs a few seconds and makes the number mean something.
 */
const digCase = async (grade, walk) => {
  const page = await b.newPage({ viewport: { width: 932, height: 430 } });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(process.env.SMOKE_URL ?? 'http://localhost:4534/Thronemound-Colony-Sim/?scene=block',
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
  await page.waitForTimeout(1200);
  const row = await page.evaluate(({ grade: g, walk: w }) => {
    const lab = window.blockScene;
    const MM = 5;
    if (g !== null) lab.setTrim(true, (g * Math.PI) / 180);
    lab.setMode(1);
    lab.setAimPitchForTest(-Math.PI / 2.4);
    const y0 = lab.at.y * MM;
    let bites = 0;
    for (let r = 0; r < 240; r += 1) {
      lab.input.dig = true;
      lab.input.walk = w;
      lab.digCooldown = 0;
      lab.stepForTest(1 / 60, 6);
      if (!lab.lastBiteWhy) bites += 1;
    }
    return {
      sankMm: +(y0 - lab.at.y * MM).toFixed(2),
      buriedMm: +(lab.buriedDepth(lab.at) * MM).toFixed(2),
      removedMm3: +(lab.removed * MM ** 3).toFixed(0),
      bites,
      gripping: lab.gripping,
    };
  }, { grade, walk });
  await page.close();
  return { grade, walk, ...row };
};
out.descend = [];
for (const [grade, walk] of [[null, 0], [null, 1], [-40, 1], [-60, 1], [-75, 1]]) {
  out.descend.push(await digCase(grade, walk));
}

/*
 * UNDERGROUND, which is the case actually asked for: "keep the body at that
 * angle ONCE UNDERGROUND".
 *
 * Digging IN is the hardest thing to ask a grade hold to help with, and it is
 * all the cases above test. In a tunnel the job is different and much more
 * plausible — floor, wall and ceiling normals swap around as she moves, and
 * each swap yanks her attitude. So: bury her the same way both times, then run
 * on with the gyro off and with it holding, and measure how much her nose
 * WANDERS.
 */
const tunnelCase = async (hold) => {
  const page = await b.newPage({ viewport: { width: 932, height: 430 } });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(process.env.SMOKE_URL ?? 'http://localhost:4534/Thronemound-Colony-Sim/?scene=block',
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
  await page.waitForTimeout(1200);
  const row = await page.evaluate((holdIt) => {
    const lab = window.blockScene;
    const MM = 5;
    lab.setMode(1);
    lab.setAimPitchForTest(-Math.PI / 2.4);
    // Bury her identically in both runs: no gyro on the way in.
    for (let r = 0; r < 200; r += 1) {
      lab.input.dig = true; lab.input.walk = 1; lab.digCooldown = 0;
      lab.stepForTest(1 / 60, 6);
    }
    const enteredMm = +(lab.buriedDepth(lab.at) * MM).toFixed(2);
    if (holdIt) lab.setTrim(true, lab.gradeDeg() * Math.PI / 180);
    // Now tunnel on, and watch the nose.
    const grades = [];
    let swing = 0;
    let last = lab.up.clone();
    for (let r = 0; r < 600; r += 1) {
      lab.input.dig = true; lab.input.walk = 1; lab.digCooldown = 0;
      lab.stepForTest(1 / 60, 2);
      grades.push(lab.gradeDeg());
      swing += Math.acos(Math.max(-1, Math.min(1, lab.up.dot(last)))) * 180 / Math.PI;
      last = lab.up.clone();
    }
    const mean = grades.reduce((a, x) => a + x, 0) / grades.length;
    const sd = Math.sqrt(grades.reduce((a, x) => a + (x - mean) ** 2, 0) / grades.length);
    return {
      enteredMm,
      endedBuriedMm: +(lab.buriedDepth(lab.at) * MM).toFixed(2),
      gradeMean: +mean.toFixed(1),
      gradeSd: +sd.toFixed(1),
      totalSwingDeg: +swing.toFixed(0),
      gripping: lab.gripping,
    };
  }, hold);
  await page.close();
  return { hold, ...row };
};
out.tunnel = [await tunnelCase(false), await tunnelCase(true)];

console.log(JSON.stringify({ ...out, errs }, null, 2));

const holdOk = out.hold.every((r) => Math.abs(r.err) <= 3 && Math.abs(r.drift) <= 1);
const descendOk = out.descend.some((r) => r.grade !== null && r.sankMm > 1);
// Untouched with the gyro off, and fully handed back when it is released.
const free = (r) => r.faces === 'side+top+under' && r.framesFalling === 0;
const costOk = free(out.walk[0]) && free(out.walk[3]);
console.log(`\nHOLD     ${holdOk ? 'converges and stays' : 'MISSES OR DRIFTS'}`);
console.log(`DESCEND  baseline sank ${out.descend[0].sankMm} mm · `
  + out.descend.slice(1).map((r) => `${r.grade ?? 'none'}° walking sank ${r.sankMm} mm (buried ${r.buriedMm})`).join(' · '));
console.log(`TUNNEL   ` + out.tunnel.map((r) => `gyro ${r.hold ? 'held' : 'off'}: nose sd ${r.gradeSd}° · swing ${r.totalSwingDeg}° · buried ${r.enteredMm}→${r.endedBuriedMm} mm`).join(' · '));
console.log(`COST     ${out.walk.map((r) => `${r.label}: ${r.faces}${r.framesFalling ? ` (${r.framesFalling} falling)` : ""}`).join(" · ")}`);
console.log(holdOk && descendOk && costOk && errs.length === 0 ? 'GYRO_GOOD' : 'GYRO_BAD');
await b.close();
