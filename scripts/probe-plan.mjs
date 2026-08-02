/**
 * THE COASTER BUILDER, flown for real: does she dig the tunnel that was drawn?
 *
 * The runner is unit-tested on its own, so what this asks is the part only the
 * soil can answer. A piece says "down fifteen, left forty-five, roll thirty,
 * six millimetres" — and the questions are whether her body actually ends up
 * on that grade, whether she comes out of the bend pointing forty-five degrees
 * further left, whether the roll is a bank and not a pitch in disguise, and
 * whether ten millimetres of tunnel really costs ten seconds.
 *
 * And the one that matters most for a tool you would actually use: taking the
 * stick mid-plan has to hand her straight back.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL
  ?? 'http://localhost:4542/Thronemound-Colony-Sim/?scene=block';
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];

const fresh = async () => {
  const page = await b.newPage({ viewport: { width: 932, height: 430 } });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
  // Paused the instant she is ready, so the probe owns the clock. See
  // probe-buried for what happens when it does not.
  await page.evaluate(() => window.blockScene.setPausedForTest(true));
  await page.waitForTimeout(400);
  return page;
};

/** Fly one plan and report what her body did. */
const flyCase = async (label, pieces, grab = false) => {
  const page = await fresh();
  const row = await page.evaluate(({ pieces: plan, grab: takeStick }) => {
    const lab = window.blockScene;
    const DEG = 180 / Math.PI;
    lab.setPausedForTest(true);
    lab.stepForTest(1 / 60, 120);
    lab.setMode(1);

    const V = Object.getPrototypeOf(lab.at).constructor;
    /** Her heading as a compass bearing, so a turn is a difference of two. */
    const bearing = () => Math.atan2(lab.forward.x, lab.forward.z) * DEG;
    /*
     * Her BANK, in the SAME convention the piece is written in: positive is
     * counterclockwise seen from behind her, which is her back leaning to her
     * LEFT. Measured against her right first, it read -28.9 for a +30 command
     * and looked like a sign bug in the body when it was a sign bug here.
     */
    const bank = () => {
      const noseFlat = new V(lab.forward.x, 0, lab.forward.z).normalize();
      const left = new V().crossVectors(noseFlat, new V(0, 1, 0)).normalize();
      return Math.asin(Math.max(-1, Math.min(1, lab.up.dot(left)))) * DEG;
    };

    lab.planPieces = plan;
    lab.startPlan();
    const bearing0 = bearing();
    const marks = [];
    let seconds = 0;
    let grabbedAt = -1;
    let released = null;
    /*
     * Sampled EVERY frame and pushed when the piece changes — including the
     * change to "no plan at all".
     *
     * Watching only for a piece-index change missed the last piece of every
     * plan, because finishing it clears the runner in the same step. Every
     * single-piece case came back with no marks at all and the probe crashed
     * reading them.
     */
    const sample = (piece) => ({
      piece,
      atSeconds: +seconds.toFixed(2),
      grade: +lab.gradeDeg().toFixed(1),
      turnedSoFar: +(bearing() - bearing0).toFixed(1),
      bank: +bank().toFixed(1),
    });
    for (let i = 0; i < 60 * 90 && lab.plan; i += 1) {
      const before = lab.plan.pieceIndex;
      lab.stepForTest(1 / 60, 1);
      seconds += 1 / 60;
      if (!lab.plan || lab.plan.pieceIndex !== before) marks.push(sample(before));
      if (takeStick && i === 300) {
        grabbedAt = i;
        lab.stopPlan();
        lab.input.walk = 0; lab.input.yaw = 0;
        released = { plan: lab.plan, trimOn: lab.trimOnForTest(), dig: lab.input.dig };
      }
    }
    return {
      marks,
      seconds: +seconds.toFixed(2),
      finished: lab.plan === null,
      grabbedAt,
      released,
      gripping: lab.gripping,
      removedMm3: +(lab.removed * 125).toFixed(0),
    };
  }, { pieces, grab });
  await page.close();
  return { label, ...row };
};

const out = {};
// One piece at a time, so a failure names itself.
out.pitch = await flyCase('down 15', [{ pitch: -15, turn: 0, roll: 0, length: 4 }]);
out.turn = await flyCase('left 45', [{ pitch: 0, turn: 45, roll: 0, length: 4 }]);
out.roll = await flyCase('roll 30', [{ pitch: 0, turn: 0, roll: 30, length: 4 }]);
// Then the sentence from the brief, plus a second piece to prove pieces chain.
out.full = await flyCase('down 15, left 45, roll 30, then level right 45', [
  { pitch: -15, turn: 45, roll: 30, length: 6 },
  { pitch: 0, turn: -45, roll: 0, length: 4 },
]);
out.grab = await flyCase('grabbed mid-plan', [
  { pitch: -30, turn: 0, roll: 0, length: 10 },
], true);

console.log(JSON.stringify({ ...out, errs }, null, 2));

const last = (r) => r.marks[r.marks.length - 1];
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const lines = [];
const check = (name, ok, detail) => { lines.push(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`); return ok; };

let good = true;
good = check('pitch', near(last(out.pitch).grade, -15, 4),
  `asked -15°, flew ${last(out.pitch).grade}°`) && good;
good = check('turn', near(last(out.turn).turnedSoFar, 45, 12),
  `asked left 45°, turned ${last(out.turn).turnedSoFar}°`) && good;
good = check('roll', near(last(out.roll).bank, 30, 10),
  `asked 30° bank, banked ${last(out.roll).bank}°`) && good;
good = check('pacing', near(out.pitch.seconds, 4, 1.5),
  `4 mm took ${out.pitch.seconds} s at 1 mm/s`) && good;
good = check('chaining', out.full.marks.length === 2 && out.full.finished,
  `${out.full.marks.length} pieces flown, ${out.full.seconds} s, `
  + `ended ${last(out.full).turnedSoFar}° off the start heading`) && good;
good = check('handback', out.grab.released && out.grab.released.plan === null
  && out.grab.released.trimOn === false && out.grab.released.dig === false,
  out.grab.released ? 'plan cleared, gyro released, bite let go' : 'never grabbed') && good;
good = check('no errors', errs.length === 0, errs.join('; ') || 'none') && good;

console.log('');
for (const line of lines) console.log(line);
console.log(good ? 'PLAN_FLIES' : 'PLAN_DRIFTS');
await b.close();
