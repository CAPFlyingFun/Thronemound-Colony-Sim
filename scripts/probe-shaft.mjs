/**
 * CRAWL DOWN A SHAFT THAT WAS NEVER DUG.
 *
 * Every underground measurement so far has been taken in a tunnel she chewed
 * herself, which means it measured the digging as much as whatever was under
 * test. This one cannot: the bore is cut to ten millimetres across and runs
 * exactly vertical into a room of exactly ten by ten by twenty, and she is
 * asked to walk down it with the jaws OFF.
 *
 * So it separates the last two things that were still tangled:
 *
 *   If she crawls down cleanly, the grip is fine at ninety degrees and it is
 *   DIGGING that breaks her.
 *   If she tumbles here too, the grip cannot hold a vertical wall at all and
 *   the digging was never the problem.
 *
 * Either answer is worth more than another run in a hand-dug hole.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL
  ?? 'http://localhost:4575/Thronemound-Colony-Sim/?scene=block&shape=shaft';
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await b.newPage({ viewport: { width: 932, height: 430 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await page.evaluate(() => window.blockScene.setPausedForTest(true));
await page.waitForTimeout(400);

const run = async (mode) => {
  const p2 = await b.newPage({ viewport: { width: 932, height: 430 } });
  p2.on('pageerror', (e) => errs.push(e.message));
  await p2.goto(URL, { waitUntil: 'domcontentloaded' });
  await p2.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
  await p2.evaluate(() => window.blockScene.setPausedForTest(true));
  await p2.waitForTimeout(400);
  const r = await p2.evaluate((how) => {
  const lab = window.blockScene;
  const MM = 5;
  const DEG = 180 / Math.PI;
  const V = Object.getPrototypeOf(lab.at).constructor;
  lab.setPausedForTest(true);
  lab.stepForTest(1 / 60, 180);

  const shaftX = lab.at.x * MM;
  const shaftZ = lab.at.z * MM + 11;
  if (how === 'inside') {
    /*
     * PUT HER IN THE BORE, rather than hoping she falls into it.
     *
     * Walking at the mouth does not work — see the other case — and "can she
     * crawl a vertical shaft" is a different question from "can she find one".
     * Set down against the wall with her back to the axis and her nose down,
     * which is how an ant is in a shaft.
     */
    lab.at.set(
      (shaftX + 3.6) / MM, lab.at.y - 8 / MM, shaftZ / MM,
    );
    lab.up.set(-1, 0, 0);
    lab.forward.set(0, -1, 0);
    lab.gripping = true;
    lab.stepForTest(1 / 60, 60);
  }
  const startY = lab.at.y * MM;
  const worst = { frameUpDeg: 0, frameLookDeg: 0, frameEyeMm: 0, offAxisMm: 0 };
  const bite = (k, v) => { worst[k] = Math.max(worst[k], Math.abs(v)); };
  let lastUp = lab.up.clone();
  let lastLook = lab.camera.getWorldDirection(new V());
  let lastEye = lab.camera.position.clone();
  const track = [];
  const seen = {};
  let deepest = 0;
  let reachedRoom = -1;

  for (let i = 0; i < (how === 'inside' ? 900 : 3000); i += 1) {
    // Straight ahead, and NOTHING else. No bite, no steering.
    lab.input.walk = 1;
    lab.input.dig = false;
    lab.stepForTest(1 / 60, 1);

    const down = startY - lab.at.y * MM;
    deepest = Math.max(deepest, down);
    const state = lab.travelState;
    seen[state] = (seen[state] ?? 0) + 1;
    if (reachedRoom < 0 && state === 'chamber') reachedRoom = i;
    // Once she is IN the shaft, how far off its axis does she sit?
    if (down > 6) {
      bite('offAxisMm', Math.hypot(lab.at.x * MM - shaftX, lab.at.z * MM - shaftZ));
    }
    const look = lab.camera.getWorldDirection(new V());
    bite('frameUpDeg', Math.acos(Math.max(-1, Math.min(1, lab.up.dot(lastUp)))) * DEG);
    bite('frameLookDeg', Math.acos(Math.max(-1, Math.min(1, look.dot(lastLook)))) * DEG);
    bite('frameEyeMm', lab.camera.position.distanceTo(lastEye) * MM);
    lastUp = lab.up.clone(); lastLook = look.clone(); lastEye = lab.camera.position.clone();

    if (i % (how === 'inside' ? 60 : 150) === 0) {
      track.push({
        i,
        downMm: +down.toFixed(2),
        upY: +lab.up.y.toFixed(2),
        state,
        bore: +lab.roomForTest().boreMm.toFixed(1),
      });
    }
  }
  lab.input.walk = 0;
  const round = (o) => Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, +v.toFixed(2)]),
  );
  return {
    mode: how,
    deepestMm: +deepest.toFixed(2),
    endedMm: +(startY - lab.at.y * MM).toFixed(2),
    reachedRoomFrame: reachedRoom,
    states: seen,
    worst: round(worst),
    track,
  };
  }, mode);
  await p2.close();
  return r;
};

const walkIn = await run('walk');
const out = await run('inside');
await page.close();

console.log(JSON.stringify({ walkingAtTheMouth: walkIn, placedInTheBore: out, errs }, null, 2));
console.log('');
console.log(`WALKING AT THE MOUTH: deepest ${walkIn.deepestMm} mm, `
  + `states ${JSON.stringify(walkIn.states)}`);
console.log('');
console.log('PLACED IN THE BORE:');
console.log('');
console.log(`${'frame'.padStart(6)} ${'down'.padStart(8)} ${'up.y'.padStart(6)} `
  + `${'bore'.padStart(6)}  state`);
for (const t of out.track) {
  console.log(`${String(t.i).padStart(6)} ${String(t.downMm).padStart(8)} `
    + `${String(t.upY).padStart(6)} ${String(t.bore).padStart(6)}  ${t.state}`);
}
console.log('');
console.log(`deepest ${out.deepestMm} mm · ended ${out.endedMm} mm down · `
  + `off the shaft axis by up to ${out.worst.offAxisMm} mm`);
console.log(`worst frame: body up ${out.worst.frameUpDeg}° · `
  + `view ${out.worst.frameLookDeg}° · eye ${out.worst.frameEyeMm} mm`);
console.log(`states: ${JSON.stringify(out.states)}`);

// The shaft drops about 44 mm to the room. Getting most of the way down it,
// staying inside a 10 mm bore, is the whole of the ask.
const gotDown = out.deepestMm > 30;
const stayedInBore = out.worst.offAxisMm < 6;
const steady = out.worst.frameUpDeg < 8 && out.worst.frameLookDeg < 12;
console.log(gotDown ? 'DESCENDS' : 'STUCK_AT_THE_TOP');
console.log(stayedInBore ? 'IN_THE_BORE' : 'WANDERED_OUT');
console.log(steady ? 'STEADY' : 'TUMBLES');
await b.close();
